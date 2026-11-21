import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  confirmHold,
  getBooking,
  createEventType,
  getSlotAvailability,
  guestSessionPrepareGuest,
  selectHold,
  releaseHold,
  getCurrentHold,
  getHold,
  getGuestOperation,
  guestSessionVerifyGuest,
  ownerAvailabilitySaveAvailability,
  ownerSessionLoginOwner,
} from '@calendar/api-client';
import type { SaveAvailability } from '@calendar/api-client';
import { resetPassword } from '../src/access.js';
import { createApp } from '../src/app.js';
import { testDatabase } from './database.js';

async function fixture(instant = '2026-11-17T04:10:00.000Z', durationMinutes = 20) {
  const db = await testDatabase();
  await db.migrate();
  let clock = new Date(instant);
  const password = 'пароль Слотов'; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  const origin = 'http://localhost:5173';
  let app = createApp({ pool: db.pool, origin, now: () => clock, decisionNow: () => clock });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await ownerSessionLoginOwner({
    baseUrl,
    headers: { Origin: origin },
    body: { password },
  });
  const headers = {
    Origin: origin,
    Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
    'Idempotency-Key': randomUUID(),
  };
  const created = await createEventType({
    baseUrl,
    headers,
    body: { name: 'Звонок', durationMinutes },
  });
  const id = created.data!.eventType.id;
  const read = () => getSlotAvailability({ baseUrl, path: { id } });
  let revision = 0;
  return {
    ownerHeaders: headers,
    pool: db.pool,
    async restart() {
      await app.close();
      app = createApp({ pool: db.pool, origin, now: () => clock, decisionNow: () => clock });
      const address = new URL(baseUrl);
      await app.listen({ host: '127.0.0.1', port: Number(address.port) });
    },
    async type(durationMinutes: number) {
      return (
        await createEventType({
          baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { name: 'Другой тип', durationMinutes },
        })
      ).data!.eventType;
    },
    read,
    async guest() {
      const r = await guestSessionPrepareGuest({ baseUrl, headers: { Origin: origin }, body: {} });
      return { Origin: origin, Cookie: r.response!.headers.get('set-cookie')!.split(';')[0]! };
    },
    baseUrl,
    id,
    setClock: (value: string) => {
      clock = new Date(value);
    },
    async save(timeZone: string, intervals: SaveAvailability['days'][number]['intervals']) {
      const result = await ownerAvailabilitySaveAvailability({
        baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: {
          revision: revision++,
          timeZone,
          days: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, intervals })),
        },
      });
      expect(result.response!.status).toBe(200);
    },
    async close() {
      await app.close();
      await db.close();
    },
  };
}

test('Гость выбирает Слот один раз и восстанавливает исходный срок', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const key = randomUUID();
    const first = await selectHold({
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': key },
      body,
    });
    expect(first.response!.status).toBe(200);
    expect(first.data!.hold).toMatchObject({
      state: 'active',
      expiresAt: '2026-11-17T04:15:00.000Z',
    });
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toEqual(
      first.data!.hold,
    );
    f.setClock('2026-11-17T04:15:00.000Z');
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold!.state).toBe(
      'expired',
    );
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).data,
    ).toEqual(first.data);
  } finally {
    await f.close();
  }
});

