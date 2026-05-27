import { test, expect } from '@playwright/test';

test.describe('smoke — Load homepage successfully', () => {
  test('TC001 - Load homepage successfully', async ({ page }) => {
    const pageErrors: Error[] = [];
    const consoleErrors: string[] = [];

    page.on('pageerror', (err) => {
      pageErrors.push(err);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    const response = await page.goto('/', { waitUntil: 'domcontentloaded' });

    expect(response, 'navigation response should exist').not.toBeNull();
    const status = response!.status();
    expect(status, `homepage status should be < 400, got ${status}`).toBeLessThan(400);

    await page.waitForLoadState('load');

    await page.locator('body').waitFor({ state: 'visible', timeout: 10000 });

    await expect(page).toHaveURL(/.*/);

    const bodyText = (await page.locator('body').innerText()).toLowerCase();
    const errorPatterns = [
      'application error',
      'internal server error',
      '500 -',
      '502 bad gateway',
      '503 service unavailable',
      'this page isn\u2019t working',
      'unhandled runtime error',
      'failed to compile',
    ];
    for (const pattern of errorPatterns) {
      expect(bodyText, `body should not contain error text "${pattern}"`).not.toContain(pattern);
    }

    const title = await page.title();
    expect(title, 'page should have a non-empty title').not.toEqual('');

    expect(pageErrors, `no uncaught page errors expected, got: ${pageErrors.map(e => e.message).join('; ')}`).toHaveLength(0);
  });
});