import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';
import { transaction } from './database.js';

const directory = new URL('../migrations/', import.meta.url);
async function migrations(path = directory) {
  const names = (await readdir(path)).filter((name) => /^\d+[-\w]*\.sql$/.test(name)).sort();
  return Promise.all(
    names.map(async (version) => {
      const sql = await readFile(new URL(version, path), 'utf8');
      return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}
export async function migrate(pool: pg.Pool, path = directory) {
  const files = await migrations(path);
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(386, 15)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL)',
    );
    const applied = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    for (const row of applied.rows) {
      if (!files.some((file) => file.version === row.version && file.checksum === row.checksum))
        throw new Error('Несовместимые миграции');
    }
    for (const file of files) {
      if (applied.rows.some((row) => row.version === file.version)) continue;
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations VALUES ($1, $2)', [
        file.version,
        file.checksum,
      ]);
    }
  });
}
export async function checkSchema(pool: pg.Pool) {
  const files = await migrations();
  const result = await pool.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  if (
    result.rows.length !== files.length ||
    result.rows.some(
      (row, i) => row.version !== files[i]?.version || row.checksum !== files[i]?.checksum,
    )
  )
    throw new Error('Несовместимая схема БД');
  const calendar = await pool.query('SELECT id FROM calendar WHERE id = 1');
  if (calendar.rowCount !== 1) throw new Error('Календарь не создан');
}