test('Два Гостя: один пересекающийся выбор, общая граница и сохранённый конфликт', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const a = await f.guest(),
      b = await f.guest();
    const otherType = await f.type(60);
    const blocked = await f.pool.connect();
    await blocked.query('BEGIN');
    await blocked.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const keyA = randomUUID(),
      keyB = randomUUID();
    const bodyA = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const bodyB = { eventTypeId: otherType.id, startsAt: '2026-11-17T09:15:00.000Z' };
    const pendingA = selectHold({
      baseUrl: f.baseUrl,
      headers: { ...a, 'Idempotency-Key': keyA },
      body: bodyA,
    });
    const pendingB = selectHold({
      baseUrl: f.baseUrl,
      headers: { ...b, 'Idempotency-Key': keyB },
      body: bodyB,
    });
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await f.pool.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            ).rows[0].count,
          ),
        )
        .toBe(2);
    } finally {
      await blocked.query('ROLLBACK');
      blocked.release();
    }
    const results = await Promise.all([pendingA, pendingB]);
    expect(results.map((r) => r.response!.status).sort()).toEqual([200, 409]);
    // The losing guest is the response with a saved refusal.
    const index = results.findIndex((r) => r.error);
    const headers = index === 0 ? a : b;
    const key = index === 0 ? keyA : keyB;
    const body = index === 0 ? bodyA : bodyB;
    expect(
      (await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data,
    ).toMatchObject({
      state: 'completed',
      response: { status: 409, body: { code: 'SLOT_UNAVAILABLE' } },
    });
    const winner = results.find((r) => r.data)!.data!.hold;
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: winner.id } })).error!.code,
    ).toBe('HOLD_UNAVAILABLE');
    expect((await f.read()).data!.slots.some((slot) => slot.startsAt === winner.startsAt)).toBe(
      false,
    );
    f.setClock('2026-11-17T04:15:00.000Z');
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).error!.code,
    ).toBe('SLOT_UNAVAILABLE');
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { eventTypeId: f.id, startsAt: '2026-11-17T10:00:00.000Z' },
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('cookie не продлевается; чужие UUID и отсутствие cookie не дают доступ', async () => {
  const f = await fixture();
  try {
    const headers = await f.guest();
    expect((await guestSessionVerifyGuest({ baseUrl: f.baseUrl, headers })).data).toEqual({
      ready: true,
    });
    expect(
      (
        await guestSessionPrepareGuest({ baseUrl: f.baseUrl, headers, body: {} })
      ).response!.headers.get('set-cookie'),
    ).toBeNull();
    expect((await getCurrentHold({ baseUrl: f.baseUrl })).response!.status).toBe(401);
    expect((await getHold({ baseUrl: f.baseUrl, path: { id: 'invalid' } })).response!.status).toBe(
      404,
    );
  } finally {
    await f.close();
  }
});

test('После ожидания блокировки пять минут начинаются с актуального времени; общая граница свободна', async () => {
  const f = await fixture(undefined, 60);
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const a = await f.guest(),
      b = await f.guest();
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const pending = selectHold({
      baseUrl: f.baseUrl,
      headers: { ...a, 'Idempotency-Key': randomUUID() },
      body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
    });
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await f.pool.query(
                "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            ).rows[0].count,
          ),
        )
        .toBe(1);
      f.setClock('2026-11-17T04:12:00.123Z');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const first = await pending;
    expect(first.data).toMatchObject({
      serverNow: '2026-11-17T04:12:00.123Z',
      hold: { expiresAt: '2026-11-17T04:17:00.123Z' },
    });
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...a, 'Idempotency-Key': randomUUID() },
          body: { eventTypeId: f.id, startsAt: first.data!.hold.startsAt },
        })
      ).data!.hold,
    ).toEqual(first.data!.hold);
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...b, 'Idempotency-Key': randomUUID() },
          body: { eventTypeId: f.id, startsAt: '2026-11-17T10:00:00.000Z' },
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('Технический откат не оставляет Бронирование или результат операции', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const key = randomUUID();
    await f.pool.query(
      "CREATE FUNCTION reject_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_operation BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION reject_operation()",
    );
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).response!.status,
    ).toBe(503);
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toBeNull();
    expect((await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data).toEqual({
      state: 'unknown',
    });
    await f.pool.query('DROP TRIGGER reject_operation ON operations');
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('Перезапуск сохраняет исходный срок и исторический результат', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest(),
      key = randomUUID();
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const first = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        body,
      })
    ).data!;
    f.setClock('2026-11-17T04:16:00.000Z');
    await f.restart();
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toMatchObject({
      id: first.hold.id,
      state: 'expired',
      expiresAt: first.hold.expiresAt,
    });
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).data,
    ).toEqual(first);
  } finally {
    await f.close();
  }
});

