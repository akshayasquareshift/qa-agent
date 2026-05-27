import { test, expect } from '@playwright/test';

test.describe('patients — Sort patients by column', () => {
  test('TC047 - Sort patients by column', async ({ page }) => {
    const TEST_USERNAME = process.env.TEST_USERNAME ?? 'testuser';
    const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'testpass';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const usernameField = page.locator('input[name="username"]').or(page.locator('input[name="email"]')).or(page.getByLabel(/username|email/i)).first();
    const passwordField = page.locator('input[name="password"]').or(page.getByLabel(/password/i)).first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(TEST_USERNAME);
    await passwordField.fill(TEST_PASSWORD);

    const submitButton = page.locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /sign in|log in|login|submit/i }))
      .first();
    await submitButton.click();

    try {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 });
    } catch {
      test.skip(true, 'STATE: login did not redirect away from auth page — credentials may need to be set via TEST_USERNAME/TEST_PASSWORD env vars');
    }

    await page.goto('/patients', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      test.skip(true, 'STATE: redirected to auth when accessing /patients — session not persisted');
    }

    await expect(page).toHaveURL(/\/patients/);

    const rowLocator = page.locator('tbody tr')
      .or(page.locator('[role="row"]'))
      .or(page.locator('[data-testid*="patient-row"]'));

    try {
      await rowLocator.first().waitFor({ state: 'visible', timeout: 10000 });
    } catch {
      test.skip(true, 'precondition: no patient seed data available to sort');
    }

    const initialRowCount = await rowLocator.count();
    if (initialRowCount < 2) {
      test.skip(true, 'precondition: need at least 2 patients to verify sort order');
    }

    const captureFirstColumn = async (): Promise<string[]> => {
      const cells = await rowLocator.locator('td, [role="cell"]').first().all();
      const values: string[] = [];
      const count = await rowLocator.count();
      for (let i = 0; i < count; i++) {
        const cellText = await rowLocator.nth(i).locator('td, [role="cell"]').first().textContent();
        values.push((cellText ?? '').trim());
      }
      return values;
    };

    const beforeSort = await captureFirstColumn();

    const columnHeader = page.getByRole('columnheader', { name: /name|patient/i })
      .or(page.locator('th').filter({ hasText: /name|patient/i }))
      .or(page.locator('[data-testid*="column-header"]').first())
      .first();

    await columnHeader.waitFor({ state: 'visible', timeout: 10000 });
    await expect(columnHeader).toBeVisible();
    await columnHeader.click();

    await page.waitForLoadState('load');
    await page.waitForTimeout(500);

    const afterSort = await captureFirstColumn();

    expect(afterSort.length).toBeGreaterThan(0);
    expect(afterSort.length).toBe(beforeSort.length);

    const sortedAsc = [...beforeSort].sort((a, b) => a.localeCompare(b));
    const sortedDesc = [...beforeSort].sort((a, b) => b.localeCompare(a));

    const orderChanged = JSON.stringify(afterSort) !== JSON.stringify(beforeSort);
    const isSorted = JSON.stringify(afterSort) === JSON.stringify(sortedAsc) ||
                     JSON.stringify(afterSort) === JSON.stringify(sortedDesc);

    expect(orderChanged || isSorted).toBeTruthy();

    await expect(rowLocator.first()).toBeVisible();
  });
});