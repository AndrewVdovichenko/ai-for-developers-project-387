import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
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

async function open(page: Page, id: string) {
  await page.goto(`http://127.0.0.1:4174/booking/${id}`);
  await page.getByLabel('День записи').selectOption('2026-10-30');
}

test('два Гостя: выбор, конфликт и восстановление после обновления', async ({ browser }) => {
  const type = await setup();
  const a = await browser.newContext(),
    b = await browser.newContext();
  const pageA = await a.newPage(),
    pageB = await b.newPage();
  try {
    await Promise.all([open(pageA, type.id), open(pageB, type.id)]);
    const first = pageA.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first();
    await expect(first).toBeVisible();
    const label = await first.textContent();
    await expect(pageB.getByRole('button', { name: label!, exact: true })).toBeVisible();
    await first.click();
    await expect(pageA.getByText('Слот выбран', { exact: true })).toBeVisible();
    const number = await pageA.getByText(/Номер Бронирования:/).textContent();
    await pageB.getByRole('button', { name: label!, exact: true }).click();
    await expect(pageB.getByRole('alert')).toContainText('Слот уже занят');
    await pageA.reload();
    await expect(pageA.getByText(number!, { exact: true })).toBeVisible();
    await expect(pageA.getByRole('timer')).toContainText('Осталось 5:');
    const cookies = await a.cookies();
    expect(cookies.find((cookie) => cookie.name === 'guest_session')).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
    });
  } finally {
    await a.close();
    await b.close();
  }
});

test('неподтверждённая cookie блокирует выбор', async ({ page }) => {
  const type = await setup();
  let submitted = 0;
  await page.route('**/api/guest-session', async (route) => {
    if (route.request().method() === 'GET') await route.fulfill({ json: { ready: false } });
    else await route.continue();
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/holds')) submitted++;
  });
  await open(page, type.id);
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await expect(page.getByRole('alert')).toContainText('Не удалось проверить cookie');
  expect(submitted).toBe(0);
});

test('полный отказ хранения блокирует POST выбора', async ({ page }) => {
  const type = await setup();
  let submitted = 0;
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('disabled');
      },
    });
    Object.defineProperty(window, 'sessionStorage', {
      get() {
        throw new Error('disabled');
      },
    });
    Object.defineProperty(document, 'cookie', {
      get() {
        return '';
      },
      set() {},
    });
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/holds')) submitted++;
  });
  await open(page, type.id);
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await expect(page.getByRole('alert')).toContainText('Не удалось сохранить ключ операции');
  expect(submitted).toBe(0);
});

for (const fault of ['lost', '503'] as const) {
  test(`выбор: ${fault}, прежний ключ и восстановление после перезагрузки`, async ({ page }) => {
    const type = await setup();
    let posts = 0;
    await page.route('**/api/holds', async (route) => {
      posts++;
      const response = await route.fetch();
      if (fault === 'lost') await route.abort();
      else
        await route.fulfill({
          status: 503,
          json: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Временный сбой' },
        });
      void response;
    });
    await open(page, type.id);
    await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
    await expect(page.getByRole('button', { name: 'Проверить результат выбора' })).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button'),
    ).toHaveCount(0);
    await expect(page.getByRole('alert')).toBeVisible();
    await page.unroute('**/api/holds');
    await page.getByRole('button', { name: 'Проверить результат выбора' }).click();
    await expect(page.getByText('Слот выбран', { exact: true })).toBeVisible();
    expect(posts).toBe(1);
  });
}

for (const fallback of ['session', 'cookie'] as const) {
  test(`ключ выбора восстанавливается через ${fallback}`, async ({ page }) => {
    const type = await setup();
    await page.addInitScript((mode) => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('disabled');
        },
      });
      if (mode === 'cookie')
        Object.defineProperty(window, 'sessionStorage', {
          get() {
            throw new Error('disabled');
          },
        });
    }, fallback);
    await page.route('**/api/holds', async (route) => {
      await route.fetch();
      await route.abort();
    });
    await open(page, type.id);
    await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
    await expect(page.getByRole('button', { name: 'Проверить результат выбора' })).toBeVisible();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.unroute('**/api/holds');
    await page.reload();
    await expect(page.getByText('Слот выбран', { exact: true })).toBeVisible();
  });
}

test('возврат к выбору сохраняет Бронирование; две вкладки видят замену и освобождение', async ({
  context,
  page,
}) => {
  const type = await setup();
  await open(page, type.id);
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  const oldNumber = await page.getByText(/Номер Бронирования:/).textContent();
  const second = await context.newPage();
  await second.goto(`http://127.0.0.1:4174/booking/${type.id}`);
  await expect(second.getByText(oldNumber!, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать другой Слот' }).click();
  await expect(page.getByText(oldNumber!, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'В каталог' }).click();
  await page.goBack();
  await expect(page.getByText(oldNumber!, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выбрать другой Слот' }).click();
  await page.getByLabel('День записи').selectOption('2026-10-31');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await expect(page.getByText(/Номер Бронирования:/)).not.toHaveText(oldNumber!);
  const newNumber = await page.getByText(/Номер Бронирования:/).textContent();
  expect(newNumber).not.toBe(oldNumber);
  await second.bringToFront();
  await second.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(second.getByText(newNumber!, { exact: true })).toBeVisible();
  await expect(second.getByRole('alert')).toContainText('Выбор изменён в');
  await second.getByRole('button', { name: 'Освободить Бронирование' }).click();
  await expect(second.getByText('Бронирование освобождено', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Бронирование освобождено', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Бронирование освобождено', { exact: true })).toBeVisible();
});

for (const committed of [true, false]) {
  test(`неизвестное освобождение сохраняет выбор до восстановления: commit ${committed}`, async ({
    page,
  }) => {
    const type = await setup();
    await open(page, type.id);
    await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
    const number = await page.getByText(/Номер Бронирования:/).textContent();
    await page.route('**/api/holds/*/release', async (route) => {
      if (committed) await route.fetch();
      await route.abort();
    });
    await page.getByRole('button', { name: 'Освободить Бронирование' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText(number!, { exact: true })).toBeVisible();
    await expect(page.getByText('Бронирование освобождено', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Проверить результат выбора' })).toBeVisible();
    await page.unroute('**/api/holds/*/release');
    await page.reload();
    await expect(page.getByText('Бронирование освобождено', { exact: true })).toBeVisible();
  });
}

test('задержавшееся чтение прежнего выбора не отменяет успешную замену', async ({ page }) => {
  const type = await setup();
  await open(page, type.id);
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  const old = await page.getByText(/Номер Бронирования:/).textContent();
  await page.getByRole('button', { name: 'Выбрать другой Слот' }).click();
  await page.getByLabel('День записи').selectOption('2026-10-31');
  let resume!: () => void, captured!: () => void, finished!: () => void;
  const delayed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    captured = resolve;
  });
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let first = true;
  await page.route('**/api/holds/current', async (route) => {
    if (!first) {
      await route.continue();
      return;
    }
    first = false;
    const response = await route.fetch();
    captured();
    await delayed;
    await route.fulfill({ response });
    finished();
  });
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await ready;
    await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
    await expect(page.getByText(/Номер Бронирования:/)).not.toHaveText(old!);
    const next = await page.getByText(/Номер Бронирования:/).textContent();
    const received = page.waitForResponse('**/api/holds/current');
    resume();
    await done;
    await received;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    // A visible stable value after the delayed response, with no second mutation.
    await expect(page.getByText(next!, { exact: true })).toBeVisible();
    await expect(page.getByText(old!, { exact: true })).toHaveCount(0);
  } finally {
    resume();
  }
});
