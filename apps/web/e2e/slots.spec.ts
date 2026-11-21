import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  createEventType,
  ownerAvailabilityGetAvailability,
  ownerAvailabilitySaveAvailability,
  ownerSessionLoginOwner,
} from '@calendar/api-client';

const baseUrl = 'http://127.0.0.1:3001';
async function setup(empty = false) {
  const origin = 'http://127.0.0.1:4174';
  const login = await ownerSessionLoginOwner({
    baseUrl,
    headers: { Origin: origin },
    body: { password: 'тестовый пароль Владельца' }, // betterleaks:allow -- public test fixture
  });
  const headers = {
    Origin: origin,
    Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
    'Idempotency-Key': randomUUID(),
  };
  const settings = (await ownerAvailabilityGetAvailability({ baseUrl, headers })).data!
    .availability;
  const saved = await ownerAvailabilitySaveAvailability({
    baseUrl,
    headers,
    body: {
      revision: settings.revision,
      timeZone: settings.timeZone ?? 'Europe/Berlin',
      days: Array.from({ length: 7 }, (_, i) => ({
        weekday: i + 1,
        intervals: empty ? [] : [{ startMinute: 0, endMinute: 1440 }],
      })),
    },
  });
  expect(saved.response!.status).toBe(200);
  const type = (
    await createEventType({
      baseUrl,
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: { name: 'Слоты ' + randomUUID(), durationMinutes: 30 },
    })
  ).data!.eventType;
  return type;
}

test('прямая ссылка: пояс Гостя, выбор дня, обновления и устаревшие данные при сбое', async ({
  browser,
}) => {
  const type = await setup();
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles' });
  const page = await context.newPage();
  try {
    await page.clock.install();
    await page.goto(`http://127.0.0.1:4174/booking/${type.id}`);
    await expect(page.getByText('Ваш часовой пояс: America/Los_Angeles')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Свободные Слоты' })).toBeVisible();
    await expect(
      page
        .getByRole('list', { name: 'Свободные Слоты' })
        .getByText(/24 октября 2026.*25 октября 2026/)
        .first(),
    ).toBeVisible();
    const refresh = page.waitForRequest(`**/api/event-types/${type.id}/availability`);
    await page.getByLabel('День записи').selectOption({ index: 1 });
    await refresh;
    await page.route(`**/api/event-types/${type.id}/availability`, (route) => route.abort());
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('alert')).toContainText('Данные устарели');
    await expect(page.getByRole('list', { name: 'Свободные Слоты' })).toBeVisible();
    await page.unroute(`**/api/event-types/${type.id}/availability`);
    await page.getByRole('button', { name: 'Повторить загрузку Слотов' }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    const minute = page.waitForRequest(`**/api/event-types/${type.id}/availability`);
    await page.clock.fastForward(60_000);
    await minute;
  } finally {
    await context.close();
  }
});

test('сбой первой загрузки отличается от настоящего отсутствия Слотов', async ({ page }) => {
  const type = await setup(true);
  await page.route(`**/api/event-types/${type.id}/availability`, (route) => route.abort());
  await page.goto(`/booking/${type.id}`);
  await expect(page.getByRole('alert')).toContainText('Не удалось загрузить Слоты');
  await expect(page.getByText(/Нет доступных Слотов/)).toHaveCount(0);
  await expect(page.getByText(/Данные устарели/)).toHaveCount(0);
  await page.unroute(`**/api/event-types/${type.id}/availability`);
  await page.getByRole('button', { name: 'Повторить загрузку Слотов' }).click();
  await expect(page.getByText('Нет доступных Слотов в окне записи.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('повторяющиеся часы Гостя различимы явным UTC-смещением', async ({ browser }) => {
  const type = await setup();
  const context = await browser.newContext({ timezoneId: 'Europe/Berlin' });
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:4174/booking/${type.id}`);
    await expect(page.getByRole('list', { name: 'Свободные Слоты' })).toBeVisible();
    await page.getByLabel('День записи').selectOption('2026-10-25');
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: /02:00 GMT\+02:00/ })
        .first(),
    ).toBeVisible();
    await expect(
      page
        .getByRole('listitem')
        .filter({ hasText: /02:00 GMT\+01:00/ })
        .first(),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
