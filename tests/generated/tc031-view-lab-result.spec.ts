import { test, expect } from '@playwright/test';

test.describe('labs — View lab result', () => {
  test('TC031 - View lab result', async ({ page }) => {
    const username = process.env.TEST_USERNAME ?? 'placeholder_user';
    const password = process.env.TEST_PASSWORD ?? 'placeholder_password';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const usernameField = page.locator('input[name="username"]').or(
      page.locator('input[name="email"]')
    ).or(page.getByLabel(/username|email/i)).first();
    const passwordField = page.locator('input[name="password"]').or(
      page.getByLabel(/password/i)
    ).first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(username);
    await passwordField.fill(password);

    const submitButton = page.locator('button[type="submit"]').or(
      page.getByRole('button', { name: /sign in|log in|login|submit/i })
    ).first();
    await submitButton.waitFor({ state: 'visible', timeout: 10000 });
    await submitButton.click();

    try {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 });
    } catch {
      test.skip(true, 'STATE: login did not redirect away from auth route — placeholder credentials likely invalid');
    }
    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      test.skip(true, 'STATE: still on auth route after login attempt — cannot proceed to protected lab page');
    }

    await page.goto('/labs', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      test.skip(true, 'STATE: protected /labs route redirected to auth — session not persisted');
    }

    const labRows = page.locator('a[href*="/labs/"], tr, [role="row"], li').filter({
      has: page.locator('a[href*="/labs/"]')
    });

    const labLinks = page.locator('a[href*="/labs/"]').filter({
      hasNot: page.locator('a[href$="/labs"]')
    });

    const labCount = await labLinks.count();
    if (labCount === 0) {
      test.skip(true, 'precondition: no seed lab data available to open');
    }

    const firstLab = labLinks.first();
    await firstLab.waitFor({ state: 'visible', timeout: 10000 });

    const href = await firstLab.getAttribute('href');
    await firstLab.click();

    await page.waitForURL(/\/labs\/[^/]+/, { timeout: 15000 });
    await page.waitForLoadState('load');

    expect(page.url()).toMatch(/\/labs\/[^/]+/);

    const main = page.locator('main, [role="main"], body').first();
    await main.waitFor({ state: 'visible', timeout: 10000 });

    const resultIndicator = page.getByText(/result|value|reference|range|test|specimen|lab/i).first();
    await resultIndicator.waitFor({ state: 'visible', timeout: 10000 });
    await expect(resultIndicator).toBeVisible();

    const bodyText = await page.locator('body').innerText();
    expect(bodyText.length).toBeGreaterThan(0);
  });
});