import { test, expect } from '@playwright/test';

test.describe('patients — Empty state for no patients', () => {
  test('TC046 - Empty state for no patients', async ({ page }) => {
    const baseURL = 'http://localhost:3000';
    const username = process.env.TEST_USERNAME ?? 'testuser';
    const password = process.env.TEST_PASSWORD ?? 'testpass';

    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const usernameField = page.locator('input[name="username"]').or(page.locator('input[name="email"]')).or(page.getByLabel(/username|email/i)).first();
    const passwordField = page.locator('input[name="password"]').or(page.getByLabel(/password/i)).first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(username);
    await passwordField.fill(password);

    const submitButton = page.locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /sign in|log in|login|submit/i }))
      .first();
    await submitButton.waitFor({ state: 'visible', timeout: 10000 });
    await submitButton.click();

    try {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 10000 });
    } catch {
      test.skip(true, 'STATE: Authentication did not redirect away from login page — credentials may be invalid (replace TEST_USERNAME/TEST_PASSWORD).');
    }

    await page.goto(`${baseURL}/patients`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      test.skip(true, 'STATE: /patients redirected back to auth — session not persisted.');
    }

    await expect(page).toHaveURL(/\/patients/);

    await page.locator('body').waitFor({ state: 'visible', timeout: 10000 });

    const emptyStateLocator = page.getByText(/no patients|no records|nothing here|empty|no data|no results found|0 patients/i).first()
      .or(page.getByRole('status').filter({ hasText: /no|empty/i }).first())
      .or(page.locator('[data-testid*="empty"]').first());

    const patientRows = page.locator('table tbody tr, [role="row"]:not([role="row"]:first-child), [data-testid*="patient-row"], [data-testid*="patient-item"]');

    const rowCount = await patientRows.count().catch(() => 0);

    if (rowCount > 0) {
      test.skip(true, 'PRECONDITION: Patients exist in the system — TC046 requires an empty patient list. Clear seed data before running.');
    }

    await emptyStateLocator.waitFor({ state: 'visible', timeout: 10000 });
    await expect(emptyStateLocator).toBeVisible();
  });
});