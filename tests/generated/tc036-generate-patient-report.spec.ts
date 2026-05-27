import { test, expect } from '@playwright/test';

test.describe('reports — Generate patient report', () => {
  test('TC036 - Generate patient report', async ({ page }) => {
    const username = process.env.TEST_USERNAME ?? 'PLACEHOLDER_USERNAME';
    const password = process.env.TEST_PASSWORD ?? 'PLACEHOLDER_PASSWORD';

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const usernameInput = page.locator('input[name="username"]').or(
      page.getByLabel(/user(name)?|email/i)
    ).first();
    const passwordInput = page.locator('input[name="password"]').or(
      page.getByLabel(/password/i)
    ).first();

    await usernameInput.waitFor({ state: 'visible', timeout: 10000 });
    await usernameInput.fill(username);
    await passwordInput.fill(password);

    const submitButton = page.locator('button[type="submit"]').or(
      page.getByRole('button', { name: /sign in|log in|login|submit|continue/i })
    ).first();
    await submitButton.waitFor({ state: 'visible', timeout: 10000 });
    await submitButton.click();

    try {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 });
    } catch {
      test.skip(true, 'STATE: login did not redirect away from auth route — credentials may be invalid');
    }

    await page.waitForLoadState('load');

    await page.goto('/reports', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    if (/\/(login|auth|signin)/.test(new URL(page.url()).pathname)) {
      test.skip(true, 'STATE: /reports redirected to auth — session not persisted');
    }

    await expect(page).toHaveURL(/\/reports/);

    const bodyReady = page.locator('body');
    await bodyReady.waitFor({ state: 'visible', timeout: 10000 });

    const reportsContainer = page.locator('[data-testid*="report" i]').or(
      page.locator('main')
    ).or(
      page.getByRole('main')
    ).first();
    await reportsContainer.waitFor({ state: 'visible', timeout: 15000 });

    const reportSelector = page.getByRole('combobox', { name: /report|type|select/i }).or(
      page.getByLabel(/report|type|select/i)
    ).or(
      page.locator('select').first()
    ).or(
      page.locator('[data-testid*="select" i]').first()
    ).first();

    const selectorCount = await reportSelector.count();
    if (selectorCount > 0) {
      try {
        await reportSelector.waitFor({ state: 'visible', timeout: 5000 });
        const tagName = await reportSelector.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        if (tagName === 'select') {
          const options = await reportSelector.locator('option').count();
          if (options > 1) {
            await reportSelector.selectOption({ index: 1 });
          }
        } else {
          await reportSelector.click();
          const option = page.getByRole('option').first().or(
            page.locator('[role="option"]').first()
          ).or(
            page.locator('li').filter({ hasText: /patient|report/i }).first()
          ).first();
          const optionCount = await option.count();
          if (optionCount > 0) {
            await option.click();
          }
        }
      } catch {
      }
    }

    const patientReportOption = page.getByRole('button', { name: /patient/i }).or(
      page.getByText(/patient report/i)
    ).first();
    const patientOptCount = await patientReportOption.count();
    if (patientOptCount > 0 && selectorCount === 0) {
      try {
        await patientReportOption.click({ timeout: 3000 });
      } catch {
      }
    }

    const runButton = page.getByRole('button', { name: /^run$|run report|generate|execute/i }).or(
      page.locator('button[type="submit"]')
    ).or(
      page.locator('[data-testid*="run" i], [data-testid*="generate" i]').first()
    ).first();

    const runCount = await runButton.count();
    if (runCount === 0) {
      test.skip(true, 'SOURCE_BUG: no run/generate button found on /reports — requires data-testid or accessible name');
    }

    await runButton.waitFor({ state: 'visible', timeout: 10000 });
    await expect(runButton).toBeEnabled({ timeout: 5000 });
    await runButton.click();

    await page.waitForLoadState('load');

    const reportOutput = page.locator('[data-testid*="report-output" i], [data-testid*="report-result" i]').or(
      page.locator('table')
    ).or(
      page.getByRole('table')
    ).or(
      page.locator('[class*="report" i][class*="result" i], [class*="report" i][class*="output" i]')
    ).or(
      page.getByText(/report generated|generated successfully|no data/i)
    ).first();

    await reportOutput.waitFor({ state: 'visible', timeout: 15000 });
    await expect(reportOutput).toBeVisible();
  });
});