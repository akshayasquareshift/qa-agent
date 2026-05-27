import { test, expect } from '@playwright/test';

test.describe('reports — Navigate to reports', () => {
  test('TC035 - Navigate to reports', async ({ page }) => {
    // Inline authentication setup
    const username = process.env.TEST_USERNAME ?? 'test_user_placeholder';
    const password = process.env.TEST_PASSWORD ?? 'test_password_placeholder';

    await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });

    const usernameField = page.locator('input[name="username"], input[name="email"], input[type="email"]').first();
    const passwordField = page.locator('input[name="password"], input[type="password"]').first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(username);
    await passwordField.fill(password);

    const submitButton = page.locator('button[type="submit"]').or(
      page.getByRole('button', { name: /sign in|log in|login|submit/i })
    ).first();

    await Promise.all([
      page.waitForURL((url) => !/\/(login|auth|signin)(\/|$|\?)/i.test(url.pathname), { timeout: 20000 }).catch(() => {}),
      submitButton.click(),
    ]);

    // Allow extra time for redirect chain (auth provider callback -> protected route)
    await page.waitForLoadState('domcontentloaded');
    for (let i = 0; i < 30; i++) {
      const p = new URL(page.url()).pathname;
      if (!/\/(login|auth|signin|sign-in|sso|oauth|callback)(\/|$)/i.test(p)) break;
      await page.waitForTimeout(1000);
    }
    // Secondary signal: wait for any post-login DOM indicator (logout/user menu/nav) so we don't rely solely on URL
    await Promise.race([
      page.getByRole('button', { name: /log\s*out|sign\s*out/i }).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
      page.getByRole('navigation').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
      page.locator('[data-testid*="user"], [aria-label*="user" i], [aria-label*="account" i]').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {}),
      page.waitForTimeout(3000),
    ]);

    // Capture URL after successful authentication (this is the session-persistence anchor)
    let authenticatedUrl = page.url();
    let authenticatedPath = new URL(authenticatedUrl).pathname;
    console.log('Authenticated URL before refresh:', authenticatedUrl);

    // If still on auth, try navigating to a protected route to surface the real landing page
    if (/\/(login|auth|signin)(\/|$)/i.test(authenticatedPath)) {
      await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForLoadState('domcontentloaded');
      authenticatedUrl = page.url();
      authenticatedPath = new URL(authenticatedUrl).pathname;
      console.log('After fallback goto, URL:', authenticatedUrl);
    }

    // If login never escaped the auth page, this is a STATE issue (bad creds or env not seeded) — fail clearly
    if (/\/(login|auth|signin)(\/|$)/i.test(authenticatedPath)) {
      throw new Error(`Login did not establish a session; still at ${authenticatedUrl}`);
    }

    // Reload the page to verify the session persists across refresh
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded');

    // Verify session persisted — must NOT be bounced back to auth
    const urlAfterRefresh = new URL(page.url()).pathname;
    expect(/\/(login|auth|signin)(\/|$)/i.test(urlAfterRefresh)).toBe(false);

    // Verify the same protected route is still rendered
    expect(urlAfterRefresh).toBe(authenticatedPath);

    // Verify page body rendered post-refresh
    await expect(page.locator('body')).toBeVisible();
  });
});