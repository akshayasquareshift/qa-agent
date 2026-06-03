import { test, expect } from '@playwright/test';

test.describe('error — 404 on invalid product handle', () => {
  test('TC043 - 404 on invalid product handle', async ({ page }) => {
    test.setTimeout(30000);

    const response = await page.goto('http://localhost:8000/dk/products/nonexistent-xyz', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    await page.waitForLoadState('load');

    const status = response?.status() ?? 0;

    const notFoundLocator = page.locator(
      'h1:has-text("404"), h2:has-text("404"), text=/404/i, text=/not\\s*found/i, text=/page.*(not\\s*found|doesn.?t\\s*exist)/i, text=/ikke\\s*fundet/i, text=/findes\\s*ikke/i'
    );

    let notFoundVisible = false;
    try {
      await notFoundLocator.first().waitFor({ state: 'visible', timeout: 8000 });
      notFoundVisible = true;
    } catch {
      notFoundVisible = false;
    }

    const bodyText = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')) || '';
    const hasNotFoundText = /404|not\s*found|ikke\s*fundet|findes\s*ikke/i.test(bodyText);

    const httpIndicates404 = status === 404;

    expect(
      httpIndicates404 || notFoundVisible || hasNotFoundText,
      `Expected 404 indicator. status=${status}, visibleMarker=${notFoundVisible}, bodySnippet="${bodyText.slice(0, 200)}"`
    ).toBeTruthy();

    await expect(page).toHaveURL(/\/products\/nonexistent-xyz/);
  });
});