test('Тайм-аут блокировки остаётся техническим и не сохраняет отказ Слота', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest(),
      key = randomUUID();
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    try {
      expect(
        (
          await selectHold({
            baseUrl: f.baseUrl,
            headers: { ...headers, 'Idempotency-Key': key },
            body,
          })
        ).error!.code,
      ).toBe('TEMPORARILY_UNAVAILABLE');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data).toEqual({
      state: 'unknown',
    });
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await f.close();
  }
});

test('Успешная замена пересекает собственный Слот и сохраняет исторический результат', async () => {
  const f = await fixture(undefined, 60);
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const key = randomUUID();
    const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
    const first = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        body,
      })
    ).data!;
    f.setClock('2026-11-17T04:12:00.000Z');
    const next = await selectHold({
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: { ...body, startsAt: '2026-11-17T09:15:00.000Z' },
    });
    expect(next.response!.status).toBe(200);
    expect(next.data!.hold).toMatchObject({
      state: 'active',
      expiresAt: '2026-11-17T04:17:00.000Z',
    });
    expect(next.data!.hold.id).not.toBe(first.hold.id);
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: first.hold.id } })).data!.hold
        .state,
    ).toBe('replaced');
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toEqual(
      next.data!.hold,
    );
    expect(
      (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': key },
          body,
        })
      ).data,
    ).toEqual(first);
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: first.hold.id } })).data!.hold
        .state,
    ).toBe('replaced');
  } finally {
    await f.close();
  }
});

test('Освобождение действует для active и expired; повторы не возобновляют выбор', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    for (const expired of [false, true]) {
      const selected = await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      });
      const hold = selected.data!.hold;
      if (expired) f.setClock(hold.expiresAt);
      const key = randomUUID();
      const options = {
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        path: { id: hold.id },
        body: {},
      };
      const released = await releaseHold(options);
      expect(released.response!.status).toBe(200);
      expect(released.data!.hold).toMatchObject({
        id: hold.id,
        state: 'released',
        expiresAt: hold.expiresAt,
      });
      await f.restart();
      expect((await releaseHold(options)).data).toEqual(released.data);
      expect(
        (
          await releaseHold({
            ...options,
            headers: { ...headers, 'Idempotency-Key': randomUUID() },
          })
        ).data!.hold.state,
      ).toBe('released');
      expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold!.state).toBe(
        'released',
      );
      expect((await f.read()).data!.slots.some((s) => s.startsAt === hold.startsAt)).toBe(true);
    }
  } finally {
    await f.close();
  }
});

async function waitForLock(f: Awaited<ReturnType<typeof fixture>>, count = 1) {
  await expect
    .poll(async () =>
      Number(
        (
          await f.pool.query(
            "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
          )
        ).rows[0].count,
      ),
    )
    .toBe(count);
}

test('Неудачная замена сохраняет прежний выбор и срок; новый ключ допускает замену после освобождения препятствия', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const a = await f.guest(),
      b = await f.guest();
    const select = (headers: typeof a, startsAt: string, key = randomUUID()) =>
      selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        body: { eventTypeId: f.id, startsAt },
      });
    const old = (await select(a, '2026-11-17T09:00:00.000Z')).data!.hold;
    const obstacle = (await select(b, '2026-11-17T10:00:00.000Z')).data!.hold;
    const key = randomUUID();
    expect((await select(a, obstacle.startsAt, key)).error!.code).toBe('SLOT_UNAVAILABLE');
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers: a })).data!.hold).toEqual(old);
    await releaseHold({
      baseUrl: f.baseUrl,
      headers: { ...b, 'Idempotency-Key': randomUUID() },
      path: { id: obstacle.id },
      body: {},
    });
    expect((await select(a, obstacle.startsAt, key)).error!.code).toBe('SLOT_UNAVAILABLE');
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers: a, path: { id: old.id } })).data!.hold,
    ).toEqual(old);
    expect((await select(a, obstacle.startsAt)).response!.status).toBe(200);
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers: a, path: { id: old.id } })).data!.hold.state,
    ).toBe('replaced');
  } finally {
    await f.close();
  }
});

