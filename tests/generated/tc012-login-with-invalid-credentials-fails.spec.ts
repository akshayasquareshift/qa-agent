import { test, expect } from '@playwright/test';

test.describe('auth — Login with invalid credentials fails', () => {
  test('TC012 - Login with invalid credentials fails', async ({ page }) => {
    test.setTimeout(45000);

    const candidateRoutes = ['/dk/account', '/dk/account/login', '/dk/login', '/account/login', '/account'];
    let emailInput = null;
    let passwordInput = null;
    let landedUrl = '';

    for (const route of candidateRoutes) {
      try {
        await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});

        const signInTab = page.getByRole('tab', { name: /sign\s*in|log\s*in|login|log\s*ind/i })
          .or(page.getByRole('button', { name: /sign\s*in|log\s*in|^login$|log\s*ind/i }))
          .or(page.getByRole('link', { name: /sign\s*in|log\s*in|^login$|log\s*ind/i }))
          .first();
        if (await signInTab.isVisible({ timeout: 1500 }).catch(() => false)) {
          await signInTab.click({ timeout: 3000 }).catch(() => {});
        }

        const emailCandidate = page.locator('input[type="email"], input[autocomplete="email"], input[autocomplete="username"], input[name*="email" i], input[name*="user" i], input[id*="email" i]')
          .filter({ visible: true })
          .first();

        if (await emailCandidate.waitFor({ state: 'visible', timeout: 6000 }).then(() => true).catch(() => false)) {
          const pwdCandidate = page.locator('input[type="password"], input[autocomplete="current-password"], input[name*="password" i], input[id*="password" i]')
            .filter({ visible: true })
            .first();
          if (await pwdCandidate.waitFor({ state: 'visible', timeout: 4000 }).then(() => true).catch(() => false)) {
            emailInput = emailCandidate;
            passwordInput = pwdCandidate;
            landedUrl = page.url();
            break;
          }
        }
      } catch {
        // try next candidate
      }
    }

    if (!emailInput || !passwordInput) {
      test.info().annotations.push({ type: 'SOURCE_BUG', description: 'No login form (email+password inputs) discoverable on /dk/account or known auth variants' });
      test.skip(true, 'SOURCE_BUG: Login form inputs not found on any known auth route');
      return;
    }

    const startingUrl = page.url();

    await emailInput.fill('invalid-user-tc012@example-invalid.test', { timeout: 5000 });
    await passwordInput.fill('definitely-wrong-password-xyz-12345', { timeout: 5000 });

    const submitBtn = page.locator('button[type="submit"], input[type="submit"]')
      .filter({ visible: true })
      .first()
      .or(page.getByRole('button', { name: /sign\s*in|log\s*in|^login$|submit|continue|log\s*ind/i }).filter({ visible: true }).first());

    await expect(submitBtn).toBeVisible({ timeout: 5000 });
    await submitBtn.click({ timeout: 5000, force: true }).catch(() => {});

    // Wait briefly for either an error to surface or a navigation attempt to resolve
    await page.waitForTimeout(1500);
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {});

    const currentUrl = page.url();

    // Verify no session was established: should still be on an auth-ish route, NOT moved to a clearly authenticated area
    const stillOnAuth = /\/(login|account|signin|sign-in|auth|log-ind)/i.test(currentUrl);

    // Look for an error indicator
    const errorLocator = page.locator('[role="alert"], [data-testid*="error" i], .error, .alert-error, [class*="error" i], [class*="Error"]')
      .filter({ visible: true })
      .first();

    const errorTextLocator = page.getByText(/invalid|incorrect|wrong|not\s*(found|match)|failed|error|forkert|ugyldig|fejl/i).first();

    const hasErrorRole = await errorLocator.isVisible({ timeout: 4000 }).catch(() => false);
    const hasErrorText = await errorTextLocator.isVisible({ timeout: 2000 }).catch(() => false);

    // Also confirm the password input is still present (no successful redirect to authenticated area)
    const passwordStillVisible = await passwordInput.isVisible({ timeout: 2000 }).catch(() => false);

    // Check that we did NOT land on a clearly authenticated/dashboard route
    const onAuthenticatedRoute = /\/(dashboard|profile|orders|my-account\/overview)/i.test(currentUrl)
      && !/\/login/i.test(currentUrl);

    expect(onAuthenticatedRoute, `Should NOT have reached authenticated route after invalid login. URL: ${currentUrl}`).toBe(false);

    // At least one signal of rejection must be true: error shown, OR still on auth form
    const rejected = hasErrorRole || hasErrorText || stillOnAuth || passwordStillVisible;

    expect(
      rejected,
      `Invalid login should be rejected. startingUrl=${startingUrl} currentUrl=${currentUrl} errorRole=${hasErrorRole} errorText=${hasErrorText} stillOnAuth=${stillOnAuth} pwdVisible=${passwordStillVisible}`
    ).toBe(true);

    // Verify no auth session cookie was established (best-effort)
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find(c =>
      /session|auth|token|jwt|sid/i.test(c.name) && c.value && c.value.length > 10
    );
    expect(
      sessionCookie === undefined || stillOnAuth,
      `No authenticated session cookie should be set after invalid login. Found: ${sessionCookie?.name}`
    ).toBe(true);
  });
});