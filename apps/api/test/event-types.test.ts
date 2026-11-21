import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate } from '../src/migrations.js';
import { expect, test } from 'vitest';
import {
  createEventType,
  eventTypesGetEventType,
  eventTypesListEventTypes,
  getOwnerOperation,
  ownerSessionLoginOwner,
} from '@calendar/api-client';
import { resetPassword } from '../src/access.js';
import { createPool } from '../src/database.js';
import { createApp } from '../src/app.js';
import { testDatabase } from './database.js';

const origin = 'http://localhost:5173';
async function fixture() {
  const db = await testDatabase();
  await db.migrate();
  const password = 'пароль для типов встречи'; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  const app = createApp({ pool: db.pool, origin });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = await ownerSessionLoginOwner({
    baseUrl,
    body: { password },
    headers: { Origin: origin },
  });
  const headers = {
    Origin: origin,
    Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
  };
  return {
    db,
    app,
    baseUrl,
    headers,
    password,
    async close() {
      await app.close();
      await db.close();
    },
  };
}

test('Владелец создаёт сразу публичный тип; повтор возвращает исходный результат', async () => {
  const f = await fixture();
  try {
    expect((await eventTypesListEventTypes({ baseUrl: f.baseUrl })).data).toEqual({ items: [] });
    const key = randomUUID();
    const body = { name: '  Знакомство 🔑  ', durationMinutes: 30 };
    const result = await createEventType({
      ...f,
      headers: { ...f.headers, 'Idempotency-Key': key },
      body,
    });
    expect(result.response!.status).toBe(201);
    expect(result.data?.eventType).toEqual({
      id: expect.any(String),
      name: 'Знакомство 🔑',
      description: '',
      durationMinutes: 30,
    });
    const repeated = await createEventType({
      ...f,
      headers: { ...f.headers, 'Idempotency-Key': key },
      body: { ...body, name: 'Знакомство 🔑', description: '' },
    });
    expect(repeated.data).toEqual(result.data);
    expect((await eventTypesListEventTypes({ baseUrl: f.baseUrl })).data).toEqual({
      items: [result.data!.eventType],
    });
    expect(
      (
        await eventTypesGetEventType({
          baseUrl: f.baseUrl,
          path: { id: result.data!.eventType.id },
        })
      ).data,
    ).toEqual(result.data!.eventType);
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({
      state: 'completed',
      response: { status: 201, body: result.data },
    });
  } finally {
    await f.close();
  }
});

