import { expect, test } from 'vitest';
import {
  ownerSessionGetOwnerSession,
  ownerSessionLoginOwner,
  ownerSessionLogoutOwner,
} from '@calendar/api-client';
import { resetPassword } from '../src/access.js';
import { createApp } from '../src/app.js';
import { testDatabase } from './database.js';
import { createPool } from '../src/database.js';
import { setTimeout } from 'node:timers/promises';

test('до настройки пароля публичная часть работает, вход закрыт', async () => {
  const db = await testDatabase();
  await db.migrate();
  const app = createApp({ pool: db.pool, origin: 'http://localhost:5173' });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const status = await ownerSessionGetOwnerSession({ baseUrl });
    expect(status.data).toMatchObject({ configured: false, authenticated: false, expiresAt: null });
    const login = await ownerSessionLoginOwner({
      baseUrl,
      body: { password: 'пароль' }, // betterleaks:allow -- public test fixture
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(login.response!.status).toBe(403);
    expect(login.error).toMatchObject({ code: 'OWNER_NOT_CONFIGURED' });
  } finally {
    await app.close();
    await db.close();
  }
});

test.each(['login-first', 'reset-first'])('конкурентный сброс и вход: %s', async (order) => {
  const db = await testDatabase();
  await db.migrate();
  const password = 'первоначальный длинный пароль'; // betterleaks:allow -- public test fixture
  const replacement = 'новый длинный пароль';
  await resetPassword(db.pool, password, password);
  const origin = 'http://localhost:5173';
  const app = createApp({ pool: db.pool, origin });
  const blocker = await db.pool.connect();
  async function waitForLock(query: string) {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const waiting = await db.pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query = $1",
        [query],
      );
      if (waiting.rowCount) return;
      if (Date.now() >= deadline) throw new Error('Запрос не достиг блокировки');
      await setTimeout(1);
    }
  }
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM calendar WHERE id = 1 FOR UPDATE');
    const signIn = () =>
      ownerSessionLoginOwner({ baseUrl, body: { password }, headers: { Origin: origin } });
    let login: ReturnType<typeof signIn>;
    let reset: Promise<void>;
    if (order === 'login-first') {
      login = signIn();
      await waitForLock('SELECT password_hash FROM calendar WHERE id = 1 FOR UPDATE');
      reset = resetPassword(db.pool, replacement, replacement);
      await waitForLock('SELECT id FROM calendar WHERE id = 1 FOR UPDATE');
    } else {
      reset = resetPassword(db.pool, replacement, replacement);
      await waitForLock('SELECT id FROM calendar WHERE id = 1 FOR UPDATE');
      login = signIn();
      await waitForLock('SELECT password_hash FROM calendar WHERE id = 1 FOR UPDATE');
    }
    await blocker.query('COMMIT');
    const result = await login;
    await reset;
    expect(result.response!.status).toBe(order === 'login-first' ? 200 : 401);
    if (order === 'login-first') {
      const Cookie = result.response!.headers.get('set-cookie')!.split(';')[0]!;
      expect(
        (await ownerSessionGetOwnerSession({ baseUrl, headers: { Cookie } })).data?.authenticated,
      ).toBe(false);
    }
    expect(
      (
        await ownerSessionLoginOwner({
          baseUrl,
          body: { password: replacement },
          headers: { Origin: origin },
        })
      ).response!.status,
    ).toBe(200);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await app.close();
    await db.close();
  }
});

test('доверенный прокси разделяет лимиты по IP; окно скользит от самой ранней ошибки', async () => {
  const db = await testDatabase();
  await db.migrate();
  const password = 'длинный пароль для прокси'; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  let time = new Date('2026-01-01T12:00:00.000Z');
  const origin = 'http://localhost:5173';
  const app = createApp({ pool: db.pool, origin, trustProxy: ['127.0.0.1'], now: () => time });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = (ip: string, value: string) =>
      ownerSessionLoginOwner({
        baseUrl,
        body: { password: value },
        headers: { Origin: origin, 'X-Forwarded-For': ip },
      });
    for (let i = 0; i < 5; i++) {
      time = new Date(Date.UTC(2026, 0, 1, 12, i));
      expect((await login('203.0.113.1', 'неверный')).response!.status).toBe(401); // betterleaks:allow -- public test fixture
    }
    time = new Date('2026-01-01T12:05:00.000Z');
    expect((await login('203.0.113.1', password)).error?.retryAfterSeconds).toBe(600);
    expect((await login('203.0.113.2', password)).response!.status).toBe(200);
    time = new Date('2026-01-01T12:15:00.000Z');
    expect((await login('203.0.113.1', 'неверный')).response!.status).toBe(401); // betterleaks:allow -- public test fixture
    expect((await login('203.0.113.1', password)).error?.retryAfterSeconds).toBe(60);
  } finally {
    await app.close();
    await db.close();
  }
});

