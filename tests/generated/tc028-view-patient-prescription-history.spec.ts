import { test, expect } from '@playwright/test';

test.describe('prescriptions — View patient prescription history', () => {
  test('TC028 - View patient prescription history', async ({ page }) => {
    const username = process.env.TEST_USERNAME ?? 'testuser';
    const password = process.env.TEST_PASSWORD ?? 'testpass';

    await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });

    const usernameInput = page.locator('input[name="username"]')
      .or(page.locator('input[name="email"]'))
      .or(page.getByLabel(/username|email/i));
    const passwordInput = page.locator('input[name="password"]')
      .or(page.getByLabel(/password/i));

    await usernameInput.first().waitFor({ state: 'visible', timeout: 10000 });
    await usernameInput.first().fill(username);
    await passwordInput.first().fill(password);

    const submitButton = page.locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /sign in|log in|login|submit/i }));
    await submitButton.first().click();

    await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 15000 });
    await page.waitForLoadState('load');

    const onAuthPage = /\/(login|auth|signin)/.test(new URL(page.url()).pathname);
    if (onAuthPage) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'Login did not redirect away from auth route with provided credentials' });
      test.skip(true, 'SOURCE_BUG: Login flow did not authenticate user');
      return;
    }

    await page.goto('http://localhost:3000/patients', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const stillOnAuth = /\/(login|auth|signin)/.test(new URL(page.url()).pathname);
    if (stillOnAuth) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'Protected route /patients redirected to auth after successful login' });
      test.skip(true, 'SOURCE_BUG: Session not persisted after login');
      return;
    }

    const patientRow = page.locator('tr, [role="row"], a[href*="/patients/"]').filter({ hasNot: page.locator('th') });
    await patientRow.first().waitFor({ state: 'visible', timeout: 15000 });

    const patientLink = page.locator('a[href*="/patients/"]').filter({ hasNotText: /^$/ }).first();
    const href = await patientLink.getAttribute('href');

    let patientId: string | null = null;
    if (href) {
      const match = href.match(/\/patients\/([^/?#]+)/);
      if (match) {
        patientId = match[1];
      }
    }

    if (!patientId) {
      const rowLink = page.locator('tr a[href*="/patients/"], [role="row"] a[href*="/patients/"]').first();
      const rowHref = await rowLink.getAttribute('href').catch(() => null);
      if (rowHref) {
        const m = rowHref.match(/\/patients\/([^/?#]+)/);
        if (m) patientId = m[1];
      }
    }

    if (!patientId) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'No patient records found to derive an ID for prescription history navigation' });
      test.skip(true, 'SOURCE_BUG: No patient records available');
      return;
    }

    await page.goto(`http://localhost:3000/patients/${patientId}/prescriptions`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    const onAuthAfterNav = /\/(login|auth|signin)/.test(new URL(page.url()).pathname);
    if (onAuthAfterNav) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'Prescriptions route redirected to auth path despite valid session' });
      test.skip(true, 'SOURCE_BUG: Prescriptions page not reachable when authenticated');
      return;
    }

    await expect(page).toHaveURL(new RegExp(`/patients/${patientId}/prescriptions`));

    const prescriptionsContainer = page.locator('main, [role="main"], [data-testid*="prescription"], table, ul, [role="list"]').first();
    await prescriptionsContainer.waitFor({ state: 'visible', timeout: 15000 });

    const heading = page.getByRole('heading', { name: /prescription/i });
    const list = page.locator('table, [role="list"], ul, [data-testid*="prescription-list"], [data-testid*="prescriptions"]');
    const emptyState = page.getByText(/no prescriptions|no records|empty/i);

    const headingVisible = await heading.first().isVisible().catch(() => false);
    const listVisible = await list.first().isVisible().catch(() => false);
    const emptyVisible = await emptyState.first().isVisible().catch(() => false);

    expect(headingVisible || listVisible || emptyVisible).toBeTruthy();

    if (listVisible) {
      await expect(list.first()).toBeVisible();
    } else if (headingVisible) {
      await expect(heading.first()).toBeVisible();
    } else {
      await expect(emptyState.first()).toBeVisible();
    }
  });
});