import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  createEventType,
  getSlotAvailability,
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
  const app = createApp({ pool: db.pool, origin, now: () => clock });
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
    read,
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

test('публичные Слоты: ненастроенное Расписание, 14 дат, шаг от 09:10 и точная граница', async () => {
  const f = await fixture();
  try {
    expect((await f.read()).data).toEqual({
      configured: false,
      serverNow: '2026-11-17T04:10:00.000Z',
      timeZone: null,
      windowStartsAt: null,
      windowEndsAt: null,
      slots: [],
    });
    await f.save('Asia/Yekaterinburg', [{ startMinute: 550, endMinute: 600 }]);
    const result = (await f.read()).data!;
    expect(result).toMatchObject({
      configured: true,
      timeZone: 'Asia/Yekaterinburg',
      windowStartsAt: '2026-11-16T19:00:00.000Z',
      windowEndsAt: '2026-11-30T19:00:00.000Z',
    });
    expect(result.slots).toHaveLength(42);
    expect(result.slots.slice(0, 3)).toEqual([
      { startsAt: '2026-11-17T04:10:00.000Z', endsAt: '2026-11-17T04:30:00.000Z' },
      { startsAt: '2026-11-17T04:25:00.000Z', endsAt: '2026-11-17T04:45:00.000Z' },
      { startsAt: '2026-11-17T04:40:00.000Z', endsAt: '2026-11-17T05:00:00.000Z' },
    ]);
    f.setClock('2026-11-17T04:10:00.001Z');
    expect((await f.read()).data!.slots[0]!.startsAt).toBe('2026-11-17T04:25:00.000Z');
    f.setClock('2026-11-17T19:00:00.000Z');
    expect((await f.read()).data!.windowEndsAt).toBe('2026-12-01T19:00:00.000Z');
    expect(
      (await getSlotAvailability({ baseUrl: f.baseUrl, path: { id: randomUUID() } })).error!.code,
    ).toBe('EVENT_TYPE_NOT_FOUND');
  } finally {
    await f.close();
  }
});

for (const scenario of [
  {
    now: '2026-03-28T23:00:00.000Z',
    start: '2026-03-28T23:00:00.000Z',
    end: '2026-04-11T22:00:00.000Z',
    date: '2026-03-29',
  },
  {
    now: '2026-10-24T22:00:00.000Z',
    start: '2026-10-24T22:00:00.000Z',
    end: '2026-11-07T23:00:00.000Z',
    date: '2026-10-25',
  },
]) {
  test(`DST ${scenario.date}: пропуски, повторы и реальные минуты внутри рабочих часов`, async () => {
    const f = await fixture(scenario.now, 60);
    try {
      await f.save('Europe/Berlin', [
        { startMinute: 90, endMinute: scenario.date === '2026-03-29' ? 210 : 180 },
      ]);
      const data = (await f.read()).data!;
      expect(data).toMatchObject({ windowStartsAt: scenario.start, windowEndsAt: scenario.end });
      const firstDay = data.slots.filter(
        (slot) => slot.startsAt < `${scenario.date}T22:00:00.000Z`,
      );
      // Berlin spring gap leaves one continuous actual hour, autumn fold 2.5 hours.
      const expected =
        scenario.date === '2026-03-29'
          ? [{ startsAt: '2026-03-29T00:30:00.000Z', endsAt: '2026-03-29T01:30:00.000Z' }]
          : [
              { startsAt: '2026-10-24T23:30:00.000Z', endsAt: '2026-10-25T00:30:00.000Z' },
              { startsAt: '2026-10-24T23:45:00.000Z', endsAt: '2026-10-25T00:45:00.000Z' },
              { startsAt: '2026-10-25T00:00:00.000Z', endsAt: '2026-10-25T01:00:00.000Z' },
              { startsAt: '2026-10-25T00:15:00.000Z', endsAt: '2026-10-25T01:15:00.000Z' },
              { startsAt: '2026-10-25T00:30:00.000Z', endsAt: '2026-10-25T01:30:00.000Z' },
              { startsAt: '2026-10-25T00:45:00.000Z', endsAt: '2026-10-25T01:45:00.000Z' },
              { startsAt: '2026-10-25T01:00:00.000Z', endsAt: '2026-10-25T02:00:00.000Z' },
            ];
      expect(firstDay).toEqual(expected);
    } finally {
      await f.close();
    }
  });
}

test('Слот помещается в один фактический интервал: fold вне часов, перерывы, соседние часы и 24:00', async () => {
  const f = await fixture('2026-10-24T22:00:00.000Z', 60);
  try {
    await f.save('Europe/Berlin', [{ startMinute: 150, endMinute: 210 }]);
    const first = (await f.read()).data!.slots.filter(
      (slot) => slot.startsAt < '2026-10-25T22:00:00.000Z',
    );
    expect(first).toEqual([
      { startsAt: '2026-10-25T01:30:00.000Z', endsAt: '2026-10-25T02:30:00.000Z' },
    ]);
    await f.save('Europe/Berlin', [
      { startMinute: 540, endMinute: 600 },
      { startMinute: 615, endMinute: 645 },
    ]);
    expect((await f.read()).data!.slots).toHaveLength(14);
    await f.save('Europe/Berlin', [
      { startMinute: 1380, endMinute: 1410 },
      { startMinute: 1410, endMinute: 1440 },
    ]);
    const data = (await f.read()).data!;
    expect(data.slots).toHaveLength(14);
    expect(data.slots.at(-1)!.endsAt).toBe(data.windowEndsAt);
    await f.save('Europe/Berlin', [{ startMinute: 540, endMinute: 550 }]);
    expect((await f.read()).data).toMatchObject({
      configured: true,
      timeZone: 'Europe/Berlin',
      windowEndsAt: '2026-11-07T23:00:00.000Z',
      slots: [],
    });
  } finally {
    await f.close();
  }
});

for (const duration of [1, 1440]) {
  test(`длительность ${duration}: реальные минуты и полное попадание в рабочие часы`, async () => {
    const f = await fixture('2026-03-28T23:00:00.000Z', duration);
    try {
      await f.save(
        'Europe/Berlin',
        duration === 1
          ? [{ startMinute: 550, endMinute: 551 }]
          : [{ startMinute: 0, endMinute: 1440 }],
      );
      const data = (await f.read()).data!;
      if (duration === 1) {
        expect(data.slots).toHaveLength(14);
        expect(data.slots[0]).toEqual({
          startsAt: '2026-03-29T07:10:00.000Z',
          endsAt: '2026-03-29T07:11:00.000Z',
        });
      } else {
        // The first local day has only 23 actual hours; subsequent days have 24.
        expect(data.slots).toHaveLength(13);
        expect(data.slots[0]).toEqual({
          startsAt: '2026-03-29T22:00:00.000Z',
          endsAt: '2026-03-30T22:00:00.000Z',
        });
        expect(data.slots.at(-1)!.endsAt).toBe(data.windowEndsAt);
      }
    } finally {
      await f.close();
    }
  });
}
