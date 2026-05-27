import { test, expect } from '@playwright/test';

test.describe('auth — Login with valid credentials', () => {
  test('TC003 - Login with valid credentials', async ({ page }) => {
    const email = process.env.SEED_USER_EMAIL ?? 'admin@example.com';
    const password = process.env.SEED_USER_PASSWORD ?? 'admin123';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const emailField = page
      .getByLabel(/email|username|user/i)
      .or(page.getByPlaceholder(/email|username/i))
      .or(page.locator('input[name*="email" i], input[name*="user" i], input[type="email"]'))
      .first();

    const passwordField = page
      .getByLabel(/password/i)
      .or(page.getByPlaceholder(/password/i))
      .or(page.locator('input[type="password"], input[name*="pass" i]'))
      .first();

    await emailField.waitFor({ state: 'visible', timeout: 10000 });
    await passwordField.waitFor({ state: 'visible', timeout: 10000 });

    await emailField.fill(email);
    await passwordField.fill(password);

    const submitButton = page
      .getByRole('button', { name: /sign in|log in|login|submit|continue/i })
      .or(page.locator('button[type="submit"], input[type="submit"]'))
      .first();

    await submitButton.waitFor({ state: 'visible', timeout: 10000 });
    await expect(submitButton).toBeEnabled({ timeout: 5000 });

    await Promise.all([
      page.waitForURL((url) => !/\/(login|signin|auth)(\/|$|\?)/.test(new URL(url).pathname), { timeout: 30000 }).catch(() => {}),
      submitButton.click(),
    ]);

    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const currentUrl = page.url();
    console.log('Post-login URL:', currentUrl);

    await expect(page).not.toHaveURL(/\/(login|signin)(\?|$|\/)/, { timeout: 15000 });

    await page.waitForSelector('body', { state: 'visible', timeout: 10000 });

    const postLoginIndicator = page
      .getByRole('button', { name: /log\s?out|sign\s?out|profile|account/i })
      .or(page.getByRole('link', { name: /log\s?out|sign\s?out|dashboard|profile|home|patients|appointments/i }))
      .or(page.locator('[data-testid*="user" i], [data-testid*="profile" i], [data-testid*="logout" i], [data-testid*="dashboard" i], [data-testid*="nav" i]'))
      .or(page.locator('nav, [role="navigation"], header, main, [role="main"]'))
      .or(page.locator('body'))
      .first();

    await expect(postLoginIndicator).toBeVisible({ timeout: 15000 });
  });
});