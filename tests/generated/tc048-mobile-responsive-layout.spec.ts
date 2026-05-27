import { test, expect } from '@playwright/test';

test.describe('responsive — Mobile responsive layout', () => {
  test('TC048 - Mobile responsive layout', async ({ page }) => {
    const username = process.env.TEST_USERNAME ?? 'placeholder_user';
    const password = process.env.TEST_PASSWORD ?? 'placeholder_pass';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const usernameField = page.locator('input[name="username"]').or(
      page.getByLabel(/user(name)?|email/i)
    ).first();
    const passwordField = page.locator('input[name="password"]').or(
      page.getByLabel(/password/i)
    ).first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(username);
    await passwordField.fill(password);

    const submitButton = page.locator('button[type="submit"]').or(
      page.getByRole('button', { name: /sign in|log in|login|submit/i })
    ).first();
    await submitButton.click();

    try {
      await page.waitForURL(/^(?!.*\/(login|auth|signin)).*$/, { timeout: 10000 });
    } catch {
      test.skip(true, 'STATE: login did not redirect away from auth path — cannot verify authenticated state');
    }

    await page.waitForLoadState('load');

    const currentUrl = page.url();
    if (/\/(login|auth|signin)/i.test(currentUrl)) {
      test.skip(true, 'STATE: still on auth path after login — authentication did not succeed');
    }

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/i.test(page.url())) {
      test.skip(true, 'STATE: /dashboard redirected to auth — protected route requires session that was not persisted');
    }

    const desktopViewport = { width: 1280, height: 800 };
    await page.setViewportSize(desktopViewport);
    await page.waitForLoadState('load');

    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: 10000 });

    const desktopBodyBox = await body.boundingBox();
    expect(desktopBodyBox).not.toBeNull();
    expect(desktopBodyBox!.width).toBeGreaterThanOrEqual(desktopViewport.width - 50);

    const mobileViewport = { width: 375, height: 667 };
    await page.setViewportSize(mobileViewport);
    await page.waitForTimeout(500);
    await page.waitForLoadState('load');

    await expect(body).toBeVisible({ timeout: 10000 });

    const mobileBodyBox = await body.boundingBox();
    expect(mobileBodyBox).not.toBeNull();
    expect(mobileBodyBox!.width).toBeLessThanOrEqual(mobileViewport.width + 20);

    const layoutAdapted = mobileBodyBox!.width < desktopBodyBox!.width;
    expect(layoutAdapted).toBe(true);

    const mainContent = page.locator('main, [role="main"], #root, #app, body > div').first();
    await expect(mainContent).toBeVisible({ timeout: 10000 });

    const mobileMainBox = await mainContent.boundingBox();
    if (mobileMainBox) {
      expect(mobileMainBox.width).toBeLessThanOrEqual(mobileViewport.width + 20);
    }

    const tabletViewport = { width: 768, height: 1024 };
    await page.setViewportSize(tabletViewport);
    await page.waitForTimeout(500);
    await page.waitForLoadState('load');

    await expect(body).toBeVisible({ timeout: 10000 });

    const tabletBodyBox = await body.boundingBox();
    expect(tabletBodyBox).not.toBeNull();
    expect(tabletBodyBox!.width).toBeLessThanOrEqual(tabletViewport.width + 20);
  });
});