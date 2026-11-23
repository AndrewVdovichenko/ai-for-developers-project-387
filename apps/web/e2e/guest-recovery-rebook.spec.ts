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
  const create = async (durationMinutes: number) =>
    (
      await createEventType({
        baseUrl,
        headers: { ...headers, 'Idempotency-Key': randomUUID() },
        body: { name: 'Восстановление ' + randomUUID(), durationMinutes },
      })
    ).data!.eventType;
  return { first: await create(30), second: await create(60) };
}

// Каталог Типов встречи: карточка нужного Типа по заголовку, вход на страницу записи по ссылке.
function typeCard(page: Page, name: string) {
  return page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

test('восстановление первой Записи, «Записаться ещё» и вторая Запись до конца', async ({
  page,
  browser,
}) => {
  const { first, second } = await setup();
  const confirmPosts: { key: string; body: string | null; url: string }[] = [];
  const operations: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/confirm'))
      confirmPosts.push({
        key: request.headers()['idempotency-key']!,
        body: request.postData(),
        url: request.url(),
      });
    if (request.url().includes('/api/operations/')) operations.push(request.url());
  });
  // Виртуальные часы замораживают интервал восстановления: единственная попытка резолвить
  // операцию с неизвестным исходом случается после перезагрузки, а не в фоновом опросе.
  await page.clock.install();
  // Первая Запись: ответ подтверждения потерян, Запись не создана, уточнять нечего серверу.
  await page.route('**/api/holds/*/confirm', (route) => route.abort());
  await page.goto(`/booking/${first.id}`);
  await page.getByLabel('День записи').selectOption('2026-11-07');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await page.getByLabel('Имя', { exact: true }).fill('Первый Гость');
  await page.getByLabel('Email', { exact: true }).fill('first@example.com');
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Уточняем результат');
  expect(confirmPosts).toHaveLength(1);
  const lostKey = confirmPosts[0]!.key,
    lostBody = confirmPosts[0]!.body;
  // Перезагрузка резолвит операцию через GET и повторную отправку с прежним ключом.
  await page.unroute('**/api/holds/*/confirm');
  const replayed = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/confirm'),
    { timeout: 30000 },
  );
  await page.reload();
  await expect
    .poll(() => operations.filter((url) => url.includes(lostKey)).length, { timeout: 30000 })
    .toBe(1);
  const replay = await replayed;
  expect(replay.headers()['idempotency-key']).toBe(lostKey);
  expect(replay.postData()).toBe(lostBody);
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  const firstId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByText(`Номер Записи: ${firstId}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible();
  expect(confirmPosts).toHaveLength(2);
  // Явное намерение: полный сброс, каталог открывается сразу.
  await page.getByRole('link', { name: 'Записаться ещё' }).click();
  await expect(page).toHaveURL(/\/event-types$/);
  // Другой Тип встречи, другой Слот, чистая форма: прежний контекст не унаследован.
  await typeCard(page, second.name).getByRole('link', { name: 'Открыть страницу записи' }).click();
  await expect(page).toHaveURL(new RegExp(`/booking/${second.id}$`));
  await page.getByLabel('День записи').selectOption('2026-11-06');
  const slotLabel = await page
    .getByRole('list', { name: 'Свободные Слоты' })
    .getByRole('button')
    .first()
    .textContent();
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await page.getByLabel('Имя', { exact: true }).fill('Второй Гость');
  await page.getByLabel('Email', { exact: true }).fill('second@example.com');
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  // Страница подтверждения показывает только новую Запись: номер, Тип встречи, время.
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/bookings/(?!${firstId})[0-9a-f-]{36}$`));
  const secondId = new URL(page.url()).pathname.split('/').pop()!;
  await expect(page.getByText(`Номер Записи: ${secondId}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const [startsTime = '', endsTime = ''] = slotLabel!.split('—').map((part) => part.trim());
  await expect(
    page.getByText(new RegExp(`6 ноября.*${escape(startsTime)}.*—.*${escape(endsTime)}`)),
  ).toBeVisible();
  await expect(page.getByText('second@example.com', { exact: true })).toBeVisible();
  await expect(page.getByText(firstId)).toHaveCount(0);
  await expect(page.getByText('first@example.com', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: first.name })).toHaveCount(0);
  // Вторая Запись отправлена собственным маршрутом и со своим ключом.
  expect(confirmPosts).toHaveLength(3);
  expect(confirmPosts[2]!.key).not.toBe(lostKey);
  expect(confirmPosts[2]!.url).not.toBe(confirmPosts[1]!.url);
  // Прежняя операция больше не опрашивается: контекст в хранилище принадлежит актуальной записи.
  // Пять минут виртуального времени дали бы ход любому фоновому циклу восстановления.
  await page.clock.runFor(300000);
  expect(operations.filter((url) => url.includes(lostKey))).toHaveLength(1);
  // Перезагрузка страницы подтверждения открывает новую Запись, а не первую.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/bookings/${secondId}$`));
  await expect(page.getByText(`Номер Записи: ${secondId}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
  await expect(page.getByText(`Номер Записи: ${firstId}`)).toHaveCount(0);
  expect(operations.filter((url) => url.includes(lostKey))).toHaveLength(1);
  // Первая Запись остаётся доступной по своему номеру.
  await page.goto(`/bookings/${firstId}`);
  await expect(page.getByText(`Номер Записи: ${firstId}`)).toBeVisible();
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible();
  // Владелец видит обе Записи гостя.
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
