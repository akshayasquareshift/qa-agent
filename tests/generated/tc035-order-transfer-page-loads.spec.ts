import { test, expect } from '@playwright/test';

test.describe('orders — Order transfer page loads', () => {
  test('TC035 - Order transfer page loads', async ({ page }) => {
    const response = await page.goto('http://localhost:8000/dk/order/order_123/transfer/token_abc', {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });

    await page.waitForLoadState('load');

    expect(response, 'navigation response should exist').not.toBeNull();

    await expect(page).toHaveURL(/\/dk\/order\/order_123\/transfer\/token_abc/, { timeout: 10000 });

    const body = page.locator('body');
    await expect(body).toBeVisible({ timeout: 10000 });

    await page.waitForFunction(
      () => (document.body?.innerText?.trim().length ?? 0) > 0,
      undefined,
      { timeout: 10000 }
    );

    const bodyText = (await body.innerText()).toLowerCase();
    const hasErrorMarker =
      /application error|internal server error|500\b|something went wrong/i.test(bodyText);

    if (hasErrorMarker) {
      test.info().annotations.push({
        type: 'SOURCE_BUG',
        description: 'Transfer page renders an application/server error instead of expected content',
      });
      throw new Error('SOURCE_BUG: Transfer page returned application error content');
    }

    const main = page
      .locator('main')
      .or(page.locator('[role="main"]'))
      .or(page.locator('article'))
      .or(page.locator('body'))
      .first();

    await expect(main).toBeVisible({ timeout: 10000 });

    const transferIndicator = page
      .getByRole('heading', { name: /transfer/i })
      .or(page.getByText(/transfer/i))
      .or(page.getByText(/order/i))
      .first();

    await expect(transferIndicator).toBeVisible({ timeout: 10000 });

    const renderedTextLength = (await body.innerText()).trim().length;
    expect(renderedTextLength, 'page should render meaningful content').toBeGreaterThan(0);
  });
});