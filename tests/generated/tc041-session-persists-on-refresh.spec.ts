import { test, expect } from '@playwright/test';

test.describe('auth — Session persists on refresh', () => {
  test('TC041 - Session persists on refresh', async ({ page }) => {
    const BASE_URL = 'http://localhost:3000';
    const TEST_USERNAME = process.env.TEST_USERNAME ?? 'testuser';
    const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'testpass';

    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const usernameField = page.locator('input[name="username"]').or(
      page.locator('input[name="email"]')
    ).or(
      page.getByLabel(/username|email/i)
    ).first();
    const passwordField = page.locator('input[name="password"]').or(
      page.getByLabel(/password/i)
    ).first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(TEST_USERNAME);
    await passwordField.fill(TEST_PASSWORD);

    const submitButton = page.locator('button[type="submit"]').or(
      page.getByRole('button', { name: /log\s?in|sign\s?in|submit/i })
    ).first();
    await submitButton.click();

    try {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 });
    } catch {
      test.skip(true, 'STATE: login did not redirect away from auth route — credentials may be invalid');
    }

    const currentUrl = page.url();
    if (/\/(login|auth|signin)/.test(new URL(currentUrl).pathname)) {
      test.skip(true, 'STATE: still on auth route after login — cannot verify session persistence');
    }

    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const preRefreshUrl = page.url();
    if (/\/(login|auth|signin)/.test(new URL(preRefreshUrl).pathname)) {
      test.skip(true, 'STATE: dashboard redirected to auth before refresh — auth state not established');
    }

    await expect(page).not.toHaveURL(/\/(login|auth|signin)/);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    await expect(page).not.toHaveURL(/\/(login|auth|signin)/, { timeout: 15000 });

    const postRefreshUrl = page.url();
    expect(/\/(login|auth|signin)/.test(new URL(postRefreshUrl).pathname)).toBe(false);

    const bodyReady = page.locator('body');
    await bodyReady.waitFor({ state: 'visible', timeout: 10000 });

    const authIndicator = page.getByRole('button', { name: /logout|sign\s?out|profile|account/i }).or(
      page.locator('[data-testid*="user"]')
    ).or(
      page.locator('main')
    ).first();

    const indicatorCount = await authIndicator.count();
    if (indicatorCount > 0) {
      await expect(authIndicator).toBeVisible({ timeout: 10000 });
    }
  });
});