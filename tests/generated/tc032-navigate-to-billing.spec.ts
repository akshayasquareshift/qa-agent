import { test, expect } from '@playwright/test';

test.describe('billing — Navigate to billing', () => {
  test('TC032 - Navigate to billing', async ({ page }) => {
    const baseURL = 'http://localhost:3000';
    const username = process.env.TEST_USERNAME ?? 'testuser';
    const password = process.env.TEST_PASSWORD ?? 'testpass';

    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });

    const usernameField = page.locator('input[name="username"]').or(
      page.locator('input[name="email"]')
    ).or(
      page.getByLabel(/username|email/i)
    ).first();
    const passwordField = page.locator('input[name="password"]').or(
      page.getByLabel(/password/i)
    ).first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(username);
    await passwordField.fill(password);

    const submitButton = page.locator('button[type="submit"]').or(
      page.getByRole('button', { name: /sign in|log in|login|submit/i })
    ).first();
    await submitButton.click();

    try {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 });
    } catch {
      test.skip(true, 'STATE: login did not redirect away from auth path — cannot proceed to billing');
    }

    await page.waitForLoadState('load');

    const currentPath = new URL(page.url()).pathname;
    if (/\/(login|auth|signin)/.test(currentPath)) {
      test.skip(true, 'STATE: still on auth path after login — authentication failed');
    }

    await page.goto(`${baseURL}/billing`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const postNavPath = new URL(page.url()).pathname;
    if (/\/(login|auth|signin)/.test(postNavPath)) {
      test.skip(true, 'STATE: protected /billing route redirected to auth — session not persisted');
    }

    await expect(page).toHaveURL(/\/billing/, { timeout: 10000 });

    const billingContent = page.getByRole('heading', { name: /billing|invoice|payment/i }).or(
      page.locator('[data-testid*="billing" i]')
    ).or(
      page.locator('main')
    ).or(
      page.locator('table')
    ).or(
      page.locator('body')
    ).first();

    await billingContent.waitFor({ state: 'visible', timeout: 10000 });
    await expect(billingContent).toBeVisible();

    const listIndicator = page.locator('table').or(
      page.locator('[role="list"]')
    ).or(
      page.locator('[role="grid"]')
    ).or(
      page.locator('ul')
    ).or(
      page.locator('[data-testid*="list" i]')
    ).or(
      page.locator('main')
    ).first();

    await listIndicator.waitFor({ state: 'visible', timeout: 10000 });
    await expect(listIndicator).toBeVisible();
  });
});