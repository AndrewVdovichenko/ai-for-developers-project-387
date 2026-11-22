import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  createEventType,
  ownerAvailabilityGetAvailability,
  ownerAvailabilitySaveAvailability,
  ownerSessionLoginOwner,
} from '@calendar/api-client';
import type { Page } from '@playwright/test';
const baseUrl = 'http://127.0.0.1:3001',
  origin = 'http://127.0.0.1:4174',
  // Служебные ключи хранилища приложения: префикс идентификатора вкладки
  // задан в apps/web/src/operation-storage.ts, база имени записи — в
  // apps/web/src/booking-draft.ts ('guest-confirmation'). При смене формата
  // в приложении синхронно править эти константы.
  tabIdPrefix = 'calendar-tab:',
  guestConfirmationKeyPrefix = 'guest-confirmation:';
async function setup() {
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
      body: { name: 'Подтверждение ' + randomUUID(), durationMinutes: 30 },
    })
  ).data!.eventType;
}

async function select(page: Page) {
  const type = await setup();
  await page.goto(`/booking/${type.id}`);
  await page.getByLabel('День записи').selectOption('2026-11-07');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await page.getByLabel('Имя', { exact: true }).fill('Прежний Гость');
  await page.getByLabel('Email', { exact: true }).fill('Same@Example.COM');
  return type;
}

async function blockStores(page: Page, mode: 'session' | 'cookie' | 'none') {
  await page.addInitScript((mode) => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('unavailable');
      },
    });
    if (mode !== 'session')
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new Error('unavailable');
        },
      });
  }, mode);
}

