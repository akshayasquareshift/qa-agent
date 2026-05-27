import { test, expect } from '@playwright/test';

test.describe('auth — Unauthorized access redirects to login', () => {
  test('TC006 - Unauthorized access redirects to login', async ({ page, context }) => {
    // Ensure no authentication state exists
    await context.clearCookies();
    await context.clearPermissions();

    // Attempt to visit protected route while unauthenticated
    await page.goto('http://localhost:3000/dashboard', { waitUntil: 'domcontentloaded' });

    // Wait for any redirect to settle
    await page.waitForLoadState('load');

    // Verify redirect to an auth route (login/signin/auth variants)
    await expect(page).toHaveURL(/\/(login|auth|signin)/, { timeout: 15000 });

    // Confirm we are NOT on the dashboard
    await expect(page).not.toHaveURL(/\/dashboard/);

    // Verify login page UI rendered — try multiple fallbacks for the login form
    const loginIndicator = page.locator(
      'input[type="password"], input[name*="password" i], input[name*="email" i], input[name*="username" i]'
    ).first();

    await loginIndicator.waitFor({ state: 'visible', timeout: 10000 });
    await expect(loginIndicator).toBeVisible();

    // Additional confirmation: look for a submit/login button on the page
    const submitButton = page.locator(
      'button[type="submit"], input[type="submit"]'
    ).first();

    const submitCount = await submitButton.count();
    if (submitCount > 0) {
      await expect(submitButton).toBeVisible({ timeout: 5000 });
    }
  });
});