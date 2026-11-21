import { expect, test } from '@playwright/test';

const password = 'тестовый пароль Владельца'; // betterleaks:allow -- public test fixture
test('вход, внутренний возврат, перезагрузка и выход', async ({ page }) => {
  await page.goto('/owner/availability?tab=week');
  await expect(page).toHaveURL(/\/owner\/login\?returnTo=/);
  await page.getByRole('textbox', { name: 'Пароль', exact: true }).fill('неверный');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Неверный пароль');
  await page.getByRole('textbox', { name: 'Пароль', exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL('/owner/availability?tab=week');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page).toHaveURL('/owner/login');
  await page.goto('/owner/bookings');
  await expect(page).toHaveURL(/\/owner\/login\?returnTo=/);
});

test('внешний возврат отклонён; сетевой сбой отличается от неверного пароля', async ({ page }) => {
  await page.goto('/owner/login?returnTo=https://example.com/');
  await page.getByRole('textbox', { name: 'Пароль', exact: true }).fill(password);
  await page.route('**/api/owner/session', (route) =>
    route.request().method() === 'POST' ? route.abort() : route.continue(),
  );
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Нет соединения/);
  await expect(page.getByRole('textbox', { name: 'Пароль', exact: true })).toHaveValue(password);
  await page.unroute('**/api/owner/session');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page).toHaveURL('/owner/event-types');
  await page.route('**/api/owner/session', (route) =>
    route.request().method() === 'DELETE' ? route.abort() : route.continue(),
  );
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/Не удалось подтвердить выход/);
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
});
