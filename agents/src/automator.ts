import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import type { AppContext, TestCase, GeneratedSpec } from "./types";

const client = new Anthropic();
const GENERATED_DIR = path.join(__dirname, "../../tests/generated");

function toFileName(tc: TestCase): string {
  const slug = tc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${tc.id.toLowerCase()}-${slug}.spec.ts`;
}

function buildAuthHelper(ctx: AppContext): string {
  const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";
  return `
// Create a fresh account to avoid state bleed between test runs
const email = \`test+\${Date.now()}@playwright-test.com\`;
const password = 'TestPassword123!';
await page.goto(\`${ctx.baseUrl}${localePrefix}/account\`);
await page.waitForLoadState('load');
await page.locator('[data-testid="register-button"]').click();
await page.waitForSelector('[data-testid="register-page"]');
await page.fill('[data-testid="first-name-input"]', 'Test');
await page.fill('[data-testid="last-name-input"]', 'User');
await page.fill('[data-testid="email-input"]', email);
await page.fill('[data-testid="password-input"]', password);
await page.locator('[data-testid="register-page"] [data-testid="register-button"]').click();
await page.waitForURL(\`**${localePrefix}/account\`);
await page.waitForLoadState('load');`;
}

function buildAddToCartHelper(ctx: AppContext): string {
  const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";
  const productHandle = ctx.productHandles[0] ?? "product";
  return `
// Add product to cart (required precondition for cart/checkout tests)
await page.goto('${ctx.baseUrl}${localePrefix}/products/${productHandle}');
await page.waitForLoadState('load');
// Wait for real ProductActionsWrapper (Suspense replaces disabled SSR fallback)
await expect(page.locator('[data-testid="option-button"]').first()).toBeEnabled({ timeout: 15000 });
const optionGroups = page.locator('[data-testid="product-options"]');
const groupCount = await optionGroups.count();
for (let i = 0; i < groupCount; i++) {
  await optionGroups.nth(i).locator('[data-testid="option-button"]').first().click();
}
const addToCartButton = page.locator('[data-testid="add-product-button"]');
await addToCartButton.waitFor({ state: 'visible' });
await expect(addToCartButton).toBeEnabled({ timeout: 10000 });
// Server actions POST to current URL — intercept response to confirm cart update
const serverActionDone = page.waitForResponse(
  resp => resp.request().method() === 'POST' && resp.url().includes('${localePrefix}/products/${productHandle}'),
  { timeout: 15000 }
);
await addToCartButton.click();
await serverActionDone;`;
}

function buildFrameworkGuidelines(ctx: AppContext): string {
  const lines: string[] = [];
  const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";

  if (ctx.framework === "nextjs-app-router" && ctx.renderingModel === "ssr-streaming") {
    lines.push(
      "## CRITICAL — Next.js Suspense Streaming",
      "The server renders a DISABLED fallback before the real component streams in.",
      "ALWAYS wait for interactive elements to be ENABLED, not just visible:",
      "  await expect(page.locator('[data-testid=\"option-button\"]').first()).toBeEnabled({ timeout: 15000 })",
      "",
      "## CRITICAL — Next.js Server Actions",
      "Server actions POST to the current page URL, not a separate API endpoint.",
      "After clicking add-to-cart, submit-address, or any server action button:",
      "  const done = page.waitForResponse(",
      "    r => r.request().method() === 'POST' && r.url().includes('/current-path'),",
      "    { timeout: 15000 }",
      "  )",
      "  await button.click()",
      "  await done",
      "Do NOT rely on waitForLoadState('load') alone — it fires before the action completes.",
      "",
      "## CRITICAL — URL-gated checkout steps",
      `The checkout form only renders when the ?step param is set. Use:`,
      `  ${ctx.baseUrl}${localePrefix}/checkout?step=address   (to open address form)`,
      `  ${ctx.baseUrl}${localePrefix}/checkout?step=delivery  (auto-set after address submit)`,
      "",
      "## CRITICAL — Parallel routes (account sub-pages)",
      `${localePrefix}/account/profile, /account/addresses, /account/orders return 404 on hard navigation.`,
      "Navigate via soft-nav only: click the link inside account-nav, then waitForURL.",
      "  await accountNav.locator('[data-testid=\"profile-link\"]').click()",
      "  await page.waitForURL('**/account/profile')",
      "",
      "## STRICT MODE — Scoping selectors",
      "Profile page: save-button, success-message, current-info each appear 4 times.",
      "ALWAYS scope to the parent section locator:",
      "  const editor = page.locator('[data-testid=\"account-name-editor\"]')",
      "  await editor.locator('[data-testid=\"save-button\"]').click()",
      "Cart nav: nav-cart-link appears twice during Suspense. Use hover to open dropdown.",
      "Product page: data-testid=\"price\" appears N times. Use data-testid=\"product-price\" for main price.",
      "",
      "## NEVER use 'networkidle'",
      "Turbopack/Next.js HMR keeps WebSocket connections open. Use 'load' or element waits instead.",
    );
  }

  lines.push(
    "",
    "## Modals",
    "Before filling a modal form: waitFor({ state: 'visible' })",
    "After saving: waitFor({ state: 'hidden', timeout: 30000 }) (extra time for parallel-load backend)",
    "",
    "## Delete / remove verifications",
    "Use not.toBeVisible({ timeout: 15000 }) on the removed element.",
    "For count-based assertions: use page.waitForFunction(() => document.querySelectorAll(...).length === N)",
  );

  return lines.join("\n");
}

