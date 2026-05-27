import { createMessage } from "./ai-client";
import type { AppContext, TestCase, TestPlan, SkippedFlow } from "./types";

export async function runPlanner(context: AppContext): Promise<TestPlan> {
  const routeList = context.routes.length
    ? context.routes
        .map((r) => `  ${r.displayUrl.padEnd(55)} — ${r.description}`)
        .join("\n")
    : "  (no file-based routes detected — app may use client-side routing)";

  const selectorList = context.selectors.length
    ? context.selectors
        .map((s) => `  [${s.context}] "${s.testId}"`)
        .join("\n")
    : "  (no data-testid selectors found)";

  const seedSection = context.seedData.length
    ? context.seedData.map((s) => `  ${s}`).join("\n")
    : "  (none configured — tests should create or discover test data inline)";

  const localePrefix = context.countryCode ? `/${context.countryCode}` : "";

  const frameworkNotes = buildFrameworkNotes(context);

  const prompt = `You are a senior QA engineer designing an automated E2E test suite.

## Application
- Name: ${process.env.APP_NAME ?? "Application"}
- Base URL: ${context.baseUrl}
- Framework: ${context.framework}
- Rendering: ${context.renderingModel}
- Locale prefix: "${localePrefix}" (empty string if not applicable)

## Available Routes
${routeList}

## Available data-testid Selectors (grouped by module)
${selectorList}

## Seed Data / Test Records
${seedSection}

## Framework Notes
${frameworkNotes}

## Your Task — Two parts

### Core objective: MAXIMUM COVERAGE
Your primary goal is to cover as much of this application's behaviour as possible — every distinct route, every meaningful user flow, every realistic edge case. Do not stop at a minimum quota.

A good plan exercises:
- Every route discovered above (at least one test per route, more for routes with multiple states)
- Every CRUD operation on every entity the app manages (create, read/list, view-detail, update, delete)
- Both happy paths AND realistic failure modes for each flow (invalid input, unauthorized access, empty-state, validation errors)
- Navigation between flows (links, breadcrumbs, redirects)
- Permission / auth boundaries (logged-out access to protected routes, wrong-role access)
- Form validation rules (required fields, formats, lengths)
- Search, filtering, sorting, pagination where the UI supports them
- Responsive / mobile layout if the app has it

### Part 1: Flow Discovery
Analyse the routes and selectors to determine this application's domain and primary purpose.
Identify all distinct user flows specific to this application.
Map their dependencies: flow B "dependsOn" flow A means A must work before B can be meaningfully tested.

### Part 2: Test Cases
Produce a test plan that maximises coverage of the flows identified above. The minimum is 20 test cases — but a real application with N routes and multiple entity types typically warrants 30–60 test cases. Err on the side of MORE coverage. Each test case should cover one specific behaviour; do not bundle multiple checks into a single test.

Order test cases by dependency (TC001 should have no deps).

Priority guidance:
- HIGH: Core critical flows for this app's primary purpose — every failing HIGH test is a production blocker
- MEDIUM: Important but not blocking (secondary features, data management, error states, validation)
- LOW: Nice-to-have (navigation links, edge cases, cosmetic checks)

Dependency rules:
- dependsOn must list TC IDs that must PASS before this test can meaningfully run
- HIGH tests first, then MEDIUM, then LOW
- Within HIGH, auth/login flows before any flows that require authentication

Selectors rules:
- selectorsToUse must contain ONLY testid names confirmed in the selector list above
- NEVER invent testid names that are not in the list

Always skip these flows and document them:
- Flows requiring external service credentials (payment processors, external OAuth, third-party APIs)
- Server-side-only flows with no browser surface (webhooks, background jobs, cron tasks)
- Flows requiring privileged credentials not available in the test environment
- Email-link or SMS/OTP verification flows that require inbox access

## IMPORTANT: Keep all string values SHORT (under 15 words). Use brief bullet-point phrases, not sentences.

## Required JSON Format
Respond with ONLY a valid JSON object — no markdown, no explanation:

{
  "test_cases": [
    {
      "id": "TC001",
      "title": "Short descriptive title",
      "page_url": "${context.baseUrl}${localePrefix}/",
      "priority": "high",
      "category": "<inferred from this app's domain>",
      "depends_on": [],
      "rationale": "Why this is critical",
      "state_setup": ["Precondition 1"],
      "steps": ["Navigate to page", "Interact with element", "Verify outcome"],
      "expected_outcome": "What success looks like",
      "selectors_to_use": [],
      "requires_auth": false
    }
  ],
  "skipped_flows": [
    {
      "flow": "Flow name",
      "reason": "Why it cannot be automated now",
      "enabled_by": "What would enable it"
    }
  ]
}`;

  const response = await createMessage({
    max_tokens: 16000,
    system: "You are a QA engineer. Respond ONLY with a valid JSON object. No markdown code fences. Be concise — keep all string values short.",
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Planner response truncated (hit max_tokens). Increase max_tokens or request fewer test cases."
    );
  }

  const rawText = response.content[0].text;

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

function buildFrameworkNotes(ctx: AppContext): string {
  const notes: string[] = [];

  if (ctx.framework === "nextjs-app-router" && ctx.renderingModel === "ssr-streaming") {
    notes.push(
      "- SSR streaming: a DISABLED fallback component renders before the real one streams in.",
      "  Tests must wait for toBeEnabled() on interactive elements, not just toBeVisible().",
      "- Server Actions POST to the current page URL — use page.waitForResponse() to confirm completion.",
      "- Never use waitForLoadState('networkidle') — HMR keeps connections alive; use 'load' instead.",
    );
  }

  if (ctx.countryCode) {
    notes.push(
      `- All URLs are prefixed with /${ctx.countryCode}/ (the active locale/region).`,
    );
  }

  return notes.length > 0 ? notes.join("\n") : "No framework-specific notes.";
}
