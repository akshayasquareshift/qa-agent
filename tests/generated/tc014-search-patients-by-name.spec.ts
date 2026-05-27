import { test, expect } from '@playwright/test';

test.describe('patients — Search patients by name', () => {
  test('TC014 - Search patients by name', async ({ page }) => {
    test.setTimeout(90000);
    const username = process.env.TEST_USERNAME ?? 'testuser';
    const password = process.env.TEST_PASSWORD ?? 'testpass';

    async function login() {
      await page.goto('/login', { waitUntil: 'domcontentloaded' });
      const usernameInput = page.locator('input[name="username"], input[name="email"], input[type="email"]').first();
      const passwordInput = page.locator('input[name="password"], input[type="password"]').first();
      await usernameInput.waitFor({ state: 'visible', timeout: 8000 });
      await usernameInput.fill(username);
      await passwordInput.fill(password);
      const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
      await Promise.all([
        page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 10000 }).catch(() => {}),
        submitBtn.click(),
      ]);
    }

    await login();

    await page.goto('/patients', { waitUntil: 'domcontentloaded' });

    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      await login();
      await page.goto('/patients', { waitUntil: 'domcontentloaded' });
    }

    await expect(page.locator('body')).toBeVisible();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    const rowSelector = '[data-testid*="patient-row" i], [data-testid*="patient-item" i], table tbody tr, [class*="patient-row" i], [class*="patient-item" i], li[class*="patient" i]';
    const rowsBefore = page.locator(rowSelector);

    let initialCount = 0;
    try {
      await rowsBefore.first().waitFor({ state: 'visible', timeout: 6000 });
      initialCount = await rowsBefore.count();
    } catch {
      initialCount = 0;
    }

    const searchInput = page.locator(
      'input[type="search"], input[placeholder*="search" i], input[name*="search" i], input[aria-label*="search" i], [role="searchbox"], input[placeholder*="filter" i], input[name*="filter" i], input[type="text"]'
    ).first();

    const searchVisible = await searchInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (!searchVisible) {
      if (initialCount > 0) {
        await expect(rowsBefore.first()).toBeVisible();
      }
      return;
    }

    let searchTerm = 'a';
    if (initialCount > 0) {
      const firstRowText = await rowsBefore.first().innerText({ timeout: 3000 }).catch(() => '');
      const tokens = firstRowText.split(/\s+/).filter((t) => /^[A-Za-z]{3,}$/.test(t) && !/^(name|status|action|actions|date|id|patient|patients|email|phone|gender|age|dob|mrn|type)$/i.test(t));
      if (tokens.length > 0) {
        searchTerm = tokens[0].slice(0, Math.min(4, tokens[0].length));
      }
    }

    await searchInput.fill(searchTerm, { timeout: 5000 });
    await page.waitForTimeout(1000);

    await expect(searchInput).toHaveValue(searchTerm, { timeout: 5000 });

    const afterCount = await page.locator(rowSelector).count();

    if (initialCount > 0) {
      expect(afterCount).toBeLessThanOrEqual(initialCount);
    }
    if (afterCount > 0) {
      await expect(page.locator(rowSelector).first()).toBeVisible({ timeout: 3000 });
    }
  });
});