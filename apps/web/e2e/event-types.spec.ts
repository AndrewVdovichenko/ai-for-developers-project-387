import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const password = 'тестовый пароль Владельца'; // betterleaks:allow -- public test fixture
async function login(page: Page) {
  await page.goto('/owner/event-types');
  await page.getByRole('textbox', { name: 'Пароль', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByLabel('Название')).toBeVisible();
}
async function fill(page: Page, name: string) {
  await page.getByLabel('Название').fill(name);
  await page.getByLabel('Описание').fill('<b>Описание</b>\nВторая строка');
  await page.getByLabel('Длительность, минут').fill('45');
}

test('каталог различает загрузку, ошибку, пустоту; неизвестный тип ведёт в каталог', async ({
  page,
}) => {
  await page.route('**/api/event-types', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
  );
  await page.goto('/event-types');
  await expect(page.getByRole('alert')).toContainText(/Не удалось загрузить/);
  await page.unroute('**/api/event-types');
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(page.getByText(/Пока нет типов встреч/)).toBeVisible();
  for (const id of ['bad-id', randomUUID()]) {
    await page.goto(`/booking/${id}`);
    await expect(page.getByRole('alert')).toContainText('Тип встречи не найден');
    await page.getByRole('link', { name: /В\s+каталог/ }).click();
    await expect(page).toHaveURL('/event-types');
  }
});

test('создание, ошибки полей, копирование, прямая ссылка и каталог', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  await page.getByLabel('Название').fill('  ');
  await page.getByRole('button', { name: 'Создать тип встречи' }).click();
  await expect(page.getByText(/Название должно содержать/)).toBeVisible();
  const name = `Знакомство ${randomUUID()}`;
  await fill(page, name);
  await page.getByRole('button', { name: 'Создать тип встречи' }).click();
  await expect(page.getByText(`Тип встречи создан: ${name}`)).toBeVisible();
  await expect(page.getByLabel('Название')).toHaveValue('');
  await expect(page).toHaveURL('/owner/event-types');
  await page.getByRole('button', { name: 'Скопировать ссылку' }).click();
  await expect(page.getByText('Ссылка скопирована', { exact: true })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  const popupPromise = page.waitForEvent('popup');
  await page.locator('output').getByRole('link', { name: 'Открыть страницу записи' }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(link);
  await expect(popup.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(popup.getByText('<b>Описание</b>\nВторая строка')).toBeVisible();
  await popup.getByRole('link', { name: /В\s+каталог/ }).click();
  await expect(popup.getByRole('heading', { name, exact: true })).toBeVisible();
  await popup.close();
  await page.getByRole('button', { name: 'Создать тип встречи' }).click();
  await expect(page.getByText(/Название должно содержать/)).toBeVisible();
});

test('U+0000 отклоняется рядом с полем до отправки запроса', async ({ page }) => {
  await login(page);
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/owner/event-types')) posts++;
  });
  for (const label of ['Название', 'Описание']) {
    await fill(page, 'Тип 😀');
    await page.getByLabel(label).fill('До\u0000после');
    await page.getByRole('button', { name: 'Создать тип встречи' }).click();
    await expect(page.getByLabel(label)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('Символ U+0000 недопустим')).toBeVisible();
    await expect(page.getByLabel(label)).toHaveValue('До\u0000после');
  }
  expect(posts).toBe(0);
});

test('потеря ответа после commit: перезагрузка и ручная проверка не создают дубликат', async ({
  page,
}) => {
  await login(page);
  const name = `Потерянный ответ ${randomUUID()}`;
  await fill(page, name);
  await page.route('**/api/owner/event-types', async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page.getByRole('button', { name: 'Создать тип встречи' }).click();
  await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
  await expect(page.getByLabel('Название')).toBeDisabled();
  await page.unroute('**/api/owner/event-types');
  await page.getByRole('button', { name: 'Проверить результат / повторить' }).click();
  await expect(page.getByText(`Тип встречи создан: ${name}`)).toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1);
});

test('401 сохраняет черновик в памяти вкладки, вход требует явной отправки', async ({
  page,
  context,
}) => {
  await login(page);
  const name = `Черновик ${randomUUID()}`;
  await fill(page, name);
  await context.clearCookies();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/\/owner\/login/);
  await page.getByRole('textbox', { name: 'Пароль', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByLabel('Название')).toHaveValue(name);
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Название')).toHaveValue('');
});

test('401 отправленной операции: новый вход сначала восстанавливает результат', async ({
  page,
  context,
}) => {
  await login(page);
  const name = `Повторный вход ${randomUUID()}`;
  await fill(page, name);
  await page.route('**/api/owner/event-types', async (route) => {
    await route.fetch();
    await context.clearCookies();
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'OWNER_AUTH_REQUIRED', message: 'Войдите' }),
    });
  });
  await page.getByRole('button', { name: 'Создать тип встречи' }).click();
  await expect(page).toHaveURL(/\/owner\/login/);
  await page.unroute('**/api/owner/event-types');
  await page.getByRole('textbox', { name: 'Пароль', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByText(`Тип встречи создан: ${name}`)).toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1);
});

test('unknown допускает только повтор исходных параметров под тем же ключом', async ({ page }) => {
  await login(page);
  await fill(page, `Без ответа ${randomUUID()}`);
  let key: string | undefined;
  await page.route('**/api/owner/event-types', async (route) => {
    key = route.request().headers()['idempotency-key'];
    await route.abort();
  });
  await page.getByRole('button', { name: 'Создать тип встречи' }).click();
  await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
  await expect(page.getByLabel('Название')).toBeDisabled();
  await page.unroute('**/api/owner/event-types');
  const requestPromise = page.waitForRequest('**/api/owner/event-types');
  await page.getByRole('button', { name: 'Проверить результат / повторить' }).click();
  expect((await requestPromise).headers()['idempotency-key']).toBe(key);
  await expect(page.getByText(/Тип встречи создан:/)).toBeVisible();
});

for (const fallback of ['session', 'cookie', 'none'] as const) {
  test(`отказ хранилищ: ${fallback}`, async ({ page }) => {
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
    const name = `Хранилище ${randomUUID()}`;
    await fill(page, name);
    let posts = 0;
    await page.route('**/api/owner/event-types', async (route) => {
      posts++;
      await route.abort();
    });
    await page.getByRole('button', { name: 'Создать тип встречи' }).click();
    if (fallback === 'none') {
      await expect(page.getByRole('alert')).toContainText(/Не удалось сохранить ключ/);
      expect(posts).toBe(0);
    } else {
      await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
      expect(posts).toBe(1);
      const cookies = await page.context().cookies();
      expect(JSON.stringify(cookies)).not.toContain(name);
      await page.reload();
      await expect(page.getByRole('alert')).toContainText(/Исход.*неизвестен/);
      if (fallback === 'cookie') {
        await expect(page.getByLabel('Название')).toHaveValue('');
        await fill(page, 'Другие параметры');
        await page.getByRole('button', { name: 'Создать тип встречи' }).click();
        await expect(page.getByRole('alert')).toContainText(/нужны исходные параметры/);
        expect(posts).toBe(1);
        await fill(page, name);
      }
      await page.unroute('**/api/owner/event-types');
      if (fallback === 'session')
        await page.getByRole('button', { name: 'Проверить результат / повторить' }).click();
      else await page.getByRole('button', { name: 'Создать тип встречи' }).click();
      await expect(page.getByText(`Тип встречи создан: ${name}`)).toBeVisible();
    }
  });
}