test('На границе срока новый выбор получает новый id и атомарно заменяет истёкший', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const select = () =>
      selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      });
    const first = (await select()).data!.hold;
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const pending = select();
    try {
      await waitForLock(f);
      f.setClock(first.expiresAt);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const second = (await pending).data!.hold;
    expect(second.id).not.toBe(first.id);
    expect(second.expiresAt).toBe('2026-11-17T04:20:00.000Z');
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: first.id } })).data!.hold.state,
    ).toBe('replaced');
  } finally {
    await f.close();
  }
});

test('Две одновременные замены одного Гостя оставляют только последний действующий выбор', async () => {
  const f = await fixture(undefined, 60);
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const select = (startsAt: string) =>
      selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt },
      });
    const first = (await select('2026-11-17T09:00:00.000Z')).data!.hold;
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const a = select('2026-11-17T09:15:00.000Z');
    const b = select('2026-11-17T09:30:00.000Z');
    try {
      await waitForLock(f, 2);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const results = await Promise.all([a, b]);
    expect(results.map((r) => r.response!.status)).toEqual([200, 200]);
    const current = (await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold!;
    const states = await Promise.all(
      [first, ...results.map((r) => r.data!.hold)].map(
        async (h) =>
          (await getHold({ baseUrl: f.baseUrl, headers, path: { id: h.id } })).data!.hold,
      ),
    );
    expect(states.filter((h) => h.state === 'active').map((h) => h.id)).toEqual([current.id]);
    expect(states.filter((h) => h.state === 'replaced')).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const releaseFirst of [true, false]) {
  test(`Освобождение и замена сериализуются: освобождение первым ${releaseFirst}`, async () => {
    const f = await fixture();
    try {
      await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
      const headers = await f.guest();
      const select = (startsAt: string) =>
        selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { eventTypeId: f.id, startsAt },
        });
      const first = (await select('2026-11-17T09:00:00.000Z')).data!.hold;
      const blocker = await f.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
      const release = () =>
        releaseHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          path: { id: first.id },
          body: {},
        });
      const replacement = () => select('2026-11-17T09:15:00.000Z');
      const one = releaseFirst ? release() : replacement();
      await waitForLock(f);
      const two = releaseFirst ? replacement() : release();
      try {
        await waitForLock(f, 2);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      const results = await Promise.all([one, two]);
      expect(results.map((r) => r.response!.status)).toEqual([200, 200]);
      expect(
        (await getHold({ baseUrl: f.baseUrl, headers, path: { id: first.id } })).data!.hold.state,
      ).toBe(releaseFirst ? 'released' : 'replaced');
      const current = (await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold!;
      expect(current).toMatchObject({ state: 'active', startsAt: '2026-11-17T09:15:00.000Z' });
    } finally {
      await f.close();
    }
  });
}

test('Откат замены и освобождения не меняет старый выбор и не сохраняет результат', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const old = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    await f.pool.query(
      "CREATE FUNCTION reject_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_operation BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION reject_operation()",
    );
    for (const action of ['replace', 'release']) {
      const key = randomUUID(),
        options = { baseUrl: f.baseUrl, headers: { ...headers, 'Idempotency-Key': key } };
      const result =
        action === 'replace'
          ? await selectHold({
              ...options,
              body: { eventTypeId: f.id, startsAt: '2026-11-17T10:00:00.000Z' },
            })
          : await releaseHold({ ...options, path: { id: old.id }, body: {} });
      expect(result.response!.status).toBe(503);
      expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toEqual(old);
      expect(
        (await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data,
      ).toEqual({ state: 'unknown' });
    }
  } finally {
    await f.close();
  }
});

test('Освобождение проверяет принадлежность, пустое тело и общее пространство ключей', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest(),
      other = await f.guest(),
      key = randomUUID();
    const old = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    const options = {
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': key },
      path: { id: old.id },
      body: {},
    };
    expect((await releaseHold(options)).error!.code).toBe('IDEMPOTENCY_KEY_REUSED');
    for (const id of [old.id, randomUUID(), 'invalid']) {
      expect(
        (
          await releaseHold({
            ...options,
            headers: { ...other, 'Idempotency-Key': randomUUID() },
            path: { id },
          })
        ).error!.code,
      ).toBe('HOLD_UNAVAILABLE');
    }
    expect(
      (
        await releaseHold({
          ...options,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { extra: true },
        })
      ).error!.code,
    ).toBe('INVALID_REQUEST');
    expect((await getCurrentHold({ baseUrl: f.baseUrl, headers })).data!.hold).toEqual(old);
  } finally {
    await f.close();
  }
});