test('пять конкурентных ошибок ограничивают IP на скользящие 15 минут после перезапуска', async () => {
  const db = await testDatabase();
  await db.migrate();
  const password = 'длинный пароль для входа'; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  let now = new Date('2026-02-01T12:00:00.000Z');
  const origin = 'http://localhost:5173';
  let pool = createPool(db.url);
  let app = createApp({ pool, origin, now: () => now });
  let baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const login = (value: string, headers = {}) =>
    ownerSessionLoginOwner({
      baseUrl,
      body: { password: value },
      headers: { Origin: origin, ...headers },
    });
  try {
    const active = await login(password);
    const Cookie = active.response!.headers.get('set-cookie')!.split(';')[0]!;
    const errors = await Promise.all(Array.from({ length: 8 }, () => login('неверный')));
    expect(errors.filter((r) => r.response!.status === 401)).toHaveLength(5);
    expect(errors.filter((r) => r.response!.status === 429)).toHaveLength(3);
    await app.close();
    await pool.end();
    pool = createPool(db.url);
    app = createApp({ pool, origin, now: () => now });
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const limited = await login(password, { 'X-Forwarded-For': '203.0.113.10' });
    expect(limited.error).toMatchObject({ code: 'LOGIN_RATE_LIMITED', retryAfterSeconds: 900 });
    expect(limited.response!.headers.get('Retry-After')).toBe('900');
    expect(
      (await ownerSessionGetOwnerSession({ baseUrl, headers: { Cookie } })).data?.authenticated,
    ).toBe(true);
    now = new Date('2026-02-01T12:14:59.001Z');
    expect((await login(password)).error).toMatchObject({ retryAfterSeconds: 1 });
    now = new Date('2026-02-01T12:15:00.000Z');
    expect((await login(password)).response!.status).toBe(200);
  } finally {
    await app.close();
    await pool.end();
    await db.close();
  }
});

test('источник обязателен, GET ничего не устанавливает, защищённый API закрыт, HTTPS cookie безопасна', async () => {
  const db = await testDatabase();
  await db.migrate();
  const password = 'длинный пароль с кириллицей'; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  const origin = 'https://calendar.example';
  const app = createApp({ pool: db.pool, origin });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const Origin of [undefined, 'null', 'https://evil.example']) {
      const headers = Origin ? { Origin } : {};
      expect(
        (await ownerSessionLoginOwner({ baseUrl, body: { password }, headers })).error,
      ).toMatchObject({ code: 'ORIGIN_NOT_ALLOWED' });
      expect((await ownerSessionLogoutOwner({ baseUrl, headers })).response!.status).toBe(403);
    }
    const read = await ownerSessionGetOwnerSession({ baseUrl });
    expect(read.response!.headers.get('set-cookie')).toBeNull();
    expect(read.response!.headers.get('cache-control')).toBe('no-store');
    // The hook covers all future owner routes too.
    expect((await fetch(`${baseUrl}/api/owner/future`)).status).toBe(401);
    const login = await ownerSessionLoginOwner({
      baseUrl,
      body: { password },
      headers: { Origin: origin },
    });
    expect(login.response!.headers.get('set-cookie')).toMatch(/^__Host-owner_session=.*; Secure$/);
    const malformed = await ownerSessionLoginOwner({
      baseUrl,
      body: { password },
      headers: { Origin: origin },
      bodySerializer: () => JSON.stringify({ password, extra: true }),
    });
    expect(malformed.error).toMatchObject({ code: 'INVALID_REQUEST' });
    await db.pool.end();
    const unavailable = await ownerSessionLoginOwner({
      baseUrl,
      body: { password },
      headers: { Origin: origin },
    });
    expect(unavailable.response!.status).toBe(503);
    expect(unavailable.error).toMatchObject({ code: 'TEMPORARILY_UNAVAILABLE' });
  } finally {
    await app.close();
    await db.close();
  }
});

test('независимые сессии, выход, точная граница семи суток и сброс пароля', async () => {
  const db = await testDatabase();
  await db.migrate();
  const password = '  Кириллица 🔑 пароль  '; // betterleaks:allow -- public test fixture
  await resetPassword(db.pool, password, password);
  let now = new Date('2026-01-01T00:00:00.000Z');
  const origin = 'http://localhost:5173';
  const app = createApp({ pool: db.pool, origin, now: () => now });
  try {
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const login = () =>
      ownerSessionLoginOwner({ baseUrl, body: { password }, headers: { Origin: origin } });
    const first = await login();
    const second = await login();
    expect(first.data).toMatchObject({
      authenticated: true,
      expiresAt: '2026-01-08T00:00:00.000Z',
    });
    const cookie = first.response!.headers.get('set-cookie')!.split(';')[0]!;
    const other = second.response!.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).not.toBe(other);
    expect(first.response!.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
    const status = (Cookie: string) =>
      ownerSessionGetOwnerSession({ baseUrl, headers: { Cookie } });
    expect((await status(cookie)).data?.authenticated).toBe(true);
    for (let i = 0; i < 2; i++) {
      const logout = await ownerSessionLogoutOwner({
        baseUrl,
        headers: { Origin: origin, Cookie: cookie },
      });
      expect(logout.response!.status).toBe(204);
      expect(logout.response!.headers.get('set-cookie')).toContain('Max-Age=0');
    }
    expect((await status(cookie)).data?.authenticated).toBe(false);
    now = new Date('2026-01-07T23:59:59.999Z');
    expect((await status(other)).data?.authenticated).toBe(true);
    now = new Date('2026-01-08T00:00:00.000Z');
    expect((await status(other)).data?.authenticated).toBe(false);
    const fresh = await login();
    const freshCookie = fresh.response!.headers.get('set-cookie')!.split(';')[0]!;
    await expect(resetPassword(db.pool, 'короткий', 'короткий')).rejects.toThrow();
    await expect(resetPassword(db.pool, password, `${password}!`)).rejects.toThrow();
    expect((await status(freshCookie)).data?.authenticated).toBe(true);
    await resetPassword(db.pool, 'другой длинный пароль', 'другой длинный пароль');
    expect((await status(freshCookie)).data?.authenticated).toBe(false);
    expect((await login()).error).toMatchObject({ code: 'INVALID_PASSWORD' });
  } finally {
    await app.close();
    await db.close();
  }
});
