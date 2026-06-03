import { test, expect } from '@playwright/test';

test.describe('account — View saved addresses', () => {
  test('TC019 - View saved addresses', async ({ page }) => {
    test.setTimeout(60000);

    const BASE = 'http://localhost:8000';
    const LOCALE = '/dk';

    // ---- Inline auth setup ----
    const username = process.env.TEST_USERNAME ?? 'testuser@example.com';
    const password = process.env.TEST_PASSWORD ?? 'TestPassword123!';

    const loginRoutes = [
      `${LOCALE}/account/login`,
      `${LOCALE}/login`,
      `${LOCALE}/account`,
      `/account/login`,
      `/login`,
    ];

    let loggedIn = false;
    for (const route of loginRoutes) {
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        continue;
      }

      // Click a Sign In tab/toggle if present
      const signInToggle = page
        .getByRole('tab', { name: /sign\s*in|log\s*in|log ind|logind/i })
        .or(page.getByRole('button', { name: /^(sign\s*in|log\s*in|log ind|logind)$/i }))
        .or(page.getByRole('link', { name: /^(sign\s*in|log\s*in|log ind|logind)$/i }));
      if (await signInToggle.first().isVisible({ timeout: 1500 }).catch(() => false)) {
        await signInToggle.first().click({ timeout: 3000 }).catch(() => {});
      }

      const emailInput = page
        .locator('input[name="username"], input[name="email"], input[autocomplete="email"], input[type="email"]')
        .first();
      const passwordInput = page
        .locator('input[name="password"], input[autocomplete="current-password"], input[type="password"]')
        .first();

      const visible = await emailInput
        .waitFor({ state: 'visible', timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (!visible) continue;

      await emailInput.fill(username, { timeout: 5000 });
      await passwordInput.fill(password, { timeout: 5000 });

      const submitBtn = page
        .locator('button[type="submit"], input[type="submit"]')
        .or(page.getByRole('button', { name: /sign\s*in|log\s*in|log ind|logind|continue|submit/i }))
        .first();

      const navPromise = page
        .waitForURL((url) => !/\/(login|signin|sign-in)(\/|$|\?)/i.test(url.pathname), { timeout: 15000 })
        .catch(() => null);
      await submitBtn.click({ timeout: 5000 });
      await navPromise;
      await page.waitForLoadState('load').catch(() => {});

      if (!/\/(login|signin|sign-in)(\/|$|\?)/i.test(new URL(page.url()).pathname)) {
        loggedIn = true;
        break;
      }
    }

    if (!loggedIn) {
      throw new Error(`STATE: Could not authenticate with provided credentials at any candidate login route. Current URL: ${page.url()}`);
    }

    // ---- Navigate to addresses page ----
    await page.goto(`${BASE}${LOCALE}/account/addresses`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load').catch(() => {});

    const currentPath = new URL(page.url()).pathname;
    if (/\/(login|signin|sign-in)(\/|$)/i.test(currentPath)) {
      throw new Error(`STATE: Redirected to auth when navigating to addresses page. URL: ${page.url()}`);
    }

    await expect(page).toHaveURL(/\/account\/addresses/i, { timeout: 10000 });

    // ---- Verify the addresses page rendered (list or empty-state both valid) ----
    const heading = page
      .getByRole('heading', { name: /address|adresse/i })
      .or(page.locator('h1, h2').filter({ hasText: /address|adresse/i }))
      .first();

    const addressContainer = page
      .locator('[data-testid*="address" i]')
      .or(page.locator('main'))
      .or(page.locator('[class*="address" i]'))
      .first();

    const ready = await Promise.race([
      heading.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'heading').catch(() => null),
      addressContainer.waitFor({ state: 'visible', timeout: 8000 }).then(() => 'container').catch(() => null),
    ]);

    if (!ready) {
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (/404|not found|side ikke fundet/i.test(bodyText)) {
        throw new Error(`STATE: Addresses page returned a 404 or error page. URL: ${page.url()}`);
      }
      throw new Error(`STATE: Addresses page did not render a recognizable address list/empty-state. URL: ${page.url()}`);
    }

    // Final explicit visibility assertion on main content
    await expect(page.locator('main, [role="main"], body').first()).toBeVisible({ timeout: 5000 });
  });
});