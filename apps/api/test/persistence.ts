// Apple Container integration check. Uses only its own random container and volume.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  ownerSessionGetOwnerSession,
  ownerSessionLoginOwner,
  ownerSessionLogoutOwner,
  getStatus,
  guestSessionPrepareGuest,
  guestSessionVerifyGuest,
  getSlotAvailability,
  selectHold,
  getHold,
  confirmHold,
  getBooking,
  getGuestOperation,
  createEventType,
  eventTypesListEventTypes,
  getOwnerOperation,
  ownerAvailabilityGetAvailability,
  ownerAvailabilitySaveAvailability,
} from '@calendar/api-client';
import { createPool } from '../src/database.js';
import { migrate } from '../src/migrations.js';
import { resetPassword } from '../src/access.js';

async function container(...args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('container', args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`container ${args[0]} failed`)),
    );
  });
}
async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}
const port = await freePort();
const name = `calendar-test-${randomUUID()}`;
const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
const origin = 'http://localhost:5173';
const password = 'пароль тестового календаря'; // betterleaks:allow -- public test fixture
let pool = createPool(url);
let api: ChildProcess | undefined;
async function startApi() {
  const apiPort = await freePort();
  const baseUrl = `http://127.0.0.1:${apiPort}`;
  api = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(new URL('../src/server.ts', import.meta.url))],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        DATABASE_URL: url,
        APP_ORIGIN: origin,
        HOST: '127.0.0.1',
        PORT: String(apiPort),
        TRUSTED_PROXIES: '127.0.0.1',
      },
    },
  );
  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await getStatus({ baseUrl });
    if (status.data) return baseUrl;
    if (api.exitCode !== null || Date.now() >= deadline) throw new Error('API not ready');
    await setTimeout(100);
  }
}
async function stopApi() {
  if (!api || api.exitCode !== null) return;
  const processToStop = api;
  await new Promise<void>((resolve, reject) => {
    processToStop.once('exit', () => resolve());
    processToStop.once('error', reject);
    processToStop.kill('SIGTERM');
  });
}
async function start() {
  await container(
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:5432`,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '-v',
    `${name}:/var/lib/postgresql`,
    'postgres:18.7@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc',
  );
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      if (Date.now() >= deadline) throw new Error('PostgreSQL not ready');
      await setTimeout(100);
    }
  }
}
async function recreate() {
  await stopApi();
  await pool.end();
  await container('stop', name);
  await container('delete', name);
  pool = createPool(url);
  await start();
  return startApi();
}
try {
  await container('volume', 'create', name);
  await start();
  await migrate(pool);
  await resetPassword(pool, password, password);
  let baseUrl = await startApi();
  let ip = '203.0.113.1';
  const login = (value: string) =>
    ownerSessionLoginOwner({
      baseUrl,
      body: { password: value },
      headers: { Origin: origin, 'X-Forwarded-For': ip },
    });
  const cookie = (response: Response | undefined) =>
    response!.headers.get('set-cookie')!.split(';')[0]!;
  const active = await login(password);
  const activeCookie = cookie(active.response);
  const revokedCookie = cookie((await login(password)).response);
  await ownerSessionLogoutOwner({ baseUrl, headers: { Origin: origin, Cookie: revokedCookie } });
  const typeKey = randomUUID();
  const refusalKey = randomUUID();
  const typeBody = { name: 'Сохранённый тип', durationMinutes: 30 };
  const typeHeaders = { Origin: origin, Cookie: activeCookie, 'Idempotency-Key': typeKey };
  const created = await createEventType({ baseUrl, headers: typeHeaders, body: typeBody });
  assert.equal(created.response!.status, 201);
  const refused = await createEventType({
    baseUrl,
    headers: { ...typeHeaders, 'Idempotency-Key': refusalKey },
    body: { name: '', durationMinutes: 30 },
  });
  assert.equal(refused.response!.status, 400);
  const scheduleKey = randomUUID();
  const scheduleBody = {
    revision: 0,
    timeZone: 'Europe/Berlin',
    days: Array.from({ length: 7 }, (_, index) => ({
      weekday: index + 1,
      intervals: index === 0 ? [{ startMinute: 540, endMinute: 1440 }] : [],
    })),
  };
  const scheduleHeaders = { ...typeHeaders, 'Idempotency-Key': scheduleKey };
  const schedule = await ownerAvailabilitySaveAvailability({
    baseUrl,
    headers: scheduleHeaders,
    body: scheduleBody,
  });
  assert.equal(schedule.response!.status, 200);
  const guestResponse = await guestSessionPrepareGuest({
    baseUrl,
    headers: { Origin: origin },
    body: {},
  });
  const guestCookie = cookie(guestResponse.response);
  const guestHeaders = { Origin: origin, Cookie: guestCookie };
  const slots = (await getSlotAvailability({ baseUrl, path: { id: created.data!.eventType.id } }))
    .data!;
  const startsAt = slots.slots[0]!.startsAt;
  const holdKey = randomUUID();
  const holdBody = { eventTypeId: created.data!.eventType.id, startsAt };
  const hold = (
    await selectHold({
      baseUrl,
      headers: { ...guestHeaders, 'Idempotency-Key': holdKey },
      body: holdBody,
    })
  ).data!;
  const guestRefusalKey = randomUUID();
  const badBody = { guestName: '', guestEmail: 'invalid' };
  const guestRefusal = await confirmHold({
    baseUrl,
    headers: { ...guestHeaders, 'Idempotency-Key': guestRefusalKey },
    path: { id: hold.hold.id },
    body: badBody,
  });
  assert.equal(guestRefusal.response!.status, 400);
  for (let i = 0; i < 5; i++) assert.equal((await login('неверный')).response!.status, 401);
  baseUrl = await recreate();
  assert.deepEqual(
    (await ownerAvailabilityGetAvailability({ baseUrl, headers: scheduleHeaders })).data!
      .availability,
    schedule.data!.availability,
  );
  assert.deepEqual(
    (
      await ownerAvailabilitySaveAvailability({
        baseUrl,
        headers: scheduleHeaders,
        body: scheduleBody,
      })
    ).data,
    schedule.data,
  );
  const status = (Cookie: string) => ownerSessionGetOwnerSession({ baseUrl, headers: { Cookie } });
  assert.equal((await status(activeCookie)).data?.expiresAt, active.data!.expiresAt);
  assert.equal((await status(revokedCookie)).data?.authenticated, false);
  assert.deepEqual((await eventTypesListEventTypes({ baseUrl })).data, {
    items: [created.data!.eventType],
  });
  assert.deepEqual(
    (await createEventType({ baseUrl, headers: typeHeaders, body: typeBody })).data,
    created.data,
  );
  assert.deepEqual(
    (await getOwnerOperation({ baseUrl, headers: typeHeaders, path: { key: refusalKey } })).data,
    { state: 'completed', response: { status: 400, body: refused.error } },
  );
  assert.equal(
    (await guestSessionVerifyGuest({ baseUrl, headers: guestHeaders })).data?.ready,
    true,
  );
  assert.deepEqual(
    (await getHold({ baseUrl, headers: guestHeaders, path: { id: hold.hold.id } })).data!.hold,
    hold.hold,
  );
  assert.deepEqual(
    (
      await selectHold({
        baseUrl,
        headers: { ...guestHeaders, 'Idempotency-Key': holdKey },
        body: holdBody,
      })
    ).data,
    hold,
  );
  assert.deepEqual(
    (await getGuestOperation({ baseUrl, headers: guestHeaders, path: { key: guestRefusalKey } }))
      .data,
    { state: 'completed', response: { status: 400, body: guestRefusal.error } },
  );
  assert.deepEqual(
    (
      await confirmHold({
        baseUrl,
        headers: { ...guestHeaders, 'Idempotency-Key': guestRefusalKey },
        path: { id: hold.hold.id },
        body: badBody,
      })
    ).error,
    guestRefusal.error,
  );
  const confirmationKey = randomUUID();
  const confirmationBody = { guestName: 'Сохранённый Гость', guestEmail: 'Guest@Example.com' };
  const confirmation = (
    await confirmHold({
      baseUrl,
      headers: { ...guestHeaders, 'Idempotency-Key': confirmationKey },
      path: { id: hold.hold.id },
      body: confirmationBody,
    })
  ).data!;
  assert(confirmation.booking.id);
  const limited = await login(password);
  assert.equal(limited.error?.code, 'LOGIN_RATE_LIMITED');
  assert(limited.error.retryAfterSeconds! > 0 && limited.error.retryAfterSeconds! <= 900);
  const replacement = 'новый пароль календаря';
  await resetPassword(pool, replacement, replacement);
  ip = '203.0.113.2';
  const replacementSession = await login(replacement);
  const replacementCookie = cookie(replacementSession.response);
  baseUrl = await recreate();
  const recovered = (
    await getGuestOperation({ baseUrl, headers: guestHeaders, path: { key: confirmationKey } })
  ).data;
  assert.deepEqual(recovered, {
    state: 'completed',
    response: { status: 200, body: confirmation },
  });
  assert.deepEqual(
    (
      await confirmHold({
        baseUrl,
        headers: { ...guestHeaders, 'Idempotency-Key': confirmationKey },
        path: { id: hold.hold.id },
        body: confirmationBody,
      })
    ).data,
    confirmation,
  );
  assert.deepEqual(
    (await getBooking({ baseUrl, headers: guestHeaders, path: { id: confirmation.booking.id } }))
      .data!.booking,
    confirmation.booking,
  );
  const confirmedHold = (
    await getHold({ baseUrl, headers: guestHeaders, path: { id: hold.hold.id } })
  ).data!.hold;
  assert.equal(confirmedHold.bookingId, confirmation.booking.id);
  assert.equal(confirmedHold.expiresAt, hold.hold.expiresAt);
  const foreign = await guestSessionPrepareGuest({
    baseUrl,
    headers: { Origin: origin },
    body: {},
  });
  const foreignHeaders = { Cookie: cookie(foreign.response) };
  assert.deepEqual(
    (await getGuestOperation({ baseUrl, headers: foreignHeaders, path: { key: confirmationKey } }))
      .data,
    { state: 'unknown' },
  );
  assert.deepEqual(
    (await getGuestOperation({ baseUrl, headers: foreignHeaders, path: { key: randomUUID() } }))
      .data,
    { state: 'unknown' },
  );
  assert.equal(
    (await getGuestOperation({ baseUrl, path: { key: confirmationKey } })).response!.status,
    401,
  );
  assert.equal(
    (await getBooking({ baseUrl, path: { id: confirmation.booking.id } })).response!.status,
    404,
  );
  assert.equal((await status(activeCookie)).data?.authenticated, false);
  assert.equal(
    (await status(replacementCookie)).data?.expiresAt,
    replacementSession.data!.expiresAt,
  );
  assert.equal((await login(password)).error?.code, 'INVALID_PASSWORD');
  assert.deepEqual(
    (
      await getOwnerOperation({
        baseUrl,
        headers: { Cookie: replacementCookie },
        path: { key: typeKey },
      })
    ).data,
    { state: 'completed', response: { status: 201, body: created.data } },
  );
  assert.deepEqual(
    (
      await createEventType({
        baseUrl,
        headers: { ...typeHeaders, Cookie: replacementCookie },
        body: typeBody,
      })
    ).data,
    created.data,
  );
  assert.equal((await eventTypesListEventTypes({ baseUrl })).data!.items.length, 1);
  assert.deepEqual(
    (
      await ownerAvailabilitySaveAvailability({
        baseUrl,
        headers: { ...scheduleHeaders, Cookie: replacementCookie },
        body: scheduleBody,
      })
    ).data,
    schedule.data,
  );
  console.log(
    'Пересоздание контейнера с тем же томом сохраняет пароль, сроки, отзыв, лимит входа, типы встреч, Гостя, Бронирование, Запись и результаты операций.',
  );
} finally {
  await stopApi();
  await pool.end();
  await container('stop', name).catch(() => {});
  await container('delete', name).catch(() => {});
  await container('volume', 'delete', name);
}
