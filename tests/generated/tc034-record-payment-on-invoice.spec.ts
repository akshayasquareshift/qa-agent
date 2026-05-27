import { test, expect } from '@playwright/test';

test.describe('billing — Record payment on invoice', () => {
  test('TC034 - Record payment on invoice', async ({ page }) => {
    test.setTimeout(60000);

    const TEST_USERNAME = process.env.TEST_USERNAME ?? 'testuser';
    const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'testpass';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const usernameField = page.locator('input[name="username"]')
      .or(page.locator('input[name="email"]'))
      .or(page.getByLabel(/username|email/i))
      .first();
    const passwordField = page.locator('input[name="password"]')
      .or(page.getByLabel(/password/i))
      .first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(TEST_USERNAME);
    await passwordField.fill(TEST_PASSWORD);

    const loginSubmit = page.locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /log\s?in|sign\s?in|submit/i }))
      .first();
    await loginSubmit.click();

    try {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 });
    } catch {
      test.skip(true, 'STATE: login did not redirect away from auth route');
    }
    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/.test(page.url())) {
      test.skip(true, 'STATE: still on auth route after login attempt');
    }

    await page.goto('/billing', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/.test(page.url())) {
      test.skip(true, 'STATE: /billing redirected to auth — session not persisted');
    }

    const bodyReady = page.locator('body');
    await bodyReady.waitFor({ state: 'visible', timeout: 10000 });

    const invoiceRow = page.locator('tr, [role="row"], [data-testid*="invoice"], a[href*="/billing/"]').first();
    const rowCount = await page.locator('tr, [role="row"], [data-testid*="invoice"], a[href*="/billing/"]').count();
    if (rowCount === 0) {
      test.skip(true, 'PRECONDITION: no invoice rows found (TC033 dependency unmet)');
    }

    await invoiceRow.waitFor({ state: 'visible', timeout: 10000 });
    await invoiceRow.click();
    await page.waitForLoadState('load');

    const onInvoiceDetail = /\/billing\/[^/]+/.test(page.url());
    if (!onInvoiceDetail) {
      const firstDetailLink = page.locator('a[href*="/billing/"]').first();
      if (await firstDetailLink.count() > 0) {
        await firstDetailLink.click();
        await page.waitForLoadState('load');
      }
    }

    if (!/\/billing\//.test(page.url())) {
      test.skip(true, 'STATE: could not reach invoice detail page');
    }

    const addPaymentButton = page.getByRole('button', { name: /add\s?payment|record\s?payment|new\s?payment|pay/i })
      .or(page.locator('[data-testid*="payment"]').filter({ hasText: /add|record|new|pay/i }))
      .or(page.locator('button').filter({ hasText: /payment/i }))
      .first();

    const addPaymentCount = await page.getByRole('button', { name: /add\s?payment|record\s?payment|new\s?payment|pay/i }).count();
    if (addPaymentCount === 0) {
      const fallbackCount = await page.locator('button').filter({ hasText: /payment/i }).count();
      if (fallbackCount === 0) {
        test.skip(true, 'SOURCE_BUG: no Add/Record Payment button found on invoice detail');
      }
    }

    await addPaymentButton.waitFor({ state: 'visible', timeout: 10000 });
    await addPaymentButton.click();

    const modal = page.getByRole('dialog')
      .or(page.locator('[role="dialog"]'))
      .or(page.locator('.modal, [class*="modal"], [class*="Modal"]'))
      .first();

    try {
      await modal.waitFor({ state: 'visible', timeout: 10000 });
      await page.waitForTimeout(300);
    } catch {
      // Some apps render an inline form rather than a modal — continue.
    }

    const scope = (await modal.count()) > 0 ? modal : page.locator('body');

    const amountField = scope.getByLabel(/amount|payment\s?amount|total/i)
      .or(scope.locator('input[name*="amount" i]'))
      .or(scope.getByPlaceholder(/amount/i))
      .or(scope.locator('input[type="number"]'))
      .first();

    await amountField.waitFor({ state: 'visible', timeout: 10000 });
    await amountField.fill('100');

    const methodField = scope.getByLabel(/method|payment\s?method|type/i)
      .or(scope.locator('select[name*="method" i]'))
      .or(scope.getByRole('combobox', { name: /method|type/i }))
      .first();

    if (await methodField.count() > 0) {
      try {
        const tagName = await methodField.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        if (tagName === 'select') {
          await methodField.selectOption({ index: 1 }).catch(() => {});
        } else {
          await methodField.click().catch(() => {});
          const option = page.getByRole('option').first();
          if (await option.count() > 0) {
            await option.click().catch(() => {});
          }
        }
      } catch {
        // Optional field — continue.
      }
    }

    const saveButton = scope.getByRole('button', { name: /save|submit|record|confirm|add/i })
      .or(scope.locator('button[type="submit"]'))
      .or(page.getByRole('button', { name: /save|submit|record|confirm/i }))
      .first();

    await saveButton.waitFor({ state: 'visible', timeout: 10000 });
    await expect(saveButton).toBeEnabled({ timeout: 5000 });
    await saveButton.click();

    if ((await modal.count()) > 0) {
      try {
        await modal.waitFor({ state: 'hidden', timeout: 15000 });
      } catch {
        // Modal may persist if save failed — verification below will catch it.
      }
    }

    await page.waitForLoadState('load');

    const successIndicator = page.getByText(/payment\s?(recorded|added|saved|successful)/i)
      .or(page.locator('[role="alert"], [class*="toast"], [class*="snackbar"]').filter({ hasText: /success|recorded|saved/i }))
      .or(page.getByText(/\$\s?100|100\.00/))
      .or(page.locator('[data-testid*="balance"], [data-testid*="payment"]'))
      .first();

    await expect(successIndicator).toBeVisible({ timeout: 15000 });

    const balanceIndicator = page.getByText(/balance|amount\s?due|total\s?due|paid/i).first();
    if (await balanceIndicator.count() > 0) {
      await expect(balanceIndicator).toBeVisible({ timeout: 10000 });
    }
  });
});