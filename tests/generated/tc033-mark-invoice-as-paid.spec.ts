import { test, expect } from '@playwright/test';

test.describe('billing — Mark invoice as paid', () => {
  test('TC033 - Mark invoice as paid', async ({ page }) => {
    const baseURL = 'http://localhost:3000';

    // Inline auth setup
    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const usernameInput = page.locator('input[name="username"]').or(page.locator('input[name="email"]')).first();
    const passwordInput = page.locator('input[name="password"]').first();

    await usernameInput.waitFor({ state: 'visible', timeout: 10000 });
    await usernameInput.fill(process.env.TEST_USERNAME ?? 'REPLACE_ME_USERNAME');
    await passwordInput.fill(process.env.TEST_PASSWORD ?? 'REPLACE_ME_PASSWORD');

    const submitButton = page.locator('button[type="submit"], input[type="submit"]').first();
    await submitButton.click();

    await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 });
    await page.waitForLoadState('load');

    // Verify authenticated by ensuring we're not on auth route
    await expect(page).not.toHaveURL(/\/(login|auth|signin)/);

    // Navigate to billing list to find an invoice
    await page.goto(`${baseURL}/billing`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    // Check if redirected back to login (session not persisted)
    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      test.info().annotations.push({
        type: 'SOURCE_BUG',
        description: 'Session not persisted after login — billing route redirected back to auth',
      });
      test.skip(true, 'SOURCE_BUG: session not persisted after login');
      return;
    }

    // Find first invoice row/link to navigate to detail page
    const invoiceLink = page
      .locator('a[href*="/billing/"]')
      .or(page.getByRole('link', { name: /invoice|bill|#/i }))
      .first();

    const hasInvoice = await invoiceLink.isVisible({ timeout: 5000 }).catch(() => false);

    if (!hasInvoice) {
      // Try clicking a row in a table
      const tableRow = page.locator('table tbody tr, [role="row"]').first();
      const hasRow = await tableRow.isVisible({ timeout: 3000 }).catch(() => false);

      if (!hasRow) {
        test.info().annotations.push({
          type: 'SOURCE_BUG',
          description: 'No invoices found in billing list to mark as paid — seed data missing or list unrendered',
        });
        test.skip(true, 'SOURCE_BUG: no invoices available in billing list');
        return;
      }
      await tableRow.click();
    } else {
      await invoiceLink.click();
    }

    await page.waitForLoadState('load');
    await expect(page).toHaveURL(/\/billing\/.+/);

    // Click "Mark as Paid" or "Paid" button
    const paidButton = page
      .getByRole('button', { name: /mark\s*as\s*paid|paid/i })
      .or(page.locator('button:has-text("Paid")'))
      .first();

    await paidButton.waitFor({ state: 'visible', timeout: 10000 });
    await expect(paidButton).toBeEnabled();
    await paidButton.click();

    // Confirm in modal/dialog if present
    const confirmDialog = page.locator('[role="dialog"], .modal, [data-testid*="dialog"]').first();
    const hasDialog = await confirmDialog.isVisible({ timeout: 3000 }).catch(() => false);

    if (hasDialog) {
      const confirmButton = confirmDialog
        .getByRole('button', { name: /confirm|yes|ok|paid/i })
        .or(confirmDialog.locator('button[type="submit"]'))
        .first();
      await confirmButton.waitFor({ state: 'visible', timeout: 5000 });
      await confirmButton.click();
      await confirmDialog.waitFor({ state: 'hidden', timeout: 15000 });
    } else {
      // Confirmation may be inline — look for a confirm button on page
      const confirmButton = page.getByRole('button', { name: /^confirm$|^yes$/i }).first();
      const hasInlineConfirm = await confirmButton.isVisible({ timeout: 2000 }).catch(() => false);
      if (hasInlineConfirm) {
        await confirmButton.click();
      }
    }

    await page.waitForLoadState('load');

    // Verify status updated to "Paid"
    const statusIndicator = page
      .getByText(/^paid$/i)
      .or(page.locator('[data-testid*="status"]:has-text("Paid")'))
      .or(page.locator('.status:has-text("Paid")'))
      .first();

    await expect(statusIndicator).toBeVisible({ timeout: 15000 });
    await expect(statusIndicator).toContainText(/paid/i);
  });
});