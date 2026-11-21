import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AccessError } from './access.js';
import { isUuid, runOperation } from './operations.js';
import { calculateSlots } from './slot-calculation.js';
import type { WeeklyDay } from './slot-calculation.js';
export const guestSubject = (id: string) => `guest:${id}`;
type HoldRow = {
  id: string;
  eventTypeId: string;
  startsAt: Date;
  endsAt: Date;
  expiresAt: Date;
  state: string;
  bookingId: string | null;
};
const columns = `id,event_type_id AS "eventTypeId",starts_at AS "startsAt",ends_at AS "endsAt",expires_at AS "expiresAt",state,booking_id AS "bookingId"`;
export async function decisionTime(client: pg.Pool | pg.PoolClient, clock?: () => Date) {
  return (
    clock?.() ??
    (await client.query<{ now: Date }>('SELECT clock_timestamp()::timestamptz(3) AS now')).rows[0]!
      .now
  );
}
function present(row: HoldRow, now: Date) {
  return {
    ...row,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    state: row.state === 'active' && row.expiresAt <= now ? 'expired' : row.state,
  };
}
export async function readHold(
  pool: pg.Pool,
  guestId: string | undefined,
  id: string | undefined,
  clock?: () => Date,
) {
  const now = await decisionTime(pool, clock);
  if (id && (!guestId || !isUuid(id)))
    throw new AccessError(404, 'HOLD_UNAVAILABLE', 'Бронирование недоступно');
  const row = guestId
    ? (
        await pool.query<HoldRow>(
          `SELECT ${columns} FROM holds WHERE guest_id=$1 ${id ? 'AND id=$2' : ''} ORDER BY creation_order DESC LIMIT 1`,
          id ? [guestId, id] : [guestId],
        )
      ).rows[0]
    : undefined;
  if (id && !row) throw new AccessError(404, 'HOLD_UNAVAILABLE', 'Бронирование недоступно');
  return { hold: row ? present(row, now) : null, serverNow: now.toISOString() };
}
export async function selectHold(
  pool: pg.Pool,
  guestId: string,
  key: unknown,
  body: unknown,
  clock?: () => Date,
) {
  if (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'eventTypeId' in body &&
    isUuid(body.eventTypeId)
  )
    body = { ...body, eventTypeId: body.eventTypeId.toLowerCase() };
  return runOperation(
    pool,
    { subject: guestSubject(guestId), key, action: 'select-hold', parameters: body },
    async (client) => {
      const now = await decisionTime(client, clock);
      const fail = (status: number, code: string, message: string) => ({
        status,
        body: { code, message },
      });
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !('eventTypeId' in body) ||
        !isUuid(body.eventTypeId) ||
        !('startsAt' in body) ||
        typeof body.startsAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.startsAt) ||
        !Number.isFinite(Date.parse(body.startsAt)) ||
        new Date(body.startsAt).toISOString() !== body.startsAt
      )
        return fail(400, 'INVALID_REQUEST', 'Некорректный выбор Слота');
      const current = (
        await client.query<HoldRow>(
          `SELECT ${columns} FROM holds WHERE guest_id=$1 AND state='active' AND expires_at>$2 ORDER BY creation_order DESC LIMIT 1`,
          [guestId, now],
        )
      ).rows[0];
      if (
        current &&
        current.eventTypeId === body.eventTypeId &&
        current.startsAt.toISOString() === body.startsAt
      )
        return { status: 200, body: { hold: present(current, now), serverNow: now.toISOString() } };
      const type = (
        await client.query<{ duration: number }>(
          'SELECT duration_minutes AS duration FROM event_types WHERE id=$1',
          [body.eventTypeId],
        )
      ).rows[0];
      if (!type) return fail(404, 'EVENT_TYPE_NOT_FOUND', 'Тип встречи не найден');
      if (Date.parse(body.startsAt) < now.getTime())
        return fail(409, 'SLOT_STARTED', 'Слот уже начался');
      const settings = (
        await client.query<{ timeZone: string | null; days: WeeklyDay[] }>(
          'SELECT time_zone AS "timeZone", days FROM calendar WHERE id=1',
        )
      ).rows[0]!;
      const slot = calculateSlots(settings, type.duration, now).slots.find(
        (s) => s.startsAt === body.startsAt,
      );
      if (!slot) return fail(409, 'SLOT_NO_LONGER_OFFERED', 'Слот больше не предлагается');
      const occupied = await client.query(
        "SELECT id FROM holds WHERE state='active' AND guest_id<>$4 AND expires_at>$1 AND starts_at<$3 AND ends_at>$2 UNION ALL SELECT id FROM bookings WHERE starts_at<$3 AND ends_at>$2",
        [now, slot.startsAt, slot.endsAt, guestId],
      );
      if (occupied.rowCount)
        return fail(409, 'SLOT_UNAVAILABLE', 'Слот уже занят. Выберите другой.');
      await client.query("UPDATE holds SET state='replaced' WHERE guest_id=$1 AND state='active'", [
        guestId,
      ]);
      const row = (
        await client.query<HoldRow>(
          `INSERT INTO holds(id,guest_id,event_type_id,starts_at,ends_at,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${columns}`,
          [
            randomUUID(),
            guestId,
            body.eventTypeId,
            slot.startsAt,
            slot.endsAt,
            new Date(now.getTime() + 300000),
          ],
        )
      ).rows[0]!;
      return { status: 200, body: { hold: present(row, now), serverNow: now.toISOString() } };
    },
  );
}

export async function releaseHold(
  pool: pg.Pool,
  guestId: string,
  id: string,
  key: unknown,
  body: unknown,
  clock?: () => Date,
) {
  return runOperation(
    pool,
    {
      subject: guestSubject(guestId),
      key,
      action: 'release-hold',
      parameters: { id: id.toLowerCase(), body },
    },
    async (client) => {
      const now = await decisionTime(client, clock);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        return {
          status: 400,
          body: { code: 'INVALID_REQUEST', message: 'Требуется пустой объект' },
        };
      const row = isUuid(id)
        ? (
            await client.query<HoldRow>(
              `SELECT ${columns} FROM holds WHERE guest_id=$1 AND id=$2`,
              [guestId, id],
            )
          ).rows[0]
        : undefined;
      if (!row)
        return {
          status: 404,
          body: { code: 'HOLD_UNAVAILABLE', message: 'Бронирование недоступно' },
        };
      if (row.state === 'confirmed')
        return {
          status: 409,
          body: { code: 'HOLD_ALREADY_CONFIRMED', message: 'Бронирование уже подтверждено' },
        };
      if (row.state === 'active') {
        await client.query("UPDATE holds SET state='released' WHERE id=$1", [id]);
        row.state = 'released';
      }
      return { status: 200, body: { hold: present(row, now), serverNow: now.toISOString() } };
    },
  );
}
