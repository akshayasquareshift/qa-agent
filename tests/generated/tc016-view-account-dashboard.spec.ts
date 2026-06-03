import { test, expect } from '@playwright/test';

test.describe('account — View account dashboard', () => {
  test('TC016 - View account dashboard', async ({ page }) => {
    test.setTimeout(60000);

    const username = process.env.TEST_USERNAME ?? 'testuser';
    const password = process.env.TEST_PASSWORD ?? 'testpass';

    // Inline auth setup
    const loginCandidates = ['/dk/account/login', '/dk/login', '/dk/account', '/login'];
    let loggedIn = false;
    for (const route of loginCandidates) {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('load').catch(() => {});

      // Click any visible sign-in tab/link if password input not yet visible
      const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').first();
      if (!(await passwordInput.isVisible({ timeout: 2000 }).catch(() => false))) {
        const signInToggle = page
          .getByRole('tab', { name: /sign in|log\s*in|login|logg ind/i })
          .or(page.getByRole('link', { name: /sign in|log\s*in|login|logg ind/i }))
          .or(page.getByRole('button', { name: /sign in|log\s*in|login|logg ind/i }))
          .first();
        if (await signInToggle.isVisible({ timeout: 1500 }).catch(() => false)) {
          await signInToggle.click({ timeout: 3000 }).catch(() => {});
        }
      }

      const userInput = page
        .locator('input[name="username"], input[name="email"], input[autocomplete="username"], input[autocomplete="email"], input[type="email"]')
        .first();
      const pwInput = page
        .locator('input[name="password"], input[type="password"], input[autocomplete="current-password"]')
        .first();

      if (
        (await userInput.isVisible({ timeout: 3000 }).catch(() => false)) &&
        (await pwInput.isVisible({ timeout: 2000 }).catch(() => false))
      ) {
        await userInput.fill(username, { timeout: 5000 });
        await pwInput.fill(password, { timeout: 5000 });

        const submit = page
          .locator('button[type="submit"], input[type="submit"]')
          .or(page.getByRole('button', { name: /sign in|log\s*in|login|logg ind|submit|continue/i }))
          .first();

        const nav = page.waitForURL((url) => !/\/(login|signin|sign-in)(\/|$|\?)/.test(url.pathname), { timeout: 15000 }).catch(() => null);
        await submit.click({ timeout: 5000 }).catch(() => {});
        await nav;

        if (!/\/(login|signin|sign-in)(\/|$|\?)/.test(new URL(page.url()).pathname)) {
          loggedIn = true;
          break;
        }
      }
    }

    if (!loggedIn) {
      throw new Error(`STATE: unable to authenticate with provided credentials. Current URL: ${page.url()}`);
    }

    // Step 1: Navigate to account
    await page.goto('/dk/account', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load').catch(() => {});

    // Confirm we landed on account (not bounced back to login)
    await expect(page).toHaveURL(/\/account(\/|$|\?)/, { timeout: 10000 });
    expect(/\/(login|signin|sign-in)(\/|$|\?)/.test(new URL(page.url()).pathname)).toBe(false);

    // Step 2: Verify dashboard sections render
    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: 10000 });

    const dashboardSignal = page
      .locator('main')
      .or(page.getByRole('heading', { level: 1 }))
      .or(page.getByRole('heading', { level: 2 }))
      .or(page.locator('[class*="account" i], [class*="dashboard" i]'))
      .first();

    await expect(dashboardSignal).toBeVisible({ timeout: 10000 });

    // Verify the page has meaningful rendered content
    const textLength = await body.evaluate((el) => (el.textContent || '').trim().length);
    expect(textLength).toBeGreaterThan(20);
  });
});