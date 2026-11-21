import { createHash, randomBytes } from 'node:crypto';
import { AccessError } from './access.js';
import { transaction } from './database.js';
import { decisionTime } from './holds.js';
import { intervalFitsWorkingHours } from './slot-calculation.js';
import type pg from 'pg';
import { ownerSubject, runOperation } from './operations.js';

type WorkingInterval = { startMinute: number; endMinute: number };
type WeeklyDay = { weekday: number; intervals: WorkingInterval[] };
type SaveAvailability = {
  revision: number;
  timeZone: string;
  days: WeeklyDay[];
  confirmationToken?: string;
};
const columns = 'time_zone AS "timeZone", revision, days, (time_zone IS NOT NULL) AS configured';
export async function getAvailability(pool: pg.Pool) {
  const result = await pool.query(
    `SELECT ${columns}, clock_timestamp() AS "serverNow" FROM calendar WHERE id = 1`,
  );
  const { serverNow, ...availability } = result.rows[0];
  return { availability, serverNow: serverNow.toISOString() };
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
function normalize(input: unknown) {
  const fieldErrors: { field: string; code: string; message: string }[] = [];
  const invalid = (field: string, message: string) =>
    fieldErrors.push({ field, code: 'INVALID_VALUE', message });
  function model(
    value: unknown,
    path: string,
    allowed: string[],
  ): value is Record<string, unknown> {
    if (!object(value)) {
      invalid(path, 'Ожидается объект');
      return false;
    }
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) invalid(path ? `${path}.${key}` : key, 'Неизвестное поле');
    return true;
  }
  if (!model(input, '', ['revision', 'timeZone', 'days', 'confirmationToken']))
    return { fieldErrors, parameters: input ?? null };
  if (!integer(input.revision, 0, 2147483646))
    invalid('revision', 'Ожидается целая версия Расписания');
  let timeZone = input.timeZone;
  try {
    if (typeof timeZone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timeZone))
      throw new Error();
    timeZone = new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
  } catch {
    invalid('timeZone', 'Выберите поддерживаемый IANA-пояс');
  }
  if (input.confirmationToken !== undefined && typeof input.confirmationToken !== 'string')
    invalid('confirmationToken', 'Ожидается строка');
  const days: WeeklyDay[] = [];
  const weekdays = new Set<number>();
  if (!Array.isArray(input.days) || input.days.length !== 7)
    invalid('days', 'Укажите ровно семь дней недели');
  if (Array.isArray(input.days))
    input.days.forEach((day: unknown, index: number) => {
      const path = `days.${index}`;
      if (!model(day, path, ['weekday', 'intervals'])) return;
      if (!integer(day.weekday, 1, 7) || weekdays.has(day.weekday))
        invalid(`${path}.weekday`, 'Дни 1–7 должны быть уникальны');
      else weekdays.add(day.weekday);
      const intervals: WorkingInterval[] = [];
      if (!Array.isArray(day.intervals))
        invalid(`${path}.intervals`, 'Ожидается список интервалов');
      else
        day.intervals.forEach((interval: unknown, position: number) => {
          const field = `${path}.intervals.${position}`;
          if (!model(interval, field, ['startMinute', 'endMinute'])) return;
          const { startMinute, endMinute } = interval;
          const startValid = integer(startMinute, 0, 1439);
          const endValid = integer(endMinute, 1, 1440);
          if (!startValid) invalid(`${field}.startMinute`, 'Начало — целая минута от 0 до 1439');
          if (!endValid || (startValid && endValid && endMinute <= startMinute))
            invalid(`${field}.endMinute`, 'Конец должен быть позже начала и не позже 24:00');
          if (startValid && endValid) intervals.push({ startMinute, endMinute });
        });
      const merged: WorkingInterval[] = [];
      for (const interval of intervals.sort(
        (left, right) => left.startMinute - right.startMinute,
      )) {
        const previous = merged.at(-1);
        if (previous && previous.endMinute > interval.startMinute)
          invalid(`${path}.intervals`, 'Интервалы не должны пересекаться');
        if (previous?.endMinute === interval.startMinute) previous.endMinute = interval.endMinute;
        else merged.push(interval);
      }
      if (integer(day.weekday, 1, 7)) days.push({ weekday: day.weekday, intervals: merged });
    });
  const parameters = fieldErrors.length
    ? input
    : { ...input, timeZone, days: days.sort((left, right) => left.weekday - right.weekday) };
  return { fieldErrors, parameters };
}
export function saveAvailability(pool: pg.Pool, key: unknown, input: unknown, clock?: () => Date) {
  const { fieldErrors, parameters } = normalize(input);
  return runOperation(
    pool,
    { subject: ownerSubject, key, action: 'saveAvailability', parameters },
    async (client) => {
      const now = await decisionTime(client, clock);
      if (fieldErrors.length)
        return {
          status: 400,
          body: { code: 'VALIDATION_FAILED', message: 'Проверьте поля Расписания', fieldErrors },
        };
      const fields = parameters as SaveAvailability;
      const current = (
        await client.query<{ revision: number; timeZone: string | null }>(
          'SELECT revision, time_zone AS "timeZone" FROM calendar WHERE id = 1',
        )
      ).rows[0]!;
      if (current.revision !== fields.revision)
        return {
          status: 409,
          body: {
            code: 'REVISION_CONFLICT',
            message:
              'Расписание изменилось в другой вкладке. Согласуйте черновик с актуальной версией.',
          },
        };
      if (current.timeZone !== null && current.timeZone !== fields.timeZone) {
        if (!fields.confirmationToken)
          return {
            status: 409,
            body: {
              code: 'PREVIEW_REQUIRED',
              message: 'Для смены пояса нужен предварительный просмотр последствий',
            },
          };
        const row = (
          await client.query<{ parameters: unknown; consequences: unknown; expiresAt: Date }>(
            'SELECT parameters, consequences, expires_at AS "expiresAt" FROM availability_previews WHERE token_hash=$1 AND owner_subject=$2',
            [tokenHash(fields.confirmationToken), ownerSubject],
          )
        ).rows[0];
        if (!row || row.expiresAt <= now || !same(row.parameters, proposal(fields))) return stale();
        if (!same(row.consequences, await consequences(client, fields, now))) return stale();
      }
      const result = await client.query(
        `UPDATE calendar SET time_zone = $1, days = $2, revision = revision + 1 WHERE id = 1 RETURNING ${columns},  $3::timestamptz AS "serverNow"`,
        [fields.timeZone, JSON.stringify(fields.days), now],
      );
      const { serverNow, ...availability } = result.rows[0];
      return { status: 200, body: { availability, serverNow: serverNow.toISOString() } };
    },
  );
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const proposal = ({ revision, timeZone, days }: SaveAvailability) => ({ revision, timeZone, days });
function same(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    );
  return canonical(left) === canonical(right);
}
const stale = () => ({
  status: 409,
  body: {
    code: 'PREVIEW_STALE',
    message: 'Последствия изменились. Получите новый просмотр и подтвердите смену пояса.',
  },
});
async function consequences(client: pg.PoolClient, fields: SaveAvailability, now: Date) {
  const read = async (holds: boolean) => {
    const rows = (
      await client.query<{
        id: string;
        eventTypeId: string;
        eventTypeName: string;
        startsAt: Date;
        endsAt: Date;
        expiresAt?: Date;
      }>(
        `SELECT x.id,x.event_type_id AS "eventTypeId",t.name AS "eventTypeName",x.starts_at AS "startsAt",x.ends_at AS "endsAt"${holds ? ',x.expires_at AS "expiresAt"' : ''} FROM ${holds ? 'holds' : 'bookings'} x JOIN event_types t ON t.id=x.event_type_id WHERE x.ends_at>$1 ${holds ? "AND x.state='active' AND x.expires_at>$1" : ''} ORDER BY x.starts_at,x.id`,
        [now],
      )
    ).rows;
    return rows
      .filter((row) => !intervalFitsWorkingHours(fields, row.startsAt, row.endsAt))
      .map((row) => ({
        ...row,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
      }));
  };
  return { affectedBookings: await read(false), affectedHolds: await read(true) };
}
export async function previewAvailability(pool: pg.Pool, input: unknown, clock?: () => Date) {
  const { fieldErrors, parameters } = normalize(input);
  if (object(input) && 'confirmationToken' in input)
    fieldErrors.push({
      field: 'confirmationToken',
      code: 'INVALID_VALUE',
      message: 'Неизвестное поле',
    });
  if (fieldErrors.length)
    throw new AccessError(400, 'VALIDATION_FAILED', 'Проверьте поля Расписания');
  const fields = parameters as SaveAvailability;
  return transaction(pool, async (client) => {
    const current = (
      await client.query<{ revision: number }>(
        'SELECT revision FROM calendar WHERE id=1 FOR UPDATE',
      )
    ).rows[0]!;
    const now = await decisionTime(client, clock);
    if (current.revision !== fields.revision)
      throw new AccessError(
        409,
        'REVISION_CONFLICT',
        'Расписание изменилось. Согласуйте черновик с актуальной версией.',
      );
    const affected = await consequences(client, fields, now);
    const confirmationToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + 300000);
    await client.query(
      'INSERT INTO availability_previews(token_hash,owner_subject,parameters,consequences,expires_at) VALUES($1,$2,$3,$4,$5)',
      [
        tokenHash(confirmationToken),
        ownerSubject,
        JSON.stringify(proposal(fields)),
        JSON.stringify(affected),
        expiresAt,
      ],
    );
    return {
      confirmationToken,
      expiresAt: expiresAt.toISOString(),
      serverNow: now.toISOString(),
      ...affected,
    };
  });
}
