import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  ownerAvailabilityGetAvailability as get,
  ownerAvailabilityPreviewAvailability as preview,
  ownerAvailabilitySaveAvailability as put,
  ownerSessionLoginOwner,
  getOwnerOperation,
  createEventType,
  guestSessionPrepareGuest,
  selectHold,
  confirmHold,
  releaseHold,
  getHold,
  getBooking,
} from '@calendar/api-client';
import type { SaveAvailability } from '@calendar/api-client';
import { resetPassword } from '../src/access.js';
import { createApp } from '../src/app.js';
import { testDatabase } from './database.js';

const fixturePassword = 'пароль недельного Расписания'; // betterleaks:allow -- public test fixture
const origin = 'http://localhost:5173';
const days = (): SaveAvailability['days'] =>
  Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, intervals: [] }));
async function fixture(instant?: string) {
  let clock = new Date(instant ?? Date.now());
  const db = await testDatabase();
  await db.migrate();
  const password = fixturePassword;
  await resetPassword(db.pool, password, password);
  let app = createApp({
    pool: db.pool,
    origin,
    ...(instant ? { now: () => clock, decisionNow: () => clock } : {}),
  });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await ownerSessionLoginOwner({
    baseUrl,
    headers: { Origin: origin },
    body: { password },
  });
  const headers = {
    Origin: origin,
    Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
  };
  return {
    db,
    clock: (value: string) => {
      clock = new Date(value);
    },
    async restart() {
      await app.close();
      app = createApp({
        pool: db.pool,
        origin,
        ...(instant ? { now: () => clock, decisionNow: () => clock } : {}),
      });
      await app.listen({ host: '127.0.0.1', port: Number(new URL(baseUrl).port) });
    },
    app,
    baseUrl,
    headers,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

test('первое Расписание: семь выходных, явный пояс и полная атомарная неделя', async () => {
  const f = await fixture();
  try {
    expect((await get(f)).data).toMatchObject({
      availability: { configured: false, timeZone: null, revision: 0, days: days() },
    });
    const body = { revision: 0, timeZone: 'Asia/Yekaterinburg', days: days() };
    const result = await put({
      ...f,
      headers: { ...f.headers, 'Idempotency-Key': randomUUID() },
      body,
    });
    expect(result.response!.status).toBe(200);
    expect(result.data?.availability).toEqual({ ...body, configured: true, revision: 1 });
    expect((await get(f)).data?.availability).toEqual(result.data?.availability);
  } finally {
    await f.close();
  }
});

test('две вкладки: только одна версия сохраняется; смена пояса требует preview; ключи общие', async () => {
  const f = await fixture();
  try {
    const body = { revision: 0, timeZone: 'Europe/Berlin', days: days() };
    const send = (key: string, parameters = body) =>
      put({ ...f, headers: { ...f.headers, 'Idempotency-Key': key }, body: parameters });
    const keys = [randomUUID(), randomUUID()];
    const results = await Promise.all(keys.map((key) => send(key)));
    expect(results.map((result) => result.response!.status).sort()).toEqual([200, 409]);
    const failed = results.findIndex((result) => result.response!.status === 409);
    expect(results[failed]?.error?.code).toBe('REVISION_CONFLICT');
    expect((await send(keys[failed]!)).error).toEqual(results[failed]?.error);
    const changed = { ...body, revision: 1, timeZone: 'Asia/Yekaterinburg' };
    expect((await send(randomUUID(), changed)).error?.code).toBe('PREVIEW_REQUIRED');
    expect((await send(randomUUID(), { ...changed, revision: 0 })).error?.code).toBe(
      'REVISION_CONFLICT',
    );
    const winner = keys[1 - failed]!;
    expect((await send(winner, { ...body, revision: 1 })).error?.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(
      (
        await createEventType({
          ...f,
          headers: { ...f.headers, 'Idempotency-Key': winner },
          body: { name: 'Тип', durationMinutes: 30 },
        })
      ).error?.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await get(f)).data?.availability.revision).toBe(1);
  } finally {
    await f.close();
  }
});

test('ошибки полной недели сохраняются как окончательные отказы без частичного изменения', async () => {
  const f = await fixture();
  try {
    const valid = { revision: 0, timeZone: 'Europe/Berlin', days: days() };
    const invalid: unknown[] = [
      null,
      [],
      'week',
      { ...valid, extra: true },
      { ...valid, revision: '0' },
      { ...valid, revision: 0.5 },
      { ...valid, timeZone: null },
      { ...valid, timeZone: 'Invalid/Zone' },
      { ...valid, timeZone: '+05:00' },
      { ...valid, days: [] },
      { ...valid, days: [...days().slice(0, 6), days()[0]] },
    ];
    for (const intervals of [
      [{ startMinute: -1, endMinute: 60 }],
      [{ startMinute: 1440, endMinute: 1440 }],
      [{ startMinute: 0, endMinute: 1441 }],
      [{ startMinute: 60, endMinute: 60 }],
      [{ startMinute: 0.5, endMinute: 60 }],
      [{ startMinute: '0', endMinute: 60 }],
      [
        { startMinute: 0, endMinute: 100 },
        { startMinute: 90, endMinute: 110 },
      ],
      [{ startMinute: 0, endMinute: 60, extra: true }],
      null,
    ])
      invalid.push({ ...valid, days: [{ weekday: 1, intervals }, ...days().slice(1)] });
    for (const body of invalid) {
      const key = randomUUID();
      const result = await put({
        ...f,
        headers: { ...f.headers, 'Idempotency-Key': key },
        body: body as SaveAvailability,
      });
      expect(result.error?.code, JSON.stringify(body)).toBe('VALIDATION_FAILED');
      expect((await getOwnerOperation({ ...f, path: { key } })).data).toMatchObject({
        state: 'completed',
        response: { status: 400, body: result.error },
      });
    }
    expect((await get(f)).data?.availability).toEqual({
      configured: false,
      revision: 0,
      timeZone: null,
      days: days(),
    });
  } finally {
    await f.close();
  }
});

test('интервалы сортируются и объединяются; канонический повтор не увеличивает revision', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const body = { revision: 0, timeZone: 'Asia/Yekaterinburg', days: days() };
    body.days[0]!.intervals = [
      { startMinute: 600, endMinute: 1440 },
      { startMinute: 540, endMinute: 600 },
    ];
    const result = await put({ ...f, headers: { ...f.headers, 'Idempotency-Key': key }, body });
    expect(result.data?.availability.days[0]?.intervals).toEqual([
      { startMinute: 540, endMinute: 1440 },
    ]);
    body.days[0]!.intervals = [{ startMinute: 540, endMinute: 1440 }];
    body.days.reverse();
    expect(
      (await put({ ...f, headers: { ...f.headers, 'Idempotency-Key': key }, body })).data,
    ).toEqual(result.data);
    expect((await get(f)).data?.availability.revision).toBe(1);
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({
      state: 'completed',
      response: { status: 200, body: result.data },
    });
  } finally {
    await f.close();
  }
});

