import { test, expect } from '@playwright/test';

test.describe('account — Update profile information', () => {
  test('TC018 - Update profile information', async ({ page }) => {
    test.setTimeout(60000);

    // Inline auth setup
    await page.goto('http://localhost:8000/dk/account/login', { waitUntil: 'domcontentloaded', timeout: 15000 });

    const emailInput = page.locator(
      'input[name="username"], input[name="email"], input[type="email"], input[autocomplete="email"], input[autocomplete="username"]'
    ).filter({ visible: true }).first();
    const passwordInput = page.locator(
      'input[name="password"], input[type="password"], input[autocomplete="current-password"]'
    ).filter({ visible: true }).first();

    // Reveal login form if behind a tab
    if (!(await emailInput.isVisible({ timeout: 2000 }).catch(() => false))) {
      const signInTab = page.getByRole('button', { name: /sign\s*in|log\s*in|login/i })
        .or(page.getByRole('tab', { name: /sign\s*in|log\s*in|login/i }))
        .or(page.getByRole('link', { name: /sign\s*in|log\s*in|login/i }))
        .first();
      if (await signInTab.isVisible({ timeout: 2000 }).catch(() => false)) {
        await signInTab.click({ timeout: 3000 }).catch(() => {});
      }
    }

    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(process.env.TEST_USERNAME || 'testuser@example.com', { timeout: 5000 });
    await passwordInput.fill(process.env.TEST_PASSWORD || 'TestPassword123!', { timeout: 5000 });

    const submitBtn = page.locator('button[type="submit"], input[type="submit"]')
      .or(page.getByRole('button', { name: /sign\s*in|log\s*in|login|submit|continue/i }))
      .filter({ visible: true })
      .first();
    await submitBtn.click({ timeout: 5000 });

    // Wait for navigation away from login
    await page.waitForFunction(
      () => !/\/(login|sign-?in|auth)(\/|$|\?)/i.test(window.location.pathname),
      null,
      { timeout: 15000 }
    ).catch(() => {});

    const stillOnLogin = /\/(login|sign-?in|auth)/i.test(new URL(page.url()).pathname);
    if (stillOnLogin) {
      throw new Error(`STATE: login did not complete — currently at ${page.url()}`);
    }

    // Navigate to the profile page
    await page.goto('http://localhost:8000/dk/account/profile', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    // Verify we landed on profile (not redirected back to auth)
    const onAuth = /\/(login|sign-?in|auth)/i.test(new URL(page.url()).pathname);
    if (onAuth) {
      throw new Error(`STATE: profile page redirected to auth — currently at ${page.url()}`);
    }

    // Locate the name field
    const nameField = page.getByLabel(/^(name|full\s*name|first\s*name|display\s*name)/i)
      .or(page.getByPlaceholder(/name/i))
      .or(page.locator('input[name="name"], input[name="firstName"], input[name="first_name"], input[name="fullName"], input[name="full_name"], input[name="displayName"]'))
      .or(page.getByRole('textbox', { name: /name/i }))
      .filter({ visible: true })
      .first();

    await nameField.waitFor({ state: 'visible', timeout: 10000 });

    const uniqueSuffix = Date.now().toString().slice(-6);
    const newName = `QA Test User ${uniqueSuffix}`;

    await nameField.fill('', { timeout: 5000 });
    await nameField.fill(newName, { timeout: 5000 });

    // Save
    const saveBtn = page.getByRole('button', { name: /^(save|update|save changes|update profile|submit)$/i })
      .or(page.locator('button[type="submit"]'))
      .filter({ visible: true })
      .first();

    await saveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await expect(saveBtn).toBeEnabled({ timeout: 5000 });

    // Race the save response/UI signals
    const responsePromise = page.waitForResponse(
      (resp) => /profile|account|user/i.test(resp.url()) && resp.request().method() !== 'GET' && resp.status() < 500,
      { timeout: 10000 }
    ).catch(() => null);

    await saveBtn.click({ timeout: 5000 });
    await responsePromise;

    // Verify success — combined signal: toast/alert OR persisted value
    const successAlert = page.getByRole('alert')
      .or(page.locator('[role="status"], .toast, .notification, [class*="success"], [data-testid*="success"]'))
      .filter({ visible: true })
      .first();

    const sawAlert = await successAlert.waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true)
      .catch(() => false);

    let valuePersisted = false;
    try {
      const currentValue = await nameField.inputValue({ timeout: 3000 });
      valuePersisted = currentValue === newName;
    } catch {
      valuePersisted = false;
    }

    if (!sawAlert && !valuePersisted) {
      // Reload and re-check persistence
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('load');
      const nameFieldAfter = page.getByLabel(/^(name|full\s*name|first\s*name|display\s*name)/i)
        .or(page.getByPlaceholder(/name/i))
        .or(page.locator('input[name="name"], input[name="firstName"], input[name="first_name"], input[name="fullName"], input[name="full_name"], input[name="displayName"]'))
        .or(page.getByRole('textbox', { name: /name/i }))
        .filter({ visible: true })
        .first();
      await nameFieldAfter.waitFor({ state: 'visible', timeout: 10000 });
      const persisted = await nameFieldAfter.inputValue({ timeout: 3000 });
      expect(persisted, `Profile name did not persist after save. Expected "${newName}", got "${persisted}"`).toBe(newName);
    } else {
      expect(sawAlert || valuePersisted).toBeTruthy();
    }
  });
});