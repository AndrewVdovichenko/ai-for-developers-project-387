import { randomUUID } from 'node:crypto';
import {
  ownerAvailabilityGetAvailability,
  ownerAvailabilitySaveAvailability,
} from '@calendar/api-client';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
const password = 'тестовый пароль Владельца'; // betterleaks:allow -- public test fixture
async function login(page: Page, seed = true) {
  await page.goto('/owner/availability');
  await page.getByRole('textbox', { name: 'Пароль', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByLabel('Часовой пояс календаря', { exact: true })).toBeVisible();
  if (seed) {
    const baseUrl = 'http://127.0.0.1:4174';
    const cookies = await page.context().cookies();
    const headers = {
      Origin: baseUrl,
      Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      'Idempotency-Key': randomUUID(),
    };
    const settings = (await ownerAvailabilityGetAvailability({ baseUrl, headers })).data!
      .availability;
    const result = await ownerAvailabilitySaveAvailability({
      baseUrl,
      headers,
      body: {
        revision: settings.revision,
        timeZone: settings.timeZone ?? 'Europe/Berlin',
        days: Array.from({ length: 7 }, (_, i) => ({
          weekday: i + 1,
          intervals: i < 2 ? [{ startMinute: i === 0 ? 540 : 600, endMinute: 1440 }] : [],
        })),
      },
    });
    expect(result.response!.status).toBe(200);
    await page.reload();
    await expect(page.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('09:00');
  }
}

test('недельный редактор: массовая замена, независимые дни, 24:00 и выходные', async ({ page }) => {
  await login(page, false);
  await page.getByLabel('Часовой пояс календаря', { exact: true }).fill('Europe/Berlin');
  await page.getByRole('button', { name: 'Понедельник: добавить интервал', exact: true }).click();
  await page.getByLabel('Понедельник: конец 1', { exact: true }).fill('24:00');
  await page.getByLabel('Применить к: Вторник', { exact: true }).check();
  await page
    .getByRole('button', { name: 'Понедельник: применить к выбранным дням', exact: true })
    .click();
  await page.getByLabel('Вторник: начало 1', { exact: true }).fill('10:00');
  await expect(page.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('09:00');
  await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Расписание сохранено');
  await page.reload();
  await expect(page.getByLabel('Вторник: начало 1', { exact: true })).toHaveValue('10:00');
  await expect(page.getByLabel('Понедельник: конец 1', { exact: true })).toHaveValue('24:00');
  await expect(page.getByLabel('Часовой пояс календаря', { exact: true })).toBeDisabled();
  await expect(page.getByText('Среда: выходной', { exact: true })).toBeVisible();
});

test('конфликт вкладок сохраняет черновик и требует явного согласования', async ({
  page,
  context,
}) => {
  await login(page);
  const other = await context.newPage();
  await other.goto('/owner/availability');
  await expect(other.getByLabel('Понедельник: начало 1', { exact: true })).toBeVisible();
  await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('08:00');
  await other.getByLabel('Понедельник: начало 1', { exact: true }).fill('07:00');
  await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(page.getByRole('status')).toBeVisible();
  await other.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText(/другой вкладке/);
  await expect(other.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('07:00');
  await expect(other.getByText('Понедельник: 08:00–24:00', { exact: true })).toBeVisible();
  await other.getByRole('button', { name: 'Оставить черновик поверх актуальной версии' }).click();
  await other.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(other.getByRole('status')).toContainText('Расписание сохранено');
  await other.close();
});

test('потерянный ответ: перезагрузка восстанавливает сохранённый результат', async ({ page }) => {
  await login(page);
  await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('06:00');
  let key: string | undefined;
  await page.route('**/api/owner/availability', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    key = route.request().headers()['idempotency-key'];
    await route.fetch();
    await route.abort();
  });
  await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
  await expect(page.getByLabel('Понедельник: начало 1', { exact: true })).toBeDisabled();
  await page.unroute('**/api/owner/availability');
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Расписание сохранено');
  await expect(page.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('06:00');
  expect(key).toBeTruthy();
});

test('сетевая ошибка не стирает форму, повторный вход сохраняет только память вкладки', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('05:00');
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/\/owner\/login/);
  await page.getByRole('textbox', { name: 'Пароль', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('05:00');
  await page.reload();
  await expect(page.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('09:00');
});

test('неизвестный исход после 503 повторяет прежний ключ; ошибка часов сохраняет черновик', async ({
  page,
}) => {
  await login(page);
  await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('24:00');
  await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Конец интервала/);
  await expect(page.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('24:00');
  await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('04:00');
  let key: string | undefined;
  await page.route('**/api/owner/availability', (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    key = route.request().headers()['idempotency-key'];
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'TEMPORARILY_UNAVAILABLE', message: 'Сбой' }),
    });
  });
  await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
  await page.unroute('**/api/owner/availability');
  const sent = page.waitForRequest(
    (request) => request.method() === 'PUT' && request.url().endsWith('/api/owner/availability'),
  );
  await page.getByRole('button', { name: 'Проверить результат / повторить', exact: true }).click();
  expect((await sent).headers()['idempotency-key']).toBe(key);
  await expect(page.getByRole('status')).toContainText('Расписание сохранено');
});

for (const fallback of ['session', 'cookie', 'none'] as const) {
  test(`сохранение Расписания при отказе хранилищ: ${fallback}`, async ({ page }) => {
    await page.addInitScript((mode) => {
      const blocked = () => {
        throw new DOMException('Blocked', 'SecurityError');
      };
      Object.defineProperty(window, 'localStorage', { get: blocked });
      if (mode !== 'session') Object.defineProperty(window, 'sessionStorage', { get: blocked });
      if (mode === 'none')
        Object.defineProperty(document, 'cookie', { get: () => '', set: () => {} });
    }, fallback);
    await login(page);
    await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('03:00');
    let sends = 0;
    let key: string | undefined;
    await page.route('**/api/owner/availability', (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      sends++;
      key = route.request().headers()['idempotency-key'];
      return route.abort();
    });
    await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
    if (fallback === 'none') {
      await expect(page.getByRole('alert')).toContainText(/Не удалось сохранить ключ/);
      expect(sends).toBe(0);
    } else {
      await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
      await page.reload();
      await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
      const cookies = await page.context().cookies();
      const technical = cookies.find((cookie) =>
        cookie.name.startsWith('owner_availability_operation_'),
      );
      if (fallback === 'cookie') {
        expect(decodeURIComponent(technical!.value)).not.toContain('03:00');
        await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('02:00');
        await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
        await expect(page.getByRole('alert')).toContainText(/нужны исходные параметры/);
        expect(sends).toBe(1);
        await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('03:00');
      }
      await page.unroute('**/api/owner/availability');
      const sent = page.waitForRequest(
        (request) =>
          request.method() === 'PUT' && request.url().endsWith('/api/owner/availability'),
      );
      await page
        .getByRole('button', {
          name: fallback === 'cookie' ? 'Сохранить Расписание' : 'Проверить результат / повторить',
          exact: true,
        })
        .click();
      expect((await sent).headers()['idempotency-key']).toBe(key);
      await expect(page.getByRole('status')).toContainText('Расписание сохранено');
    }
  });
}

test('потерянный ответ конфликта после перезагрузки оставляет редактор и исходный черновик', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('02:00');
  const other = await context.newPage();
  await other.goto('/owner/availability');
  await expect(other.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('09:00');
  await other.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(other.getByRole('status')).toBeVisible();
  await other.close();
  await page.route('**/api/owner/availability', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    await route.fetch();
    await route.abort();
  });
  await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
  await page.unroute('**/api/owner/availability');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(/другой вкладке/);
  await expect(page.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('02:00');
  await expect(
    page.getByRole('button', { name: 'Оставить черновик поверх актуальной версии' }),
  ).toBeVisible();
});

test('сбой чтения после конфликта позволяет загрузить актуальную неделю, сохраняя черновик', async ({
  page,
  context,
}) => {
  await login(page);
  await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('02:00');
  const other = await context.newPage();
  await other.goto('/owner/availability');
  await expect(other.getByLabel('Понедельник: начало 1', { exact: true })).toBeVisible();
  await other.getByLabel('Понедельник: начало 1', { exact: true }).fill('01:00');
  await other.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(other.getByRole('status')).toBeVisible();
  await other.close();
  await page.route('**/api/owner/availability', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      : route.continue(),
  );
  await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Не удалось загрузить/);
  await page.unroute('**/api/owner/availability');
  await page
    .getByRole('button', { name: 'Повторить загрузку актуального Расписания', exact: true })
    .click();
  await expect(page.getByText('Понедельник: 01:00–24:00', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Понедельник: начало 1', { exact: true })).toHaveValue('02:00');
});

test('вторая вкладка не стирает восстановление потерянного ответа первой', async ({
  page,
  context,
}) => {
  await login(page);
  const other = await context.newPage();
  await other.goto('/owner/availability');
  await expect(other.getByLabel('Понедельник: начало 1', { exact: true })).toBeVisible();
  await page.getByLabel('Понедельник: начало 1', { exact: true }).fill('02:00');
  let operationKey: string | undefined;
  await page.route('**/api/owner/availability', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    operationKey = route.request().headers()['idempotency-key'];
    await route.fetch();
    await route.abort();
  });
  await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
  await other.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
  await expect(other.getByRole('alert')).toContainText(/другой вкладке/);
  await page.unroute('**/api/owner/availability');
  const recovered = page.waitForRequest((request) =>
    request.url().endsWith(`/api/owner/operations/${operationKey}`),
  );
  await page.reload();
  await recovered;
  await expect(page.getByRole('status')).toContainText('Расписание сохранено');
  await other.close();
});