test('границы Unicode, строгие типы, переносы и сохранённые отказы', async () => {
  const f = await fixture();
  const valid = {
    name: '😀'.repeat(100),
    description: '\n<b>Привет</b>\n' + 'я'.repeat(1985),
    durationMinutes: 1440,
  };
  const send = (body: unknown, key = randomUUID()) =>
    createEventType({
      ...f,
      headers: { ...f.headers, 'Idempotency-Key': key },
      body: valid,
      fetch: (request) => fetch(new Request(request, { body: JSON.stringify(body) })),
    });
  try {
    const upper = await send(valid);
    expect(upper.response!.status).toBe(201);
    expect(upper.data!.eventType).toMatchObject(valid);
    expect(
      (await send({ name: 'я', description: '😀'.repeat(2000), durationMinutes: 1 })).response!
        .status,
    ).toBe(201);
    const cases: [unknown, string][] = [
      [{ ...valid, name: '' }, 'name'],
      [{ ...valid, name: ' \n ' }, 'name'],
      [{ ...valid, name: '😀'.repeat(101) }, 'name'],
      [{ ...valid, name: null }, 'name'],
      [{ ...valid, description: '😀'.repeat(2001) }, 'description'],
      [{ ...valid, description: null }, 'description'],
      ...[0, 1441, 1.1, '30', null].map((durationMinutes): [unknown, string] => [
        { ...valid, durationMinutes },
        'durationMinutes',
      ]),
    ];
    for (const [body, field] of cases) {
      const key = randomUUID();
      const result = await send(body, key);
      expect(result.response!.status).toBe(400);
      expect(result.error?.fieldErrors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field })]),
      );
      expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({
        state: 'completed',
        response: { status: 400, body: result.error },
      });
      expect((await send(body, key)).error).toEqual(result.error);
      expect((await send(valid, key)).error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
    for (const body of [
      { ...valid, extra: true },
      { ...valid, extra: '\u0000', durationMinutes: 0 },
      [],
      null,
      'invalid',
    ]) {
      const key = randomUUID();
      const result = await send(body, key);
      expect(result.error?.code).toBe('VALIDATION_FAILED');
      expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({
        state: 'completed',
        response: { status: 400, body: result.error },
      });
    }
    expect((await eventTypesListEventTypes({ baseUrl: f.baseUrl })).data?.items).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('права, источник и ключ проверяются без сохранения результата; публичные UUID неразличимы', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const body = { name: 'Тип', durationMinutes: 1 };
    expect(
      (
        await createEventType({
          baseUrl: f.baseUrl,
          headers: { Origin: origin, 'Idempotency-Key': key },
          body,
        })
      ).response!.status,
    ).toBe(401);
    expect(
      (
        await createEventType({
          ...f,
          headers: { ...f.headers, Origin: 'https://other.test', 'Idempotency-Key': key },
          body,
        })
      ).response!.status,
    ).toBe(403);
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({ state: 'unknown' });
    for (const invalid of ['', 'bad-key']) {
      expect(
        (
          await createEventType({
            ...f,
            headers: { ...f.headers, 'Idempotency-Key': invalid },
            body,
          })
        ).error?.code,
      ).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
    const malformed = await createEventType({
      ...f,
      headers: { ...f.headers, 'Idempotency-Key': key },
      body,
      fetch: (request) => fetch(new Request(request, { body: '{' })),
    });
    expect(malformed.response!.status).toBe(400);
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({ state: 'unknown' });
    const known = await createEventType({
      ...f,
      headers: { ...f.headers, 'Idempotency-Key': key },
      body,
    });
    expect((await getOwnerOperation({ baseUrl: f.baseUrl, path: { key } })).response!.status).toBe(
      401,
    );
    const absent = await eventTypesGetEventType({ baseUrl: f.baseUrl, path: { id: randomUUID() } });
    const invalid = await eventTypesGetEventType({ baseUrl: f.baseUrl, path: { id: 'bad-id' } });
    expect(absent.response!.status).toBe(404);
    expect(invalid.error).toEqual(absent.error);
    const publicList = (await eventTypesListEventTypes({ baseUrl: f.baseUrl })).data;
    expect(publicList).toEqual({ items: [known.data!.eventType] });
  } finally {
    await f.close();
  }
});

