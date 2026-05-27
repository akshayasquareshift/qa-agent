import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:3000';
const TEST_USERNAME = process.env.TEST_USERNAME ?? 'testuser';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'testpass';

test.describe('patients — View patient medical history', () => {
  test('TC030 - View patient medical history', async ({ page }) => {
    test.setTimeout(60000);

    // ---- Inline authentication ----
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const usernameField = page.locator('input[name="username"]')
      .or(page.locator('input[name="email"]'))
      .or(page.getByLabel(/username|email/i))
      .first();
    const passwordField = page.locator('input[name="password"]')
      .or(page.getByLabel(/password/i))
      .first();

    await usernameField.waitFor({ state: 'visible', timeout: 10000 });
    await usernameField.fill(TEST_USERNAME);
    await passwordField.fill(TEST_PASSWORD);

    const submitBtn = page.locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /sign in|log in|login|submit/i }))
      .first();
    await submitBtn.click();

    await page.waitForURL((url) => !/\/(login|signin|auth)/i.test(url.pathname), { timeout: 15000 });
    await page.waitForLoadState('load');

    // Verify authentication succeeded
    expect(page.url()).not.toMatch(/\/(login|signin|auth)/i);

    // ---- Navigate to patients list to find a patient ID ----
    await page.goto(`${BASE_URL}/patients`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    // Wait for the patients list to render — wait for first row/link/card
    const patientLink = page.locator('a[href*="/patients/"]').first();
    await patientLink.waitFor({ state: 'visible', timeout: 15000 });

    const href = await patientLink.getAttribute('href');
    expect(href).toBeTruthy();

    // Extract patient ID from href (handles /patients/<id> and /patients/<id>/...)
    const match = href!.match(/\/patients\/([^/?#]+)/);
    expect(match).not.toBeNull();
    const patientId = match![1];

    // ---- Open patient detail page ----
    await page.goto(`${BASE_URL}/patients/${patientId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    // ---- Navigate to history page ----
    await page.goto(`${BASE_URL}/patients/${patientId}/history`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    // Confirm URL is the history page
    await expect(page).toHaveURL(new RegExp(`/patients/${patientId}/history`));

    // ---- Verify history timeline is shown ----
    const timeline = page.locator('[data-testid="history-timeline"]')
      .or(page.locator('[data-testid="patient-history"]'))
      .or(page.getByRole('heading', { name: /history|medical history|timeline/i }))
      .or(page.locator('main').getByText(/history|timeline|medical/i).first())
      .first();

    await timeline.waitFor({ state: 'visible', timeout: 15000 });
    await expect(timeline).toBeVisible();
  });
});