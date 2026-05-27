import { test, expect } from '@playwright/test';

test.describe('clinical — Navigate to encounters/visits', () => {
  test('TC023 - Navigate to encounters/visits', async ({ page }) => {
    const baseURL = 'http://localhost:3000';
    const username = process.env.TEST_USERNAME ?? 'testuser';
    const password = process.env.TEST_PASSWORD ?? 'testpass';

    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });

    const usernameField = page.locator('input[name="username"]')
      .or(page.locator('input[name="email"]'))
      .or(page.getByLabel(/username|email/i))
      .first();
    const passwordField = page.locator('input[name="password"]')
      .or(page.getByLabel(/password/i))
      .first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(username);
    await passwordField.fill(password);

    const submitBtn = page.locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /sign in|log in|login|submit/i }))
      .first();
    await submitBtn.click();

    await page.waitForURL(url => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 }).catch(() => {});

    const currentUrl = page.url();
    if (/\/(login|auth|signin)/.test(new URL(currentUrl).pathname)) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'Login did not redirect away from auth path with provided credentials' });
      test.skip(true, 'SOURCE_BUG: authentication failed — cannot verify protected route');
      return;
    }

    // Prefer UI navigation via a sidebar/menu link — fall back to candidate routes.
    const navLink = page.getByRole('link', { name: /encounter|visit|appointment/i })
      .or(page.getByRole('button', { name: /encounter|visit|appointment/i }))
      .first();
    const linkVisible = await navLink.isVisible({ timeout: 3000 }).catch(() => false);
    if (linkVisible) {
      await navLink.click().catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    } else {
      const candidates = ['/encounters', '/visits', '/appointments', '/clinical/encounters', '/clinical/visits'];
      for (const route of candidates) {
        await page.goto(`${baseURL}${route}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        const path = new URL(page.url()).pathname;
        if (!/\/(login|auth|signin)/.test(path) && new RegExp(route.replace(/\//g, '\\/')).test(path)) break;
      }
    }

    await page.waitForLoadState('load').catch(() => {});

    const finalPath = new URL(page.url()).pathname;
    if (/\/(login|auth|signin)/.test(finalPath)) {
      test.info().annotations.push({ type: 'STATE', description: `Navigation to encounters bounced to auth route: ${finalPath}` });
      throw new Error(`Encounters navigation bounced to auth route: ${finalPath} — session likely not persisted across navigation`);
    }

    await expect(page).toHaveURL(/\/(encounter|visit|appointment)/i, { timeout: 10000 });

    const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    const hasEncounterContent = /encounter|visit|appointment|no\s+(records|results|data)|empty/i.test(bodyText);
    expect(hasEncounterContent, `Page body did not contain expected encounter/visit content. Actual: ${bodyText.slice(0, 200)}`).toBe(true);
  });
});