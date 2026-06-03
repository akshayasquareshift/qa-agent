import { createMessage } from "./ai-client";
import { formatSeedStateForPrompt } from "./seed-state";
import type { AppContext, SeedState } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Natural-Language Test Authoring
//
// Turns a non-technical user's plain-English instruction into an executable,
// self-contained Playwright spec — no structured TestCase required. This is the
// "democratization" surface: a product owner types intent, the agent translates.
//
// Two modes:
//   - fresh:  instruction only            → brand-new spec
//   - adapt:  instruction + previousCode  → minimal edit of an existing spec
//             (e.g. "now apply a coupon code") so the test evolves in place.
//
// Every generated spec wraps its actions in test.step('<human label>', ...) so
// the UI can render a step-by-step timeline of what the business user asked for.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SELECTORS_IN_PROMPT = 80;

function buildContextBlock(ctx: AppContext, seedState: SeedState | null): string {
  const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";

  const routeLines = ctx.routes.length
    ? ctx.routes
        .slice(0, 40)
        .map((r) => `  ${r.displayUrl}  — ${r.description}`)
        .join("\n")
    : "  (no routes discovered — navigate from the base URL)";

  // De-dupe selectors and cap the list so the prompt stays focused.
  const seen = new Set<string>();
  const selectorLines: string[] = [];
  for (const s of ctx.selectors) {
    if (seen.has(s.testId)) continue;
    seen.add(s.testId);
    selectorLines.push(`  [data-testid="${s.testId}"]  (${s.context})`);
    if (selectorLines.length >= MAX_SELECTORS_IN_PROMPT) break;
  }
  const selectorBlock = selectorLines.length
    ? selectorLines.join("\n")
    : "  (no data-testid selectors discovered — fall back to role / label / text selectors)";

  // Real clickable elements: their actual visible label paired with any testid.
  // This stops the generator from guessing button text (the #1 cause of
  // "element not found"). Group dynamic-text elements (same testid, many labels)
  // so the model knows to build a resilient locator.
  const actionBlock = buildActionVocabulary(ctx);

  const seedStateBlock = formatSeedStateForPrompt(seedState);

  const testUsername = process.env.TEST_USERNAME;
  const testPassword = process.env.TEST_PASSWORD;
  const credsNote =
    testUsername && testPassword
      ? `If a step needs a logged-in user, log in with username="${testUsername}", password="${testPassword}" (selectors: input[name="username"] / input[name="password"], or the app's equivalents).`
      : `No standing test credentials are configured. If the instruction needs a logged-in user and no seeded credentials are listed above, register/use a fresh account inline.`;

  return `## Application under test
- Name:            ${process.env.APP_NAME ?? "the application"}
- Framework:       ${ctx.framework} (${ctx.renderingModel})
- Base URL:        ${ctx.baseUrl}${localePrefix ? `\n- Locale prefix:   ${localePrefix}  (prepend to in-app paths, e.g. ${ctx.baseUrl}${localePrefix}/store)` : ""}

## Known routes (use real paths — do NOT invent URLs)
${routeLines}

## Known selectors (prefer these data-testid values — do NOT invent new testids)
${selectorBlock}

${actionBlock}${seedStateBlock}## Authentication
${credsNote}`;
}

