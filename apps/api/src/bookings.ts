import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AccessError } from './access.js';
import { decisionTime, guestSubject } from './holds.js';
import { isUuid, runOperation } from './operations.js';
import { calculateSlots } from './slot-calculation.js';
import type { WeeklyDay } from './slot-calculation.js';

type BookingRow = {
  id: string;
  holdId: string;
  eventTypeId: string;
  eventTypeName: string;
  startsAt: Date;
  endsAt: Date;
  guestName: string;
  guestEmail: string;
};
const columns = `b.id,b.hold_id AS "holdId",b.event_type_id AS "eventTypeId",t.name AS "eventTypeName",b.starts_at AS "startsAt",b.ends_at AS "endsAt",b.guest_name AS "guestName",b.guest_email AS "guestEmail"`;
const present = (row: BookingRow) => ({
  ...row,
  startsAt: row.startsAt.toISOString(),
  endsAt: row.endsAt.toISOString(),
});
export async function readBooking(
  pool: pg.Pool,
  id: string,
  guestId: string | undefined,
  owner: boolean,
  clock?: () => Date,
) {
  const row =
    isUuid(id) && (guestId || owner)
      ? (
          await pool.query<BookingRow>(
            `SELECT ${columns} FROM bookings b JOIN event_types t ON t.id=b.event_type_id WHERE b.id=$1 AND ($2 OR b.guest_id=$3)`,
            [id, owner, guestId ?? null],
          )
        ).rows[0]
      : undefined;
  if (!row) throw new AccessError(404, 'BOOKING_UNAVAILABLE', 'Запись недоступна');
  return { booking: present(row), serverNow: (await decisionTime(pool, clock)).toISOString() };
}