test('доступ и источник защищены; сбой БД откатывает неделю и результат; после перезапуска повтор безопасен', async () => {
  const f = await fixture();
  let restarted: ReturnType<typeof createApp> | undefined;
  try {
    const body = { revision: 0, timeZone: 'Europe/Berlin', days: days() };
    const key = randomUUID();
    expect((await get({ baseUrl: f.baseUrl })).error?.code).toBe('OWNER_AUTH_REQUIRED');
    expect(
      (await put({ baseUrl: f.baseUrl, body, headers: { Origin: origin, 'Idempotency-Key': key } }))
        .error?.code,
    ).toBe('OWNER_AUTH_REQUIRED');
    expect(
      (
        await put({
          ...f,
          body,
          headers: { ...f.headers, Origin: 'https://untrusted.test', 'Idempotency-Key': key },
        })
      ).error?.code,
    ).toBe('ORIGIN_NOT_ALLOWED');
    expect(
      (await put({ ...f, body, headers: { ...f.headers, 'Idempotency-Key': '' } })).error?.code,
    ).toBe('IDEMPOTENCY_KEY_REQUIRED');
    await f.db.pool.query(
      `CREATE FUNCTION fail_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_save BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION fail_save()`,
    );
    expect(
      (await put({ ...f, body, headers: { ...f.headers, 'Idempotency-Key': key } })).response!
        .status,
    ).toBe(503);
    expect((await get(f)).data?.availability.revision).toBe(0);
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({ state: 'unknown' });
    await f.db.pool.query('DROP TRIGGER fail_save ON operations');
    const result = await put({ ...f, body, headers: { ...f.headers, 'Idempotency-Key': key } });
    await f.app.close();
    restarted = createApp({ pool: f.db.pool, origin });
    const baseUrl = await restarted.listen({ host: '127.0.0.1', port: 0 });
    expect(
      (await put({ baseUrl, body, headers: { ...f.headers, 'Idempotency-Key': key } })).data,
    ).toEqual(result.data);
    expect((await get({ baseUrl, headers: f.headers })).data?.availability.revision).toBe(1);
  } finally {
    await restarted?.close();
    await f.close();
  }
});

