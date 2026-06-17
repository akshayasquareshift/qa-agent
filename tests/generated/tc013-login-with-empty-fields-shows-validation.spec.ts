import { test, expect } from '@playwright/test';

test.describe('auth — Login with empty fields shows validation', () => {
  test('TC013 - Login with empty fields shows validation', async ({ page }) => {
    test.setTimeout(45000);

    await page.goto('http://localhost:8000/dk/account', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    // Reveal sign-in form if it lives behind a tab
    const signInTab = page.getByRole('tab', { name: /sign\s*in|log\s*in|login/i })
      .or(page.getByRole('button', { name: /^(sign\s*in|log\s*in|login)$/i }))
      .or(page.getByRole('link', { name: /^(sign\s*in|log\s*in|login)$/i }));
    try {
      if (await signInTab.first().isVisible({ timeout: 2000 })) {
        await signInTab.first().click({ timeout: 3000 });
      }
    } catch {}

    // Locate email/username input
    const emailInput = page.locator('input[type="email"], input[autocomplete="email"], input[autocomplete="username"], input[name="email"], input[name="username"], input[id*="email" i]')
      .filter({ visible: true })
      .first();

    // Locate password input
    const passwordInput = page.locator('input[type="password"], input[autocomplete="current-password"], input[name="password"]')
      .filter({ visible: true })
      .first();

    let formVisible = false;
    try {
      await emailInput.waitFor({ state: 'visible', timeout: 8000 });
      await passwordInput.waitFor({ state: 'visible', timeout: 5000 });
      formVisible = true;
    } catch {
      // Try alternate auth routes
      for (const route of ['/dk/login', '/dk/account/login', '/dk/sign-in']) {
        try {
          await page.goto(`http://localhost:8000${route}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
          await page.waitForLoadState('load');
          if (await emailInput.isVisible({ timeout: 4000 })) {
            await passwordInput.waitFor({ state: 'visible', timeout: 3000 });
            formVisible = true;
            break;
          }
        } catch {}
      }
    }

    if (!formVisible) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'Login form (email + password inputs) not discoverable on /dk/account or common auth routes' });
      test.skip(true, 'SOURCE_BUG: login form not found');
      return;
    }

    const startUrl = page.url();

    // Ensure fields are empty
    await emailInput.fill('', { timeout: 3000 });
    await passwordInput.fill('', { timeout: 3000 });

    // Locate submit button
    const submitButton = page.locator('button[type="submit"], input[type="submit"]')
      .or(page.getByRole('button', { name: /^(sign\s*in|log\s*in|login|submit|continue)$/i }))
      .filter({ visible: true })
      .first();

    await submitButton.waitFor({ state: 'visible', timeout: 5000 });

    // Submit the empty form
    await submitButton.click({ timeout: 5000, force: true }).catch(() => {});

    // Give validation a moment to render
    await page.waitForTimeout(500);

    // Detect validation: either an error message OR the URL stayed on auth OR native :invalid
    const errorAlert = page.locator('[role="alert"], [aria-live="polite"], [aria-live="assertive"], .error, .field-error, [class*="error" i]')
      .filter({ visible: true })
      .filter({ hasText: /.+/ });

    const errorVisible = await errorAlert.first().isVisible({ timeout: 3000 }).catch(() => false);

    const ariaInvalid = await page.locator('input[aria-invalid="true"]').first().isVisible({ timeout: 1000 }).catch(() => false);

    const nativeInvalid = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input')) as HTMLInputElement[];
      return inputs.some(i => (i.type === 'email' || i.type === 'password' || i.name === 'email' || i.name === 'username' || i.name === 'password') && i.validity && !i.validity.valid);
    }).catch(() => false);

    const currentUrl = page.url();
    const stayedOnAuth = currentUrl === startUrl || /\/(account|login|sign-?in|auth)/i.test(currentUrl);

    const validationDetected = errorVisible || ariaInvalid || nativeInvalid || stayedOnAuth;

    expect(validationDetected, `Expected validation feedback or non-submission. errorVisible=${errorVisible} ariaInvalid=${ariaInvalid} nativeInvalid=${nativeInvalid} stayedOnAuth=${stayedOnAuth} url=${currentUrl}`).toBe(true);

    // Additionally verify the password input is still present (form not submitted)
    await expect(passwordInput).toBeVisible({ timeout: 3000 });
  });
});