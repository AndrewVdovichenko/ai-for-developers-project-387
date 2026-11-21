import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  listOwnerBookings,
  createEventType,
  ownerSessionLoginOwner,
  ownerAvailabilitySaveAvailability,
  guestSessionPrepareGuest,
  selectHold,
  confirmHold,
} from '@calendar/api-client';
import type { EventType } from '@calendar/api-client';
import { resetPassword } from '../src/access.js';
import { createApp } from '../src/app.js';
import { testDatabase } from './database.js';

async function fixture() {
  const db = await testDatabase();
  await db.migrate();
  const password = 'пароль списка'; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  let clock = new Date('2026-11-17T00:00:00.000Z');
  const origin = 'http://localhost:5173';
  const app = createApp({ pool: db.pool, origin, decisionNow: () => clock });
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
  const types: EventType[] = [];
  for (const name of ['Звонок', 'Консультация', 'Без записей'])
    types.push(
      (
        await createEventType({
          baseUrl,
          headers: { ...headers, 'Idempotency-Key': randomUUID() },
          body: { name, durationMinutes: 30 },
        })
      ).data!.eventType,
    );
  await ownerAvailabilitySaveAvailability({
    baseUrl,
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    body: {
      revision: 0,
      timeZone: 'UTC',
      days: Array.from({ length: 7 }, (_, i) => ({
        weekday: i + 1,
        intervals: [{ startMinute: 0, endMinute: 1440 }],
      })),
    },
  });
  const guest = await guestSessionPrepareGuest({ baseUrl, headers: { Origin: origin }, body: {} });
  const guestHeaders = {
    Origin: origin,
    Cookie: guest.response!.headers.get('set-cookie')!.split(';')[0]!,
  };
  async function hold(type: number, startsAt: string) {
    const result = await selectHold({
      baseUrl,
      headers: { ...guestHeaders, 'Idempotency-Key': randomUUID() },
      body: { eventTypeId: types[type]!.id, startsAt },
    });
    expect(result.response!.status).toBe(200);
    return result.data!.hold;
  }
  async function book(type: number, startsAt: string) {
    const selected = await hold(type, startsAt);
    const result = await confirmHold({
      baseUrl,
      path: { id: selected.id },
      headers: { ...guestHeaders, 'Idempotency-Key': randomUUID() },
      body: { guestName: 'Анна', guestEmail: 'anna@example.com' },
    });
    expect(result.response!.status).toBe(200);
    return result.data!.booking;
  }
  return {
    baseUrl,
    headers,
    types,
    hold,
    book,
    setClock: (value: string) => {
      clock = new Date(value);
    },
    read: (eventTypeId?: string[]) =>
      listOwnerBookings({ baseUrl, headers, query: { eventTypeId } }),
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}

test('Владелец видит только подтверждённые предстоящие Записи, включая идущие и дальние', async () => {
  const f = await fixture();
  try {
    const late = await f.book(1, '2026-11-18T10:00:00.000Z');
    const early = await f.book(0, '2026-11-17T09:00:00.000Z');
    await f.hold(0, '2026-11-17T12:00:00.000Z');
    expect((await listOwnerBookings({ baseUrl: f.baseUrl })).response!.status).toBe(401);
    f.setClock('2026-11-17T09:00:00.000Z');
    expect((await f.read()).data!.items).toEqual([early, late]);
    f.setClock('2026-11-17T09:29:59.999Z');
    expect((await f.read()).data!.items).toEqual([early, late]);
    f.setClock('2026-11-17T09:30:00.000Z');
    expect((await f.read()).data!.items).toEqual([late]);
    f.setClock('2026-10-01T00:00:00.000Z');
    expect((await f.read()).data!.items).toEqual([early, late]);
    expect((await f.read()).data!.serverNow).toBe('2026-10-01T00:00:00.000Z');
  } finally {
    await f.close();
  }
});

test('Фильтр объединяет типы, нормализует UUID и никогда не расширяется при ошибке', async () => {
  const f = await fixture();
  try {
    const a = await f.book(0, '2026-11-17T09:00:00.000Z');
    const b = await f.book(1, '2026-11-17T10:00:00.000Z');
    expect((await f.read([f.types[0]!.id.toUpperCase(), f.types[0]!.id])).data!.items).toEqual([a]);
    expect((await f.read([f.types[1]!.id, f.types[0]!.id])).data!.items).toEqual([a, b]);
    expect((await f.read([f.types[2]!.id])).data!.items).toEqual([]);
    for (const value of ['', 'not-uuid', randomUUID(), `${f.types[0]!.id},${f.types[1]!.id}`]) {
      const result = await f.read([f.types[0]!.id, value]);
      expect(result.response!.status).toBe(400);
      expect(result.error!.code).toBe('INVALID_FILTER');
      expect(result.data).toBeUndefined();
    }
  } finally {
    await f.close();
  }
});