test('ожидание общей блокировки ограничено и не превращается в бизнес-конфликт', async () => {
  const f = await fixture();
  const blocker = await f.db.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id = 1 FOR UPDATE');
    const key = randomUUID();
    const result = await put({
      ...f,
      body: { revision: 0, timeZone: 'Europe/Berlin', days: days() },
      headers: { ...f.headers, 'Idempotency-Key': key },
    });
    expect(result.error?.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({ state: 'unknown' });
    expect((await get(f)).data?.availability.revision).toBe(0);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await f.close();
  }
});

test('разные некорректные JSON-модели под прежним ключом не совпадают', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const send = (body: unknown) =>
      put({
        ...f,
        headers: { ...f.headers, 'Idempotency-Key': key },
        body: body as SaveAvailability,
      });
    expect((await send(null)).error?.code).toBe('VALIDATION_FAILED');
    expect((await send({ invalidModel: null })).error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
  } finally {
    await f.close();
  }
});

test('защищённый preview без ключа сохраняет полный черновик только после подтверждения', async () => {
  const f = await fixture();
  try {
    const send = (body: SaveAvailability, key = randomUUID()) =>
      put({ ...f, headers: { ...f.headers, 'Idempotency-Key': key }, body });
    await send({ revision: 0, timeZone: 'Europe/Berlin', days: days() });
    const body = { revision: 1, timeZone: 'Asia/Yekaterinburg', days: days() };
    const viewed = await preview({ ...f, body });
    expect(viewed.response!.status).toBe(200);
    expect(viewed.data).toMatchObject({ affectedBookings: [], affectedHolds: [] });
    expect(Date.parse(viewed.data!.expiresAt) - Date.parse(viewed.data!.serverNow)).toBe(300000);
    expect((await get(f)).data!.availability.timeZone).toBe('Europe/Berlin');
    expect((await send({ ...body, confirmationToken: 'forged' })).error?.code).toBe(
      'PREVIEW_STALE',
    );
    const approved = { ...body, confirmationToken: viewed.data!.confirmationToken };
    const key = randomUUID();
    const saved = await send(approved, key);
    expect(saved.data!.availability).toMatchObject({ revision: 2, timeZone: body.timeZone });
    expect((await send(approved, key)).data).toEqual(saved.data);
  } finally {
    await f.close();
  }
});