test('одновременный повтор ждёт commit; unknown не означает отказ, одинаковые типы допустимы', async () => {
  const f = await fixture();
  const blocker = await f.db.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id = 1 FOR UPDATE');
    const key = randomUUID();
    const body = { name: 'Одинаковые поля', durationMinutes: 1440 };
    const send = (operationKey: string) =>
      createEventType({ ...f, headers: { ...f.headers, 'Idempotency-Key': operationKey }, body });
    const first = send(key);
    const repeat = send(key);
    const deadline = Date.now() + 2000;
    for (;;) {
      const waiting = await f.db.pool.query(
        "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      );
      if (waiting.rows[0].count >= 2) break;
      if (Date.now() > deadline) throw new Error('Запросы не достигли блокировки');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({ state: 'unknown' });
    await blocker.query('COMMIT');
    const [created, repeated] = await Promise.all([first, repeat]);
    expect(created.response!.status).toBe(201);
    expect(repeated.data).toEqual(created.data);
    const others = await Promise.all(Array.from({ length: 5 }, () => send(randomUUID())));
    expect(new Set(others.map((result) => result.data!.eventType.id)).size).toBe(5);
    const catalog = (await eventTypesListEventTypes({ baseUrl: f.baseUrl })).data!;
    expect(catalog.items).toHaveLength(6);
    expect(catalog.items[0]).toEqual(created.data!.eventType);
    expect((await eventTypesListEventTypes({ baseUrl: f.baseUrl })).data).toEqual(catalog);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await f.close();
  }
});

test('потеря ответа после commit и новая сессия восстанавливают исходный результат после перезапуска', async () => {
  const f = await fixture();
  const key = randomUUID();
  const body = { name: 'После перезапуска', durationMinutes: 30 };
  try {
    const lost = await createEventType({
      ...f,
      headers: { ...f.headers, 'Idempotency-Key': key },
      body,
      fetch: async (request) => {
        const response = await fetch(request);
        expect(response.status).toBe(201);
        await response.text();
        throw new TypeError('Ответ потерян после commit');
      },
    });
    expect(lost.data).toBeUndefined();
    const catalog = (await eventTypesListEventTypes({ baseUrl: f.baseUrl })).data!;
    await f.app.close();
    const pool = createPool(f.db.url);
    const restarted = createApp({ pool, origin });
    try {
      const baseUrl = await restarted.listen({ host: '127.0.0.1', port: 0 });
      const login = await ownerSessionLoginOwner({
        baseUrl,
        body: { password: f.password },
        headers: { Origin: origin },
      });
      const headers = {
        Origin: origin,
        Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
        'Idempotency-Key': key,
      };
      const recovery = await getOwnerOperation({ baseUrl, headers, path: { key } });
      expect(recovery.data).toEqual({
        state: 'completed',
        response: { status: 201, body: { eventType: catalog.items[0] } },
      });
      expect((await createEventType({ baseUrl, headers, body })).data).toEqual({
        eventType: catalog.items[0],
      });
      expect((await eventTypesListEventTypes({ baseUrl })).data).toEqual(catalog);
    } finally {
      await restarted.close();
      await pool.end();
    }
  } finally {
    await f.close();
  }
});

test('технический откат не оставляет тип или результат; пространство ключей общее для действий', async () => {
  const f = await fixture();
  try {
    const key = randomUUID();
    const body = { name: 'Атомарность', durationMinutes: 30 };
    await f.db.pool
      .query(`CREATE FUNCTION fail_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER fail_result BEFORE INSERT ON operations FOR EACH ROW EXECUTE FUNCTION fail_result()`);
    expect(
      (await createEventType({ ...f, headers: { ...f.headers, 'Idempotency-Key': key }, body }))
        .response!.status,
    ).toBe(503);
    expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({ state: 'unknown' });
    expect((await eventTypesListEventTypes({ baseUrl: f.baseUrl })).data).toEqual({ items: [] });
    await f.db.pool.query('DROP TRIGGER fail_result ON operations');
    expect(
      (await createEventType({ ...f, headers: { ...f.headers, 'Idempotency-Key': key }, body }))
        .response!.status,
    ).toBe(201);
    const otherKey = randomUUID();
    // A saved operation from another action shares the permanent Owner subject.
    await f.db.pool.query(
      'INSERT INTO operations (subject, key, action, parameters, status, body) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        'owner:1',
        otherKey,
        'saveAvailability',
        '{}',
        400,
        '{"code":"VALIDATION_FAILED","message":"Отказ"}',
      ],
    );
    expect(
      (
        await createEventType({
          ...f,
          headers: { ...f.headers, 'Idempotency-Key': otherKey },
          body,
        })
      ).error?.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await getOwnerOperation({ ...f, path: { key: otherKey } })).data).toMatchObject({
      state: 'completed',
      response: { status: 400 },
    });
  } finally {
    await f.close();
  }
});