export async function confirmHold(
  pool: pg.Pool,
  guestId: string,
  id: string,
  key: unknown,
  body: unknown,
  clock?: () => Date,
) {
  // Normalize before the shared operation boundary so a replay can use trimmed data.
  if (body && typeof body === 'object' && !Array.isArray(body))
    body = Object.fromEntries(
      Object.entries(body).map(([k, v]) => [
        k,
        (k === 'guestName' || k === 'guestEmail') && typeof v === 'string' ? v.trim() : v,
      ]),
    );
  return runOperation(
    pool,
    {
      subject: guestSubject(guestId),
      key,
      action: 'confirm-hold',
      parameters: { id: id.toLowerCase(), body },
    },
    async (client) => {
      const now = await decisionTime(client, clock);
      const fail = (code: string, message: string, status = 409) => ({
        status,
        body: { code, message },
      });
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !('guestName' in body) ||
        !('guestEmail' in body) ||
        typeof body.guestName !== 'string' ||
        typeof body.guestEmail !== 'string'
      )
        return fail('INVALID_REQUEST', 'Укажите имя и email', 400);
      const fieldErrors = [];
      if (
        [...body.guestName].length < 1 ||
        [...body.guestName].length > 100 ||
        body.guestName.includes('\0')
      )
        fieldErrors.push({
          field: 'guestName',
          code: 'INVALID_NAME',
          message: 'Введите имя от 1 до 100 символов',
        });
      if (
        [...body.guestEmail].length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.guestEmail) ||
        body.guestEmail.includes('\0')
      )
        fieldErrors.push({
          field: 'guestEmail',
          code: 'INVALID_EMAIL',
          message: 'Введите email до 254 символов в формате имя@домен.зона',
        });
      if (fieldErrors.length)
        return {
          status: 400,
          body: { code: 'VALIDATION_FAILED', message: 'Проверьте поля формы', fieldErrors },
        };
      const hold = isUuid(id)
        ? (
            await client.query<{
              id: string;
              eventTypeId: string;
              startsAt: Date;
              endsAt: Date;
              expiresAt: Date;
              state: string;
            }>(
              `SELECT id,event_type_id AS "eventTypeId",starts_at AS "startsAt",ends_at AS "endsAt",expires_at AS "expiresAt",state FROM holds WHERE id=$1 AND guest_id=$2`,
              [id, guestId],
            )
          ).rows[0]
        : undefined;
      if (!hold) return fail('HOLD_UNAVAILABLE', 'Бронирование недоступно', 404);
      if (hold.state === 'confirmed') {
        const existing = (
          await client.query<BookingRow>(
            `SELECT ${columns} FROM bookings b JOIN event_types t ON t.id=b.event_type_id WHERE b.hold_id=$1`,
            [id],
          )
        ).rows[0]!;
        if (existing.guestName !== body.guestName || existing.guestEmail !== body.guestEmail)
          return fail('HOLD_ALREADY_CONFIRMED', 'Бронирование уже подтверждено');
        return { status: 200, body: { booking: present(existing), serverNow: now.toISOString() } };
      }
      if (hold.state === 'replaced')
        return fail('HOLD_REPLACED', 'Бронирование заменено. Выберите актуальный Слот.');
      if (hold.state === 'released')
        return fail('HOLD_RELEASED', 'Бронирование освобождено. Выберите Слот.');
      if (hold.startsAt < now) return fail('SLOT_STARTED', 'Слот уже начался');
      if (hold.expiresAt <= now) {
        const settings = (
          await client.query<{ timeZone: string | null; days: WeeklyDay[] }>(
            'SELECT time_zone AS "timeZone",days FROM calendar WHERE id=1',
          )
        ).rows[0]!;
        const duration = (hold.endsAt.getTime() - hold.startsAt.getTime()) / 60000;
        if (
          !calculateSlots(settings, duration, now).slots.some(
            (s) =>
              s.startsAt === hold.startsAt.toISOString() && s.endsAt === hold.endsAt.toISOString(),
          )
        )
          return fail('SLOT_NO_LONGER_OFFERED', 'Слот больше не предлагается');
      }
      const occupied = await client.query(
        `SELECT id FROM holds WHERE state='active' AND id<>$4 AND expires_at>$1 AND starts_at<$3 AND ends_at>$2 UNION ALL SELECT id FROM bookings WHERE starts_at<$3 AND ends_at>$2`,
        [now, hold.startsAt, hold.endsAt, id],
      );
      if (occupied.rowCount) return fail('SLOT_UNAVAILABLE', 'Слот уже занят. Выберите другой.');
      const bookingId = randomUUID();
      await client.query(
        'INSERT INTO bookings(id,hold_id,guest_id,event_type_id,starts_at,ends_at,guest_name,guest_email) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          bookingId,
          id,
          guestId,
          hold.eventTypeId,
          hold.startsAt,
          hold.endsAt,
          body.guestName,
          body.guestEmail,
        ],
      );
      await client.query("UPDATE holds SET state='confirmed',booking_id=$2 WHERE id=$1", [
        id,
        bookingId,
      ]);
      const row = (
        await client.query<BookingRow>(
          `SELECT ${columns} FROM bookings b JOIN event_types t ON t.id=b.event_type_id WHERE b.id=$1`,
          [bookingId],
        )
      ).rows[0]!;
      return { status: 200, body: { booking: present(row), serverNow: now.toISOString() } };
    },
  );
}

export async function listOwnerBookings(pool: pg.Pool, rawFilter: unknown, clock?: () => Date) {
  const values = rawFilter === undefined ? [] : Array.isArray(rawFilter) ? rawFilter : [rawFilter];
  if (!values.every(isUuid))
    throw new AccessError(400, 'INVALID_FILTER', 'Некорректный Тип встречи. Сбросьте фильтр.');
  const ids = [...new Set(values.map((id: string) => id.toLowerCase()))];
  if (ids.length) {
    const known = await pool.query('SELECT id FROM event_types WHERE id=ANY($1::uuid[])', [ids]);
    if (known.rowCount !== ids.length)
      throw new AccessError(400, 'INVALID_FILTER', 'Неизвестный Тип встречи. Сбросьте фильтр.');
  }
  const now = await decisionTime(pool, clock);
  const rows = await pool.query<BookingRow>(
    `SELECT ${columns} FROM bookings b JOIN event_types t ON t.id=b.event_type_id WHERE b.ends_at>$1 ${ids.length ? 'AND b.event_type_id=ANY($2::uuid[])' : ''} ORDER BY b.starts_at,b.id`,
    ids.length ? [now, ids] : [now],
  );
  return { items: rows.rows.map(present), serverNow: now.toISOString() };
}
