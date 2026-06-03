import { test, expect } from '@playwright/test';

test.describe('account — Edit existing address', () => {
  test('TC021 - Edit existing address', async ({ page }) => {
    const BASE = 'http://localhost:8000';
    const LOCALE = '/dk';

    test.setTimeout(90000);

    // ---- Inline auth setup ----
    const username = process.env.TEST_USERNAME ?? 'test@example.com';
    const password = process.env.TEST_PASSWORD ?? 'TestPassword123!';

    const loginCandidates = [
      `${LOCALE}/account/login`,
      `${LOCALE}/account`,
      `${LOCALE}/login`,
      `/account/login`,
      `/login`,
    ];

    let loggedIn = false;
    for (const route of loginCandidates) {
      try {
        await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});

        // Try to reveal a sign-in tab if needed
        const signInTab = page.getByRole('button', { name: /sign in|log in|login/i })
          .or(page.getByRole('tab', { name: /sign in|log in|login/i }))
          .or(page.getByRole('link', { name: /sign in|log in|login/i }));
        if (await signInTab.first().isVisible({ timeout: 1500 }).catch(() => false)) {
          await signInTab.first().click({ timeout: 3000 }).catch(() => {});
        }

        const emailInput = page.locator('input[name="email"], input[name="username"], input[type="email"], input[autocomplete="email"], input[autocomplete="username"]').first();
        const passwordInput = page.locator('input[name="password"], input[type="password"], input[autocomplete="current-password"]').first();

        if (await emailInput.isVisible({ timeout: 6000 }).catch(() => false)) {
          await emailInput.fill(username, { timeout: 5000 });
          await passwordInput.waitFor({ state: 'visible', timeout: 5000 });
          await passwordInput.fill(password, { timeout: 5000 });

          const submit = page.locator('button[type="submit"], input[type="submit"]')
            .or(page.getByRole('button', { name: /sign in|log in|login|submit|continue/i }))
            .first();

          const navPromise = page.waitForURL((u) => !/\/(login|signin|sign-in)(\/|\?|$)/i.test(u.pathname), { timeout: 15000 }).catch(() => null);
          await submit.click({ timeout: 5000 });
          await navPromise;
          await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});

          if (!/\/(login|signin|sign-in)(\/|\?|$)/i.test(new URL(page.url()).pathname)) {
            loggedIn = true;
            break;
          }
        }
      } catch {
        // try next candidate
      }
    }

    if (!loggedIn) {
      throw new Error(`STATE: failed to authenticate with provided credentials at any known login route. Current URL: ${page.url()}`);
    }

    // ---- Navigate to addresses page ----
    await page.goto(`${BASE}${LOCALE}/account/addresses`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});

    // Guard against auth redirect
    const onAuth = /\/(login|signin|sign-in)(\/|\?|$)/i.test(new URL(page.url()).pathname);
    if (onAuth) {
      throw new Error(`STATE: addresses page redirected to auth. URL: ${page.url()}`);
    }

    // ---- Ensure at least one address exists; if none, create one (precondition TC020) ----
    const addressCard = page.locator(
      '[data-testid*="address" i], article:has-text("address"), li:has-text("address"), .address-card, [class*="address" i]'
    ).filter({ visible: true });

    // Look for an Add new address affordance and use it if no addresses present
    const editButtons = page.getByRole('button', { name: /edit|rediger|ændr|change|modify/i })
      .or(page.getByRole('link', { name: /edit|rediger|ændr|change|modify/i }))
      .or(page.locator('[data-testid*="edit" i], [aria-label*="edit" i], a[href*="edit" i], button[title*="edit" i]'))
      .or(page.locator('a, button').filter({ has: page.locator('svg[class*="edit" i], svg[data-icon*="edit" i], [class*="pencil" i], [class*="edit-icon" i]') }));

    let editCount = await editButtons.count().catch(() => 0);

    if (editCount === 0) {
      // Try to create one via Add new address
      const addBtn = page.getByRole('button', { name: /add (new )?address|new address|create address/i })
        .or(page.getByRole('link', { name: /add (new )?address|new address|create address/i }));

      if (await addBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
        await addBtn.first().click({ timeout: 5000 });

        const modal = page.getByRole('dialog').or(page.locator('[role="dialog"], .modal, [class*="modal" i]')).first();
        await modal.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});

        const fill = async (regex: RegExp, value: string) => {
          const field = page.getByLabel(regex)
            .or(page.getByPlaceholder(regex))
            .or(page.locator(`input[name*="${regex.source.split('|')[0]}" i]`))
            .first();
          if (await field.isVisible({ timeout: 1500 }).catch(() => false)) {
            await field.fill(value, { timeout: 3000 }).catch(() => {});
          }
        };

        await fill(/first.?name/i, 'Test');
        await fill(/last.?name/i, 'User');
        await fill(/company/i, 'TestCo');
        await fill(/address|street/i, '123 Test St');
        await fill(/city/i, 'Copenhagen');
        await fill(/post(al)?.?code|zip/i, '1000');
        await fill(/phone/i, '12345678');

        const save = page.getByRole('button', { name: /save|add|create|submit/i }).first();
        await save.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(1000);

        editCount = await editButtons.count().catch(() => 0);
      }
    }

    expect(editCount, 'Expected at least one address with an Edit control').toBeGreaterThan(0);

    // ---- Step 1: Click edit ----
    const editBtn = editButtons.first();
    await editBtn.waitFor({ state: 'visible', timeout: 10000 });
    await editBtn.click({ timeout: 5000 });

    // Wait for edit form / modal
    const editForm = page.getByRole('dialog')
      .or(page.locator('form:has(input)'))
      .first();
    await editForm.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(300);

    // ---- Step 2: Modify fields ----
    const uniqueMarker = `Edited St ${Date.now().toString().slice(-6)}`;

    const cityField = page.getByLabel(/city/i)
      .or(page.getByPlaceholder(/city/i))
      .or(page.locator('input[name*="city" i]'))
      .first();

    const addressField = page.getByLabel(/^address|street|address.?line/i)
      .or(page.getByPlaceholder(/address|street/i))
      .or(page.locator('input[name*="address" i], input[name*="street" i]'))
      .first();

    let modifiedField: 'address' | 'city' | null = null;
    let newValue = '';

    if (await addressField.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addressField.fill('', { timeout: 3000 }).catch(() => {});
      await addressField.fill(uniqueMarker, { timeout: 3000 });
      modifiedField = 'address';
      newValue = uniqueMarker;
    } else if (await cityField.isVisible({ timeout: 3000 }).catch(() => false)) {
      const cityValue = `Aarhus ${Date.now().toString().slice(-4)}`;
      await cityField.fill('', { timeout: 3000 }).catch(() => {});
      await cityField.fill(cityValue, { timeout: 3000 });
      modifiedField = 'city';
      newValue = cityValue;
    } else {
      throw new Error('SOURCE_BUG: no editable address or city field found in edit form');
    }

    // ---- Step 3: Save ----
    const saveBtn = page.getByRole('button', { name: /^save$|save changes|update|submit/i }).first();
    await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
    await saveBtn.click({ timeout: 5000 });

    // Wait for modal to close (if any) or page to settle
    await editForm.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(800);

    // ---- Step 4: Verify changes ----
    await expect(page.getByText(newValue, { exact: false }).first()).toBeVisible({ timeout: 10000 });
  });
});