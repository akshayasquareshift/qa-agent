import { test, expect } from '@playwright/test';

test.describe('checkout — Empty cart blocks checkout', () => {
  test('TC031 - Empty cart blocks checkout', async ({ page, context }) => {
    test.setTimeout(45000);

    await context.clearCookies();
    await context.clearPermissions();
    try {
      await page.goto('/dk', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.evaluate(() => {
        try { localStorage.clear(); } catch {}
        try { sessionStorage.clear(); } catch {}
      });
    } catch {}

    const response = await page.goto('/dk/checkout', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});

    const currentUrl = page.url();
    const path = new URL(currentUrl).pathname;

    const redirectedAway = !/\/checkout(\/|$)/.test(path);

    if (redirectedAway) {
      expect(redirectedAway, `Expected redirect away from /checkout, got ${path}`).toBe(true);
      return;
    }

    const emptyMessageLocator = page.locator('body').getByText(
      /(empty|tom|no items|ingen varer|your cart is empty|kurven er tom|basket is empty)/i
    ).first();

    const continueShoppingLocator = page.getByRole('link', {
      name: /(continue shopping|tilbage til|shop|browse|fortsæt|handel)/i,
    }).first();

    const checkoutFormLocator = page.locator(
      'form[data-testid*="checkout"], [data-testid="checkout-form"], [data-testid="payment-form"], form input[name="email"], form input[name="cardNumber"]'
    ).first();

    const submitButtonLocator = page.getByRole('button', {
      name: /(place order|pay now|complete order|betal|bestil|gennemfør)/i,
    }).first();

    const hasEmptyMessage = await emptyMessageLocator.isVisible({ timeout: 5000 }).catch(() => false);
    const hasContinueShopping = await continueShoppingLocator.isVisible({ timeout: 2000 }).catch(() => false);
    const hasCheckoutForm = await checkoutFormLocator.isVisible({ timeout: 2000 }).catch(() => false);
    const hasSubmitButton = await submitButtonLocator.isVisible({ timeout: 2000 }).catch(() => false);

    const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');
    const bodyHasEmptyKeyword = /(empty|tom|ingen varer|no items|kurven er tom)/i.test(bodyText);

    const blocked =
      hasEmptyMessage ||
      hasContinueShopping ||
      bodyHasEmptyKeyword ||
      (!hasCheckoutForm && !hasSubmitButton);

    expect(
      blocked,
      `Expected empty cart to block checkout. URL=${path}, emptyMsg=${hasEmptyMessage}, continueShop=${hasContinueShopping}, checkoutForm=${hasCheckoutForm}, submitBtn=${hasSubmitButton}, bodyEmptyKeyword=${bodyHasEmptyKeyword}`
    ).toBe(true);

    expect(response?.status() ?? 200, 'Checkout response should not be a server error').toBeLessThan(500);
  });
});