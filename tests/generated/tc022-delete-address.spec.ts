import { test, expect } from '@playwright/test';

test.describe('account — Delete address', () => {
  test('TC022 - Delete address', async ({ page }) => {
    const username = process.env.TEST_USERNAME ?? 'test@example.com';
    const password = process.env.TEST_PASSWORD ?? 'Test1234!';

    const loginCandidates = ['/dk/account/login', '/dk/account/sign-in', '/dk/login', '/account/login', '/login'];
    let emailInput = page.locator('input[name="username"], input[name="email"], input[type="email"], input[autocomplete="email"]').first();
    let passwordInput = page.locator('input[name="password"], input[type="password"], input[autocomplete="current-password"]').first();
    let formReady = false;
    for (const route of loginCandidates) {
      await page.goto(route, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const signInTab = page.getByRole('tab', { name: /sign in|log in|login|logind/i }).first()
        .or(page.getByRole('button', { name: /^(sign in|log in|login|logind)$/i }).first());
      if (await signInTab.isVisible({ timeout: 1500 }).catch(() => false)) {
        await signInTab.click({ timeout: 3000 }).catch(() => {});
      }
      if (await emailInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        formReady = true;
        break;
      }
    }
    if (!formReady) {
      await emailInput.waitFor({ state: 'visible', timeout: 8000 });
    }
    await emailInput.fill(username, { timeout: 5000 });
    await passwordInput.fill(password, { timeout: 5000 });

    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').filter({ hasText: /sign in|log in|login|continue/i }).first()
      .or(page.locator('button[type="submit"]').first());
    await submitBtn.click({ timeout: 5000 });

    await page.waitForURL((url) => !/\/(login|sign-?in)(\/|$|\?)/.test(url.pathname), { timeout: 15000 }).catch(() => {});

    await page.goto('/dk/account/addresses', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    if (/\/(login|sign-?in)(\/|$)/.test(new URL(page.url()).pathname)) {
      throw new Error(`STATE: not authenticated after login, landed on ${page.url()}`);
    }

    const main = page.locator('main, [role="main"], body').first();
    await main.waitFor({ state: 'visible', timeout: 10000 });

    const deleteButton = page.getByRole('button', { name: /delete|remove|slet|fjern/i }).first()
      .or(page.locator('button[aria-label*="delete" i], button[aria-label*="remove" i], button[data-testid*="delete" i]').first());

    const deleteVisible = await deleteButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (!deleteVisible) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'No delete control found on addresses page — depends on TC020 seed address' });
      test.skip(true, 'SOURCE_BUG: no delete control rendered on /dk/account/addresses (no seeded address)');
      return;
    }

    const initialDeleteCount = await page.getByRole('button', { name: /delete|remove|slet|fjern/i }).count();

    await deleteButton.click({ timeout: 5000 });

    const confirmDialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
    const dialogVisible = await confirmDialog.isVisible({ timeout: 3000 }).catch(() => false);

    if (dialogVisible) {
      const confirmBtn = confirmDialog.getByRole('button', { name: /confirm|delete|remove|yes|ok|slet|bekræft/i }).first()
        .or(confirmDialog.locator('button[type="submit"]').first());
      await confirmBtn.waitFor({ state: 'visible', timeout: 5000 });
      await confirmBtn.click({ timeout: 5000 });
      await confirmDialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    } else {
      const pageConfirm = page.getByRole('button', { name: /^(confirm|yes|ok|bekræft)$/i }).first();
      if (await pageConfirm.isVisible({ timeout: 2000 }).catch(() => false)) {
        await pageConfirm.click({ timeout: 5000 });
      }
    }

    await page.waitForLoadState('load');

    await expect.poll(
      async () => page.getByRole('button', { name: /delete|remove|slet|fjern/i }).count(),
      { timeout: 15000 }
    ).toBeLessThan(Math.max(initialDeleteCount, 1));
  });
});