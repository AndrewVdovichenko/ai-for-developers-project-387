import { expect, test } from '@playwright/test';

// Тексты содержат неразрывные пробелы (typography), поэтому матчинг — регулярками:
// \s захватывает и U+00A0.

test('главная страница открывается', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Календарь звонков');
  await expect(
    page.getByRole('heading', { level: 1, name: /Запись на\s+встречи по\s+ссылке/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /Записаться на\s+встречу/ })).toBeVisible();
});

test('CTA ведёт в каталог', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Записаться на\s+встречу/ }).click();
  await expect(page).toHaveURL(/\/event-types$/);
  await expect(page.getByRole('heading', { level: 1, name: /Типы встречи/ })).toBeVisible();
});

test('из каталога можно вернуться на главную', async ({ page }) => {
  await page.goto('/event-types');
  await page.getByRole('link', { name: /На\s+главную/ }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: /Записаться на\s+встречу/ })).toBeVisible();
});
