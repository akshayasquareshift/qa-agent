import { test, expect } from '@playwright/test';

test.describe('navigation — Load homepage successfully', () => {
  test('TC001 - Load homepage successfully', async ({ page }) => {
    const response = await page.goto('http://localhost:8000/dk', { waitUntil: 'domcontentloaded', timeout: 15000 });

    expect(response, 'navigation response should exist').not.toBeNull();
    const status = response!.status();
    expect(status, `expected 2xx status, got ${status}`).toBeGreaterThanOrEqual(200);
    expect(status, `expected 2xx status, got ${status}`).toBeLessThan(400);

    await page.waitForLoadState('load');

    await expect(page).toHaveURL(/\/dk(\/|$|\?)/, { timeout: 10000 });

    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: 10000 });

    const bodyText = (await body.innerText({ timeout: 5000 })).toLowerCase();
    const errorMarkers = ['application error', 'this page could not be found', '500 - internal server error', 'something went wrong'];
    for (const marker of errorMarkers) {
      expect(bodyText, `homepage body should not contain error marker "${marker}"`).not.toContain(marker);
    }

    const mainContent = page.locator('main:visible, [role="main"]:visible, #__next:visible, body > div:visible').first();
    await expect(mainContent).toBeVisible({ timeout: 10000 });
  });
});