test.each(['name', 'description'] as const)(
  'U+0000 в поле %s даёт сохранённую ошибку валидации',
  async (field) => {
    const f = await fixture();
    try {
      const key = randomUUID();
      const body = {
        name: 'Тип 😀',
        description: 'Первая строка\nВторая строка',
        durationMinutes: 30,
        [field]: 'До\u0000после',
      };
      const send = (operationKey: string, parameters = body) =>
        createEventType({
          ...f,
          headers: { ...f.headers, 'Idempotency-Key': operationKey },
          body: parameters,
        });
      const result = await send(key);
      expect(result.response!.status).toBe(400);
      expect(result.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        fieldErrors: [expect.objectContaining({ field, code: 'INVALID_VALUE' })],
      });
      expect((await getOwnerOperation({ ...f, path: { key } })).data).toEqual({
        state: 'completed',
        response: { status: 400, body: result.error },
      });
      expect((await send(key)).error).toEqual(result.error);
      expect((await eventTypesListEventTypes({ baseUrl: f.baseUrl })).data).toEqual({ items: [] });
      const corrected = {
        name: 'Тип 😀',
        description: 'Первая строка\nЛитеральное \\u0000',
        durationMinutes: 30,
      };
      expect((await send(key, corrected)).error?.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect((await send(randomUUID(), corrected)).data?.eventType).toMatchObject(corrected);
    } finally {
      await f.close();
    }
  },
);

test.each(['text', 'json'] as const)(
  'переход с %s на text сохраняет типы и результаты операций',
  async (storage) => {
    const db = await testDatabase();
    const directory = await mkdtemp(join(tmpdir(), 'calendar-event-upgrade-'));
    const key = randomUUID();
    const id = randomUUID();
    let app: ReturnType<typeof createApp> | undefined;
    try {
      const versions = ['001-access.sql', '002-event-types.sql'];
      if (storage === 'json') versions.push('003-operation-json.sql', '004-event-type-unicode.sql');
      for (const name of versions)
        await writeFile(
          join(directory, name),
          await readFile(new URL(`../migrations/${name}`, import.meta.url)),
        );
      await migrate(db.pool, pathToFileURL(`${directory}/`));
      const eventType = {
        id,
        name: 'Старый тип 😀',
        description: '\nОписание\\n',
        durationMinutes: 30,
      };
      await db.pool.query(
        'INSERT INTO event_types (id, name, description, duration_minutes) VALUES ($1, $2, $3, $4)',
        [
          id,
          storage === 'json' ? JSON.stringify(eventType.name) : eventType.name,
          storage === 'json' ? JSON.stringify(eventType.description) : eventType.description,
          30,
        ],
      );
      await db.pool.query(
        'INSERT INTO operations (subject, key, action, parameters, status, body) VALUES ($1, $2, $3, $4, $5, $6)',
        [
          'owner:1',
          key,
          'createEventType',
          JSON.stringify({
            durationMinutes: 30,
            description: eventType.description,
            name: eventType.name,
          }),
          201,
          JSON.stringify({ eventType }),
        ],
      );
      await db.migrate();
      const password = 'длинный пароль миграции'; // betterleaks:allow -- public test fixture
      await resetPassword(db.pool, password, password);
      app = createApp({ pool: db.pool, origin });
      const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      const login = await ownerSessionLoginOwner({
        baseUrl,
        body: { password },
        headers: { Origin: origin },
      });
      const headers = {
        Origin: origin,
        Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
        'Idempotency-Key': key,
      };
      expect(
        (
          await createEventType({
            baseUrl,
            headers,
            body: { name: eventType.name, description: eventType.description, durationMinutes: 30 },
          })
        ).data,
      ).toEqual({ eventType });
      expect((await eventTypesListEventTypes({ baseUrl })).data).toEqual({ items: [eventType] });
    } finally {
      await app?.close();
      await db.close();
      await rm(directory, { recursive: true });
    }
  },
);
