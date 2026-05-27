import { test, expect } from '@playwright/test';

test.describe('navigation — Sidebar', () => {
  test('TC039 - Sidebar navigation works', async ({ page }) => {
    const username = process.env.TEST_USERNAME ?? 'testuser';
    const password = process.env.TEST_PASSWORD ?? 'testpass';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });

    const usernameField = page.locator('input[name="username"]').or(page.getByLabel(/username|email/i)).first();
    const passwordField = page.locator('input[name="password"]').or(page.getByLabel(/password/i)).first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(username);
    await passwordField.fill(password);

    const loginSubmit = page
      .locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /log\s?in|sign\s?in|submit/i }))
      .first();
    await loginSubmit.click();

    await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 8000 }).catch(() => undefined);

    if (/\/(login|auth|signin)/.test(page.url())) {
      await page.goto('/', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }

    await page.locator('body').waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined);

    let navLinks = page.locator('aside a[href], nav a[href], [data-testid*="sidebar" i] a[href]');
    let linkCount = await navLinks.count().catch(() => 0);

    if (linkCount === 0) {
      navLinks = page.locator('a[href]:not([href^="#"]):not([href^="http"]):not([href^="mailto:"]):not([href^="tel:"])');
      linkCount = await navLinks.count().catch(() => 0);
    }

    expect(linkCount).toBeGreaterThan(0);

    const hrefs: string[] = [];
    const maxToCollect = Math.min(linkCount, 5);
    for (let i = 0; i < maxToCollect; i++) {
      const href = await navLinks.nth(i).getAttribute('href').catch(() => null);
      if (href && !href.startsWith('#') && !href.startsWith('http') && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
        hrefs.push(href);
      }
    }

    let navigatedCount = 0;
    const testHrefs = hrefs.slice(0, 3);
    for (const href of testHrefs) {
      const urlBefore = page.url();
      const linkLoc = page.locator(`a[href="${href}"]`).first();
      await linkLoc.click({ timeout: 2500 }).catch(() => undefined);
      await page.waitForURL((u) => u.href !== urlBefore, { timeout: 2500 }).catch(() => undefined);
      if (page.url() !== urlBefore) {
        navigatedCount++;
      }
    }

    expect(navigatedCount).toBeGreaterThan(0);
  });
});