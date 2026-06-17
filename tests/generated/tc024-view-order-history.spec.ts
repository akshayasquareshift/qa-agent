import { test, expect } from '@playwright/test';

test.describe('orders — View order history', () => {
  test('TC024 - View order history', async ({ page }) => {
    const TEST_USERNAME = process.env.TEST_USERNAME ?? 'test@example.com';
    const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'Test1234!';

    test.setTimeout(60000);

    // --- Inline auth setup ---
    const loginRoutes = ['/dk/account/login', '/dk/login', '/dk/account', '/login'];
    let loggedIn = false;

    for (const route of loginRoutes) {
      try {
        await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        continue;
      }

      // Try to reveal login form if behind a tab
      const signInTab = page
        .getByRole('button', { name: /sign\s*in|log\s*in|login/i })
        .or(page.getByRole('link', { name: /sign\s*in|log\s*in|login/i }))
        .or(page.getByRole('tab', { name: /sign\s*in|log\s*in|login/i }));
      try {
        if (await signInTab.first().isVisible({ timeout: 1500 })) {
          await signInTab.first().click({ timeout: 3000 }).catch(() => {});
        }
      } catch {}

      const usernameInput = page
        .locator('input[name="username"]')
        .or(page.locator('input[name="email"]'))
        .or(page.locator('input[autocomplete="username"]'))
        .or(page.locator('input[autocomplete="email"]'))
        .or(page.getByLabel(/email|username/i));
      const passwordInput = page
        .locator('input[name="password"]')
        .or(page.locator('input[type="password"]'))
        .or(page.getByLabel(/password/i));

      try {
        await usernameInput.first().waitFor({ state: 'visible', timeout: 6000 });
      } catch {
        continue;
      }

      await usernameInput.first().fill(TEST_USERNAME, { timeout: 5000 });
      await passwordInput.first().fill(TEST_PASSWORD, { timeout: 5000 });

      const submit = page
        .locator('button[type="submit"]')
        .or(page.locator('input[type="submit"]'))
        .or(page.getByRole('button', { name: /sign\s*in|log\s*in|login|continue|submit/i }));

      const navPromise = page
        .waitForURL((url) => !/\/(login|signin|sign-in)(\b|\/|$)/i.test(url.pathname), { timeout: 15000 })
        .catch(() => {});
      await submit.first().click({ timeout: 5000 });
      await navPromise;

      const currentUrl = page.url();
      if (!/\/(login|signin|sign-in)(\b|\/|$)/i.test(new URL(currentUrl).pathname)) {
        loggedIn = true;
        break;
      }
    }

    if (!loggedIn) {
      throw new Error(`STATE: login failed with provided credentials; current URL: ${page.url()}`);
    }

    // --- Navigate to orders ---
    await page.goto('/dk/account/orders', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    // Confirm we landed on the orders route (not bounced to login)
    await expect(page).toHaveURL(/\/dk\/account\/orders/i, { timeout: 10000 });

    // Wait for body readiness
    await page.locator('body').waitFor({ state: 'visible', timeout: 5000 });

    // Verify either an orders list or an empty state is visible
    const ordersHeading = page
      .getByRole('heading', { name: /orders|order\s*history|ordre/i })
      .or(page.locator('h1, h2').filter({ hasText: /orders|order\s*history|ordre/i }));

    const ordersList = page
      .locator('[data-testid*="order" i]')
      .or(page.locator('table'))
      .or(page.locator('[role="table"]'))
      .or(page.locator('ul li, ol li').filter({ hasText: /order|#\d+|\d{4}/i }));

    const emptyState = page
      .getByText(/no\s+orders|empty|you\s+have\s+no|ingen\s+ordrer|haven['’]?t\s+placed/i)
      .or(page.locator('[data-testid*="empty" i]'));

    const headingVisible = await ordersHeading
      .first()
      .isVisible({ timeout: 8000 })
      .catch(() => false);
    const listVisible = await ordersList
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);
    const emptyVisible = await emptyState
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    expect(
      headingVisible || listVisible || emptyVisible,
      `Orders page did not render heading, list, or empty state. URL: ${page.url()}`,
    ).toBeTruthy();

    // Final assertion: page URL holds orders route
    expect(page.url()).toMatch(/\/dk\/account\/orders/i);
  });
});