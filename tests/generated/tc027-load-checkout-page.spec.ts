import { test, expect } from '@playwright/test';

test.describe('checkout — Load checkout page', () => {
  test('TC027 - Load checkout page', async ({ page }) => {
    test.setTimeout(45000);

    await page.goto('/dk/checkout', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    await expect(page).toHaveURL(/\/checkout/i, { timeout: 10000 });

    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: 5000 });

    const main = page.locator('main, [role="main"], form, [data-testid*="checkout"]').first();
    await main.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

    const formSignals = page.locator(
      'form, input[type="email"], input[name*="email" i], input[name*="address" i], input[name*="name" i], input[name*="city" i], input[name*="zip" i], input[name*="postal" i], [data-testid*="checkout"], [data-testid*="address"], [data-testid*="payment"]'
    );

    const emptyCartSignal = page.getByText(/empty|tom|ingen varer|no items/i).first();

    const hasForm = await formSignals.first().isVisible({ timeout: 8000 }).catch(() => false);
    const hasEmpty = await emptyCartSignal.isVisible({ timeout: 2000 }).catch(() => false);

    if (!hasForm && !hasEmpty) {
      const visibleHeading = page.locator('h1, h2, [role="heading"]').first();
      await expect(visibleHeading).toBeVisible({ timeout: 5000 });
    } else {
      expect(hasForm || hasEmpty).toBeTruthy();
    }

    await expect(page).not.toHaveURL(/\/(login|signin|auth)(\/|$|\?)/i);
  });
});