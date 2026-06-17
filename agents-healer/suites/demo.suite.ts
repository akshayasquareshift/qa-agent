import type { HealableSuite } from "../src/types";

// Demo suite for the self-healing executor.
//
// Each step expresses *intent* in plain language plus a locator that was valid
// at the time the test was written. If the app's UI drifts — button renamed,
// element relocated, field reordered — the locator may stop matching. The
// executor catches that, snapshots the DOM, and asks Claude to map the intent
// to the new element. The original locator is intentionally left as-is so the
// diff in the report reflects the real before/after.
//
// Point BASE_URL at the running target app, then:
//   pnpm --filter @qa/healer heal:demo

const suite: HealableSuite = {
  name: "Demo — login + create patient flow",
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  steps: [
    { intent: "Open the application homepage", action: "goto", value: "/" },

    // Scenario 1: button rename. Originally "Sign in" — app may now say
    // "Log in" / "Continue" / similar. data-testid may or may not have moved.
    {
      intent: "Click the primary login / sign-in entry button in the top nav",
      action: "click",
      locator: "[data-testid='sign-in-button']",
    },

    {
      intent: "Wait for the login form to render",
      action: "expectVisible",
      locator: "form[data-testid='login-form']",
    },

    // Scenario 2: form fields reordered. Original tests assumed email-first.
    // App may have swapped to username-first or split into two-step.
    {
      intent: "Enter the user's email address into the email/identifier field",
      action: "fill",
      locator: "input[data-testid='email-input']",
      value: process.env.TEST_EMAIL ?? "qa@example.com",
    },
    {
      intent: "Enter the user's password into the password field",
      action: "fill",
      locator: "input[data-testid='password-input']",
      value: process.env.TEST_PASSWORD ?? "Password123!",
    },

    // Scenario 3: submit button relocated/renamed. May now live inside a
    // wrapper, may say "Continue" instead of "Sign in".
    {
      intent: "Submit the login form",
      action: "click",
      locator: "button[data-testid='login-submit']",
    },

    {
      intent: "Verify the user lands on the authenticated dashboard",
      action: "expectVisible",
      locator: "[data-testid='dashboard-greeting']",
    },

    // Scenario 4: nav item relocation. Sidebar → topbar, or label changed.
    {
      intent: "Navigate to the patients list from the main navigation",
      action: "click",
      locator: "a[data-testid='nav-patients']",
    },
    {
      intent: "Confirm the patients list page rendered",
      action: "expectVisible",
      locator: "[data-testid='patients-list']",
    },

    // Scenario 5: action button rename. "New patient" → "Add patient" / "+".
    {
      intent: "Open the create-patient form by clicking the primary add/new action",
      action: "click",
      locator: "button[data-testid='new-patient-button']",
    },
    {
      intent: "Fill the patient's first name",
      action: "fill",
      locator: "input[name='firstName']",
      value: "Ada",
    },
    {
      intent: "Fill the patient's last name",
      action: "fill",
      locator: "input[name='lastName']",
      value: "Lovelace",
    },
    {
      intent: "Save the new patient record",
      action: "click",
      locator: "button[data-testid='save-patient']",
    },
    {
      intent: "Verify the new patient appears in the list",
      action: "expectText",
      locator: "[data-testid='patients-list']",
      value: "Ada Lovelace",
    },
  ],
};

export default suite;
