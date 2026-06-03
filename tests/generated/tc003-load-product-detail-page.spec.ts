import { test, expect } from '@playwright/test';

test.describe('catalog — Load product detail page', () => {
  test('TC003 - Load product detail page', async ({ page }) => {
    test.setTimeout(45000);

    const productListUrlPattern = /\/[a-z]{2}\/(products|product|store|shop|catalog|collections)(\/|$)/i;

    // Step 1: Navigate to product URL. The given URL /dk/products/item is a placeholder slug.
    // First try direct nav, then fall back to discovering a real product from the listing page.
    let onProductPage = false;
    const candidateUrls = ['/dk/products/item', '/dk/product/item', '/dk/products', '/dk/shop', '/dk/store', '/dk'];

    for (const url of candidateUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
        await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
      } catch {
        continue;
      }

      const currentUrl = page.url();
      const has404 = await page
        .locator('main, body')
        .filter({ hasText: /404|not\s*found|ikke\s*fundet/i })
        .first()
        .isVisible({ timeout: 1500 })
        .catch(() => false);

      if (!has404 && /\/(products?|product)\/[^/]+/i.test(currentUrl)) {
        onProductPage = true;
        break;
      }

      // If we landed on a listing page, click the first visible product link
      const productLinkCandidates = [
        page.locator('a[href*="/products/"]:visible').first(),
        page.locator('a[href*="/product/"]:visible').first(),
        page.getByRole('link', { name: /view|see|details|shop|køb|se mere/i }).first(),
      ];

      for (const link of productLinkCandidates) {
        const visible = await link.isVisible({ timeout: 2000 }).catch(() => false);
        if (visible) {
          await Promise.all([
            page.waitForURL(/\/(products?|product)\/[^/]+/i, { timeout: 10000 }).catch(() => {}),
            link.click({ timeout: 5000 }).catch(() => {}),
          ]);
          await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});
          if (/\/(products?|product)\/[^/]+/i.test(page.url())) {
            onProductPage = true;
            break;
          }
        }
      }

      if (onProductPage) break;
    }

    expect(onProductPage, `Could not reach a product detail page. Last URL: ${page.url()}`).toBe(true);

    // Wait for SPA content to hydrate
    await page
      .waitForFunction(() => document.body && document.body.innerText.trim().length > 100, {
        timeout: 10000,
      })
      .catch(() => {});

    // Step 2: Verify title
    const titleLocator = page
      .locator('h1:visible, h2:visible, [data-testid*="title" i]:visible, [class*="product-title" i]:visible, [class*="ProductTitle" i]:visible, [itemprop="name"]:visible')
      .first();

    const titleVisible = await titleLocator.isVisible({ timeout: 6000 }).catch(() => false);
    expect(titleVisible, `No product title element visible on ${page.url()}`).toBe(true);

    const titleText = (await titleLocator.textContent({ timeout: 3000 }).catch(() => '')) ?? '';
    expect(titleText.trim().length, 'Product title is empty').toBeGreaterThan(0);

    // Step 2 (cont): Verify price
    const priceFound = await page
      .waitForFunction(
        () => {
          const text = document.body.innerText || '';
          // DKK, kr, €, $, £, or generic numeric price patterns
          return /(\bkr\.?\b|DKK|€|\$|£|\d+[.,]\d{2})/i.test(text);
        },
        { timeout: 8000 }
      )
      .then(() => true)
      .catch(() => false);

    if (!priceFound) {
      const priceLocator = page
        .locator('[data-testid*="price" i]:visible, [class*="price" i]:visible, [itemprop="price"]:visible')
        .first();
      const priceVisible = await priceLocator.isVisible({ timeout: 3000 }).catch(() => false);
      expect(priceVisible, `No price element or currency text found on ${page.url()}`).toBe(true);
    }

    // Step 3: Verify add-to-cart visible. Some storefronts require a variant (size/colour)
    // to be selected before the add-to-cart button enables/appears — try clicking the first
    // visible variant option before probing for the button.
    const variantCandidates = [
      page.locator('[data-testid*="size" i] button:visible, [data-testid*="variant" i] button:visible, [data-testid*="option" i] button:visible').first(),
      page.locator('fieldset:visible label:visible, [role="radiogroup"]:visible [role="radio"]:visible, [role="radiogroup"]:visible label:visible').first(),
      page.locator('button[aria-pressed]:visible, button[data-selected]:visible').first(),
    ];
    for (const variant of variantCandidates) {
      const v = await variant.isVisible({ timeout: 1000 }).catch(() => false);
      if (v) {
        await variant.click({ timeout: 2000 }).catch(() => {});
        break;
      }
    }

    const addToCartCandidates: Array<() => Promise<boolean>> = [
      async () =>
        page
          .getByRole('button', { name: /add\s*(to|item)|add\s*to\s*(cart|bag|basket)|buy\s*now|purchase|checkout|læg\s*i\s*kurv|tilføj|køb/i })
          .first()
          .isVisible({ timeout: 3000 })
          .catch(() => false),
      async () =>
        page
          .locator('[data-testid*="add" i]:visible, [data-testid*="cart" i]:visible, [data-testid*="buy" i]:visible, [data-test*="add-to-cart" i]:visible')
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false),
      async () =>
        page
          .locator('button[name*="add" i]:visible, button[id*="add-to-cart" i]:visible, button[class*="AddToCart" i]:visible, button[class*="add-to-cart" i]:visible, button[class*="add_to_cart" i]:visible')
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false),
      async () =>
        page
          .locator('form[action*="cart" i] button[type="submit"]:visible, form[action*="cart" i] input[type="submit"]:visible')
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false),
      async () =>
        page
          .locator('button:visible, a[role="button"]:visible, input[type="submit"]:visible')
          .filter({ hasText: /add|buy|purchase|cart|bag|basket|kurv|tilføj|køb/i })
          .first()
          .isVisible({ timeout: 2000 })
          .catch(() => false),
      async () => {
        return await page
          .evaluate(() => {
            const text = (document.body.innerText || '').toLowerCase();
            return /add\s*(to\s*)?(cart|bag|basket|item)|buy\s*now|læg\s*i\s*kurv|tilføj|køb/.test(text);
          })
          .catch(() => false);
      },
    ];

    let addToCartVisible = false;
    for (const probe of addToCartCandidates) {
      if (await probe()) {
        addToCartVisible = true;
        break;
      }
    }

    expect(addToCartVisible, `Add-to-cart control not visible on ${page.url()}`).toBe(true);

    await expect(page).toHaveURL(/\/(products?|product)\/[^/]+/i);
  });
});