import { createMessage } from "./ai-client";
import * as fs from "fs";
import * as path from "path";
import { formatSeedStateForPrompt } from "./seed-state";
import type { AppContext, TestCase, GeneratedSpec, SeedState } from "./types";

const GENERATED_DIR = path.join(__dirname, "../../tests/generated");

function toFileName(tc: TestCase): string {
  const slug = tc.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${tc.id.toLowerCase()}-${slug}.spec.ts`;
}

function buildFrameworkGuidelines(ctx: AppContext): string {
  const lines: string[] = [];

  if (ctx.framework === "nextjs-app-router" && ctx.renderingModel === "ssr-streaming") {
    lines.push(
      "## CRITICAL — Next.js Suspense Streaming",
      "The server renders a DISABLED fallback before the real component streams in.",
      "ALWAYS wait for interactive elements to be ENABLED, not just visible:",
      "  await expect(page.locator('[data-testid=\"<id>\"]').first()).toBeEnabled({ timeout: 15000 })",
      "",
      "## CRITICAL — Next.js Server Actions",
      "Server actions POST to the current page URL, not a separate API endpoint.",
      "After clicking any server action button, use waitForResponse:",
      "  const done = page.waitForResponse(",
      "    r => r.request().method() === 'POST' && r.url().includes('/current-path'),",
      "    { timeout: 15000 }",
      "  )",
      "  await button.click()",
      "  await done",
      "",
      "## NEVER use 'networkidle'",
      "HMR keeps WebSocket connections open. Use 'load' or element waits instead.",
    );
  }

  lines.push(
    "",
    "## Strict Mode — Scoping selectors",
    "If a locator resolves to multiple elements, ALWAYS scope to the nearest parent container.",
    "Example: page.locator('[data-testid=\"form\"]').locator('[data-testid=\"submit\"]')",
    "",
    "## Modals and overlays",
    "Before filling a modal form: waitFor({ state: 'visible' })",
    "After saving/closing: waitFor({ state: 'hidden', timeout: 15000 })",
    "",
    "## Delete / remove verifications",
    "Use not.toBeVisible({ timeout: 15000 }) on the removed element.",
  );

  return lines.join("\n");
}

function buildPrompt(tc: TestCase, ctx: AppContext, seedState: SeedState | null, learnings?: string): string {
  const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";

  const selectorBlock = tc.selectorsToUse.length
    ? tc.selectorsToUse.map((s) => `  page.locator('[data-testid="${s}"]')`).join("\n")
    : "  (no testid selectors specified — use visible text, role, or label selectors as fallback)";

  const testUsername = process.env.TEST_USERNAME;
  const testPassword = process.env.TEST_PASSWORD;
  const credentialsNote = testUsername && testPassword
    ? `Use these test credentials: username="${testUsername}", password="${testPassword}"`
    : `No TEST_USERNAME/TEST_PASSWORD set in .env — use placeholder values and note they must be replaced.`;

  const authSetupNote = tc.requiresAuth
    ? `\n## Authentication Setup (inline)\n` +
      `This test requires the user to be authenticated. Navigate to the login page, fill in\n` +
      `credentials using \`input[name="username"]\` and \`input[name="password"]\` (or the\n` +
      `equivalent selectors for this app), submit, and wait for navigation to the authenticated area.\n` +
      `${credentialsNote}\n`
    : "";

  const stateSetupBlock = tc.stateSetup.length
    ? `\n## Preconditions\n${tc.stateSetup.map((s) => `- ${s}`).join("\n")}\n`
    : "";

  const frameworkGuidelines = buildFrameworkGuidelines(ctx);
  const learningsSection = learnings ? `\n${learnings}\n` : "";

  const seedBlock = ctx.seedData.length
    ? `\n## Seed Data / Test Records\n${ctx.seedData.map((s) => `  ${s}`).join("\n")}\n`
    : "";

  const seedStateBlock = formatSeedStateForPrompt(seedState);

  return `You are an expert Playwright test engineer for a ${ctx.framework} application.

## NO-SKIP POLICY (READ FIRST)
The agent has pre-seeded test credentials and baseline data — see "Seeded Test Data" below. Your test MUST:
- Use those seeded credentials for any login step (do NOT invent placeholder usernames)
- Look up seeded entities by their marker string when the test needs an existing record
- NEVER call \`test.skip()\` or \`test.fixme()\` to handle a missing-data / no-session / no-results precondition

The ONLY legitimate reason to skip is when the test detects a genuine bug in the application source code (e.g. a missing data-testid, a broken server action, a feature that returns an error page where it shouldn't). In that case:
- Add \`test.info().annotations.push({ type: 'SOURCE_BUG', description: '<one-line reason>' })\`
- THEN call \`test.skip(true, 'SOURCE_BUG: <reason>')\`

Every other "the data isn't there" / "session didn't persist" situation must be FIXED in the spec (re-login, search by marker, navigate via UI link, etc.) — not bypassed with skip.

${seedStateBlock}
## Test Case
- ID: ${tc.id}
- Title: ${tc.title}
- URL: ${tc.pageUrl}
- Category: ${tc.category}
- Priority: ${tc.priority}
- Requires Auth: ${tc.requiresAuth}
- Depends On: ${tc.dependsOn.join(", ") || "none"}

## Steps
${tc.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

## Expected Outcome
${tc.expectedOutcome}

## Key Selectors (use ONLY these — do NOT invent new testid names)
${selectorBlock}
${authSetupNote}${stateSetupBlock}${seedBlock}
## Framework Guidelines (READ CAREFULLY)
${frameworkGuidelines}
${learningsSection}
## Spec Requirements
1. Start with: import { test, expect } from '@playwright/test';
2. Wrap in: test.describe('${tc.category} — ${tc.title}', ...)
3. Single test function named "${tc.id} - ${tc.title}"
4. Use ONLY data-testid selectors from the Key Selectors list (fall back to role/label otherwise)
5. Use await page.waitForLoadState('load') after navigations — NEVER 'networkidle'
6. Build inline auth setup if requires_auth is true — use the seeded credentials above
7. Make every assertion explicit: toBeVisible(), toContainText(), toHaveURL()
8. Handle dynamic content: locator.waitFor({ state: 'visible' })
9. Keep fully self-contained — no imports from external fixture files
10. Base URL: ${ctx.baseUrl}${localePrefix ? `  — Locale prefix: ${localePrefix}` : ""}
11. NO test.skip() / test.fixme() for missing preconditions — see NO-SKIP POLICY above

Return ONLY the TypeScript source code. No markdown, no explanation, no code fences.`;
}

export async function runAutomator(
  testCase: TestCase,
  context: AppContext,
  seedState: SeedState | null,
  learnings?: string
): Promise<GeneratedSpec> {
  const response = await createMessage({
    max_tokens: 3000,
    messages: [{ role: "user", content: buildPrompt(testCase, context, seedState, learnings) }],
  });

  let specContent = response.content[0].text;

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
