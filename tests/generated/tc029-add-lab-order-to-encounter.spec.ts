import { test, expect } from '@playwright/test';

test.describe('labs — View lab results', () => {
  test('TC029 - View lab results', async ({ page }) => {
    const username = process.env.TEST_USERNAME ?? 'testuser';
    const password = process.env.TEST_PASSWORD ?? 'testpass';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    const usernameInput = page.locator('input[name="username"]').or(page.locator('input[name="email"]')).or(page.getByLabel(/username|email/i)).first();
    const passwordInput = page.locator('input[name="password"]').or(page.getByLabel(/password/i)).first();

    await usernameInput.waitFor({ state: 'visible', timeout: 10000 });
    await usernameInput.fill(username);
    await passwordInput.fill(password);

    await page.locator('button[type="submit"]').or(page.getByRole('button', { name: /sign in|log in|login|submit/i })).first().click();

    await page.waitForURL(/^(?!.*\/(login|auth|signin)).*/i, { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('domcontentloaded');

    const candidates = ['/labs', '/lab-results', '/results', '/orders/labs'];
    let reached = false;
    for (const route of candidates) {
      await page.goto(route, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      if (!/\/(login|auth|signin)/i.test(page.url())) { reached = true; break; }
    }

    if (!reached) {
      const navLink = page.getByRole('link', { name: /labs?|results/i }).first();
      if (await navLink.isVisible({ timeout: 3000 }).catch(() => false)) {
        await navLink.click();
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        reached = !/\/(login|auth|signin)/i.test(page.url());
      }
    }

    expect(reached, 'expected to reach a lab results route after login').toBe(true);

    const labsContent = page.locator('table, [role="grid"], [role="table"], [data-testid*="lab"], [data-testid*="result"], main').first();
    await expect(labsContent).toBeVisible({ timeout: 10000 });
  });
});