test('Подтверждение создаёт одну защищённую Запись, сохраняет регистр и блокирует Слот', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const hold = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    const options = {
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      path: { id: hold.id },
      body: { guestName: '  Анна 😀  ', guestEmail: ' Anna@Example.COM ' },
    };
    const first = await confirmHold(options);
    expect(first.response!.status).toBe(200);
    expect(first.data!.booking).toMatchObject({
      holdId: hold.id,
      guestName: 'Анна 😀',
      guestEmail: 'Anna@Example.COM',
      eventTypeName: 'Звонок',
    });
    expect(
      (await getBooking({ baseUrl: f.baseUrl, headers, path: { id: first.data!.booking.id } }))
        .data!.booking,
    ).toEqual(first.data!.booking);
    expect(
      (
        await getBooking({
          baseUrl: f.baseUrl,
          headers: f.ownerHeaders,
          path: { id: first.data!.booking.id },
        })
      ).data!.booking,
    ).toEqual(first.data!.booking);
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: hold.id } })).data!.hold,
    ).toMatchObject({ state: 'confirmed', bookingId: first.data!.booking.id });
    expect((await f.read()).data!.slots.some((s) => s.startsAt === hold.startsAt)).toBe(false);
    expect(
      (
        await releaseHold({
          ...options,
          body: {},
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
        })
      ).error!.code,
    ).toBe('HOLD_ALREADY_CONFIRMED');
    expect(
      (await getBooking({ baseUrl: f.baseUrl, headers, path: { id: first.data!.booking.id } }))
        .data!.booking,
    ).toEqual(first.data!.booking);
    f.setClock('2026-11-17T10:00:00.000Z');
    await f.restart();
    expect((await confirmHold(options)).data).toEqual(first.data);
    expect(
      (await confirmHold({ ...options, headers: { ...headers, 'Idempotency-Key': randomUUID() } }))
        .data!.booking,
    ).toEqual(first.data!.booking);
    expect(
      (
        await confirmHold({
          ...options,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { ...options.body, guestName: 'Другой' },
        })
      ).error!.code,
    ).toBe('HOLD_ALREADY_CONFIRMED');
    for (const id of [first.data!.booking.id, randomUUID(), 'invalid']) {
      const foreign = await getBooking({
        baseUrl: f.baseUrl,
        headers: await f.guest(),
        path: { id },
      });
      expect(foreign.response!.status).toBe(404);
      expect(foreign.error).toEqual({ code: 'BOOKING_UNAVAILABLE', message: 'Запись недоступна' });
      expect((await getBooking({ baseUrl: f.baseUrl, path: { id } })).error).toEqual(foreign.error);
    }
  } finally {
    await f.close();
  }
});

for (const [guestName, guestEmail, field] of [
  ['', 'a@b.c', 'guestName'],
  ['😀'.repeat(101), 'a@b.c', 'guestName'],
  ['Имя', 'a@b', 'guestEmail'],
  ['Имя', 'a @b.c', 'guestEmail'],
  ['Имя', 'a@@b.c', 'guestEmail'],
  ['Имя', 'a'.repeat(250) + '@b.co', 'guestEmail'],
] as const) {
  test(`Форма отклоняет ${field}: ${guestName.length}/${guestEmail.length}`, async () => {
    const f = await fixture();
    try {
      const headers = await f.guest();
      const result = await confirmHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        path: { id: randomUUID() },
        body: { guestName: guestName!, guestEmail: guestEmail! },
      });
      expect(result.response!.status).toBe(400);
      expect(result.error!.fieldErrors?.map((e) => e.field)).toContain(field);
    } finally {
      await f.close();
    }
  });
}

