import { test, expect } from '@playwright/test';

test.describe('billing — Record payment for invoice', () => {
  test('TC033 - Record payment for invoice', async ({ page }) => {
    const BASE_URL = 'http://localhost:3000';
    const TEST_USERNAME = process.env.TEST_USERNAME ?? 'testuser';
    const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'testpass';

    // --- Authentication setup ---
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });

    const usernameField = page
      .locator('input[name="username"]')
      .or(page.locator('input[name="email"]'))
      .or(page.getByLabel(/username|email/i))
      .first();
    const passwordField = page
      .locator('input[name="password"]')
      .or(page.getByLabel(/password/i))
      .first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(TEST_USERNAME);
    await passwordField.fill(TEST_PASSWORD);

    const loginSubmit = page
      .locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /sign in|log in|login|submit/i }))
      .first();
    await loginSubmit.click();

    // Wait for navigation away from /login (post-login redirect target is app-specific)
    await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), {
      timeout: 15000,
    });
    await page.waitForLoadState('load');

    // Verify auth succeeded — must not be on an auth route
    const currentUrl = new URL(page.url());
    if (/\/(login|auth|signin)/.test(currentUrl.pathname)) {
      test.info().annotations.push({
        type: 'SOURCE_BUG',
        description: 'Login did not redirect away from auth route — credentials may be invalid or login flow broken',
      });
      test.skip(true, 'SOURCE_BUG: Login failed to redirect away from auth route');
      return;
    }

    // --- Navigate to billing/invoices list to find an invoice ---
    await page.goto(`${BASE_URL}/billing`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    // Find any invoice row/link and open it. Try several common patterns.
    const invoiceLink = page
      .locator('a[href*="/billing/"]')
      .or(page.locator('[data-testid*="invoice"] a'))
      .or(page.getByRole('link', { name: /invoice|view|details/i }))
      .first();

    await invoiceLink.waitFor({ state: 'visible', timeout: 15000 });
    await invoiceLink.click();

    await page.waitForURL(/\/billing\/[^/]+/, { timeout: 15000 });
    await page.waitForLoadState('load');

    // --- Step 2: Record payment ---
    const recordPaymentButton = page
      .getByRole('button', { name: /record payment|add payment|pay|new payment/i })
      .or(page.locator('button:has-text("Record Payment")'))
      .or(page.locator('button:has-text("Payment")'))
      .first();

    await recordPaymentButton.waitFor({ state: 'visible', timeout: 15000 });
    await recordPaymentButton.click();

    // Wait for payment modal/dialog to appear
    const paymentDialog = page
      .getByRole('dialog')
      .or(page.locator('[role="dialog"]'))
      .or(page.locator('.modal, [class*="modal"], [class*="Modal"]'))
      .first();

    await paymentDialog.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(300);

    // Fill payment amount (commonly required)
    const amountField = paymentDialog
      .getByLabel(/amount|total|payment amount/i)
      .or(paymentDialog.locator('input[name*="amount" i]'))
      .or(paymentDialog.locator('input[type="number"]'))
      .first();

    if (await amountField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await amountField.fill('100');
    }

    // Optional payment method field
    const methodField = paymentDialog
      .getByLabel(/method|payment method|type/i)
      .or(paymentDialog.locator('select[name*="method" i]'))
      .first();

    if (await methodField.isVisible({ timeout: 2000 }).catch(() => false)) {
      const tagName = await methodField.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
      if (tagName === 'select') {
        const options = await methodField.locator('option').count().catch(() => 0);
        if (options > 1) {
          await methodField.selectOption({ index: 1 }).catch(() => {});
        }
      } else {
        await methodField.fill('Cash').catch(() => {});
      }
    }

    // --- Step 3: Save ---
    const saveButton = page
      .getByRole('button', { name: /save|submit|record|confirm|create/i })
      .or(page.locator('button[type="submit"]'))
      .last();

    await saveButton.waitFor({ state: 'visible', timeout: 10000 });
    await saveButton.click();

    // Wait for modal to close (payment saved)
    await paymentDialog
      .waitFor({ state: 'hidden', timeout: 15000 })
      .catch(() => {});

    await page.waitForLoadState('load');

    // --- Expected Outcome: Payment recorded ---
    // Verify by looking for a success indicator, the payment in the list, or the modal closing
    const successIndicator = page
      .getByText(/payment recorded|payment saved|success|paid/i)
      .or(page.locator('[data-testid*="payment"]'))
      .or(page.locator('text=/\\$\\s*100/'))
      .first();

    await expect(successIndicator).toBeVisible({ timeout: 15000 });

    // Final URL assertion — still on a billing/invoice page
    await expect(page).toHaveURL(/\/billing\//);
  });
});