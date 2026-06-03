import { test, expect } from '@playwright/test';

test.describe('navigation — Navigate store to product detail', () => {
  test('TC040 - Navigate store to product detail', async ({ page }) => {
    test.setTimeout(60000);

    await page.goto('/dk/store', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load');

    // Wait for product cards to render in the DOM
    await page.waitForFunction(
      () => {
        const candidates = document.querySelectorAll(
          'a[href*="/product/"], a[href*="/products/"], [data-testid*="product-card"], [data-testid*="product-item"]'
        );
        return candidates.length > 0;
      },
      { timeout: 15000 }
    ).catch(() => {});

    const startUrl = page.url();

    // Build a candidate locator for product cards/links — visible only
    const productLinkCandidates = [
      page.locator('[data-testid*="product-card"] a, a[data-testid*="product-card"]').filter({ visible: true }),
      page.locator('a[href*="/product/"]').filter({ visible: true }),
      page.locator('a[href*="/products/"]').filter({ visible: true }),
      page.locator('main a:has(img)').filter({ visible: true }),
    ];

    let clicked = false;
    let targetHref: string | null = null;

    for (const cand of productLinkCandidates) {
      const count = await cand.count().catch(() => 0);
      if (count === 0) continue;

      // Find the first candidate whose href is not the current page
      for (let i = 0; i < Math.min(count, 10); i++) {
        const item = cand.nth(i);
        const visible = await item.isVisible({ timeout: 1500 }).catch(() => false);
        if (!visible) continue;
        const href = await item.getAttribute('href').catch(() => null);
        if (!href) continue;
        if (href.startsWith('#')) continue;
        // Skip self-referential links to the current store listing
        if (href === startUrl || href.endsWith('/dk/store') || href.endsWith('/store')) continue;

        targetHref = href;
        const navPromise = page.waitForURL((url) => url.toString() !== startUrl, { timeout: 15000 }).catch(() => {});
        await item.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await item.click({ timeout: 5000 }).catch(async () => {
          await item.click({ force: true, timeout: 5000 }).catch(() => {});
        });
        await navPromise;
        clicked = true;
        break;
      }
      if (clicked) break;
    }

    expect(clicked, 'No product card link was found on the store page').toBe(true);

    await page.waitForLoadState('load');

    // Assert we navigated away from the listing
    const finalUrl = page.url();
    expect(finalUrl).not.toBe(startUrl);

    // Verify PDP loaded — URL should reflect a product detail route
    expect(finalUrl).toMatch(/\/(product|products)\//i);

    // Verify no 404 marker present
    const notFound = page.locator('text=/404|not found|page not found/i').first();
    const isNotFound = await notFound.isVisible({ timeout: 1500 }).catch(() => false);
    expect(isNotFound, `PDP returned 404 for ${finalUrl}`).toBe(false);

    // Verify PDP content: title, image, or price/CTA — multi-signal readiness
    const titleLocator = page.locator(
      'h1, h2, [data-testid*="product-title"], [data-testid*="product-name"], [itemprop="name"], [class*="product-title" i], [class*="product-name" i]'
    ).filter({ visible: true }).first();

    const imageLocator = page.locator('main img, [data-testid*="product"] img, [itemprop="image"]').filter({ visible: true }).first();

    const priceOrCta = page.locator(
      '[data-testid*="price"], [itemprop="price"], [class*="price" i], [class*="amount" i], button:has-text(/add|buy|kurv|køb|tilføj/i), [role="button"][aria-label*="cart" i]'
    ).filter({ visible: true }).first();

    const titleVisible = await titleLocator.isVisible({ timeout: 8000 }).catch(() => false);
    const imageVisible = await imageLocator.isVisible({ timeout: 5000 }).catch(() => false);
    const priceCtaVisible = await priceOrCta.isVisible({ timeout: 5000 }).catch(() => false);

    expect(
      titleVisible || imageVisible || priceCtaVisible,
      `PDP did not render expected content signals at ${finalUrl} (title=${titleVisible}, image=${imageVisible}, priceOrCta=${priceCtaVisible})`
    ).toBe(true);
  });
});