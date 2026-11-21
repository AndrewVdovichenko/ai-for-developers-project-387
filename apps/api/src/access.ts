import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { transaction } from './database.js';

const week = 7 * 24 * 60 * 60 * 1000;
const windowMs = 15 * 60 * 1000;
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}
function digest(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

export async function resetPassword(pool: pg.Pool, password: string, confirmation: string) {
  if (password !== confirmation || [...password].length < 12)
    throw new Error('Пароли должны совпадать и содержать не менее 12 символов');
  const salt = randomBytes(32).toString('hex');
  const hash = `scrypt:${salt}:${(await derive(password, salt)).toString('hex')}`;
  await transaction(pool, async (client) => {
    const result = await client.query('SELECT id FROM calendar WHERE id = 1 FOR UPDATE');
    if (result.rowCount !== 1) throw new Error('Календарь не создан');
    await client.query('UPDATE calendar SET password_hash = $1 WHERE id = 1', [hash]);
    await client.query('DELETE FROM owner_sessions');
  });
}

export class AccessError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export async function login(pool: pg.Pool, password: string, ip: string, now: () => Date) {
  // The same row lock serializes login accounting and password reset.
  const result = await transaction(pool, async (client) => {
    const calendar = await client.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM calendar WHERE id = 1 FOR UPDATE',
    );
    const hash = calendar.rows[0]?.password_hash;
    if (!hash)
      return new AccessError(403, 'OWNER_NOT_CONFIGURED', 'Вход Владельца ещё не настроен');
    const time = now();
    const attempts = await client.query<{ attempted_at: Date }>(
      'SELECT attempted_at FROM login_attempts WHERE ip = $1 AND attempted_at > $2 ORDER BY attempted_at',
      [ip, new Date(time.getTime() - windowMs)],
    );
    if (attempts.rows.length >= 5) {
      const retry = Math.ceil(
        (attempts.rows[attempts.rows.length - 5]!.attempted_at.getTime() +
          windowMs -
          time.getTime()) /
          1000,
      );
      return new AccessError(
        429,
        'LOGIN_RATE_LIMITED',
        'Слишком много попыток входа. Подождите и повторите.',
        retry,
      );
    }
    const [algorithm, salt, expected] = hash.split(':');
    if (algorithm !== 'scrypt' || !salt || !expected) throw new Error('Некорректный хеш');
    const key = await derive(password, salt);
    const stored = Buffer.from(expected, 'hex');
    if (key.length !== stored.length || !timingSafeEqual(key, stored)) {
      await client.query('INSERT INTO login_attempts (ip, attempted_at) VALUES ($1, $2)', [
        ip,
        now(),
      ]);
      return new AccessError(401, 'INVALID_PASSWORD', 'Неверный пароль');
    }
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + week);
    const secret = randomBytes(32).toString('base64url');
    await client.query('INSERT INTO owner_sessions VALUES ($1, $2, $3)', [
      digest(secret),
      createdAt,
      expiresAt,
    ]);
    return {
      secret,
      expiresAt: expiresAt.toISOString(),
      serverNow: createdAt.toISOString(),
      authenticated: true,
    };
  });
  // Throw after COMMIT so a failed password still records the attempt.
  if (result instanceof AccessError) throw result;
  return result;
}

export async function session(pool: pg.Pool, secret: string | undefined, now: () => Date) {
  const result = await pool.query<{ configured: boolean; expires_at: Date | null }>(
    `SELECT password_hash IS NOT NULL AS configured,
      (SELECT expires_at FROM owner_sessions WHERE secret_hash = $1) AS expires_at
     FROM calendar WHERE id = 1`,
    [digest(secret ?? '')],
  );
  const time = now();
  const row = result.rows[0];
  if (!row) throw new Error('Календарь не создан');
  const authenticated = !!row.expires_at && row.expires_at > time;
  return {
    configured: row.configured,
    authenticated,
    expiresAt: authenticated ? row.expires_at!.toISOString() : null,
    serverNow: time.toISOString(),
  };
}
export async function logout(pool: pg.Pool, secret: string | undefined) {
  await pool.query('DELETE FROM owner_sessions WHERE secret_hash = $1', [digest(secret ?? '')]);
}
