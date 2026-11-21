import { expect, test } from '@playwright/test';
import {
  ownerAvailabilityGetAvailability,
  ownerAvailabilitySaveAvailability,
  ownerAvailabilityPreviewAvailability,
} from '@calendar/api-client';

test('предложение пояса можно отклонить; ручная смена требует просмотра и явного подтверждения', async ({
  browser,
}) => {
  const context = await browser.newContext({ timezoneId: 'Pacific/Honolulu' });
  const page = await context.newPage();
  try {
    await page.goto('/owner/availability');
    await page
      .getByRole('textbox', { name: 'Пароль', exact: true })
      .fill('тестовый пароль Владельца');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByText('Пояс браузера: Pacific/Honolulu', { exact: true })).toBeVisible();
    const initialCookies = await context.cookies();
    const initialOptions = {
      baseUrl: 'http://127.0.0.1:4174',
      headers: {
        Origin: 'http://127.0.0.1:4174',
        Cookie: initialCookies.map((c) => `${c.name}=${c.value}`).join('; '),
      },
    };
    const initial = (await ownerAvailabilityGetAvailability(initialOptions)).data!.availability;
    if (!initial.configured || initial.timeZone === 'Pacific/Honolulu') {
      const body = { revision: initial.revision, timeZone: 'Europe/Berlin', days: initial.days };
      const confirmationToken = initial.configured
        ? (await ownerAvailabilityPreviewAvailability({ ...initialOptions, body })).data!
            .confirmationToken
        : undefined;
      await ownerAvailabilitySaveAvailability({
        ...initialOptions,
        headers: { ...initialOptions.headers, 'Idempotency-Key': crypto.randomUUID() },
        body: { ...body, ...(confirmationToken ? { confirmationToken } : {}) },
      });
      await page.reload();
    }
    await page.getByRole('button', { name: 'Оставить текущий', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Оставить текущий', exact: true })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: 'Изменить пояс вручную', exact: true }).click();
    await page.getByLabel('Часовой пояс календаря', { exact: true }).fill('Pacific/Honolulu');
    const cookies = await context.cookies();
    const options = {
      baseUrl: 'http://127.0.0.1:4174',
      headers: { Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
    };
    const before = (await ownerAvailabilityGetAvailability(options)).data!.availability;
    await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Pacific/Honolulu');
    expect((await ownerAvailabilityGetAvailability(options)).data!.availability).toEqual(before);
    await page.getByRole('button', { name: 'Оставить черновик', exact: true }).click();
    await expect(page.getByLabel('Часовой пояс календаря', { exact: true })).toHaveValue(
      'Pacific/Honolulu',
    );
    await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
    await page.getByRole('button', { name: 'Подтвердить смену пояса', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Расписание сохранено');
    expect((await ownerAvailabilityGetAvailability(options)).data!.availability).toMatchObject({
      timeZone: 'Pacific/Honolulu',
      days: before.days,
      revision: before.revision + 1,
    });
  } finally {
    await context.close();
  }
});

// The fixtures use the same SDK and HTTP boundaries as the product.
async function consequenceFixture() {
  const baseUrl = 'http://127.0.0.1:3001',
    Origin = 'http://127.0.0.1:4174';
  const sdk = await import('@calendar/api-client');
  const login = await sdk.ownerSessionLoginOwner({
    baseUrl,
    headers: { Origin },
    body: { password: 'тестовый пароль Владельца' }, // betterleaks:allow -- public test fixture
  });
  const headers = { Origin, Cookie: login.response!.headers.get('set-cookie')!.split(';')[0]! };
  const settings = (await sdk.ownerAvailabilityGetAvailability({ baseUrl, headers })).data!
    .availability;
  const body = {
    revision: settings.revision,
    timeZone: 'UTC',
    days: Array.from({ length: 7 }, (_, index) => ({
      weekday: index + 1,
      intervals: [{ startMinute: 540, endMinute: 1080 }],
    })),
  };
  const confirmationToken =
    settings.configured && settings.timeZone !== body.timeZone
      ? (await sdk.ownerAvailabilityPreviewAvailability({ baseUrl, headers, body })).data!
          .confirmationToken
      : undefined;
  expect(
    (
      await sdk.ownerAvailabilitySaveAvailability({
        baseUrl,
        headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        body: { ...body, ...(confirmationToken ? { confirmationToken } : {}) },
      })
    ).response!.status,
  ).toBe(200);
  const type = (
    await sdk.createEventType({
      baseUrl,
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      body: { name: 'Последствия пояса ' + crypto.randomUUID(), durationMinutes: 30 },
    })
  ).data!.eventType;
  const slots = (
    await sdk.getSlotAvailability({ baseUrl, path: { id: type.id } })
  ).data!.slots.filter((s) => s.startsAt.startsWith('2026-10-27'));
  const selected = [];
  for (const slot of [slots[0]!, slots[2]!, slots[4]!, slots[6]!]) {
    const guest = await sdk.guestSessionPrepareGuest({ baseUrl, headers: { Origin }, body: {} });
    const guestHeaders = {
      Origin,
      Cookie: guest.response!.headers.get('set-cookie')!.split(';')[0]!,
    };
    const held = await sdk.selectHold({
      baseUrl,
      headers: { ...guestHeaders, 'Idempotency-Key': crypto.randomUUID() },
      body: { eventTypeId: type.id, startsAt: slot.startsAt },
    });
    expect(held.response!.status).toBe(200);
    selected.push({ headers: guestHeaders, hold: held.data!.hold });
  }
  const booked = (
    await sdk.confirmHold({
      baseUrl,
      headers: { ...selected[0]!.headers, 'Idempotency-Key': crypto.randomUUID() },
      path: { id: selected[0]!.hold.id },
      body: { guestName: 'Гость preview', guestEmail: 'preview@example.test' },
    })
  ).data!.booking;
  return { sdk, baseUrl, headers, selected, booked, type };
}

test('последствия требуют повторного просмотра после изменения набора; UTC Записей сохраняется, активное и истёкшее Бронирования проверяются по-разному', async ({
  browser,
  request,
}) => {
  const f = await consequenceFixture();
  const owner = await browser.newContext();
  const active = await browser.newContext();
  const expired = await browser.newContext();
  const cookie = async (context: typeof owner, headers: { Cookie: string }) => {
    const [name, value] = headers.Cookie.split('=');
    await context.addCookies([{ name: name!, value: value!, url: 'http://127.0.0.1:4174' }]);
  };
  try {
    await cookie(owner, f.headers);
    const page = await owner.newPage();
    await page.goto('/owner/availability');
    await page.getByRole('button', { name: 'Изменить пояс вручную' }).click();
    await page.getByLabel('Часовой пояс календаря', { exact: true }).fill('Pacific/Honolulu');
    await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(
      `${f.type.name}: ${f.booked.startsAt} — ${f.booked.endsAt}`,
    );
    for (const selected of f.selected.slice(1))
      await expect(page.getByRole('dialog')).toContainText(
        `${f.type.name}: ${selected.hold.startsAt} — ${selected.hold.endsAt}`,
      );
    await f.sdk.releaseHold({
      baseUrl: f.baseUrl,
      headers: { ...f.selected[1]!.headers, 'Idempotency-Key': crypto.randomUUID() },
      path: { id: f.selected[1]!.hold.id },
      body: {},
    });
    await page.getByRole('button', { name: 'Подтвердить смену пояса', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Последствия изменились');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toContainText(
      `${f.type.name}: ${f.selected[1]!.hold.startsAt}`,
    );
    for (const selected of f.selected.slice(2))
      await expect(page.getByRole('dialog')).toContainText(
        `${f.type.name}: ${selected.hold.startsAt} — ${selected.hold.endsAt}`,
      );
    await page.getByRole('button', { name: 'Подтвердить смену пояса', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Расписание сохранено');
    expect(
      (
        await f.sdk.getBooking({
          baseUrl: f.baseUrl,
          headers: f.headers,
          path: { id: f.booked.id },
        })
      ).data!.booking,
    ).toEqual(f.booked);
    await cookie(active, f.selected[2]!.headers);
    const activePage = await active.newPage();
    await activePage.goto(`/booking/${f.type.id}`);
    await activePage.getByLabel('Имя', { exact: true }).fill('Активный Гость');
    await activePage.getByLabel('Email', { exact: true }).fill('active@example.test');
    await activePage.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    await expect(activePage.getByRole('heading', { name: 'Вы записаны' })).toBeVisible();
    await request.post('http://127.0.0.1:3001/__test/clock', {
      headers: { Origin: 'http://127.0.0.1:4174' },
      data: { instant: '2026-10-24T22:05:00.000Z' },
    });
    await cookie(expired, f.selected[3]!.headers);
    const expiredPage = await expired.newPage();
    await expiredPage.goto(`/booking/${f.type.id}`);
    await expiredPage.getByLabel('Имя', { exact: true }).fill('Опоздавший Гость');
    await expiredPage.getByLabel('Email', { exact: true }).fill('expired@example.test');
    await expiredPage.getByRole('button', { name: 'Подтвердить запись', exact: true }).click();
    await expect(expiredPage.getByRole('alert')).toContainText('Слот больше не предлагается');
  } finally {
    await request.post('http://127.0.0.1:3001/__test/clock', {
      headers: { Origin: 'http://127.0.0.1:4174' },
      data: { instant: '2026-10-24T22:00:00.000Z' },
    });
    await Promise.all([owner.close(), active.close(), expired.close()]);
  }
});

test('конфликт revision сохраняет предложенный пояс в черновике до нового просмотра', async ({
  page,
  context,
}) => {
  await page.goto('/owner/availability');
  await page
    .getByRole('textbox', { name: 'Пароль', exact: true })
    .fill('тестовый пароль Владельца');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByLabel('Часовой пояс календаря', { exact: true })).toBeVisible();
  const other = await context.newPage();
  try {
    await other.goto('/owner/availability');
    await expect(other.getByLabel('Понедельник: начало 1', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Изменить пояс вручную' }).click();
    await page.getByLabel('Часовой пояс календаря', { exact: true }).fill('Europe/London');
    await other.getByLabel('Понедельник: начало 1', { exact: true }).fill('08:00');
    await other.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
    await expect(other.getByRole('status')).toContainText('Расписание сохранено');
    await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Расписание изменилось');
    await expect(page.getByLabel('Часовой пояс календаря', { exact: true })).toHaveValue(
      'Europe/London',
    );
    await page.getByRole('button', { name: 'Оставить черновик поверх актуальной версии' }).click();
    await expect(page.getByLabel('Часовой пояс календаря', { exact: true })).toHaveValue(
      'Europe/London',
    );
    await page.getByRole('button', { name: 'Сохранить Расписание', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Новый пояс календаря: Europe/London');
    await page.getByRole('button', { name: 'Подтвердить смену пояса', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Расписание сохранено');
  } finally {
    await other.close();
  }
});