test('утрата формы: сначала GET результата, затем только прежние параметры с прежним ключом', async ({
  page,
}) => {
  await blockStores(page, 'cookie');
  await select(page);
  const sent: { key: string; body: string | null }[] = [];
  await page.route('**/api/holds/*/confirm', async (route) => {
    sent.push({
      key: route.request().headers()['idempotency-key']!,
      body: route.request().postData(),
    });
    await route.abort();
  });
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Уточняем результат');
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route('**/api/operations/*', async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.reload();
    await expect(page.getByLabel('Имя', { exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole('alert')).toContainText('Введите прежние');
    await page.getByLabel('Имя', { exact: true }).fill('Другой Гость');
    await page.getByLabel('Email', { exact: true }).fill('Changed@Example.COM');
    const before = sent.length;
    await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Нужны прежние');
    expect(sent.length).toBe(before);
    await expect(page.getByRole('button', { name: 'Выбрать другой Слот' })).toBeDisabled();
    await page.getByLabel('Имя', { exact: true }).fill('Прежний Гость');
    await page.getByLabel('Email', { exact: true }).fill('Same@Example.COM');
    await page.unroute('**/api/holds/*/confirm');
    const request = page.waitForRequest(
      (r) => r.url().endsWith('/confirm') && r.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    const replay = await request;
    expect(replay.headers()['idempotency-key']).toBe(sent[0]!.key);
    expect(replay.postData()).toBe(sent[0]!.body);
    await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  } finally {
    release();
  }
});

test('offline приостанавливает восстановление; online автоматически повторяет исходный запрос', async ({
  page,
  context,
}) => {
  await select(page);
  let key = '',
    body: string | null = null,
    gets = 0;
  await page.route('**/api/holds/*/confirm', async (route) => {
    key = route.request().headers()['idempotency-key']!;
    body = route.request().postData();
    await context.setOffline(true);
    await route.abort();
  });
  await page.route('**/api/operations/*', async (route) => {
    gets++;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Нет соединения. Продолжим после');
  const paused = gets;
  await page.clock.install();
  await page.clock.runFor(30000);
  expect(gets).toBe(paused);
  await page.unroute('**/api/holds/*/confirm');
  const request = page.waitForRequest((r) => r.url().endsWith('/confirm') && r.method() === 'POST');
  await context.setOffline(false);
  await page.clock.runFor(1000);
  const replay = await request;
  expect(replay.headers()['idempotency-key']).toBe(key);
  expect(replay.postData()).toBe(body);
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
});

test('503 сохраняет ключ и параметры; интервалы восстановления 1, 2, 4, 10, 10 секунд', async ({
  page,
}) => {
  await select(page);
  let key = '',
    gets = 0;
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
  await page.route('**/api/holds/*/confirm', async (route) => {
    key = route.request().headers()['idempotency-key']!;
    await route.abort();
  });
  await page.route('**/api/operations/*', async (route) => {
    expect(route.request().url()).toContain(key);
    gets++;
    await route.fulfill({
      status: 503,
      json: { code: 'SERVICE_UNAVAILABLE', message: 'technical' },
    });
  });
  // Enter по нативной submit-кнопке запускает onSubmit формы без pointer-пути:
  // проверки actionability у click() зависят от времени и не проходят при
  // остановленных виртуальных часах.
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toContainText('Уточняем результат');
  for (const [index, delay] of [1000, 2000, 4000, 10000, 10000].entries()) {
    await page.clock.runFor(delay - 1);
    expect(gets).toBe(index);
    await page.clock.runFor(1);
    // После ответа дождаться записи номера попытки и постановки следующего таймера.
    await expect
      .poll(() =>
        page.evaluate(
          ({ tab, confirmation }) => {
            const tabId = window.name.slice(tab.length);
            const record = localStorage.getItem(`${confirmation}${tabId}`);
            return record && JSON.parse(record).context?.attempt;
          },
          { tab: tabIdPrefix, confirmation: guestConfirmationKeyPrefix },
        ),
      )
      .toBe(index + 1);
    expect(gets).toBe(index + 1);
    await expect(page.getByLabel('Имя', { exact: true })).toBeDisabled();
  }
  await page.unroute('**/api/operations/*');
  await page.unroute('**/api/holds/*/confirm');
  await page.clock.runFor(10000);
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
});

test('полный отказ хранилищ блокирует подтверждение до отправки', async ({ page }) => {
  await select(page);
  await page.evaluate(() => {
    for (const name of ['localStorage', 'sessionStorage'])
      Object.defineProperty(window, name, {
        get() {
          throw new Error('unavailable');
        },
      });
    Object.defineProperty(document, 'cookie', { get: () => '', set: () => {} });
  });
  let posts = 0;
  await page.route('**/api/holds/*/confirm', async (route) => {
    posts++;
    await route.abort();
  });
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось сохранить ключ');
  expect(posts).toBe(0);
});

test('новый результат в sessionStorage вытесняет старую читаемую копию localStorage после отказа записи', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && localStorage.getItem('deny-writes') === 'yes')
        throw new Error('read-only');
      return original.call(this, key, value);
    };
    const remove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function (key) {
      if (this === localStorage && localStorage.getItem('deny-writes') === 'yes')
        throw new Error('read-only');
      return remove.call(this, key);
    };
  });
  const type = await select(page);
  await page.route('**/api/holds/*/confirm', async (route) => {
    const response = await route.fetch();
    await page.evaluate(() => localStorage.setItem('deny-writes', 'yes'));
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  await page.route('**/api/operations/*', (route) =>
    route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE', message: 'technical' } }),
  );
  await page.goto(`/booking/${type.id}`);
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  await page.getByRole('link', { name: 'Записаться ещё' }).click();
  await page.goto(`/booking/${type.id}`);
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toHaveCount(0);
  await page.getByLabel('День записи').selectOption('2026-11-07');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('');
});

test('15 секунд ожидания ответа не отменяют commit; автоматический GET открывает единственную Запись', async ({
  page,
}) => {
  await select(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let posts = 0;
  await page.route('**/api/holds/*/confirm', async (route) => {
    posts++;
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    const checked = page.waitForRequest((request) => request.url().includes('/api/operations/'), {
      timeout: 20000,
    });
    await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Записываем…' })).toBeDisabled();
    await checked;
    await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
    expect(posts).toBe(1);
  } finally {
    release();
  }
});