test('Форма отвергает неизвестные поля и типы; предел Unicode сохраняется без изменения email', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const hold = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    for (const body of [
      { guestName: 42, guestEmail: 'a@b.c' },
      { guestName: null, guestEmail: 'a@b.c' },
      { guestName: 'Имя', guestEmail: 'a@b.c', phone: '123' },
    ]) {
      // Invalid wire inputs are deliberately sent through the generated SDK.
      const r = await confirmHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        path: { id: hold.id },
        // @ts-expect-error invalid request at HTTP seam
        body,
      });
      expect(r.error!.code).toBe('INVALID_REQUEST');
    }
    const r = await confirmHold({
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      path: { id: hold.id },
      body: { guestName: '😀'.repeat(100), guestEmail: 'Я'.repeat(249) + '@Б.РФ' },
    });
    expect(r.response!.status).toBe(200);
    expect([...r.data!.booking.guestName]).toHaveLength(100);
    expect([...r.data!.booking.guestEmail]).toHaveLength(254);
  } finally {
    await f.close();
  }
});

for (const expired of [false, true]) {
  test(`Изменённые часы: подтверждение ${expired ? 'истёкшего' : 'действующего'} Бронирования`, async () => {
    const f = await fixture();
    try {
      await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
      const headers = await f.guest();
      const hold = (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
        })
      ).data!.hold;
      await f.save('UTC', [{ startMinute: 600, endMinute: 720 }]);
      if (expired) f.setClock(hold.expiresAt);
      const r = await confirmHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        path: { id: hold.id },
        body: { guestName: 'Гость', guestEmail: 'a@b.c' },
      });
      expect(r.response!.status).toBe(expired ? 409 : 200);
      if (expired) expect(r.error!.code).toBe('SLOT_NO_LONGER_OFFERED');
    } finally {
      await f.close();
    }
  });
}

test('Позднее подтверждение перепроверяет полный интервал, окно, прошлое и собственную Запись', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const a = await f.guest(),
      b = await f.guest();
    const select = (headers: typeof a, startsAt: string) =>
      selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt },
      });
    const old = (await select(a, '2026-11-17T09:00:00.000Z')).data!.hold;
    f.setClock(old.expiresAt);
    const newer = (await select(b, old.startsAt)).data!.hold;
    const confirm = (headers: typeof a, id: string) =>
      confirmHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        path: { id },
        body: { guestName: 'Гость', guestEmail: 'a@b.c' },
      });
    expect((await confirm(a, old.id)).error!.code).toBe('SLOT_UNAVAILABLE');
    await releaseHold({
      baseUrl: f.baseUrl,
      headers: { ...b, 'Idempotency-Key': randomUUID() },
      path: { id: newer.id },
      body: {},
    });
    expect((await confirm(a, old.id)).response!.status).toBe(200);
    expect((await select(a, old.startsAt)).error!.code).toBe('SLOT_UNAVAILABLE');
    const future = (await select(a, '2026-11-17T10:00:00.000Z')).data!.hold;
    await f.save('UTC', [{ startMinute: 600, endMinute: 610 }]);
    f.setClock(future.expiresAt);
    expect((await confirm(a, future.id)).error!.code).toBe('SLOT_NO_LONGER_OFFERED');
    f.setClock('2026-11-17T10:00:00.001Z');
    expect((await confirm(a, future.id)).error!.code).toBe('SLOT_STARTED');
  } finally {
    await f.close();
  }
});

