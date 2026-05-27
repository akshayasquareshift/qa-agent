import { test, expect } from '@playwright/test';

test.describe('patients — View patient details', () => {
  test('TC011 - View patient details', async ({ page }) => {
    const username = process.env.TEST_USERNAME ?? 'admin';
    const password = process.env.TEST_PASSWORD ?? 'admin123';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    const usernameField = page.locator('input[name="username"]').or(page.locator('input[name="email"]')).or(page.getByLabel(/username|email/i)).first();
    const passwordField = page.locator('input[name="password"]').or(page.getByLabel(/password/i)).first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(username);
    await passwordField.fill(password);

    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').or(page.getByRole('button', { name: /sign in|log in|login|submit/i })).first();
    await Promise.all([
      page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 30000 }).catch(() => {}),
      submitBtn.click(),
    ]);
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // If still on auth route, wait a bit more for redirect to settle
    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 }).catch(() => {});
    }

    await page.goto('/patients', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // If we got bounced back to auth, re-login once
    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      const u2 = page.locator('input[name="username"]').or(page.locator('input[name="email"]')).or(page.getByLabel(/username|email/i)).first();
      const p2 = page.locator('input[name="password"]').or(page.getByLabel(/password/i)).first();
      await u2.waitFor({ state: 'visible', timeout: 10000 });
      await u2.fill(username);
      await p2.fill(password);
      const s2 = page.locator('button[type="submit"], input[type="submit"]').or(page.getByRole('button', { name: /sign in|log in|login|submit/i })).first();
      await Promise.all([
        page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 30000 }).catch(() => {}),
        s2.click(),
      ]);
      await page.goto('/patients', { waitUntil: 'domcontentloaded' });
    }

    const stillOnAuth = /\/(login|auth|signin)/.test(new URL(page.url()).pathname);
    expect(stillOnAuth, 'session should persist after login to access /patients').toBe(false);

    test.setTimeout(120000);

    const detailLinks = page.locator('a[href*="/patients/"]:not([href$="/patients"]):not([href$="/patients/"])');
    const patientRows = page.locator('[data-testid^="patient-row"], tbody tr, [data-testid="patient-card"]');

    await expect(async () => {
      const linkCount = await detailLinks.count();
      const rowCount = await patientRows.count();
      expect(linkCount + rowCount).toBeGreaterThan(0);
    }).toPass({ timeout: 15000 });

    const beforeUrl = page.url();

    const linkCount = await detailLinks.count();
    const rowCount = await patientRows.count();
    if (linkCount > 0) {
      const href = await detailLinks.first().getAttribute('href').catch(() => null);
      if (href) {
        await page.goto(href, { waitUntil: 'domcontentloaded' });
      } else {
        await Promise.all([
          page.waitForURL(/\/patients\/[^/]+/, { timeout: 15000 }).catch(() => {}),
          detailLinks.first().click(),
        ]);
      }
    } else if (rowCount > 0) {
      const firstRow = patientRows.first();
      await firstRow.waitFor({ state: 'visible', timeout: 5000 });
      const rowLink = firstRow.locator('a[href*="/patients/"]').first();
      if (await rowLink.count() > 0) {
        const href = await rowLink.getAttribute('href').catch(() => null);
        if (href) {
          await page.goto(href, { waitUntil: 'domcontentloaded' });
        } else {
          await Promise.all([
            page.waitForURL(/\/patients\/[^/]+/, { timeout: 15000 }).catch(() => {}),
            rowLink.click(),
          ]);
        }
      } else {
        const viewBtn = firstRow.getByRole('button', { name: /view|details|open/i }).first();
        if (await viewBtn.count() > 0) {
          await Promise.all([
            page.waitForURL(/\/patients\/[^/]+/, { timeout: 15000 }).catch(() => {}),
            viewBtn.click(),
          ]);
        } else {
          await Promise.all([
            page.waitForURL(/\/patients\/[^/]+/, { timeout: 15000 }).catch(() => {}),
            firstRow.click(),
          ]);
        }
      }
    }

    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const currentUrl = new URL(page.url());
    expect(currentUrl.pathname).toMatch(/\/patients\/[^/]+/);
    expect(currentUrl.pathname).not.toBe(new URL(beforeUrl, 'http://localhost:3000').pathname);

    const detailsContainer = page.locator(
      '[data-testid="patient-details"], [data-testid="patient-detail"], main, [role="main"], body'
    ).first();
    await expect(detailsContainer).toBeVisible({ timeout: 10000 });

    const detailIndicators = page.locator([
      '[data-testid="patient-name"]',
      '[data-testid="patient-info"]',
      '[data-testid="patient-details"]',
      'h1',
      'h2',
      'dl',
      'dd',
    ].join(', '));

    await expect(async () => {
      const count = await detailIndicators.count();
      expect(count).toBeGreaterThan(0);
    }).toPass({ timeout: 10000 });

    const bodyText = await page.locator('body').innerText();
    expect(bodyText.trim().length).toBeGreaterThan(0);
  });
});