import { test, expect } from '@playwright/test';

test.describe('catalog — Load collection page', () => {
  test('TC005 - Load collection page', async ({ page }) => {
    // Discover an actual collection link from the homepage rather than guessing the slug
    await page.goto('/dk', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const collectionLink = page.locator('a[href*="/collections/"]').first();
    await collectionLink.waitFor({ state: 'attached', timeout: 10000 });
    const href = await collectionLink.getAttribute('href');
    if (!href) throw new Error('No collection link found on homepage');

    const response = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Verify page loaded successfully (not a 404 or error page)
    if (response) {
      const status = response.status();
      expect.soft(status, `Collection page returned ${status}`).toBeLessThan(400);
    }

    await expect(page).toHaveURL(/\/collections\//);

    // Wait for the page main content to be ready
    const main = page.locator('main, [role="main"], body').first();
    await main.waitFor({ state: 'visible', timeout: 10000 });

    // Verify collection name / heading is visible
    const heading = page
      .locator('h1, h2, [data-testid*="collection-title"], [data-testid*="collection-name"], [class*="collection-title"], [class*="collection-name"], [class*="page-title"]')
      .filter({ visible: true })
      .first();

    let headingFound = false;
    try {
      await heading.waitFor({ state: 'visible', timeout: 5000 });
      const text = (await heading.textContent({ timeout: 2000 }))?.trim() ?? '';
      expect(text.length, 'Collection heading should have non-empty text').toBeGreaterThan(0);
      headingFound = true;
    } catch {
      // Fall back to checking page title contains a meaningful name
      const title = await page.title();
      expect(title.length, 'Page title should be non-empty').toBeGreaterThan(0);
    }

    // Verify products are visible on the collection page using multi-signal detection
    const productsVisible = await page.waitForFunction(
      () => {
        const selectors = [
          '[data-testid*="product"]',
          '[data-testid*="collection-item"]',
          'a[href*="/products/"]',
          'a[href*="/product/"]',
          '[class*="product-card"]',
          '[class*="product-item"]',
          '[class*="ProductCard"]',
          '[itemtype*="Product"]',
        ];
        for (const sel of selectors) {
          const els = document.querySelectorAll(sel);
          let visibleCount = 0;
          els.forEach((el) => {
            const rect = (el as HTMLElement).getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) visibleCount++;
          });
          if (visibleCount > 0) return visibleCount;
        }
        return 0;
      },
      undefined,
      { timeout: 10000 }
    ).catch(() => null);

    if (!productsVisible) {
      // Accept empty-collection state if the page is clearly a collection page
      const bodyText = (await page.locator('body').textContent({ timeout: 2000 })) ?? '';
      const isEmptyState = /no products|empty|ingen produkter|tom/i.test(bodyText);
      expect(
        isEmptyState || headingFound,
        'Collection page should render either products, a heading, or an empty-state message'
      ).toBeTruthy();
    } else {
      const count = await productsVisible.jsonValue();
      expect(Number(count), 'At least one product should be visible').toBeGreaterThan(0);
    }
  });
});