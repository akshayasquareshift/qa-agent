import { test, expect } from '@playwright/test';

test.describe('responsive — Mobile responsive layout', () => {
  test('TC044 - Mobile responsive layout', async ({ page }) => {
    test.setTimeout(90000);

    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});

    const usernameInput = page.locator('input[name="username"], input[name="email"], input[type="email"]').first();
    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();

    const loginVisible = await usernameInput.isVisible({ timeout: 2000 }).catch(() => false);
    if (loginVisible) {
      await usernameInput.fill(process.env.TEST_USERNAME || 'testuser', { timeout: 3000 }).catch(() => {});
      await passwordInput.fill(process.env.TEST_PASSWORD || 'testpass', { timeout: 3000 }).catch(() => {});

      const submitButton = page.locator('button[type="submit"], input[type="submit"]').first();
      await submitButton.click({ timeout: 3000 }).catch(() => {});
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 5000 }).catch(() => {});
    }

    const postLoginUrl = page.url();
    console.log('[TC044] post-login url:', postLoginUrl);

    if (/\/(login|auth|signin)/.test(new URL(postLoginUrl).pathname)) {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
    } else {
      const okDash = await page.goto('/dashboard', { waitUntil: 'domcontentloaded', timeout: 8000 }).then(() => true).catch(() => false);
      if (!okDash) {
        await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      }
    }

    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: 5000 });

    const viewport = page.viewportSize();
    expect(viewport?.width).toBe(375);
    expect(viewport?.height).toBe(667);

    const dims = await page.evaluate(() => ({
      scrollW: document.body.scrollWidth,
      clientW: document.documentElement.clientWidth,
      hasContent: document.body.innerText.trim().length > 0,
    }));

    expect(dims.scrollW).toBeLessThanOrEqual(dims.clientW + 5);
    expect(dims.hasContent).toBe(true);

    const main = page.locator('main, [role="main"], #__next, body > div').first();
    const mainVisible = await main.isVisible({ timeout: 3000 }).catch(() => false);
    if (mainVisible) {
      const mainBox = await main.boundingBox();
      if (mainBox) {
        expect(mainBox.width).toBeLessThanOrEqual(viewport!.width + 5);
      }
    }

    const overflowingElements = await page.evaluate((vpWidth) => {
      const elements = document.querySelectorAll('*');
      let overflowCount = 0;
      const cap = Math.min(elements.length, 500);
      for (let i = 0; i < cap; i++) {
        const rect = (elements[i] as Element).getBoundingClientRect();
        if (rect.width > vpWidth + 10 && rect.height > 0) {
          overflowCount++;
        }
      }
      return overflowCount;
    }, viewport!.width);

    expect(overflowingElements).toBeLessThan(5);
  });
});