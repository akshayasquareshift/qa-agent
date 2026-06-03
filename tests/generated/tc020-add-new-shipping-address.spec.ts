import { test, expect } from '@playwright/test';

test.describe('account — Add new shipping address', () => {
  test('TC020 - Add new shipping address', async ({ page }) => {
    test.setTimeout(60000);

    // Inline auth setup — probe multiple route variants since the app's login path may differ
    const loginRouteCandidates = ['/dk/account/login', '/dk/account', '/dk/login', '/account/login', '/login', '/dk/account/signin', '/dk/sign-in'];

    const emailInput = page.locator(
      'input[name="username"], input[name="email"], input[type="email"], input[autocomplete="email"], input[autocomplete="username"]'
    ).filter({ visible: true }).first();

    const passwordInput = page.locator(
      'input[name="password"], input[type="password"], input[autocomplete="current-password"]'
    ).filter({ visible: true }).first();

    let formFound = false;
    for (const route of loginRouteCandidates) {
      await page.goto(route, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(500);

      // Reveal login form if behind a tab
      const signInTab = page.getByRole('button', { name: /sign\s*in|log\s*in/i }).or(
        page.getByRole('link', { name: /sign\s*in|log\s*in/i })
      ).filter({ visible: true }).first();
      if (await signInTab.isVisible({ timeout: 1500 }).catch(() => false)) {
        await signInTab.click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(500);
      }

      if (await emailInput.isVisible({ timeout: 3000 }).catch(() => false) &&
          await passwordInput.isVisible({ timeout: 1500 }).catch(() => false)) {
        formFound = true;
        break;
      }
    }

    if (!formFound) {
      throw new Error(`STATE: Could not locate a login form on any candidate route. Last URL: ${page.url()}`);
    }

    await emailInput.waitFor({ state: 'visible', timeout: 8000 });
    await emailInput.fill('test@example.com', { timeout: 5000 });
    await passwordInput.fill('TestPassword123!', { timeout: 5000 });

    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').filter({ visible: true }).first()
      .or(page.getByRole('button', { name: /sign\s*in|log\s*in|continue/i }).filter({ visible: true }).first());

    const navWait = page.waitForURL((url) => !/\/(login|signin|sign-in)(\/|$|\?)/.test(url.pathname), { timeout: 15000 }).catch(() => {});
    await submitBtn.click({ timeout: 5000 });
    await navWait;
    await page.waitForLoadState('load');

    // Verify auth success
    const currentUrl = page.url();
    if (/\/(login|signin|sign-in)(\/|$|\?)/.test(new URL(currentUrl).pathname)) {
      throw new Error(`STATE: Login did not succeed — still on auth route: ${currentUrl}`);
    }

    // Navigate to addresses page
    await page.goto('/dk/account/addresses', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    // Confirm we landed on addresses (not redirected to login)
    if (/\/(login|signin|sign-in)(\/|$|\?)/.test(new URL(page.url()).pathname)) {
      throw new Error(`STATE: addresses route redirected to auth: ${page.url()}`);
    }

    // Capture baseline address count for verification later
    const addressCardSelector = '[data-testid*="address"], [class*="address-card"], [class*="AddressCard"], article, li';
    const baselineCount = await page.locator(addressCardSelector).count().catch(() => 0);

    // Step 1: Click "Add address"
    const addAddressBtn = page.getByRole('button', { name: /add\s*(new\s*)?(shipping\s*)?address|new\s*address|add/i })
      .or(page.getByRole('link', { name: /add\s*(new\s*)?(shipping\s*)?address|new\s*address/i }))
      .filter({ visible: true })
      .first();

    await addAddressBtn.waitFor({ state: 'visible', timeout: 10000 });
    await addAddressBtn.click({ timeout: 5000 });

    // Wait for form/modal to render
    const formContainer = page.locator('form, [role="dialog"], [data-testid*="form"], [data-testid*="modal"]')
      .filter({ visible: true })
      .first();
    await formContainer.waitFor({ state: 'visible', timeout: 10000 });

    // Step 2: Fill form
    const firstNameInput = formContainer.locator(
      'input[name*="first" i], input[name*="given" i], input[autocomplete="given-name"]'
    ).filter({ visible: true }).first();

    const lastNameInput = formContainer.locator(
      'input[name*="last" i], input[name*="family" i], input[name*="surname" i], input[autocomplete="family-name"]'
    ).filter({ visible: true }).first();

    const streetInput = formContainer.locator(
      'input[name*="street" i], input[name*="address1" i], input[name*="line1" i], input[autocomplete="address-line1"]'
    ).filter({ visible: true }).first();

    const cityInput = formContainer.locator(
      'input[name*="city" i], input[name*="town" i], input[autocomplete="address-level2"]'
    ).filter({ visible: true }).first();

    const postalInput = formContainer.locator(
      'input[name*="postal" i], input[name*="zip" i], input[name*="postcode" i], input[autocomplete="postal-code"]'
    ).filter({ visible: true }).first();

    const phoneInput = formContainer.locator(
      'input[name*="phone" i], input[type="tel"], input[autocomplete="tel"]'
    ).filter({ visible: true }).first();

    const countrySelect = formContainer.locator(
      'select[name*="country" i], [role="combobox"][name*="country" i], select[autocomplete="country"]'
    ).filter({ visible: true }).first();

    const marker = `QA-${Date.now()}`;

    if (await firstNameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await firstNameInput.fill('Test', { timeout: 3000 });
    }
    if (await lastNameInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await lastNameInput.fill(`User-${marker}`, { timeout: 3000 });
    }
    if (await streetInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await streetInput.fill(`123 Test St ${marker}`, { timeout: 3000 });
    }
    if (await cityInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await cityInput.fill('Copenhagen', { timeout: 3000 });
    }
    if (await postalInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await postalInput.fill('1000', { timeout: 3000 });
    }
    if (await phoneInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await phoneInput.fill('+4512345678', { timeout: 3000 });
    }
    if (await countrySelect.isVisible({ timeout: 1500 }).catch(() => false)) {
      const tag = await countrySelect.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
      if (tag === 'select') {
        await countrySelect.selectOption({ label: /denmark|danmark/i }).catch(async () => {
          await countrySelect.selectOption('DK').catch(() => {});
        });
      }
    }

    // Step 3: Save
    const saveBtn = formContainer.locator('button[type="submit"], input[type="submit"]')
      .filter({ visible: true })
      .first()
      .or(
        page.getByRole('button', { name: /save|submit|create|add\s*address|confirm/i })
          .filter({ visible: true })
          .first()
      );

    await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
    await saveBtn.click({ timeout: 5000 });

    // Wait for modal to close if it was a dialog
    const dialog = page.locator('[role="dialog"]').filter({ visible: true }).first();
    if (await dialog.isVisible({ timeout: 1500 }).catch(() => false)) {
      await dialog.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    }

    await page.waitForLoadState('load');

    // Step 4: Verify in list — either marker appears, count increased, or success message shown
    const markerLocator = page.getByText(new RegExp(marker, 'i')).first();
    const successAlert = page.locator('[role="alert"], [class*="success"], [class*="toast"]').filter({ visible: true }).first();

    let verified = false;

    if (await markerLocator.isVisible({ timeout: 8000 }).catch(() => false)) {
      await expect(markerLocator).toBeVisible();
      verified = true;
    } else {
      const newCount = await page.locator(addressCardSelector).count().catch(() => 0);
      if (newCount > baselineCount) {
        expect(newCount).toBeGreaterThan(baselineCount);
        verified = true;
      } else if (await successAlert.isVisible({ timeout: 2000 }).catch(() => false)) {
        await expect(successAlert).toBeVisible();
        verified = true;
      }
    }

    expect(verified, 'Expected the new address to appear in the list, count to increase, or a success message to show').toBe(true);
  });
});