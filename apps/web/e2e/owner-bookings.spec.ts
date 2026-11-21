import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { createEventType, ownerSessionLoginOwner } from '@calendar/api-client';
const password = 'тестовый пароль Владельца'; // betterleaks:allow -- public test fixture
test.use({ timezoneId: 'Asia/Tokyo' });
const baseUrl = 'http://127.0.0.1:3001',
  origin = 'http://127.0.0.1:4174';

async function setClock(request: APIRequestContext, instant: string) {
  expect(
    (
      await request.post(`${baseUrl}/__test/clock`, {
        headers: { Origin: origin },
        data: { instant },
      })
    ).status(),
  ).toBe(200);
}
async function owner(page: import('@playwright/test').Page) {
  await page.goto('/owner/login?returnTo=%2Fowner%2Fbookings');
  await page.getByRole('textbox', { name: 'Пароль' }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL(/\/owner\/bookings$/);
}
async function emptyType() {
  const login = await ownerSessionLoginOwner({
    baseUrl,
    headers: { Origin: origin },
    body: { password: password },
  }); // betterleaks:allow -- public test fixture
  return (
    await createEventType({
      baseUrl,
      headers: {
        Origin: origin,
        Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
        'Idempotency-Key': randomUUID(),
      },
      body: { name: 'Пустой ' + randomUUID(), durationMinutes: 20 },
    })
  ).data!.eventType;
}

test('Владелец восстанавливает несколько фильтров из закладки и сбрасывает их', async ({
  page,
}) => {
  const a = await emptyType(),
    b = await emptyType();
  await owner(page);
  await page.goto(
    `/owner/bookings?eventTypeId=${a.id.toUpperCase()}&eventTypeId=${b.id}&eventTypeId=${a.id}`,
  );
  await expect(
    page.getByText('Нет предстоящих встреч выбранных типов', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: a.name })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: b.name })).toBeChecked();
  expect(new URL(page.url()).searchParams.getAll('eventTypeId')).toEqual([a.id, b.id]);
  await page.getByRole('checkbox', { name: a.name }).click();
  await expect.poll(() => new URL(page.url()).searchParams.getAll('eventTypeId')).toEqual([b.id]);
  await page.getByRole('checkbox', { name: a.name }).click();
  await expect(page.getByRole('checkbox', { name: a.name })).toBeChecked();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: a.name })).toBeChecked();
  await page.getByRole('button', { name: 'Сбросить фильтр' }).click();
  await expect(page).toHaveURL(/\/owner\/bookings$/);
  await page.goto(`/owner/bookings?eventTypeId=${a.id},${b.id}`);
  await expect(page.getByRole('alert')).toContainText('Сбросьте фильтр');
  await page.goto('/owner/bookings?eventTypeId=invalid');
  await expect(page.getByRole('alert')).toContainText('Сбросьте фильтр');
  await page.getByRole('button', { name: 'Сбросить фильтр' }).click();
  await expect(page).toHaveURL(/\/owner\/bookings$/);
});

test('Владелец различает пустой календарь и пустой фильтр', async ({ page, request }) => {
  await setClock(request, '2030-01-01T00:00:00.000Z');
  try {
    await owner(page);
    await expect(page.getByText('Предстоящих встреч пока нет', { exact: true })).toBeVisible();
    const type = await emptyType();
    await page.goto(`/owner/bookings?eventTypeId=${type.id}`);
    await expect(
      page.getByText('Нет предстоящих встреч выбранных типов', { exact: true }),
    ).toBeVisible();
  } finally {
    await setClock(request, '2026-10-24T22:00:00.000Z');
  }
});