for (const action of ['release', 'replace', 'confirm', 'select', 'schedule'] as const)
  for (const confirmationFirst of [true, false]) {
    test(`Подтверждение сериализуется с ${action}, первым ${confirmationFirst}`, async () => {
      const f = await fixture();
      try {
        await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
        const a = await f.guest(),
          b = await f.guest();
        const select = (headers: typeof a, startsAt = '2026-11-17T09:00:00.000Z') =>
          selectHold({
            baseUrl: f.baseUrl,
            headers: { ...headers, 'Idempotency-Key': randomUUID() },
            body: { eventTypeId: f.id, startsAt },
          });
        const old = (await select(a)).data!.hold;
        // Two guests hold the same interval only after both fixed leases have elapsed.
        f.setClock(old.expiresAt);
        const rival = action === 'confirm' ? (await select(b)).data!.hold : undefined;
        if (rival) f.setClock(rival.expiresAt);
        const confirm = (headers: typeof a, id: string) =>
          confirmHold({
            baseUrl: f.baseUrl,
            headers: { ...headers, 'Idempotency-Key': randomUUID() },
            path: { id },
            body: { guestName: 'Гость', guestEmail: 'a@b.c' },
          });
        const other = () =>
          action === 'release'
            ? releaseHold({
                baseUrl: f.baseUrl,
                headers: { ...a, 'Idempotency-Key': randomUUID() },
                path: { id: old.id },
                body: {},
              })
            : action === 'replace'
              ? select(a, '2026-11-17T10:00:00.000Z')
              : action === 'select'
                ? select(b)
                : action === 'confirm'
                  ? confirm(b, rival!.id)
                  : f.save('UTC', [{ startMinute: 600, endMinute: 720 }]);
        const blocker = await f.pool.connect();
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
        const one = confirmationFirst ? confirm(a, old.id) : other();
        await waitForLock(f);
        const two = confirmationFirst ? other() : confirm(a, old.id);
        try {
          await waitForLock(f, 2);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
        const results = await Promise.all([one, two]);
        const result = results[confirmationFirst ? 0 : 1]!;
        if (!('response' in result)) throw new Error('missing confirmation');
        expect(result.response!.status).toBe(confirmationFirst ? 200 : 409);
        const rows = (
          await f.pool.query('SELECT state,booking_id FROM holds WHERE id=$1', [old.id])
        ).rows;
        expect(rows[0].state).toBe(
          confirmationFirst
            ? 'confirmed'
            : action === 'release'
              ? 'released'
              : action === 'replace'
                ? 'replaced'
                : 'active',
        );
        expect(
          (
            await f.pool.query('SELECT count(*)::int AS count FROM bookings WHERE hold_id=$1', [
              old.id,
            ])
          ).rows[0].count,
        ).toBe(confirmationFirst ? 1 : 0);
      } finally {
        await f.close();
      }
    });
  }

test('Ошибка сохранения результата откатывает Запись и преобразование Бронирования', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const hold = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    await f.pool.query(
      "CREATE FUNCTION reject_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER reject_confirmation BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION reject_confirmation()",
    );
    const key = randomUUID(),
      options = {
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        path: { id: hold.id },
        body: { guestName: 'Гость', guestEmail: 'a@b.c' },
      };
    expect((await confirmHold(options)).response!.status).toBe(503);
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: hold.id } })).data!.hold.state,
    ).toBe('active');
    expect((await f.pool.query('SELECT * FROM bookings')).rowCount).toBe(0);
    expect(
      (await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data!.state,
    ).toBe('unknown');
    await f.pool.query('DROP TRIGGER reject_confirmation ON operations');
    expect((await confirmHold(options)).response!.status).toBe(200);
  } finally {
    await f.close();
  }
});

test('Два одновременных подтверждения одним ключом возвращают один сохранённый результат', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const hold = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    const key = randomUUID(),
      options = {
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        path: { id: hold.id },
        body: { guestName: 'Гость', guestEmail: 'a@b.c' },
      };
    const blocker = await f.pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
    const a = confirmHold(options),
      b = confirmHold(options);
    try {
      await waitForLock(f, 2);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    const results = await Promise.all([a, b]);
    expect(results[0].response!.status).toBe(200);
    expect(results[1].data).toEqual(results[0].data);
    expect((await f.pool.query('SELECT count(*)::int AS count FROM bookings')).rows[0].count).toBe(
      1,
    );
  } finally {
    await f.close();
  }
});