function buildPrompt(tc: TestCase, ctx: AppContext, learnings?: string): string {
  const selectorBlock = tc.selectorsToUse.length
    ? tc.selectorsToUse.map((s) => `  page.locator('[data-testid="${s}"]')`).join("\n")
    : "  Use visible text or role selectors as fallback";

  const authSection = tc.requiresAuth
    ? `\n## Auth Setup (inline — required for this test)\n\`\`\`typescript\n${buildAuthHelper(ctx)}\n\`\`\`\n`
    : "";

  const cartSection =
    (tc.category === "cart" || tc.category === "checkout") && tc.stateSetup.some((s) =>
      s.toLowerCase().includes("cart") || s.toLowerCase().includes("item")
    )
      ? `\n## Add-to-Cart Setup (inline — cart must have an item)\n\`\`\`typescript\n${buildAddToCartHelper(ctx)}\n\`\`\`\n`
      : "";

  const frameworkGuidelines = buildFrameworkGuidelines(ctx);
  const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";
  const learningsSection = learnings ? `\n${learnings}\n` : "";

  return `You are an expert Playwright test engineer for a ${ctx.framework} application.

## Test Case
- ID: ${tc.id}
- Title: ${tc.title}
- URL: ${tc.pageUrl}
- Category: ${tc.category}
- Priority: ${tc.priority}
- Requires Auth: ${tc.requiresAuth}
- Depends On: ${tc.dependsOn.join(", ") || "none"}

## State Setup
${tc.stateSetup.length ? tc.stateSetup.map((s) => `- ${s}`).join("\n") : "None"}

## Steps
${tc.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Expected Outcome
${tc.expectedOutcome}

## Key Selectors (use ONLY these — do NOT invent new testid names)
${selectorBlock}
${authSection}${cartSection}
## Framework Guidelines (READ CAREFULLY)
${frameworkGuidelines}
${learningsSection}
## Available Product URLs
${ctx.productHandles.map((h) => `  ${ctx.baseUrl}${localePrefix}/products/${h}`).join("\n")}

## Spec Requirements
1. Start with: import { test, expect } from '@playwright/test';
2. Wrap in: test.describe('${tc.category} — ${tc.title}', ...)
3. Single test function named "TC_ID - title"
4. Use ONLY data-testid selectors from the Key Selectors list
5. Use await page.waitForLoadState('load') after navigations — NEVER 'networkidle'
6. Inline auth setup if requires_auth is true (use the Auth Setup pattern above)
7. Inline add-to-cart if category is cart/checkout and state setup mentions having items
8. Make every assertion explicit: toBeVisible(), toContainText(), toHaveURL()
9. Handle dynamic content: locator.waitFor({ state: 'visible' })
10. Keep fully self-contained — no imports from external fixture files
11. Base URL: ${ctx.baseUrl} — Locale prefix: ${localePrefix}/

Return ONLY the TypeScript source code. No markdown, no explanation, no code fences.`;
}

export async function runAutomator(
  testCase: TestCase,
  context: AppContext,
  learnings?: string
): Promise<GeneratedSpec> {
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3000,
    messages: [{ role: "user", content: buildPrompt(testCase, context, learnings) }],
  });

  let specContent = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("");

  specContent = specContent
    .replace(/^```(?:typescript|ts)?\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();

  const fileName = toFileName(testCase);
  const filePath = path.join(GENERATED_DIR, fileName);

  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(filePath, specContent, "utf-8");

  return { testCase, specContent, fileName, filePath };
}