// Render the real button/link vocabulary, grouping elements that share a testid
// but vary their label (dynamic text like "Add item" / "Out of stock"), so the
// model targets a stable testid with a text fallback instead of guessing.
function buildActionVocabulary(ctx: AppContext): string {
  if (!ctx.actionLabels.length) {
    return (
      "## Clickable elements\n" +
      "  (none auto-discovered — when clicking a button/link, do NOT hard-code a guessed\n" +
      "   label; use a permissive regex name, e.g. getByRole('button', { name: /add|cart|bag/i }).)\n\n"
    );
  }

  // Group labels by testid (elements with the same testid but different text are
  // the same control with dynamic text). Labels with no testid stand alone.
  const byTestId = new Map<string, Set<string>>();
  const noTestId: Array<{ label: string; element: string }> = [];
  for (const a of ctx.actionLabels) {
    if (a.testId) {
      if (!byTestId.has(a.testId)) byTestId.set(a.testId, new Set());
      byTestId.get(a.testId)!.add(a.label);
    } else {
      noTestId.push({ label: a.label, element: a.element });
    }
  }

  const lines: string[] = [];
  lines.push("## Clickable elements (REAL labels + testids — use these; do NOT invent button text)");
  lines.push("Each entry is a real button/link in the app. Prefer getByTestId; if an element shows");
  lines.push("different text in different states, build a resilient locator (testid first, text fallback).");
  lines.push("");
  for (const [testId, labels] of byTestId) {
    const list = Array.from(labels).map((l) => `"${l}"`).join(", ");
    lines.push(`  getByTestId('${testId}')   ← shows: ${list}`);
  }
  if (noTestId.length) {
    lines.push("");
    lines.push("  Elements WITHOUT a testid (target by exact text via getByRole):");
    for (const { label, element } of noTestId.slice(0, 40)) {
      lines.push(`    getByRole('${element === "link" ? "link" : "button"}', { name: "${label}" })`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function frameworkGuidelines(ctx: AppContext): string {
  const lines: string[] = [
    "## Reliability rules (Playwright)",
    "- Use await page.waitForLoadState('load') after navigations — NEVER 'networkidle'.",
    "- To click a button/link, use the 'Clickable elements' vocabulary above. NEVER guess button text",
    "  that isn't listed there (guessing 'Add to cart' when the button says 'Add item' is the #1 failure).",
    "- Prefer getByTestId('<id>') for any element that has a testid. For testid-less elements, target the",
    "  EXACT label text shown in the vocabulary via getByRole('button'|'link', { name: '<exact text>' }).",
    "- When a control has dynamic text (the vocabulary lists several labels for one testid), build a",
    "  RESILIENT locator: lead with the testid and add a text fallback, e.g.",
    "    const addBtn = page.getByTestId('add-product-button')",
    "      .or(page.getByRole('button', { name: /add (item|to cart|to bag)/i }));",
    "- A primary action button (add-to-cart, submit, continue) is often DISABLED until a required",
    "  choice is made. BEFORE clicking it, if option/variant selectors exist (e.g. a testid containing",
    "  'option', a size/colour picker, a select, or radio buttons), click the first available one — then",
    "  wait for the button to become enabled: await expect(addBtn).toBeEnabled({ timeout: 15000 }).",
    "  Do NOT silently skip the click when the button is disabled (that leaves the cart empty and the",
    "  next step fails with 'element not found'). Make the variant/option selection succeed first.",
    "- To READ a value (price, total, item count, title), use the EXACT testid from the selector list",
    "  above via page.getByTestId('exact-id'). NEVER use attribute-substring wildcards like",
    "  [data-testid*=\"total\"] or [data-testid*=\"price\"] — they match labels AND values and trigger",
    "  strict-mode violations. If the exact id you need isn't in the list, match a currency/number regex",
    "  scoped with .first(), e.g. page.getByText(/€\\s?\\d|\\d+[.,]\\d{2}/).first().",
    "- AVOID strict-mode violations: any locator used with expect() or click() must resolve to ONE element.",
    "  If it could match several, narrow it (exact testid, scoped container, or .first()).",
    "- If a locator could match multiple elements, scope to the nearest container or use .first() deliberately.",
    "- Wait for elements to be visible/enabled before acting: await expect(locator).toBeVisible({ timeout: 15000 }).",
    "- For monetary / total assertions, read the on-screen text and assert on the parsed number, not a hard-coded string.",
  ];
  if (ctx.framework === "nextjs-app-router" && ctx.renderingModel === "ssr-streaming") {
    lines.push(
      "- This is Next.js App Router with Suspense streaming: wait for interactive elements to be ENABLED, not just visible.",
      "- Server actions POST to the current URL; after submitting, wait for the resulting navigation or a visible confirmation, not 'networkidle'.",
    );
  }
  return lines.join("\n");
}

export interface NlpGenerationResult {
  code: string;
  /** Short human-readable summary the agent inferred from the instruction. */
  mode: "fresh" | "adapt";
}

/**
 * Convert a plain-English instruction into a runnable Playwright spec.
 * When `previousCode` is supplied, the agent ADAPTS that spec to satisfy the
 * (usually incremental) new instruction rather than writing one from scratch.
 */
export async function authorTestFromNaturalLanguage(params: {
  instruction: string;
  ctx: AppContext;
  seedState: SeedState | null;
  previousCode?: string;
}): Promise<NlpGenerationResult> {
  const { instruction, ctx, seedState, previousCode } = params;
  const mode: "fresh" | "adapt" = previousCode && previousCode.trim() ? "adapt" : "fresh";

  const contextBlock = buildContextBlock(ctx, seedState);
  const guidelines = frameworkGuidelines(ctx);

  const adaptBlock =
    mode === "adapt"
      ? `## You are ADAPTING an existing test
A business user previously authored a test, and now wants to change it. Below is the
CURRENT spec. Apply the NEW instruction as a minimal, targeted modification — keep the
parts that still apply, change only what the new instruction requires. Preserve the
overall structure and any working selectors.

### Current spec
\`\`\`typescript
${previousCode!.trim()}
\`\`\`
`
      : "";

  const prompt = `You are an expert Playwright test engineer working as a translator for a NON-TECHNICAL user
(a product owner or business analyst). They describe what they want to verify in plain English,
and you produce a single, self-contained, runnable Playwright spec that proves it.

${contextBlock}

${guidelines}

${adaptBlock}## The user's plain-English instruction
"""
${instruction.trim()}
"""

## Output requirements
1. Start with: import { test, expect } from '@playwright/test';
2. One test.describe(...) and ONE test(...) block. Give the test a clear, business-readable title
   derived from the instruction (e.g. "Cart total is correct after adding 3 items and removing 1").
3. Wrap each meaningful phase of the scenario in test.step('<plain-English label>', async () => { ... })
   so the user can see a readable timeline of what ran. Use labels a non-technical person understands,
   e.g. test.step('Add 3 items to the cart', ...), test.step('Verify the checkout total', ...).
4. Make the final assertion(s) directly verify the user's intent — be explicit (toContainText, toHaveText,
   parsed-number comparisons, toHaveURL, etc.). Do not "pass" without actually checking the thing asked for.
5. Fully self-contained: no imports from fixture files, no external helpers. Inline any login.
6. Use ONLY the real routes, base URL, locale prefix, and data-testid selectors from the context above.
7. Set a generous per-action timeout where flakiness is likely. Total test should fit within 60s.
8. Do NOT use test.skip() / test.fixme(). If the instruction can't be fully verified, still write the
   best executable test that gets as far as possible and asserts what it can.

Return ONLY the TypeScript source code. No markdown fences, no commentary.`;

  const response = await createMessage({
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  let code = response.content[0].text;
  code = code
    .replace(/^```(?:typescript|ts)?\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();

  return { code, mode };
}

export interface NlpHealResult {
  code: string;
  rootCause: string;
}

/**
 * Self-healing: given a spec that FAILED, the failing step, and the error, return
 * a corrected full spec. Reuses the same app context (routes/selectors/actions) the
 * author uses, plus the failure evidence. Returns the COMPLETE rewritten spec — for a
 * single file this is more robust than old/new string patching (no "string not found"
 * misses). Steps that already passed must be preserved.
 */
export async function healNlpSpec(params: {
  code: string;
  errorMessage: string;
  failingStep?: string;
  passedSteps?: string[];
  ctx: AppContext;
  seedState: SeedState | null;
}): Promise<NlpHealResult> {
  const { code, errorMessage, failingStep, passedSteps, ctx, seedState } = params;

  const contextBlock = buildContextBlock(ctx, seedState);
  const guidelines = frameworkGuidelines(ctx);
  const passedBlock = passedSteps?.length
    ? `These steps already PASSED — keep them working, do not break them:\n${passedSteps.map((s) => `  ✓ ${s}`).join("\n")}\n`
    : "";

  const prompt = `You are a Playwright debugging expert. A self-contained spec FAILED when run against the
live application. Diagnose the failure from the error and the app context, then return a CORRECTED,
COMPLETE spec that runs green.

${contextBlock}

${guidelines}

## The spec that failed
\`\`\`typescript
${code.trim()}
\`\`\`

## Failure
${failingStep ? `Failing step: "${failingStep}"` : ""}
Error:
"""
${errorMessage.trim().slice(0, 1500)}
"""

${passedBlock}
## How to fix (in priority order)
1. **strict-mode violation** ("resolved to N elements") — the locator matched more than one element.
   Narrow it: use the EXACT testid from the list (never a [data-testid*="..."] substring wildcard),
   scope to a container, or add .first(). This is the most common failure — fix it precisely.
2. **element not found / not visible** — the selector is wrong or the element needs a precondition.
   Use the real testid or exact label from the vocabulary above. If a primary button never appeared,
   a prior step probably did not actually complete (e.g. add-to-cart skipped because no variant was
   selected) — fix the ROOT step, not just the assertion.
3. **timeout waiting for enabled** — select the required option/variant first, then wait toBeEnabled.
4. Keep all passing steps intact. Do NOT add test.skip()/test.fixme(). Do NOT weaken the test into a
   no-op — it must still verify the user's original intent.

Return ONLY the complete corrected TypeScript spec. No markdown fences, no commentary.
Begin your reply with a single line comment stating the root cause, e.g.
// FIX: cart total locator matched the label too — switched to getByTestId('cart-total')`;

  const response = await createMessage({
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  let out = response.content[0].text
    .replace(/^```(?:typescript|ts)?\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();

  // Pull the leading "// FIX: ..." line as the root cause, if present.
  let rootCause = "fix applied";
  const m = out.match(/^\/\/\s*FIX:\s*(.+)$/m);
  if (m) rootCause = m[1].trim();

  return { code: out, rootCause };
}
