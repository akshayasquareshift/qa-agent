import { test, expect } from '@playwright/test';

test.describe('auth — Login with valid credentials', () => {
  test('TC015 - Login with valid credentials', async ({ page }) => {
    test.setTimeout(60000);

    const BASE = 'http://localhost:8000';
    const LOCALE = '/dk';

    const email = process.env.SEED_EMAIL || 'testuser@example.com';
    const password = process.env.SEED_PASSWORD || 'TestPassword123!';

    const loginRoutes = [
      `${BASE}${LOCALE}/account`,
      `${BASE}${LOCALE}/account/login`,
      `${BASE}${LOCALE}/login`,
      `${BASE}/account`,
      `${BASE}/login`,
    ];

    let emailInput = page.locator('input[type="email"], input[autocomplete="email"], input[name*="email" i], input[id*="email" i]').filter({ visible: true }).first();
    let revealed = false;

    for (const route of loginRoutes) {
      try {
        await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});

        const signInTab = page.getByRole('button', { name: /sign\s*in|log\s*in|login|log\s*ind|logind/i })
          .or(page.getByRole('link', { name: /sign\s*in|log\s*in|login|log\s*ind|logind/i }))
          .or(page.getByRole('tab', { name: /sign\s*in|log\s*in|login|log\s*ind|logind/i }))
          .filter({ visible: true })
          .first();

        if (await signInTab.isVisible({ timeout: 2000 }).catch(() => false)) {
          await signInTab.click({ timeout: 5000 }).catch(() => {});
        }

        if (await emailInput.isVisible({ timeout: 6000 }).catch(() => false)) {
          revealed = true;
          break;
        }
      } catch {
        continue;
      }
    }

    expect(revealed, 'Login form (email input) should be reachable from a known auth route').toBeTruthy();

    await emailInput.fill(email, { timeout: 5000 });

    const passwordInput = page.locator('input[type="password"], input[autocomplete="current-password"], input[name*="password" i], input[id*="password" i]').filter({ visible: true }).first();
    await passwordInput.waitFor({ state: 'visible', timeout: 8000 });
    await passwordInput.fill(password, { timeout: 5000 });

    const submitBtn = page.locator('button[type="submit"], input[type="submit"]')
      .or(page.getByRole('button', { name: /sign\s*in|log\s*in|login|logind|continue|submit/i }))
      .filter({ visible: true })
      .first();

    await submitBtn.waitFor({ state: 'visible', timeout: 8000 });

    const startUrl = page.url();
    const navPromise = page.waitForURL((url) => !/\/(login|sign[-_]?in)(\/|$|\?)/i.test(url.pathname) || url.toString() !== startUrl, { timeout: 15000 }).catch(() => null);

    await submitBtn.click({ timeout: 5000 });

    await navPromise;
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});

    const finalUrl = page.url();
    const stillOnLogin = /\/(login|sign[-_]?in)(\/|$|\?)/i.test(new URL(finalUrl).pathname);

    const passwordGone = !(await passwordInput.isVisible({ timeout: 2000 }).catch(() => false));
    const accountAffordance = page.getByRole('button', { name: /account|profile|sign\s*out|log\s*out|logout|min konto/i })
      .or(page.getByRole('link', { name: /account|profile|sign\s*out|log\s*out|logout|min konto/i }))
      .or(page.locator('[data-testid*="account" i], [data-testid*="user-menu" i], [data-testid*="profile" i], [data-testid*="logout" i]'))
      .filter({ visible: true })
      .first();
    const hasAffordance = await accountAffordance.isVisible({ timeout: 3000 }).catch(() => false);

    const authenticated = (!stillOnLogin) && (passwordGone || hasAffordance);

    expect(
      authenticated,
      `Expected authenticated state. finalUrl=${finalUrl} stillOnLogin=${stillOnLogin} passwordGone=${passwordGone} hasAffordance=${hasAffordance}`
    ).toBeTruthy();
  });
});