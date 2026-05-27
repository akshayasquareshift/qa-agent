import { test, expect } from '@playwright/test';

test.describe('navigation — 404 page on invalid route', () => {
  test('TC042 - 404 page on invalid route', async ({ page }) => {
    await page.goto('/nonexistent', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const currentUrl = page.url();
    const isAuthRedirect = /\/(login|auth|signin)/i.test(currentUrl);

    if (isAuthRedirect) {
      const authIndicator = page.locator('input[type="password"]')
        .or(page.getByRole('heading', { name: /sign in|log in|login/i }))
        .or(page.getByRole('button', { name: /sign in|log in|login/i }))
        .first();
      await authIndicator.waitFor({ state: 'visible', timeout: 10000 });
      await expect(authIndicator).toBeVisible();
      return;
    }

    const notFoundIndicator = page.getByText(/404|not.?found|page.+not.+exist|doesn['']?t exist/i).first()
      .or(page.getByRole('heading', { name: /404|not.?found/i }).first())
      .or(page.locator('[data-testid*="not-found" i]').first())
      .or(page.locator('[data-testid*="404"]').first());

    const bodyText = page.locator('body');
    await bodyText.waitFor({ state: 'visible', timeout: 5000 });

    const notFoundCount = await notFoundIndicator.count();

    if (notFoundCount > 0) {
      await expect(notFoundIndicator.first()).toBeVisible({ timeout: 5000 });
    } else {
      const bodyContent = await bodyText.textContent();
      const hasNotFoundText = /404|not.?found|page.+not.+exist/i.test(bodyContent ?? '');
      expect(hasNotFoundText, 'Expected 404/not-found indicator on invalid route').toBeTruthy();
    }

    await expect(page).toHaveURL(/\/nonexistent/);
  });
});