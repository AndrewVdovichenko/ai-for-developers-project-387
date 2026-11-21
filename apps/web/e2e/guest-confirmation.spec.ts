import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import {
  createEventType,
  ownerAvailabilityGetAvailability,
  ownerAvailabilitySaveAvailability,
  ownerSessionLoginOwner,
} from '@calendar/api-client';
const baseUrl = 'http://127.0.0.1:3001',
  origin = 'http://127.0.0.1:4174';
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

test('форма сохраняется при смене Слота и обновлении; успех и закладка защищены cookie', async ({
  page,
  browser,
}) => {
  const type = await setup();
  await page.goto(`/booking/${type.id}`);
  await page.getByLabel('День записи').selectOption('2026-11-02');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await expect(page.getByText('Введите имя от 1 до 100 символов')).toBeVisible();
  await page.getByLabel('Имя', { exact: true }).fill('Анна 😀');
  await page.getByLabel('Email', { exact: true }).fill('Anna@Example.COM');
  await page.getByRole('button', { name: 'Выбрать другой Слот' }).click();
  await page.getByLabel('День записи').selectOption('2026-11-03');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await page.reload();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('Анна 😀');
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('Anna@Example.COM');
  await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  const url = page.url();
  await expect(page.getByText('Anna@Example.COM', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  const foreign = await browser.newContext();
  try {
    const other = await foreign.newPage();
    await other.goto(url);
    await expect(other.getByText('Запись недоступна', { exact: true })).toBeVisible();
    await expect(other.getByText('Anna@Example.COM', { exact: true })).toHaveCount(0);
  } finally {
    await foreign.close();
  }
  await page.getByRole('link', { name: 'Записаться ещё' }).click();
  await page.goto(`/booking/${type.id}`);
  await page.getByLabel('День записи').selectOption('2026-11-04');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('');
});

for (const mode of ['localStorage', 'sessionStorage', 'cookie'] as const)
  test(`потерянный commit блокирует изменение формы; восстановление ${mode}`, async ({
    page,
    context,
  }) => {
    const type = await setup();
    if (mode !== 'localStorage')
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
      }, mode);
    await page.goto(`/booking/${type.id}`);
    await page.getByLabel('День записи').selectOption('2026-11-05');
    await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
    await page.getByLabel('Имя', { exact: true }).fill('Секретное имя');
    await page.getByLabel('Email', { exact: true }).fill('Private@Example.COM');
    let posts = 0;
    await page.route('**/api/holds/*/confirm', async (route) => {
      posts++;
      await route.fetch();
      await route.abort();
    });
    await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Проверить результат подтверждения' }),
    ).toHaveCount(0);
    await expect(page.getByRole('alert')).toContainText('Уточняем результат');
    await expect(page.getByLabel('Имя', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Выбрать другой Слот' })).toBeDisabled();
    const technical = (await context.cookies()).filter((c) =>
      c.name.startsWith('guest_confirmation_'),
    );
    if (mode === 'cookie') {
      expect(technical).toHaveLength(1);
      expect(decodeURIComponent(technical[0]!.value)).not.toContain('Private');
      expect(decodeURIComponent(technical[0]!.value)).not.toContain('Секретное');
    }
    await page.unroute('**/api/holds/*/confirm');
    if (mode === 'cookie') await page.reload();
    await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
    await page.goto(`/booking/${type.id}`);
    await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
    expect(posts).toBe(1);
  });

test('подтверждение показывает спиннер и не отправляет двойное нажатие', async ({ page }) => {
  const type = await setup();
  await page.goto(`/booking/${type.id}`);
  await page.getByLabel('День записи').selectOption('2026-11-06');
  await page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first().click();
  await page.getByLabel('Имя', { exact: true }).fill('Анна');
  await page.getByLabel('Email', { exact: true }).fill('a@b.c');
  let resume!: () => void,
    ready!: () => void,
    posts = 0;
  const gate = new Promise<void>((r) => {
      resume = r;
    }),
    entered = new Promise<void>((r) => {
      ready = r;
    });
  await page.route('**/api/holds/*/confirm', async (route) => {
    posts++;
    const response = await route.fetch();
    ready();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    await entered;
    await expect(page.getByRole('button', { name: 'Записываем…' })).toBeDisabled();
    await page.locator('form').evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    resume();
    await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
    expect(posts).toBe(1);
  } finally {
    resume();
  }
});

test('истёкшее Бронирование подтверждается; конфликт сохраняет форму и обновляет доступность', async ({
  page,
  browser,
}) => {
  const type = await setup();
  await page.goto(`/booking/${type.id}`);
  await page.getByLabel('День записи').selectOption('2026-11-01');
  const slot = page.getByRole('list', { name: 'Свободные Слоты' }).getByRole('button').first();
  const label = (await slot.textContent())!;
  await slot.click();
  await page.getByLabel('Имя', { exact: true }).fill('Поздний Гость');
  await page.getByLabel('Email', { exact: true }).fill('late@b.c');
  const clock = async (instant: string) => {
    expect(
      (
        await page.request.post(`${baseUrl}/__test/clock`, {
          headers: { Origin: origin },
          data: { instant },
        })
      ).status(),
    ).toBe(200);
  };
  const rival = await browser.newContext();
  try {
    await clock('2026-10-24T22:05:00.000Z');
    await page.reload();
    await expect(page.getByRole('timer')).toHaveText(
      'Срок бронирования истёк. При подтверждении проверим, свободен ли слот',
    );
    const other = await rival.newPage();
    await other.goto(`/booking/${type.id}`);
    await other.getByLabel('День записи').selectOption('2026-11-01');
    await other.getByRole('button', { name: label, exact: true }).click();
    await expect(other.getByText('Слот выбран', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Слот уже занят');
    await expect(page.getByLabel('Имя', { exact: true })).toHaveValue('Поздний Гость');
    await other.getByRole('button', { name: 'Освободить Бронирование' }).click();
    await expect(other.getByText('Бронирование освобождено', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
  } finally {
    await clock('2026-10-24T22:00:00.000Z');
    await rival.close();
  }
});

test('пояс браузера, UTC-смещения и обе даты видны у выбора и Записи', async ({ browser }) => {
  const type = await setup();
  const context = await browser.newContext({ timezoneId: 'Asia/Kolkata' });
  try {
    const page = await context.newPage();
    await page.goto(`/booking/${type.id}`);
    await page.getByLabel('День записи').selectOption('2026-11-01');
    await page
      .getByRole('list', { name: 'Свободные Слоты' })
      .getByRole('button', { name: /23:45.*00:15/ })
      .click();
    const selected = page.getByLabel('Выбранное Бронирование');
    await expect(selected).toContainText('Asia/Calcutta');
    await expect(selected).toContainText('1 ноября');
    await expect(selected).toContainText('2 ноября');
    await expect(selected).toContainText('GMT+05:30');
    await page.getByLabel('Имя', { exact: true }).fill('Гость');
    await page.getByLabel('Email', { exact: true }).fill('a@b.c');
    await page.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
    await expect(page.getByText(/Ваш часовой пояс:/)).toHaveText('Ваш часовой пояс: Asia/Calcutta');
    await expect(page.getByText(/1 ноября.*2 ноября/)).toContainText('GMT+05:30');
  } finally {
    await context.close();
  }
});
