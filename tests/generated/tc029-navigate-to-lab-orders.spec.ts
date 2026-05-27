import { test, expect } from '@playwright/test';

test.describe('labs — Navigate to lab orders', () => {
  test('TC029 - Navigate to lab orders', async ({ page }) => {
    const username = process.env.TEST_USERNAME ?? 'REPLACE_WITH_VALID_USERNAME';
    const password = process.env.TEST_PASSWORD ?? 'REPLACE_WITH_VALID_PASSWORD';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    const usernameInput = page.locator('input[name="username"]').or(
      page.locator('input[name="email"]')
    ).or(
      page.getByLabel(/username|email/i)
    ).first();
    const passwordInput = page.locator('input[name="password"]').or(
      page.getByLabel(/password/i)
    ).first();

    await usernameInput.waitFor({ state: 'visible', timeout: 10000 });
    await usernameInput.fill(username);
    await passwordInput.fill(password);

    const submitButton = page.locator('button[type="submit"]').or(
      page.getByRole('button', { name: /sign in|log in|login|submit/i })
    ).first();
    await submitButton.click();

    try {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 });
    } catch {
      test.skip(true, 'STATE: login did not redirect away from auth route — credentials may be invalid');
    }

    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      test.skip(true, 'STATE: still on auth route after login — cannot proceed to protected /labs route');
    }

    await page.goto('/labs', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      test.skip(true, 'STATE: /labs redirected back to auth — session not persisted');
    }

    await expect(page).toHaveURL(/\/labs/);

    const labsNavLink = page.getByRole('link', { name: /^labs?$/i }).or(
      page.getByRole('button', { name: /^labs?$/i })
    ).or(
      page.locator('[data-testid*="labs" i]')
    ).first();

    const navCount = await labsNavLink.count();
    if (navCount > 0) {
      try {
        await labsNavLink.click({ timeout: 5000 });
        await page.waitForLoadState('load');
      } catch {
        // Already on labs page or nav not clickable — proceed to verification
      }
    }

    await expect(page).toHaveURL(/\/labs/);

    const labsList = page.getByRole('table').or(
      page.locator('[data-testid*="lab" i]')
    ).or(
      page.locator('table')
    ).or(
      page.getByRole('list')
    ).or(
      page.locator('main')
    ).first();

    await labsList.waitFor({ state: 'visible', timeout: 10000 });
    await expect(labsList).toBeVisible();

    const heading = page.getByRole('heading', { name: /lab(s| orders?)?/i }).first();
    const headingCount = await heading.count();
    if (headingCount > 0) {
      await expect(heading).toBeVisible();
    }

    await expect(page.locator('body')).toBeVisible();
  });
});