async function populatedPreview(
  instant = '2026-11-17T08:00:00.000Z',
  durationMinutes = 20,
  start = 540,
  end = 720,
) {
  const f = await fixture(instant);
  const week = (startMinute: number, endMinute: number) =>
    days().map((day) => ({ ...day, intervals: [{ startMinute, endMinute }] }));
  const send = (body: SaveAvailability, key = randomUUID()) =>
    put({ ...f, body, headers: { ...f.headers, 'Idempotency-Key': key } });
  await send({ revision: 0, timeZone: 'UTC', days: week(start, end) });
  const type = (
    await createEventType({
      ...f,
      headers: { ...f.headers, 'Idempotency-Key': randomUUID() },
      body: { name: 'Встреча', durationMinutes },
    })
  ).data!.eventType;
  const guest = async () => {
    const r = await guestSessionPrepareGuest({
      baseUrl: f.baseUrl,
      headers: { Origin: origin },
      body: {},
    });
    return { Origin: origin, Cookie: r.response!.headers.get('set-cookie')!.split(';')[0]! };
  };
  const select = async (startsAt: string) => {
    const headers = await guest();
    const result = await selectHold({
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: { eventTypeId: type.id, startsAt },
    });
    expect(result.response!.status).toBe(200);
    return { headers, hold: result.data!.hold };
  };
  const confirm = (selected: Awaited<ReturnType<typeof select>>) =>
    confirmHold({
      baseUrl: f.baseUrl,
      headers: { ...selected.headers, 'Idempotency-Key': randomUUID() },
      path: { id: selected.hold.id },
      body: { guestName: 'Гость', guestEmail: 'guest@example.test' },
    });
  const body = { revision: 1, timeZone: 'Asia/Yekaterinburg', days: week(540, 720) };
  return { ...f, send, select, confirm, proposed: body, week, type };
}

test('preview показывает точные UTC-последствия; активное Бронирование сохраняет право подтверждения после смены пояса', async () => {
  const f = await populatedPreview();
  try {
    const booked = await f.select('2026-11-17T09:00:00.000Z');
    const booking = (await f.confirm(booked)).data!.booking;
    const held = await f.select('2026-11-17T10:00:00.000Z');
    const viewed = (await preview({ ...f, body: f.proposed })).data!;
    expect(viewed.affectedBookings).toEqual([
      {
        id: booking.id,
        eventTypeId: f.type.id,
        eventTypeName: 'Встреча',
        startsAt: '2026-11-17T09:00:00.000Z',
        endsAt: '2026-11-17T09:20:00.000Z',
      },
    ]);
    expect(viewed.affectedHolds).toEqual([
      {
        id: held.hold.id,
        eventTypeId: f.type.id,
        eventTypeName: 'Встреча',
        startsAt: '2026-11-17T10:00:00.000Z',
        endsAt: '2026-11-17T10:20:00.000Z',
        expiresAt: '2026-11-17T08:05:00.000Z',
      },
    ]);
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers: held.headers, path: { id: held.hold.id } }))
        .data!.hold,
    ).toEqual(held.hold);
    expect(
      (await f.send({ ...f.proposed, confirmationToken: viewed.confirmationToken })).response!
        .status,
    ).toBe(200);
    const confirmed = await f.confirm(held);
    expect(confirmed.data!.booking).toMatchObject({
      startsAt: held.hold.startsAt,
      endsAt: held.hold.endsAt,
    });
    expect((await getBooking({ ...f, path: { id: booking.id } })).data!.booking).toEqual(booking);
  } finally {
    await f.close();
  }
});

