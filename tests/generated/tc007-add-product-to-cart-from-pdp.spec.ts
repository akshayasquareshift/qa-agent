import { test, expect } from '@playwright/test';

test.describe('cart — Add product to cart from PDP', () => {
  test('TC007 - Add product to cart from PDP', async ({ page }) => {
    test.setTimeout(60000);

    // Discover a product to test against. Start from the storefront and find a PDP link.
    await page.goto('/dk', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    // Try direct PDP first; if it 404s, fall back to discovering a product link from the listing.
    let pdpReady = false;
    try {
      await page.goto('/dk/products/item', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForLoadState('load');
      const notFound = await page
        .getByText(/404|not\s*found|page\s+not\s+found|kunne ikke findes/i)
        .first()
        .isVisible({ timeout: 1500 })
        .catch(() => false);
      if (!notFound) {
        pdpReady = true;
      }
    } catch {
      pdpReady = false;
    }

    if (!pdpReady) {
      // Try a products listing route, then click into the first visible product.
      const listingCandidates = ['/dk/products', '/dk/shop', '/dk/store', '/dk/collections', '/dk'];
      for (const route of listingCandidates) {
        try {
          await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForLoadState('load');
          const productLink = page
            .locator(
              'a[href*="/products/"], a[href*="/product/"], [data-testid*="product"] a, a[data-testid*="product"]'
            )
            .filter({ has: page.locator(':visible') })
            .first();
          if (await productLink.isVisible({ timeout: 4000 }).catch(() => false)) {
            const href = await productLink.getAttribute('href');
            await Promise.all([
              page.waitForURL(/\/products?\//, { timeout: 15000 }).catch(() => {}),
              productLink.click({ timeout: 5000 }),
            ]);
            await page.waitForLoadState('load');
            if (/\/products?\//.test(page.url())) {
              pdpReady = true;
              break;
            }
            if (href) {
              await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });
              await page.waitForLoadState('load');
              pdpReady = /\/products?\//.test(page.url());
              if (pdpReady) break;
            }
          }
        } catch {
          // try next candidate
        }
      }
    }

    expect(pdpReady, `Could not reach a PDP from base URL. Final URL: ${page.url()}`).toBe(true);

    // Wait for PDP main content to mount: title or main region.
    const pdpTitle = page
      .locator(
        'h1, [data-testid*="product-title"], [data-testid*="productTitle"], [class*="product-title"], [class*="ProductTitle"]'
      )
      .filter({ has: page.locator(':visible') })
      .first();
    await pdpTitle.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

    // Select a variant if variant controls exist (size/color/swatch). Best-effort.
    const variantCandidates = [
      page.getByRole('radio').filter({ has: page.locator(':visible') }),
      page.locator('[data-testid*="variant"] button, [data-testid*="size"] button, [data-testid*="swatch"] button'),
      page.locator('button[aria-pressed], [role="radio"]'),
      page.locator('select[name*="variant" i], select[name*="size" i], select[name*="color" i]'),
    ];
    for (const cand of variantCandidates) {
      const count = await cand.count().catch(() => 0);
      if (count > 0) {
        const el = cand.first();
        const tag = await el.evaluate((n) => n.tagName.toLowerCase()).catch(() => '');
        try {
          if (tag === 'select') {
            const optionValue = await el
              .locator('option')
              .nth(1)
              .getAttribute('value')
              .catch(() => null);
            if (optionValue) await el.selectOption(optionValue, { timeout: 3000 });
          } else {
            await el.click({ timeout: 3000 });
          }
          break;
        } catch {
          // try next variant candidate
        }
      }
    }

    // Locate the Add to Cart CTA with multi-variant matching (Danish + English labels).
    // Try candidates sequentially with short per-step timeouts to avoid slow chained .or() resolution.
    const ctaCandidates = [
      page.locator('[data-testid*="add-to-cart"]:visible, [data-testid*="addToCart"]:visible').first(),
      page.getByRole('button', { name: /add to (cart|bag|basket)/i }).first(),
      page.getByRole('button', { name: /læg i kurv|tilføj til kurv|i kurv/i }).first(),
      page.getByRole('button', { name: /køb|buy now|purchase/i }).first(),
      page.locator('button[name*="add" i]:visible').first(),
      page.locator('form button[type="submit"]:visible').first(),
    ];
    let addToCartCta = ctaCandidates[0];
    let ctaFound = false;
    for (const cand of ctaCandidates) {
      if (await cand.isVisible({ timeout: 3000 }).catch(() => false)) {
        addToCartCta = cand;
        ctaFound = true;
        break;
      }
    }
    expect(ctaFound, `Add-to-cart CTA not found on PDP. Final URL: ${page.url()}`).toBe(true);
    await expect(addToCartCta).toBeEnabled({ timeout: 10000 });

    // Click and wait for the cart mutation network response OR a UI signal that the cart updated.
    const cartResponsePromise = page
      .waitForResponse(
        (resp) =>
          /cart|basket|kurv|checkout|line[-_]?items?/i.test(resp.url()) &&
          ['POST', 'PUT', 'PATCH'].includes(resp.request().method()) &&
          resp.status() < 500,
        { timeout: 15000 }
      )
      .catch(() => null);

    await addToCartCta.click({ timeout: 5000 });
    await cartResponsePromise;

    // Verify cart updated via one of: mini-cart drawer visible, cart badge count > 0,
    // confirmation toast, or by navigating to the cart page and seeing a line item.
    const drawer = page
      .locator(
        '[data-testid*="mini-cart"], [data-testid*="cart-drawer"], [role="dialog"][aria-label*="cart" i], [role="dialog"][aria-label*="kurv" i]'
      )
      .first();
    const badge = page
      .locator(
        '[data-testid*="cart-count"], [data-testid*="cartCount"], [data-testid*="cart-badge"], [aria-label*="cart" i] [class*="count" i], a[href*="/cart"] [class*="badge" i]'
      )
      .first();
    const toast = page
      .getByText(/added to (cart|bag|basket)|tilføjet til kurv|lagt i kurv|i din kurv/i)
      .first();

    let cartUpdated = false;

    if (await drawer.isVisible({ timeout: 4000 }).catch(() => false)) {
      cartUpdated = true;
      await expect(drawer).toBeVisible();
    } else if (await toast.isVisible({ timeout: 3000 }).catch(() => false)) {
      cartUpdated = true;
      await expect(toast).toBeVisible();
    } else if (await badge.isVisible({ timeout: 3000 }).catch(() => false)) {
      const txt = (await badge.textContent({ timeout: 2000 }).catch(() => '')) ?? '';
      const n = parseInt(txt.replace(/\D+/g, ''), 10);
      if (!Number.isNaN(n) && n > 0) {
        cartUpdated = true;
        expect(n).toBeGreaterThan(0);
      }
    }

    if (!cartUpdated) {
      // Navigate to the cart page and look for a line item.
      const cartCandidates = ['/dk/cart', '/dk/basket', '/dk/kurv', '/dk/checkout/cart', '/cart'];
      for (const route of cartCandidates) {
        try {
          await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForLoadState('load');
          const lineItem = page
            .locator(
              '[data-testid*="line-item"], [data-testid*="cart-item"], [data-testid*="cartItem"], [class*="line-item" i], [class*="cart-item" i], tr[class*="cart" i]'
            )
            .filter({ has: page.locator(':visible') })
            .first();
          if (await lineItem.isVisible({ timeout: 5000 }).catch(() => false)) {
            cartUpdated = true;
            await expect(lineItem).toBeVisible();
            break;
          }
          const emptyMarker = await page
            .getByText(/your cart is empty|kurven er tom|empty cart/i)
            .first()
            .isVisible({ timeout: 1500 })
            .catch(() => false);
          if (emptyMarker) {
            // definitively empty on this route — try next
            continue;
          }
        } catch {
          // try next candidate
        }
      }
    }

    expect(
      cartUpdated,
      `Cart did not appear to update after add-to-cart. Final URL: ${page.url()}`
    ).toBe(true);
  });
});