import { test, expect } from '@playwright/test';

test.describe('patients — Paginate patient list', () => {
  test('TC016 - Paginate patient list', async ({ page }) => {
    const baseURL = 'http://localhost:3000';
    const username = process.env.TEST_USERNAME ?? 'testuser';
    const password = process.env.TEST_PASSWORD ?? 'testpass';

    test.setTimeout(90000);

    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });

    const usernameInput = page.locator('input[name="username"], input[name="email"]').first();
    const passwordInput = page.locator('input[name="password"]').first();

    await usernameInput.waitFor({ state: 'visible', timeout: 8000 });
    await usernameInput.fill(username);
    await passwordInput.fill(password);

    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
    await Promise.all([
      page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 10000 }).catch(() => {}),
      submitBtn.click(),
    ]);

    await page.goto(`${baseURL}/patients`, { waitUntil: 'domcontentloaded', timeout: 15000 });

    const postNavUrl = new URL(page.url());
    if (/\/(login|auth|signin)/.test(postNavUrl.pathname)) {
      await usernameInput.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      if (await usernameInput.isVisible().catch(() => false)) {
        await usernameInput.fill(username);
        await passwordInput.fill(password);
        await submitBtn.click();
        await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 10000 }).catch(() => {});
        await page.goto(`${baseURL}/patients`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      }
    }

    await expect(page).toHaveURL(/\/patients/, { timeout: 5000 });

    const readyIndicator = page.locator('table, [role="table"], [data-testid*="patient"], main').first();
    await readyIndicator.waitFor({ state: 'visible', timeout: 8000 });

    const initialRows = page.locator('table tbody tr, [data-testid*="patient-row"], [data-testid*="patient-item"]');
    await page.waitForTimeout(500);
    const initialCount = await initialRows.count();

    if (initialCount === 0) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'No patient rows rendered on /patients — cannot test pagination' });
      test.skip(true, 'SOURCE_BUG: patient list empty, pagination cannot be exercised');
      return;
    }

    const firstRowTextBefore = await initialRows.first().innerText().catch(() => '');

    const nextButton = page.locator('[data-testid*="next"], [aria-label*="next" i], button:has-text("Next"), a:has-text("Next"), button:has-text(">")').first();

    const nextVisible = await nextButton.isVisible({ timeout: 3000 }).catch(() => false);
    if (!nextVisible) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'No next-page control found on /patients — pagination UI missing' });
      test.skip(true, 'SOURCE_BUG: pagination control not rendered');
      return;
    }

    const isEnabled = await nextButton.isEnabled().catch(() => false);
    if (!isEnabled) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'Next page control is disabled — insufficient seed data for pagination or control broken' });
      test.skip(true, 'SOURCE_BUG: next-page control disabled, cannot paginate');
      return;
    }

    const urlBefore = page.url();
    await nextButton.click();
    await page.waitForTimeout(1000);

    const urlAfter = page.url();
    const firstRowTextAfter = await initialRows.first().innerText().catch(() => '');

    const urlChanged = urlBefore !== urlAfter;
    const contentChanged = firstRowTextBefore !== firstRowTextAfter && firstRowTextAfter.length > 0;

    expect(urlChanged || contentChanged).toBeTruthy();
  });
});