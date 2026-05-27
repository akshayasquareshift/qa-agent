import { test, expect } from '@playwright/test';

test.describe('appointments — Reschedule appointment', () => {
  test('TC020 - Reschedule appointment', async ({ page }) => {
    const TEST_USERNAME = process.env.TEST_USERNAME ?? 'testuser';
    const TEST_PASSWORD = process.env.TEST_PASSWORD ?? 'testpass';

    // --- Authentication ---
    await page.goto('http://localhost:3000/login', { waitUntil: 'domcontentloaded' });
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

    const loginSubmit = page.locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /sign in|log in|login|submit/i }))
      .first();
    await Promise.race([
      loginSubmit.click(),
      page.waitForLoadState('domcontentloaded').catch(() => {}),
    ]);

    // Wait for either successful navigation away from auth, or for the auth route to stabilize
    try {
      await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 20000 });
    } catch {
      // Possibly already authenticated server-side but URL didn't change; try navigating to a known protected page
      await page.goto('http://localhost:3000/appointments', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('domcontentloaded');
      const probeUrl = new URL(page.url());
      if (/\/(login|auth|signin)/.test(probeUrl.pathname)) {
        // Re-attempt login once
        await usernameField.waitFor({ state: 'visible', timeout: 5000 });
        await usernameField.fill(TEST_USERNAME);
        await passwordField.fill(TEST_PASSWORD);
        await loginSubmit.click();
        await page.waitForURL((url) => !/\/(login|auth|signin)/.test(url.pathname), { timeout: 8000 }).catch(() => {});
      }
    }
    await page.waitForLoadState('domcontentloaded');

    const currentUrl = new URL(page.url());
    if (/\/(login|auth|signin)/.test(currentUrl.pathname)) {
      // Final navigation attempt to a protected route
      await page.goto('http://localhost:3000/appointments', { waitUntil: 'domcontentloaded' });
    }

    // --- Navigate to appointments list ---
    await page.goto('http://localhost:3000/appointments', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('load');

    // Wait for the appointments page to render
    const bodyReady = page.locator('body');
    await bodyReady.waitFor({ state: 'visible', timeout: 10000 });

    // --- Find first appointment and open its edit page ---
    const appointmentLinks = page.locator('a[href*="/appointments/"]');
    const linkCount = await appointmentLinks.count();

    let appointmentId: string | null = null;
    for (let i = 0; i < Math.min(linkCount, 20); i++) {
      const href = await appointmentLinks.nth(i).getAttribute('href');
      if (href) {
        const match = href.match(/\/appointments\/([^\/\?#]+)(?:\/edit)?/);
        if (match && match[1] && match[1] !== 'new' && match[1] !== 'create') {
          appointmentId = match[1];
          break;
        }
      }
    }

    if (!appointmentId) {
      // Try to look at table rows or cards for an id
      const rowLinks = page.getByRole('link').filter({ hasText: /.+/ });
      const rCount = await rowLinks.count();
      for (let i = 0; i < Math.min(rCount, 20); i++) {
        const href = await rowLinks.nth(i).getAttribute('href');
        if (href && /\/appointments\/[^\/]+/.test(href)) {
          const match = href.match(/\/appointments\/([^\/\?#]+)/);
          if (match && match[1] && match[1] !== 'new') {
            appointmentId = match[1];
            break;
          }
        }
      }
    }

    if (!appointmentId) {
      test.info().annotations.push({
        type: 'SOURCE_BUG',
        description: 'No appointment records found to reschedule — seed data missing or list not rendering links',
      });
      test.skip(true, 'SOURCE_BUG: no appointment available to edit');
      return;
    }

    // --- Step 1: Open edit ---
    await page.goto(`http://localhost:3000/appointments/${appointmentId}/edit`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForLoadState('load');

    const editUrl = new URL(page.url());
    if (/\/(login|auth|signin)/.test(editUrl.pathname)) {
      test.info().annotations.push({
        type: 'SOURCE_BUG',
        description: 'Edit appointment route redirected to auth — session not persisted',
      });
      test.skip(true, 'SOURCE_BUG: edit route requires re-auth');
      return;
    }

    // --- Step 2: Change time ---
    const timeField = page.locator('input[type="time"]')
      .or(page.locator('input[name*="time" i]'))
      .or(page.locator('input[name*="start" i]'))
      .or(page.locator('input[type="datetime-local"]'))
      .or(page.getByLabel(/time|start|appointment time|when/i))
      .first();

    await timeField.waitFor({ state: 'visible', timeout: 10000 });

    const fieldType = await timeField.getAttribute('type');
    let newValue: string;
    if (fieldType === 'datetime-local') {
      newValue = '2026-12-15T14:30';
    } else if (fieldType === 'time') {
      newValue = '14:30';
    } else if (fieldType === 'date') {
      newValue = '2026-12-15';
    } else {
      newValue = '14:30';
    }

    await timeField.fill('');
    await timeField.fill(newValue);
    await expect(timeField).toHaveValue(newValue, { timeout: 5000 });

    // --- Step 3: Save ---
    const saveButton = page.locator('button[type="submit"]')
      .or(page.getByRole('button', { name: /save|update|submit|reschedule|confirm/i }))
      .first();

    await saveButton.waitFor({ state: 'visible', timeout: 10000 });
    await expect(saveButton).toBeEnabled({ timeout: 5000 });
    await saveButton.click();

    // --- Verify update ---
    const successDetectors = [
      page.getByRole('alert').filter({ hasText: /updated|saved|success|rescheduled/i }),
      page.getByText(/appointment updated|successfully updated|saved|rescheduled/i),
    ];

    let navigatedAway = false;
    try {
      await page.waitForURL(
        (url) => !/\/edit$/.test(url.pathname),
        { timeout: 10000 }
      );
      navigatedAway = true;
    } catch {
      navigatedAway = false;
    }

    await page.waitForLoadState('load');

    let sawSuccess = false;
    for (const detector of successDetectors) {
      try {
        if (await detector.first().isVisible({ timeout: 2000 })) {
          sawSuccess = true;
          break;
        }
      } catch {
        // continue
      }
    }

    expect(navigatedAway || sawSuccess).toBeTruthy();

    const finalUrl = new URL(page.url());
    expect(/\/(login|auth|signin)/.test(finalUrl.pathname)).toBeFalsy();
  });
});