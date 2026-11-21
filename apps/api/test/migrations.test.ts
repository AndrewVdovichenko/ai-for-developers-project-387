import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrations.js';
import { createPool, transaction } from '../src/database.js';
import { testDatabase } from './database.js';

test('миграции атомарны, повторяемы, проверяют checksum; API не мигрирует', async () => {
  const db = await testDatabase();
  const dir = await mkdtemp(join(tmpdir(), 'calendar-migrations-'));
  const path = pathToFileURL(`${dir}/`);
  try {
    const app = createApp({ pool: db.pool, origin: 'http://localhost' });
    await expect(app.ready()).rejects.toThrow();
    await app.close();
    await writeFile(
      join(dir, '001-access.sql'),
      await readFile(new URL('../migrations/001-access.sql', import.meta.url)),
    );
    await writeFile(
      join(dir, '002-broken.sql'),
      'CREATE TABLE partial (id int); SELECT invalid_column;',
    );
    await expect(migrate(db.pool, path)).rejects.toThrow();
    expect(
      (
        await db.pool.query(
          "SELECT to_regclass('partial') AS partial, to_regclass('calendar') AS calendar",
        )
      ).rows[0],
    ).toEqual({ partial: null, calendar: null });
    await db.migrate();
    await Promise.all([db.migrate(), db.migrate()]);
    expect(
      (await db.pool.query('SELECT id, password_hash, time_zone, revision FROM calendar')).rows,
    ).toEqual([{ id: 1, password_hash: null, time_zone: null, revision: 0 }]);
    await db.pool.query("UPDATE schema_migrations SET checksum = 'changed'");
    await expect(db.migrate()).rejects.toThrow('Несовместимые миграции');
    const incompatible = createApp({ pool: db.pool, origin: 'http://localhost' });
    await expect(incompatible.ready()).rejects.toThrow('Несовместимая схема');
    await incompatible.close();
    const badPool = createPool('postgresql://postgres@127.0.0.1:1/missing');
    const unavailable = createApp({ pool: badPool, origin: 'http://localhost' });
    await expect(unavailable.ready()).rejects.toThrow();
    await unavailable.close();
    await badPool.end();
  } finally {
    await db.close();
    await rm(dir, { recursive: true });
  }
});

test('SQL, блокировки, вся транзакция и пул имеют независимые пределы ожидания', async () => {
  const db = await testDatabase();
  await db.migrate();
  try {
    await expect(db.pool.query('SELECT pg_sleep(6)')).rejects.toThrow(/statement timeout/);
    const blocker = await db.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM calendar FOR UPDATE');
      await expect(
        transaction(db.pool, async (client) => {
          await client.query('SELECT id FROM calendar FOR UPDATE');
        }),
      ).rejects.toThrow(/lock timeout/);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await expect(
      transaction(db.pool, async (client) => {
        await client.query('UPDATE calendar SET revision = 5');
        for (let i = 0; i < 3; i++) await client.query('SELECT pg_sleep(3.6)');
      }),
    ).rejects.toThrow();
    expect((await db.pool.query('SELECT revision FROM calendar')).rows[0].revision).toBe(0);
    const clients = await Promise.all(Array.from({ length: 10 }, () => db.pool.connect()));
    try {
      await expect(db.pool.connect()).rejects.toThrow(/timeout/);
    } finally {
      for (const client of clients) client.release();
    }
    expect((await db.pool.query('SELECT 1 AS value')).rows[0].value).toBe(1);
  } finally {
    await db.close();
  }
}, 25_000);

test('переход на text откатывается без потери старых строк с U+0000', async () => {
  const db = await testDatabase();
  const dir = await mkdtemp(join(tmpdir(), 'calendar-text-migration-'));
  try {
    for (const name of [
      '001-access.sql',
      '002-event-types.sql',
      '003-operation-json.sql',
      '004-event-type-unicode.sql',
    ])
      await writeFile(
        join(dir, name),
        await readFile(new URL(`../migrations/${name}`, import.meta.url)),
      );
    await migrate(db.pool, pathToFileURL(`${dir}/`));
    await db.pool.query(
      'INSERT INTO event_types (id, name, description, duration_minutes) VALUES ($1, $2, $3, $4)',
      [
        '11111111-1111-4111-8111-111111111111',
        JSON.stringify('Тип\u0000😀'),
        JSON.stringify('Описание\n'),
        30,
      ],
    );
    await expect(db.migrate()).rejects.toThrow(/Unicode/);
    expect(
      (
        await db.pool.query(
          'SELECT name, description, pg_typeof(name)::text AS storage FROM event_types',
        )
      ).rows,
    ).toEqual([{ name: 'Тип\u0000😀', description: 'Описание\n', storage: 'json' }]);
    expect(
      (
        await db.pool.query(
          "SELECT version FROM schema_migrations WHERE version = '005-event-type-text.sql'",
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true });
  }
});
