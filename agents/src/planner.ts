import Anthropic from "@anthropic-ai/sdk";
import type { AppContext, TestCase, TestPlan, SkippedFlow } from "./types";

const client = new Anthropic();

export async function runPlanner(context: AppContext): Promise<TestPlan> {
  const routeList = context.routes
    .map((r) => `  ${r.displayUrl.padEnd(55)} — ${r.description}`)
    .join("\n");

  const selectorList = context.selectors
    .map((s) => `  [${s.context}] "${s.testId}"`)
    .join("\n");

  const itemUrls = context.productHandles.length
    ? context.productHandles
        .map((h) => `  ${context.baseUrl}/${context.countryCode}/products/${h}`)
        .join("\n")
    : "  (no seeded items)";

  const localePrefix = context.countryCode
    ? `/${context.countryCode}`
    : "";

  const frameworkNotes = buildFrameworkNotes(context);

  const prompt = `You are a senior QA engineer designing an automated E2E test suite.

## Application
- Base URL: ${context.baseUrl}
- Framework: ${context.framework}
- Rendering: ${context.renderingModel}
- Locale prefix: "${localePrefix}" (empty string if not applicable)

## Available Routes
${routeList}

## Available data-testid Selectors (grouped by module)
${selectorList}

## Seeded Items / Products
${itemUrls}

## Framework Notes
${frameworkNotes}

## Your Task — Two parts

### Part 1: Flow Dependency Graph
First identify all distinct user flows in this application.
Map their dependencies: flow B "dependsOn" flow A means A must work before B can be meaningfully tested.

Flow categories to consider: auth, navigation, product, cart, checkout, account, order, search, categories

### Part 2: Test Cases
Produce a test plan of AT LEAST 20 test cases ordered by dependency (TC001 should have no deps, TC002 may depend on TC001, etc.).

Priority guidance:
- HIGH: Direct revenue path — every failing HIGH test is a blocker (registration, login, add-to-cart, checkout)
- MEDIUM: Important but not blocking (account management, product discovery, error states, sort/filter)
- LOW: Nice-to-have (navigation links, edge cases, cosmetic checks)

Dependency rules:
- dependsOn must list TC IDs that must PASS before this test can meaningfully run
- Respect the ordering: HIGH tests first, then MEDIUM, then LOW
- Within HIGH, respect dependency chain: auth before cart, cart before checkout

Selectors rules:
- selectorsToUse must contain ONLY testid names confirmed in the selector list above
- NEVER invent testid names that are not in the list

Always skip these flows and document them:
- Admin / back-office dashboards (requires admin credentials)
- Payment provider processing (requires live keys)
- Webhook / server-side-only flows (no browser surface)
- Email-link flows (requires email testing infrastructure)
- OAuth third-party login

## IMPORTANT: Keep all string values SHORT (under 15 words). Use brief bullet-point phrases, not sentences.

## Required JSON Format
Respond with ONLY a valid JSON object — no markdown, no explanation:

{
  "test_cases": [
    {
      "id": "TC001",
      "title": "User registration with valid credentials",
      "page_url": "${context.baseUrl}${localePrefix}/account",
      "priority": "high",
      "category": "auth",
      "depends_on": [],
      "rationale": "Critical user acquisition flow",
      "state_setup": ["Not logged in"],
      "steps": ["Go to /account", "Click register-button", "Fill form", "Submit"],
      "expected_outcome": "Redirected to account dashboard",
      "selectors_to_use": ["register-button", "first-name-input", "email-input", "password-input"],
      "requires_auth": false
    }
  ],
  "skipped_flows": [
    {
      "flow": "Stripe payment processing",
      "reason": "Requires live keys and card numbers",
      "enabled_by": "Mock payment provider or Stripe test mode with configured keys"
    }
  ]
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    system: "You are a QA engineer. Respond ONLY with a valid JSON object. No markdown code fences. Be concise — keep all string values short.",
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Planner response truncated (hit max_tokens). Increase max_tokens or request fewer test cases."
    );
  }

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const jsonStr = rawText
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  let raw: {
    test_cases?: Array<{
      id: string;
      title: string;
      page_url: string;
      priority: string;
      category: string;
      depends_on?: string[];
      rationale: string;
      state_setup: string[];
      steps: string[];
      expected_outcome: string;
      selectors_to_use: string[];
      requires_auth: boolean;
    }>;
    skipped_flows?: Array<{ flow: string; reason: string; enabled_by?: string }>;
  };

  try {
    raw = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(
      `Planner returned invalid JSON.\nParse error: ${err}\nRaw (first 600 chars):\n${rawText.slice(0, 600)}`
    );
  }

  if (!Array.isArray(raw.test_cases)) {
    throw new Error(
      `Planner JSON missing test_cases array. Keys: ${Object.keys(raw).join(", ")}\n${jsonStr.slice(0, 600)}`
    );
  }

  const testCases: TestCase[] = raw.test_cases.map((tc) => ({
    id: tc.id,
    title: tc.title,
    pageUrl: tc.page_url,
    priority: tc.priority as TestCase["priority"],
    category: tc.category,
    dependsOn: tc.depends_on ?? [],
    rationale: tc.rationale,
    stateSetup: tc.state_setup,
    steps: tc.steps,
    expectedOutcome: tc.expected_outcome,
    selectorsToUse: tc.selectors_to_use,
    requiresAuth: tc.requires_auth,
  }));

  const skippedFlows: SkippedFlow[] = (raw.skipped_flows ?? []).map((sf) => ({
    flow: sf.flow,
    reason: sf.reason,
    enabledBy: sf.enabled_by,
  }));

  return { testCases, skippedFlows, generatedAt: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Framework-specific notes injected into the planner prompt
// ─────────────────────────────────────────────────────────────────────────────

function buildFrameworkNotes(ctx: AppContext): string {
  const notes: string[] = [];

  if (ctx.framework === "nextjs-app-router" && ctx.renderingModel === "ssr-streaming") {
    notes.push(
      "- SSR streaming: a DISABLED fallback component renders before the real one streams in.",
      "  Tests must wait for toBeEnabled() on interactive elements, not just toBeVisible().",
      "- Server Actions POST to the current page URL — use page.waitForResponse() to confirm completion.",
      "- Some routes are URL-param-gated (e.g. /checkout?step=address opens the address form).",
      "- Parallel routes (/account/profile, /account/addresses, /account/orders) return 404 on hard",
      "  navigation (page.goto). Must navigate via link/button clicks (soft navigation).",
      "- Never use waitForLoadState('networkidle') — Turbopack HMR keeps connections alive.",
    );
  }

  if (ctx.countryCode) {
    notes.push(
      `- All URLs are prefixed with /${ctx.countryCode}/ (the active locale/region).`,
      `- Country selector options must match the region (e.g. 'gb' for the GB region).`,
    );
  }

  return notes.length > 0 ? notes.join("\n") : "No framework-specific notes.";
}
