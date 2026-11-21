import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AccessError } from './access.js';
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
export function guestSecret(header: string | undefined, secure: boolean) {
  const name = secure ? '__Host-guest_session' : 'guest_session';
  return header
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export async function guest(pool: pg.Pool, secret: string | undefined, now: Date) {
  if (!secret) return undefined;
  return (
    await pool.query<{ id: string }>(
      'SELECT id FROM guests WHERE secret_hash=$1 AND expires_at>$2',
      [digest(secret), now],
    )
  ).rows[0]?.id;
}
export function requireGuest(id: string | undefined) {
  if (!id)
    throw new AccessError(401, 'GUEST_SESSION_REQUIRED', 'Разрешите cookie для сохранения выбора');
  return id;
}
export async function prepareGuest(pool: pg.Pool, secret: string | undefined, now: Date) {
  if (await guest(pool, secret, now)) return undefined;
  const value = randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO guests VALUES ($1,$2,$3)', [
    randomUUID(),
    digest(value),
    new Date(now.getTime() + 365 * 86400000),
  ]);
  return value;
}