test('изменение затронутого набора сохраняет отказ под старым ключом; новый просмотр требует нового ключа', async () => {
  const f = await populatedPreview();
  try {
    const held = await f.select('2026-11-17T09:00:00.000Z');
    const viewed = (await preview({ ...f, body: f.proposed })).data!;
    await releaseHold({
      baseUrl: f.baseUrl,
      headers: { ...held.headers, 'Idempotency-Key': randomUUID() },
      path: { id: held.hold.id },
      body: {},
    });
    const approved = { ...f.proposed, confirmationToken: viewed.confirmationToken };
    const key = randomUUID();
    expect((await f.send(approved, key)).error!.code).toBe('PREVIEW_STALE');
    const renewed = (await preview({ ...f, body: f.proposed })).data!;
    expect((await f.send(approved, key)).error!.code).toBe('PREVIEW_STALE');
    expect(
      (await f.send({ ...f.proposed, confirmationToken: renewed.confirmationToken })).response!
        .status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('срок preview и Бронирования: граница недействительна, revision приоритетнее; истёкшее подтверждение проверяет новые часы', async () => {
  const f = await populatedPreview();
  try {
    const held = await f.select('2026-11-17T09:00:00.000Z');
    const viewed = (await preview({ ...f, body: f.proposed })).data!;
    expect(
      (
        await f.send({
          ...f.proposed,
          days: f.week(600, 720),
          confirmationToken: viewed.confirmationToken,
        })
      ).error!.code,
    ).toBe('PREVIEW_STALE');
    f.clock('2026-11-17T08:04:59.999Z');
    expect(
      (await f.send({ ...f.proposed, confirmationToken: viewed.confirmationToken })).response!
        .status,
    ).toBe(200);
    f.clock('2026-11-17T08:05:00.000Z');
    expect((await f.confirm(held)).error!.code).toBe('SLOT_NO_LONGER_OFFERED');
    expect(
      (await f.send({ ...f.proposed, confirmationToken: viewed.confirmationToken })).error!.code,
    ).toBe('REVISION_CONFLICT');
    const next = { ...f.proposed, revision: 2, timeZone: 'Europe/Berlin' };
    const boundary = (await preview({ ...f, body: next })).data!;
    f.clock(boundary.expiresAt);
    expect(
      (await f.send({ ...next, confirmationToken: boundary.confirmationToken })).error!.code,
    ).toBe('PREVIEW_STALE');
    expect((await get(f)).data!.availability.revision).toBe(2);
  } finally {
    await f.close();
  }
});

test('незатронутая новая Запись не обесценивает preview; проверяется весь интервал без привязки к сетке Слотов', async () => {
  const f = await populatedPreview();
  try {
    const proposed = { ...f.proposed, timeZone: 'Africa/Abidjan', days: f.week(550, 580) };
    const viewed = (await preview({ ...f, body: proposed })).data!;
    const selected = await f.select('2026-11-17T09:15:00.000Z');
    const booking = await f.confirm(selected);
    expect(booking.response!.status).toBe(200);
    expect(
      (await f.send({ ...proposed, confirmationToken: viewed.confirmationToken })).response!.status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('preview охватывает Записи за пределами 14 дат; учитывает окончание, а не начало', async () => {
  const f = await populatedPreview();
  try {
    const selected = await f.select('2026-11-30T09:00:00.000Z');
    const booked = (await f.confirm(selected)).data!.booking;
    f.clock('2026-11-01T08:00:00.000Z');
    const future = (await preview({ ...f, body: f.proposed })).data!;
    expect(future.affectedBookings.map((b) => b.id)).toEqual([booked.id]);
    f.clock('2026-11-30T09:19:59.999Z');
    const renewedLogin = await ownerSessionLoginOwner({
      baseUrl: f.baseUrl,
      headers: { Origin: origin },
      body: { password: fixturePassword },
    });
    f.headers.Cookie = renewedLogin.response!.headers.get('set-cookie')!.split(';')[0]!;
    expect(
      (await preview({ ...f, body: f.proposed })).data!.affectedBookings.map((b) => b.id),
    ).toEqual([booked.id]);
    f.clock('2026-11-30T09:20:00.000Z');
    // Owner sessions have a fixed lifetime: authenticate again at this decision time.
    const login = await ownerSessionLoginOwner({
      baseUrl: f.baseUrl,
      headers: { Origin: origin },
      body: { password: fixturePassword },
    });
    const headers = {
      ...f.headers,
      Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
    };
    expect(
      (await preview({ baseUrl: f.baseUrl, headers, body: f.proposed })).data!.affectedBookings,
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

test('истечение затронутого Бронирования меняет точный набор даже при действующем preview', async () => {
  const f = await populatedPreview();
  try {
    await f.select('2026-11-17T09:00:00.000Z');
    f.clock('2026-11-17T08:01:00.000Z');
    const viewed = (await preview({ ...f, body: f.proposed })).data!;
    f.clock('2026-11-17T08:05:00.000Z');
    expect(
      (await f.send({ ...f.proposed, confirmationToken: viewed.confirmationToken })).error!.code,
    ).toBe('PREVIEW_STALE');
  } finally {
    await f.close();
  }
});

test('preview переживает перезапуск; технический сбой откатывает сохранение и результат, повтор увеличивает revision один раз', async () => {
  const f = await populatedPreview();
  try {
    const viewed = (await preview({ ...f, body: f.proposed })).data!;
    await f.restart();
    const approved = { ...f.proposed, confirmationToken: viewed.confirmationToken };
    const key = randomUUID();
    await f.db.pool.query(
      `CREATE FUNCTION reject_preview_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test'; END $$; CREATE TRIGGER reject_preview_save BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION reject_preview_save()`,
    );
    expect((await f.send(approved, key)).response!.status).toBe(503);
    expect((await get(f)).data!.availability).toMatchObject({ revision: 1, timeZone: 'UTC' });
    expect((await getOwnerOperation({ ...f, path: { key } })).data!.state).toBe('unknown');
    await f.db.pool.query('DROP TRIGGER reject_preview_save ON operations');
    const saved = await f.send(approved, key);
    expect(saved.data!.availability.revision).toBe(2);
    await f.restart();
    expect((await f.send(approved, key)).data).toEqual(saved.data);
  } finally {
    await f.close();
  }
});

for (const action of ['confirm', 'release', 'select'] as const) {
  test(`общая блокировка согласует смену пояса и ${action} без частичного изменения`, async () => {
    const f = await populatedPreview();
    const blocker = await f.db.pool.connect();
    try {
      const held = await f.select('2026-11-17T09:00:00.000Z');
      const viewed = (await preview({ ...f, body: f.proposed })).data!;
      const guest = await guestSessionPrepareGuest({
        baseUrl: f.baseUrl,
        headers: { Origin: origin },
        body: {},
      });
      const headers = {
        Origin: origin,
        Cookie: guest.response!.headers.get('set-cookie')!.split(';')[0]!,
        'Idempotency-Key': randomUUID(),
      };
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
      const save = f.send({ ...f.proposed, confirmationToken: viewed.confirmationToken });
      const mutate =
        action === 'confirm'
          ? f.confirm(held)
          : action === 'release'
            ? releaseHold({
                baseUrl: f.baseUrl,
                headers: { ...held.headers, 'Idempotency-Key': randomUUID() },
                path: { id: held.hold.id },
                body: {},
              })
            : selectHold({
                baseUrl: f.baseUrl,
                headers,
                body: { eventTypeId: f.type.id, startsAt: '2026-11-17T10:00:00.000Z' },
              });
      const deadline = Date.now() + 2000;
      while (true) {
        const waiting = await f.db.pool.query<{ count: string }>(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
        );
        if (Number(waiting.rows[0]!.count) >= 2) break;
        if (Date.now() > deadline) throw new Error('Requests did not wait for the calendar lock');
      }
      await blocker.query('COMMIT');
      const [saved, mutated] = await Promise.all([save, mutate]);
      if (saved.data) {
        expect(saved.data.availability.revision).toBe(2);
        expect(mutated.response!.status).toBe(action === 'select' ? 409 : 200);
      } else {
        expect(saved.error!.code).toBe('PREVIEW_STALE');
        expect(mutated.response!.status).toBe(200);
        expect((await get(f)).data!.availability).toMatchObject({ revision: 1, timeZone: 'UTC' });
      }
      expect(
        (await getHold({ baseUrl: f.baseUrl, headers: held.headers, path: { id: held.hold.id } }))
          .data!.hold,
      ).toMatchObject({ startsAt: held.hold.startsAt, endsAt: held.hold.endsAt });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await f.close();
    }
  });
}

test('срок preview проверяется после ожидания блокировки; повторный вход сохраняет идентичность Владельца', async () => {
  const f = await populatedPreview();
  const blocker = await f.db.pool.connect();
  try {
    const viewed = (await preview({ ...f, body: f.proposed })).data!;
    const login = await ownerSessionLoginOwner({
      baseUrl: f.baseUrl,
      headers: { Origin: origin },
      body: { password: fixturePassword },
    });
    f.headers.Cookie = login.response!.headers.get('set-cookie')!.split(';')[0]!;
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const saved = f.send({ ...f.proposed, confirmationToken: viewed.confirmationToken });
    const deadline = Date.now() + 2000;
    while (true) {
      const waiting = await f.db.pool.query<{ count: string }>(
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      );
      if (Number(waiting.rows[0]!.count)) break;
      if (Date.now() > deadline) throw new Error('Request did not wait for calendar lock');
    }
    f.clock(viewed.expiresAt);
    await blocker.query('COMMIT');
    expect((await saved).error!.code).toBe('PREVIEW_STALE');
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await f.close();
  }
});

test('preview проверяет каждый момент повторного часа DST, включая разрыв внутри локального интервала', async () => {
  const f = await populatedPreview('2026-10-24T20:00:00.000Z', 30, 0, 1440);
  try {
    const held = await f.select('2026-10-25T00:45:00.000Z');
    const booking = (await f.confirm(held)).data!.booking;
    // 02:45 CEST → 02:15 CET: both endpoints lie in 02:00–03:00.
    const whole = { ...f.proposed, timeZone: 'Europe/Berlin', days: f.week(120, 180) };
    expect((await preview({ ...f, body: whole })).data!.affectedBookings).toEqual([]);
    // The real interval crosses 02:00–02:14 again; endpoint-only or grid checks fail here.
    const broken = { ...whole, days: f.week(135, 180) };
    expect((await preview({ ...f, body: broken })).data!.affectedBookings.map((b) => b.id)).toEqual(
      [booking.id],
    );
  } finally {
    await f.close();
  }
});

test('preview защищён сессией и Origin, не принимает лишние поля и нормализует неделю перед связыванием токена', async () => {
  const f = await populatedPreview();
  try {
    expect(
      (await preview({ baseUrl: f.baseUrl, headers: { Origin: origin }, body: f.proposed })).error!
        .code,
    ).toBe('OWNER_AUTH_REQUIRED');
    expect(
      (
        await preview({
          ...f,
          headers: { ...f.headers, Origin: 'https://other.test' },
          body: f.proposed,
        })
      ).error!.code,
    ).toBe('ORIGIN_NOT_ALLOWED');
    expect((await preview({ ...f, body: { ...f.proposed, days: [] } })).error!.code).toBe(
      'VALIDATION_FAILED',
    );
    const proposed = {
      ...f.proposed,
      days: f.proposed.days
        .map((day) => ({
          ...day,
          intervals: [
            { startMinute: 540, endMinute: 600 },
            { startMinute: 600, endMinute: 720 },
          ],
        }))
        .reverse(),
    };
    const viewed = (await preview({ ...f, body: proposed })).data!;
    expect(
      (await f.send({ ...f.proposed, confirmationToken: viewed.confirmationToken })).response!
        .status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});
