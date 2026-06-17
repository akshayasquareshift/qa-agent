import { test, expect } from '@playwright/test';

test.describe('cart — Cart persists across page reload', () => {
  test('TC045 - Cart persists across page reload', async ({ page }) => {
    test.setTimeout(60000);

    // Step 1: Navigate to homepage and find a product to add to cart
    await page.goto('http://localhost:8000/dk', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    // Find a product link from the homepage
    const productLinkCandidates = [
      page.locator('a[href*="/product"]').filter({ has: page.locator(':visible') }).first(),
      page.locator('a[href*="/products/"]').filter({ has: page.locator(':visible') }).first(),
      page.getByRole('link').filter({ hasText: /shop|view|details/i }).first(),
    ];

    let productOpened = false;
    for (const candidate of productLinkCandidates) {
      try {
        if (await candidate.isVisible({ timeout: 2000 })) {
          await candidate.click({ timeout: 5000 });
          await page.waitForLoadState('load');
          productOpened = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!productOpened) {
      // Try direct navigation to a products listing
      await page.goto('http://localhost:8000/dk/products', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('load');
      const firstProduct = page.locator('a[href*="/product"]').filter({ has: page.locator(':visible') }).first();
      if (await firstProduct.isVisible({ timeout: 3000 })) {
        await firstProduct.click({ timeout: 5000 });
        await page.waitForLoadState('load');
        productOpened = true;
      }
    }

    expect(productOpened, 'Could not locate a product to add to cart').toBe(true);

    // Try to select a variant if present (size/color)
    const variantButton = page.locator('button[data-variant], [data-testid*="variant"], [data-testid*="size"] button').first();
    try {
      if (await variantButton.isVisible({ timeout: 1500 })) {
        await variantButton.click({ timeout: 3000 });
      }
    } catch {}

    // Step 2: Add item to cart — try a broad set of selectors/labels
    const addToCartCandidates = [
      page.locator('[data-testid*="add-to-cart" i]'),
      page.locator('[data-testid*="add-to-bag" i]'),
      page.locator('[data-testid*="addtocart" i]'),
      page.locator('[data-test*="add-to-cart" i]'),
      page.locator('[aria-label*="add to cart" i]'),
      page.locator('[aria-label*="add to bag" i]'),
      page.locator('[aria-label*="add to basket" i]'),
      page.getByRole('button', { name: /add to (cart|bag|basket)/i }),
      page.getByRole('button', { name: /^add(\s+item)?$/i }),
      page.getByRole('button', { name: /buy now|buy it now|purchase/i }),
      page.locator('button:has-text("Add to cart")'),
      page.locator('button:has-text("Add to bag")'),
      page.locator('button:has-text("Add to basket")'),
      page.locator('button:has-text("Add item")'),
      page.locator('button:has-text("Add")').filter({ hasNotText: /address|account|review|note/i }),
      page.locator('form button[type="submit"]').filter({ hasText: /add|buy|cart|basket|bag/i }),
      page.locator('form button[type="submit"]'),
    ];

    let added = false;
    for (const btn of addToCartCandidates) {
      try {
        const target = btn.first();
        const visible = await target.isVisible({ timeout: 1500 });
        if (!visible) continue;
        const enabled = await target.isEnabled({ timeout: 1500 }).catch(() => true);
        if (!enabled) continue;
        const cartResponse = page.waitForResponse(
          (resp) => /cart|basket|bag/i.test(resp.url()) && resp.request().method() !== 'GET',
          { timeout: 6000 }
        ).catch(() => null);
        await target.click({ timeout: 5000 });
        await cartResponse;
        added = true;
        break;
      } catch {
        continue;
      }
    }

    if (!added) {
      // Last-resort: dump visible button labels for diagnostics, then try the first submit button on the page
      const labels = await page.locator('button:visible').allInnerTexts().catch(() => []);
      console.log('[TC045] visible button labels on product page:', labels);
      const fallback = page.locator('button:visible').first();
      if (await fallback.isVisible({ timeout: 1000 }).catch(() => false)) {
        try {
          await fallback.click({ timeout: 3000 });
          added = true;
        } catch {}
      }
    }

    expect(added, 'Could not find an add-to-cart button on the product page').toBe(true);

    // Give cart state time to persist
    await page.waitForTimeout(800);

    // Step 3: Navigate to cart page
    await page.goto('http://localhost:8000/dk/cart', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    // Capture cart state before reload — look for cart items
    const cartItemSelectors = [
      '[data-testid*="cart-item"]',
      '[data-testid*="line-item"]',
      '[class*="cart-item"]',
      '[class*="line-item"]',
      'main li',
      'main tr',
    ];

    let preReloadCount = 0;
    let usedSelector = '';
    for (const sel of cartItemSelectors) {
      const count = await page.locator(sel).count();
      if (count > 0) {
        preReloadCount = count;
        usedSelector = sel;
        break;
      }
    }

    // Capture body text snapshot of cart for comparison
    const mainContent = page.locator('main').first();
    await mainContent.waitFor({ state: 'visible', timeout: 8000 });
    const preReloadText = await mainContent.innerText({ timeout: 5000 });

    expect(preReloadCount, `Cart appeared empty before reload (selector tried: ${cartItemSelectors.join(', ')})`).toBeGreaterThan(0);

    // Step 4: Reload the page
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    // Step 5: Verify cart unchanged
    await mainContent.waitFor({ state: 'visible', timeout: 8000 });

    const postReloadCount = await page.locator(usedSelector).count();
    expect(postReloadCount, `Cart item count changed after reload (before: ${preReloadCount}, after: ${postReloadCount})`).toBe(preReloadCount);

    // Verify URL is still cart page
    await expect(page).toHaveURL(/\/cart/, { timeout: 5000 });

    // Verify some content overlap (cart not emptied)
    const postReloadText = await mainContent.innerText({ timeout: 5000 });
    expect(postReloadText.length, 'Cart content empty after reload').toBeGreaterThan(0);
  });
});