import { test, expect } from '@playwright/test';

test.describe('navigation — Navigate category to product', () => {
  test('TC041 - Navigate category to product', async ({ page }) => {
    // Discover a real category via the home page rather than hardcoding a placeholder path.
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 15000 });

    const categoryLinkSelector = [
      'a[href*="/categories/"]',
      'a[href*="/category/"]',
      'a[href*="/c/"]',
      'nav a[href*="categor" i]',
    ].join(', ');

    await page.waitForFunction(
      (sel) => {
        const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
        return els.some((el) => (el as HTMLElement).offsetParent !== null);
      },
      categoryLinkSelector,
      { timeout: 15000 },
    ).catch(() => {});

    const categoryLinks = page.locator(categoryLinkSelector).filter({ visible: true });
    const catCount = await categoryLinks.count();
    expect(catCount, 'expected at least one category link on home').toBeGreaterThan(0);

    await categoryLinks.first().click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded');

    // Confirm we landed on a category-ish page (accept locale redirect variants)
    await expect(page).toHaveURL(/\/(categories|category|c)\//i, { timeout: 10000 });

    // Wait for at least one product link to be present in the DOM.
    const productLinkSelector = [
      'a[href*="/products/"]',
      'a[href*="/product/"]',
      '[data-testid*="product-card"] a',
      '[data-testid="product-card"]',
      'article a[href]',
    ].join(', ');

    await page.waitForFunction(
      (sel) => {
        const els = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
        return els.some((el) => (el as HTMLElement).offsetParent !== null);
      },
      productLinkSelector,
      { timeout: 15000 },
    );

    const productLinks = page.locator(productLinkSelector).filter({ visible: true });
    const count = await productLinks.count();
    expect(count, 'expected at least one product link on category page').toBeGreaterThan(0);

    // Pick the first product link whose href is not self-referential to the category.
    let target = productLinks.first();
    let targetHref: string | null = null;
    const currentPath = new URL(page.url()).pathname;

    for (let i = 0; i < Math.min(count, 20); i++) {
      const candidate = productLinks.nth(i);
      const href = await candidate.getAttribute('href');
      if (!href) continue;
      if (href.startsWith('#')) continue;
      const resolvedPath = href.startsWith('http') ? new URL(href).pathname : href.split('?')[0];
      if (resolvedPath === currentPath) continue;
      target = candidate;
      targetHref = resolvedPath;
      break;
    }

    await target.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await expect(target).toBeVisible({ timeout: 5000 });

    const navPromise = page.waitForURL(
      (url) => {
        const p = url.pathname;
        return /\/products?\//i.test(p) || (targetHref ? p === targetHref : false);
      },
      { timeout: 15000 },
    );
    await target.click({ timeout: 5000 });
    await navPromise;

    await page.waitForLoadState('load');

    // PDP readiness: URL contains product segment AND a meaningful PDP signal is visible.
    await expect(page).toHaveURL(/\/products?\//i, { timeout: 10000 });

    const pdpSignal = page
      .locator(
        [
          '[data-testid*="product"]',
          '[data-testid*="pdp"]',
          '[itemprop="name"]',
          'h1',
          'h2',
          '[class*="product-title" i]',
          '[class*="product-name" i]',
          'main img',
        ].join(', '),
      )
      .filter({ visible: true })
      .first();

    await expect(pdpSignal, 'expected PDP content to render').toBeVisible({ timeout: 10000 });

    // 404 guard: ensure we didn't land on an error page.
    const notFound = page.locator('text=/404|not\\s*found|page not found/i').first();
    await expect(notFound).toHaveCount(0).catch(async () => {
      const isVisible = await notFound.isVisible().catch(() => false);
      expect(isVisible, 'PDP should not be a 404 page').toBeFalsy();
    });
  });
});