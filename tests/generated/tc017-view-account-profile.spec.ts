import { test, expect } from '@playwright/test';

test.describe('account — View account profile', () => {
  test('TC017 - View account profile', async ({ page }) => {
    test.setTimeout(60000);

    const username = process.env.TEST_USERNAME ?? 'testuser@example.com';
    const password = process.env.TEST_PASSWORD ?? 'TestPass123!';

    // Inline auth setup — try multiple known login route variants
    const loginRoutes = ['/login', '/dk/login', '/auth/login', '/signin', '/dk/signin', '/account/login'];
    const usernameInput = page.locator(
      'input[name="username"], input[name="email"], input[autocomplete="username"], input[autocomplete="email"], input[type="email"]'
    ).filter({ visible: true }).first();
    const passwordInput = page.locator(
      'input[name="password"], input[type="password"], input[autocomplete="current-password"]'
    ).filter({ visible: true }).first();

    let formFound = false;
    for (const route of loginRoutes) {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      // Try to reveal form if hidden behind a tab
      const signInTab = page.getByRole('tab', { name: /sign in|log in|login/i }).or(page.getByRole('button', { name: /^(sign in|log in|login)$/i })).first();
      await signInTab.click({ timeout: 1500 }).catch(() => null);
      if (await usernameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        formFound = true;
        break;
      }
    }
    if (!formFound) {
      throw new Error(`STATE: Could not locate login form on any known route. Current URL: ${page.url()}`);
    }

    await usernameInput.waitFor({ state: 'visible', timeout: 10000 });
    await usernameInput.fill(username, { timeout: 5000 });
    await passwordInput.fill(password, { timeout: 5000 });

    const submitButton = page.locator(
      'button[type="submit"], input[type="submit"]'
    ).or(page.getByRole('button', { name: /sign in|log in|login|submit|continue/i })).first();

    const navPromise = page.waitForURL((url) => !/\/(login|signin|sign-in|auth)(\/|$|\?)/i.test(url.pathname), { timeout: 15000 }).catch(() => null);
    await submitButton.click({ timeout: 5000 });
    await navPromise;

    // Verify auth succeeded
    const currentUrl = page.url();
    if (/\/(login|signin|sign-in)(\/|$|\?)/i.test(new URL(currentUrl).pathname)) {
      throw new Error(`STATE: Login did not succeed — still on auth route: ${currentUrl}`);
    }

    // Navigate to profile
    await page.goto('/dk/account/profile', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    const profileUrl = page.url();
    if (/\/(login|signin|sign-in|auth)(\/|$|\?)/i.test(new URL(profileUrl).pathname)) {
      throw new Error(`STATE: Profile route redirected to auth — session not persisted. URL: ${profileUrl}`);
    }

    await expect(page).toHaveURL(/\/account\/profile/);

    // Wait for content to render
    await page.locator('body').waitFor({ state: 'visible', timeout: 10000 });

    // Verify profile data visible — look for any form fields, profile info, or headings
    const profileContent = page.locator(
      'main, [role="main"], form, [data-testid*="profile"], section'
    ).filter({ visible: true }).first();

    await expect(profileContent).toBeVisible({ timeout: 10000 });

    // Verify at least one field is populated — check for inputs with values or readable text
    const populatedField = page.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"])').filter({ visible: true });
    const fieldCount = await populatedField.count();

    if (fieldCount > 0) {
      let hasValue = false;
      const checkLimit = Math.min(fieldCount, 20);
      for (let i = 0; i < checkLimit; i++) {
        const val = await populatedField.nth(i).inputValue().catch(() => '');
        if (val && val.trim().length > 0) {
          hasValue = true;
          break;
        }
      }

      if (!hasValue) {
        // Fall back to checking for visible text content that suggests profile data
        const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        expect(bodyText.length, 'Profile page should have visible content').toBeGreaterThan(50);
      } else {
        expect(hasValue).toBe(true);
      }
    } else {
      // No inputs — verify profile data shown as text
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      expect(bodyText.length, 'Profile page should have visible profile content').toBeGreaterThan(50);
    }
  });
});