for (const confirmFirst of [true, false])
  test(`Ожидание пересекает точный срок: первым подтверждение ${confirmFirst}`, async () => {
    const f = await fixture();
    try {
      await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
      const a = await f.guest(),
        b = await f.guest();
      const body = { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' };
      const hold = (
        await selectHold({
          baseUrl: f.baseUrl,
          headers: { ...a, 'Idempotency-Key': randomUUID() },
          body,
        })
      ).data!.hold;
      f.setClock('2026-11-17T04:14:59.999Z');
      const confirm = () =>
        confirmHold({
          baseUrl: f.baseUrl,
          headers: { ...a, 'Idempotency-Key': randomUUID() },
          path: { id: hold.id },
          body: { guestName: 'Гость', guestEmail: 'a@b.c' },
        });
      const select = () =>
        selectHold({
          baseUrl: f.baseUrl,
          headers: { ...b, 'Idempotency-Key': randomUUID() },
          body,
        });
      const blocker = await f.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM calendar WHERE id=1 FOR UPDATE');
      const one = confirmFirst ? confirm() : select();
      await waitForLock(f);
      const two = confirmFirst ? select() : confirm();
      try {
        await waitForLock(f, 2);
        f.setClock(hold.expiresAt);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      const results = await Promise.all([one, two]);
      expect(results.map((r) => r.response!.status)).toEqual([200, 409]);
      const result = results[confirmFirst ? 0 : 1];
      if (confirmFirst) expect(result.data).toMatchObject({ serverNow: hold.expiresAt });
      else expect(result.error!.code).toBe('SLOT_UNAVAILABLE');
      expect(
        (await f.pool.query('SELECT count(*)::int AS count FROM bookings')).rows[0].count,
      ).toBe(confirmFirst ? 1 : 0);
    } finally {
      await f.close();
    }
  });

test('Потеря ответа выполняющегося подтверждения не отменяет commit; результат восстанавливается после перезапуска', async () => {
  const f = await fixture();
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const hold = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    // SQL boundary pauses after business decision and conversion, before result+COMMIT.
    await f.pool.query(
      "CREATE FUNCTION pause_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(386,21); RETURN NEW; END $$; CREATE TRIGGER pause_confirmation BEFORE INSERT ON operations FOR EACH ROW WHEN (NEW.action='confirm-hold') EXECUTE FUNCTION pause_confirmation()",
    );
    f.setClock('2026-11-17T04:14:59.999Z');
    const blocker = await f.pool.connect();
    await blocker.query('SELECT pg_advisory_lock(386,21)');
    const key = randomUUID(),
      options = {
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': key },
        path: { id: hold.id },
        body: { guestName: 'Гость', guestEmail: 'a@b.c' },
      };
    const controller = new AbortController();
    const pending = confirmHold({ ...options, signal: controller.signal });
    try {
      await waitForLock(f);
      f.setClock(hold.expiresAt);
      expect(
        (await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data!.state,
      ).toBe('unknown');
      controller.abort();
      expect((await pending).data).toBeUndefined();
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(386,21)');
      blocker.release();
    }
    await expect
      .poll(
        async () =>
          (await getGuestOperation({ baseUrl: f.baseUrl, headers, path: { key } })).data!.state,
      )
      .toBe('completed');
    const result = await confirmHold(options);
    expect(result.response!.status).toBe(200);
    expect(result.data!.serverNow).toBe('2026-11-17T04:14:59.999Z');
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: hold.id } })).data!.hold.state,
    ).toBe('confirmed');
    await f.restart();
    expect((await confirmHold(options)).data).toEqual(result.data);
  } finally {
    await f.close();
  }
});

test('Действующее Бронирование нельзя подтвердить после начала встречи', async () => {
  const f = await fixture('2026-11-17T08:59:00.000Z');
  try {
    await f.save('UTC', [{ startMinute: 540, endMinute: 720 }]);
    const headers = await f.guest();
    const hold = (
      await selectHold({
        baseUrl: f.baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: f.id, startsAt: '2026-11-17T09:00:00.000Z' },
      })
    ).data!.hold;
    f.setClock('2026-11-17T09:00:00.001Z');
    expect(
      (await getHold({ baseUrl: f.baseUrl, headers, path: { id: hold.id } })).data!.hold.state,
    ).toBe('active');
    const result = await confirmHold({
      baseUrl: f.baseUrl,
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      path: { id: hold.id },
      body: { guestName: 'Гость', guestEmail: 'a@b.c' },
    });
    expect(result.error!.code).toBe('SLOT_STARTED');
    expect((await f.pool.query('SELECT * FROM bookings')).rowCount).toBe(0);
  } finally {
    await f.close();
  }
});