test('Обновления сохраняют фильтр и старый список при сбоях; 401 сохраняет внутренний возврат', async ({
  page,
  request,
}) => {
  try {
    const type = await emptyType();
    const sdk = await import('@calendar/api-client');
    const login = await ownerSessionLoginOwner({
      baseUrl,
      headers: { Origin: origin },
      body: { password: password },
    }); // betterleaks:allow -- public test fixture
    const ownerHeaders = {
      Origin: origin,
      Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
      'Idempotency-Key': randomUUID(),
    };
    const settings = (
      await sdk.ownerAvailabilityGetAvailability({ baseUrl, headers: ownerHeaders })
    ).data!.availability;
    await sdk.ownerAvailabilitySaveAvailability({
      baseUrl,
      headers: ownerHeaders,
      body: {
        revision: settings.revision,
        timeZone: settings.timeZone ?? 'UTC',
        days: Array.from({ length: 7 }, (_, i) => ({
          weekday: i + 1,
          intervals: [{ startMinute: 0, endMinute: 1440 }],
        })),
      },
    });
    const guest = await sdk.guestSessionPrepareGuest({
      baseUrl,
      headers: { Origin: origin },
      body: {},
    });
    const headers = {
      Origin: origin,
      Cookie: guest.response!.headers.get('set-cookie')!.split(';')[0]!,
    };
    const available = (await sdk.getSlotAvailability({ baseUrl, path: { id: type.id } })).data!
      .slots;
    const slot = available.find((slot) => slot.startsAt === '2026-10-28T14:45:00.000Z')!;
    expect(slot).toBeDefined();
    const hold = (
      await sdk.selectHold({
        baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { eventTypeId: type.id, startsAt: slot.startsAt },
      })
    ).data!.hold;
    await page.clock.install();
    await owner(page);
    const destination = `/owner/bookings?eventTypeId=${type.id}`;
    await page.goto(destination);
    await expect(
      page.getByText('Нет предстоящих встреч выбранных типов', { exact: true }),
    ).toBeVisible();
    const booking = (
      await sdk.confirmHold({
        baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        path: { id: hold.id },
        body: { guestName: 'Гость списка', guestEmail: 'owner-list@example.com' },
      })
    ).data!.booking;
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(page.getByText('owner-list@example.com', { exact: true })).toBeVisible();
    await expect(page.getByText('Ваш часовой пояс: Asia/Tokyo')).toBeVisible();
    await expect(
      page.getByText(/28 октября 2026.*GMT\+09:00.*29 октября 2026.*GMT\+09:00/),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Подробности Записи' }).click();
    await expect(page).toHaveURL(new RegExp(`/bookings/${booking.id}$`));
    await expect(page.getByText('owner-list@example.com', { exact: true })).toBeVisible();
    await page.goto(destination);
    await expect(page.getByText('owner-list@example.com', { exact: true })).toBeVisible();
    let reads = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/owner/bookings') {
        reads++;
        expect(new URL(r.url()).searchParams.getAll('eventTypeId')).toEqual([type.id]);
      }
    });
    for (const event of ['focus', 'online', 'visibilitychange', 'minute', 'manual']) {
      const before = reads;
      if (event === 'minute') await page.clock.runFor(60000);
      else if (event === 'manual')
        await page.getByRole('button', { name: 'Обновить', exact: true }).click();
      else
        await page.evaluate((event) => {
          (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
        }, event);
      await expect.poll(() => reads).toBeGreaterThan(before);
      await expect(page.getByRole('button', { name: 'Обновить', exact: true })).toBeEnabled();
    }
    await page.evaluate(() =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }),
    );
    const hiddenReads = reads;
    await page.clock.runFor(60000);
    expect(reads).toBe(hiddenReads);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => reads).toBeGreaterThan(hiddenReads);
    await setClock(request, booking.startsAt);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(page.getByText('Идёт сейчас', { exact: true })).toBeVisible();
    await setClock(request, booking.endsAt);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(
      page.getByText('Нет предстоящих встреч выбранных типов', { exact: true }),
    ).toBeVisible();
    await setClock(request, '2026-10-24T22:00:00.000Z');
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(page.getByText('owner-list@example.com', { exact: true })).toBeVisible();
    for (const network of [true, false]) {
      await page.route('**/api/owner/bookings?*', async (route) => {
        if (network) await route.abort();
        else
          await route.fulfill({
            status: 503,
            json: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Сбой' },
          });
      });
      await page.getByRole('button', { name: 'Обновить', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Данные могут быть неактуальны');
      await expect(page.getByText('owner-list@example.com', { exact: true })).toBeVisible();
      await expect(page).toHaveURL(new RegExp('eventTypeId=' + type.id));
      await page.unroute('**/api/owner/bookings?*');
    }
    await page.route('**/api/owner/bookings?*', (route) =>
      route.fulfill({ status: 401, json: { code: 'OWNER_AUTH_REQUIRED', message: 'Войдите' } }),
    );
    await page.route('**/api/owner/session', (route) =>
      route.fulfill({
        json: {
          authenticated: false,
          configured: true,
          expiresAt: null,
          serverNow: '2026-10-24T22:00:00.000Z',
        },
      }),
    );
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(page).toHaveURL(new RegExp('/owner/login\\?returnTo='));
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe(destination);
  } finally {
    await setClock(request, '2026-10-24T22:00:00.000Z');
  }
});
