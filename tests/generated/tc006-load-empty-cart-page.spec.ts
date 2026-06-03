import { test, expect } from '@playwright/test';

test.describe('cart — Load empty cart page', () => {
  test('TC006 - Load empty cart page', async ({ page }) => {
    test.setTimeout(30000);

    await page.goto('/dk/cart', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    await expect(page).toHaveURL(/\/dk\/cart/, { timeout: 10000 });

    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: 5000 });

    const emptyStateSignals = page.locator(
      '[data-testid*="empty" i], [class*="empty" i]'
    ).or(
      page.getByText(/your\s*(shopping\s*)?(cart|bag|basket)\s*is\s*empty/i)
    ).or(
      page.getByText(/no\s*items?\s*(in\s*)?(your\s*)?(cart|bag|basket)/i)
    ).or(
      page.getByText(/cart\s*is\s*empty/i)
    ).or(
      page.getByText(/empty\s*cart/i)
    ).or(
      page.getByText(/din\s*kurv\s*er\s*tom/i)
    ).or(
      page.getByText(/ingen\s*varer/i)
    ).or(
      page.getByRole('heading', { name: /empty|tom/i })
    );

    let foundEmptyState = false;
    try {
      await emptyStateSignals.first().waitFor({ state: 'visible', timeout: 8000 });
      foundEmptyState = true;
    } catch {
      foundEmptyState = false;
    }

    if (!foundEmptyState) {
      const bodyText = (await body.innerText({ timeout: 3000 }).catch(() => '')).toLowerCase();
      const hasEmptyKeyword =
        /empty|tom|no items|ingen varer|kurv er tom|cart is empty/i.test(bodyText);

      const lineItems = page.locator(
        '[data-testid*="cart-item" i], [data-testid*="line-item" i], [class*="cart-item" i], [class*="line-item" i]'
      );
      const itemCount = await lineItems.count().catch(() => 0);

      expect(
        hasEmptyKeyword || itemCount === 0,
        `Expected empty cart state but found ${itemCount} item(s) and no empty-state text. Body excerpt: ${bodyText.slice(0, 300)}`
      ).toBeTruthy();
    } else {
      await expect(emptyStateSignals.first()).toBeVisible({ timeout: 3000 });
    }
  });
});