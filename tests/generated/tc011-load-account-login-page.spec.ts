import { test, expect } from '@playwright/test';

test.describe('auth — Load account login page', () => {
  test('TC011 - Load account login page', async ({ page }) => {
    test.setTimeout(45000);

    const response = await page.goto('/dk/account', { waitUntil: 'domcontentloaded', timeout: 15000 });
    expect(response, 'navigation response should exist').not.toBeNull();

    await page.waitForLoadState('load');

    await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 0, null, { timeout: 10000 });

    const currentUrl = page.url();
    expect(currentUrl, `URL should be account/login-related, got ${currentUrl}`).toMatch(/\/(account|login|signin|sign-in|auth)(\/|$|\?)/i);

    const emailCandidates = [
      page.getByLabel(/email|e-?mail|brugernavn|username|user/i).first(),
      page.locator('input[autocomplete="email"], input[autocomplete="username"]').first(),
      page.locator('input[type="email"]').first(),
      page.locator('input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i]').first(),
      page.getByPlaceholder(/email|e-?mail|brugernavn|username/i).first(),
      page.getByRole('textbox', { name: /email|e-?mail|brugernavn|username|user/i }).first(),
    ];

    const passwordCandidates = [
      page.locator('input[type="password"]').first(),
      page.getByLabel(/password|adgangskode|kodeord/i).first(),
      page.locator('input[autocomplete="current-password"], input[autocomplete="new-password"]').first(),
      page.locator('input[name*="pass" i], input[id*="pass" i]').first(),
      page.getByPlaceholder(/password|adgangskode|kodeord/i).first(),
    ];

    const submitCandidates = [
      page.getByRole('button', { name: /log\s*in|login|sign\s*in|signin|log\s*ind|continue|fortsæt|submit/i }).first(),
      page.locator('button[type="submit"], input[type="submit"]').first(),
      page.locator('form button').first(),
    ];

    let emailVisible = false;
    for (const c of emailCandidates) {
      try {
        if (await c.isVisible({ timeout: 1500 })) { emailVisible = true; break; }
      } catch { /* try next */ }
    }

    let passwordVisible = false;
    for (const c of passwordCandidates) {
      try {
        if (await c.isVisible({ timeout: 1500 })) { passwordVisible = true; break; }
      } catch { /* try next */ }
    }

    let submitVisible = false;
    for (const c of submitCandidates) {
      try {
        if (await c.isVisible({ timeout: 1500 })) { submitVisible = true; break; }
      } catch { /* try next */ }
    }

    if (!emailVisible || !passwordVisible) {
      const signInToggle = page.getByRole('button', { name: /log\s*in|sign\s*in|log\s*ind/i })
        .or(page.getByRole('link', { name: /log\s*in|sign\s*in|log\s*ind/i }))
        .or(page.getByRole('tab', { name: /log\s*in|sign\s*in|log\s*ind/i }))
        .first();
      try {
        if (await signInToggle.isVisible({ timeout: 2000 })) {
          await signInToggle.click({ timeout: 3000 });
          await page.waitForLoadState('load');
        }
      } catch { /* ignore */ }

      for (const c of emailCandidates) {
        try {
          if (await c.isVisible({ timeout: 1500 })) { emailVisible = true; break; }
        } catch { /* try next */ }
      }
      for (const c of passwordCandidates) {
        try {
          if (await c.isVisible({ timeout: 1500 })) { passwordVisible = true; break; }
        } catch { /* try next */ }
      }
      for (const c of submitCandidates) {
        try {
          if (await c.isVisible({ timeout: 1500 })) { submitVisible = true; break; }
        } catch { /* try next */ }
      }
    }

    expect(emailVisible, 'email/username input should be visible on login page').toBe(true);
    expect(passwordVisible, 'password input should be visible on login page').toBe(true);
    expect(submitVisible, 'submit/login button should be visible on login page').toBe(true);
  });
});