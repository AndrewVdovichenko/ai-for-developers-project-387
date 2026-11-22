import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  createEventType,
  ownerAvailabilityGetAvailability,
  ownerAvailabilitySaveAvailability,
  ownerSessionLoginOwner,
} from '@calendar/api-client';
const baseUrl = 'http://127.0.0.1:3001',
  origin = 'http://127.0.0.1:4174',
  password = 'тестовый пароль Владельца'; // betterleaks:allow -- public test fixture

// Спек заводит Типы встречи в общей базе e2e, поэтому имя держит его после event-types.spec.ts
// в алфавитном порядке: тот проверяет пустой каталог на чистой базе.
async function setup() {
  const login = await ownerSessionLoginOwner({
    baseUrl,
    headers: { Origin: origin },
    body: { password: password }, // betterleaks:allow -- public test fixture
  });
  const headers = {
    Origin: origin,
    Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]!,
    'Idempotency-Key': randomUUID(),
  };
  const settings = (await ownerAvailabilityGetAvailability({ baseUrl, headers })).data!
    .availability;
  expect(
    (
      await ownerAvailabilitySaveAvailability({
        baseUrl,
        headers,
        body: {
          revision: settings.revision,
          timeZone: settings.timeZone ?? 'Europe/Berlin',
          days: Array.from({ length: 7 }, (_, i) => ({
            weekday: i + 1,
            intervals: [{ startMinute: 0, endMinute: 1440 }],
          })),
        },
      })
    ).response!.status,
  ).toBe(200);
  const create = async (durationMinutes: number) =>
    (
      await createEventType({
        baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { name: 'Повтор ' + randomUUID(), durationMinutes },
      })
    ).data!.eventType;
  return { first: await create(30), second: await create(60) };
}

// Каталог Типов встречи: карточка нужного Типа по заголовку, вход на страницу записи по ссылке.
function typeCard(page: Page, name: string) {
  return page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

test('«Записаться ещё» начинает новую запись: прежний контекст подтверждения перебит', async ({
  page,
  browser,
}) => {
  const { first, second } = await setup();
  const keys: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/confirm'))
      keys.push(request.headers()['idempotency-key']!);
  });
  // Первая Запись: подтверждение доходит до страницы Записи.
  await page.goto(`/booking/${first.id}`);
  await page.getByLabel('День записи').selectOption('2026-11-04');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await page.getByLabel('Имя', { exact: true }).fill('Первый Гость');
  await page.getByLabel('Email', { exact: true }).fill('first@example.com');
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  const firstId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByText(`Номер Записи: ${firstId}`)).toBeVisible();
  // Явное намерение записи: кнопка ведёт в каталог, а не на страницу прежней Записи.
  await page.getByRole('link', { name: 'Записаться ещё' }).click();
  await expect(page).toHaveURL(/\/event-types$/);
  await expect(page.getByRole('heading', { name: 'Типы встречи' })).toBeVisible();
  // Навигация внутри вкладки без перезагрузки: контроллер подтверждения живёт между страницами.
  await typeCard(page, second.name).getByRole('link', { name: 'Открыть страницу записи' }).click();
  await expect(page).toHaveURL(new RegExp(`/booking/${second.id}$`));
  await expect(page.getByRole('heading', { name: 'Страница записи' })).toBeVisible();
  // Другой Слот и чистая форма: имя и email завершённой Записи не подставлены.
  await page.getByLabel('День записи').selectOption('2026-11-05');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await page.getByLabel('Имя', { exact: true }).fill('Второй Гость');
  await page.getByLabel('Email', { exact: true }).fill('second@example.com');
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  // Страница подтверждения показывает новую Запись, а прежняя остаётся доступной по своему номеру.
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/bookings/(?!${firstId})[0-9a-f-]{36}$`));
  const secondId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByText(`Номер Записи: ${secondId}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
  await expect(page.getByText('Второй Гость', { exact: true })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  await page.goto(`/bookings/${firstId}`);
  await expect(page.getByText(`Номер Записи: ${firstId}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible();
  // Владелец видит обе Записи.
  const ownerTab = await browser.newContext();
  try {
    const owner = await ownerTab.newPage();
    await owner.goto('/owner/login?returnTo=%2Fowner%2Fbookings');
    await owner.getByRole('textbox', { name: 'Пароль' }).fill(password);
    await owner.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(owner).toHaveURL(/\/owner\/bookings$/);
    await owner.goto(`/owner/bookings?eventTypeId=${first.id}&eventTypeId=${second.id}`);
    await expect(owner.getByText('first@example.com', { exact: true })).toBeVisible();
    await expect(owner.getByText('second@example.com', { exact: true })).toBeVisible();
  } finally {
    await ownerTab.close();
  }
});
