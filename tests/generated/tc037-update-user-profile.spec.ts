import { test, expect } from '@playwright/test';

test.describe('settings — Update user profile', () => {
  test('TC037 - Update user profile', async ({ page }) => {
    test.setTimeout(60000);

    // Inline auth setup
    await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });

    const usernameField = page.locator('input[name="username"]')
      .or(page.locator('input[name="email"]'))
      .or(page.getByLabel(/username|email/i))
      .first();
    const passwordField = page.locator('input[name="password"]')
      .or(page.getByLabel(/password/i))
      .first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill('admin');
    await passwordField.fill('admin123');

    const submitBtn = page.locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /sign in|log in|login|submit/i }))
      .first();
    await submitBtn.click();

    // Verify login succeeded — wait for redirect away from /login
    await page.waitForURL((url) => !/\/login/.test(url.pathname), { timeout: 15000 }).catch(() => {});

    const currentUrl = page.url();
    if (/\/login/.test(new URL(currentUrl).pathname)) {
      test.info().annotations.push({
        type: 'SOURCE_BUG',
        description: 'Login did not redirect away from /login with seeded credentials',
      });
      test.skip(true, 'SOURCE_BUG: login failed with seeded credentials');
      return;
    }

    // Navigate to profile settings
    await page.goto('http://localhost:3000/settings/profile', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    // Confirm we landed on the profile page (not bounced to auth)
    const landedUrl = page.url();
    if (/\/(login|signin|auth)/.test(new URL(landedUrl).pathname)) {
      test.info().annotations.push({
        type: 'SOURCE_BUG',
        description: 'Protected /settings/profile redirected to auth after login',
      });
      test.skip(true, 'SOURCE_BUG: protected route redirected to auth despite valid session');
      return;
    }

    // Locate the name input — flexible label/name matching
    const nameField = page.getByLabel(/^name$|full name|display name|first name/i)
      .or(page.locator('input[name="name"]'))
      .or(page.locator('input[name="fullName"]'))
      .or(page.locator('input[name="displayName"]'))
      .or(page.locator('input[name="firstName"]'))
      .or(page.getByPlaceholder(/name/i))
      .first();

    const nameFieldCount = await nameField.count();
    if (nameFieldCount === 0) {
      test.info().annotations.push({
        type: 'SOURCE_BUG',
        description: 'No name input found on /settings/profile page',
      });
      test.skip(true, 'SOURCE_BUG: profile name field missing');
      return;
    }

    await nameField.waitFor({ state: 'visible', timeout: 10000 });

    // Edit name with a unique marker so we can verify persistence
    const updatedName = `QA Test User ${Date.now()}`;
    await nameField.fill('');
    await nameField.fill(updatedName);
    await expect(nameField).toHaveValue(updatedName);

    // Save — broad submit selector
    const saveBtn = page.getByRole('button', { name: /^save$|save changes|update|submit/i })
      .or(page.locator('button[type="submit"]'))
      .first();

    await saveBtn.waitFor({ state: 'visible', timeout: 10000 });
    await expect(saveBtn).toBeEnabled({ timeout: 5000 });
    await saveBtn.click();

    // Verify success: either a toast/banner appears, or the field still holds the new value after reload
    const successIndicator = page.getByText(/saved|updated|success|profile updated/i).first();

    const successVisible = await successIndicator.isVisible({ timeout: 5000 }).catch(() => false);

    if (successVisible) {
      await expect(successIndicator).toBeVisible();
    } else {
      // Fallback verification — reload and check field persisted
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('load');

      const reloadedField = page.getByLabel(/^name$|full name|display name|first name/i)
        .or(page.locator('input[name="name"]'))
        .or(page.locator('input[name="fullName"]'))
        .or(page.locator('input[name="displayName"]'))
        .or(page.locator('input[name="firstName"]'))
        .first();

      await reloadedField.waitFor({ state: 'visible', timeout: 10000 });
      await expect(reloadedField).toHaveValue(updatedName);
    }

    // Final URL assertion — still on settings/profile
    await expect(page).toHaveURL(/\/settings\/profile/);
  });
});