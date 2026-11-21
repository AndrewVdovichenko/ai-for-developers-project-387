import pg from 'pg';

export function createPool(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    lock_timeout: 3_000,
    options: '-c transaction_timeout=10000',
  });
  // Idle connection failures must not crash the process or expose secrets.
  pool.on('error', () => {});
  // A transaction timeout terminates the backend; checked-out clients emit too.
  pool.on('connect', (client) => client.on('error', () => {}));
  return pool;
}

export async function transaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}
