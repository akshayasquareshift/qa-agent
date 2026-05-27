import { test, expect } from '@playwright/test';

test.describe('auth — Detect login page presence', () => {
  test('TC002 - Detect login page presence', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    await expect(page).toHaveURL(/\/(login|auth|signin)/);

    const usernameField = page.locator(
      'input[type="email"], input[name*="email" i], input[name*="user" i], input[id*="email" i], input[id*="user" i], input[placeholder*="email" i], input[placeholder*="user" i]'
    ).first();

    const passwordField = page.locator(
      'input[type="password"], input[name*="password" i], input[id*="password" i]'
    ).first();

    const submitButton = page.locator(
      'button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login"), button:has-text("Submit")'
    ).first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await passwordField.waitFor({ state: 'visible', timeout: 10000 });
    await submitButton.waitFor({ state: 'visible', timeout: 10000 });

    await expect(usernameField).toBeVisible();
    await expect(passwordField).toBeVisible();
    await expect(submitButton).toBeVisible();

    await expect(usernameField).toBeEditable();
    await expect(passwordField).toBeEditable();

    await usernameField.fill('test@example.com');
    await passwordField.fill('password123');

    await expect(submitButton).toBeEnabled();
  });
});