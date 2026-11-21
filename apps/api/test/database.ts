import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migrations.js';

export async function testDatabase() {
  const connectionString =
    process.env.TEST_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/postgres';
  const admin = new pg.Client({ connectionString });
  await admin.connect();
  const name = `calendar_test_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  const pool = createPool(url.href);
  return {
    pool,
    url: url.href,
    migrate: () => migrate(pool),
    async close() {
      if (!pool.ended) await pool.end();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
