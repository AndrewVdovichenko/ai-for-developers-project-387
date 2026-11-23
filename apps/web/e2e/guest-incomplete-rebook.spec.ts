import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
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
    body: { password }, // betterleaks:allow -- public test fixture
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
  return (
    await createEventType({
      baseUrl,
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      body: { name: 'Незакрытое ' + randomUUID(), durationMinutes: 30 },
    })
  ).data!.eventType;
}

test('«Записаться ещё» при незакрытом подтверждении прекращает опрос прежней операции', async ({
  page,
}) => {
  const type = await setup();
  const confirmPosts: string[] = [];
  const operations: string[] = [];
  const failed: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/confirm'))
      confirmPosts.push(request.headers()['idempotency-key']!);
    if (request.url().includes('/api/operations/')) operations.push(request.url());
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/operations/')) failed.push(request.url());
  });
  // Ответ подтверждения первой Записи не доходит до сервера: Запись не создана, уточнять нечего.
  await page.route('**/api/holds/*/confirm', (route) => route.abort());
  // Первый же GET прежней операции зависает: вкладка ждёт уже не нужный ответ.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/operations/*', async (route) => {
    await gate;
    await route.abort().catch(() => {});
  });
  try {
    await page.clock.install();
    await page.goto(`/booking/${type.id}`);
    await page.getByLabel('День записи').selectOption('2026-11-07');
    await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
    await page.getByLabel('Имя', { exact: true }).fill('Первый Гость');
    await page.getByLabel('Email', { exact: true }).fill('first@example.com');
    await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    const firstKey = confirmPosts[0]!;
    await expect(page.getByRole('alert')).toContainText('Уточняем результат');
    await expect(page.getByLabel('Имя', { exact: true })).toBeDisabled();
    // Интервал восстановления: через 1 с вкладка спрашивает сервер о прежней операции.
    await page.clock.runFor(1000);
    await expect
      .poll(() => operations.filter((url) => url.includes(firstKey)).length, { timeout: 5000 })
      .toBe(1);
    // Явное намерение не ждёт разбирательства с прошлым: каталог открывается сразу.
    await page.getByRole('link', { name: 'Записаться ещё' }).press('Enter');
    await expect(page).toHaveURL(/\/event-types$/);
    await expect(page.getByRole('heading', { name: type.name, exact: true })).toBeVisible();
    // Полный сброс: зависший ответ прежней операции прерван, страница не ждёт его.
    await expect
      .poll(() => failed.filter((url) => url.includes(firstKey)).length, { timeout: 5000 })
      .toBe(1);
    // Ни одного нового запроса о прежней операции — цикл опроса отменён окончательно.
    await page.clock.runFor(300000);
    expect(operations.filter((url) => url.includes(firstKey))).toHaveLength(1);
  } finally {
    release();
  }
  await page.unroute('**/api/holds/*/confirm');
  await page.unroute('**/api/operations/*');
  // Новая запись идёт собственным маршрутом и со своим ключом до самого подтверждения.
  await page.goto(`/booking/${type.id}`);
  await page.getByRole('button', { name: 'Выбрать другой Слот' }).click();
  await page.getByLabel('День записи').selectOption('2026-11-07');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').nth(1).click();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('');
  await page.getByLabel('Имя', { exact: true }).fill('Второй Гость');
  await page.getByLabel('Email', { exact: true }).fill('second@example.com');
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  const secondId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByText(`Номер Записи: ${secondId}`)).toBeVisible();
  expect(confirmPosts).toHaveLength(2);
  expect(confirmPosts[1]).not.toBe(confirmPosts[0]);
  // Прежний ключ остался на единственном зависшем GET; новая запись его не касалась.
  expect(operations.filter((url) => url.includes(confirmPosts[0]!))).toHaveLength(1);
  expect(operations.some((url) => url.includes(confirmPosts[1]!))).toBe(false);
});
