import { createMessage } from "./ai-client";
import * as fs from "fs";
import * as path from "path";
import type { TestRunResult, TestFix, BugReport, Learning, LearningsStore } from "./types";

const LEARNINGS_FILE = path.join(__dirname, "../learnings.json");

// ─────────────────────────────────────────────────────────────────────────────
// Baseline guidelines — GENERIC, application-agnostic best practices that apply
// to every app. Unlike learnings.json (AI-accumulated, app-specific, churned),
// these live in code so they're always injected and never drift. Each item has
// a `spec` line (for the spec writer) and a `fixer` line (for the debugger).
// ─────────────────────────────────────────────────────────────────────────────

const BASELINE_GUIDELINES: Array<{ title: string; spec: string; fixer: string }> = [
  {
    title: "Modals & drawers — wait for the container, scope inside it",
    spec: "After an action opens a modal/dialog/drawer, wait for the container (getByRole('dialog'), or the drawer/overlay element) to be visible BEFORE interacting; scope all field/button lookups to that container; after save/close, wait for it to be hidden ({ state: 'hidden' }).",
    fixer: "Timeouts right after a create/edit click usually mean the modal/drawer wasn't awaited — wait for getByRole('dialog') visible and scope inner selectors to it.",
  },
  {
    title: "Primary action buttons may render in a portal/footer outside the form",
    spec: "A modal/drawer's primary button (Save/Create/Submit/Continue) is often rendered in a footer or portal OUTSIDE the <form> DOM. Do NOT scope the submit click strictly inside the form — target the dialog's action area or the page by role+name, e.g. getByRole('button', { name: /save|create|submit|continue/i }).",
    fixer: "If a submit/save click times out when scoped to a form, the button is likely portal/footer-rendered — re-target it by role+name at the dialog or page level.",
  },
  {
    title: "Edit affordance first — detail pages aren't editable by default",
    spec: "Detail/view pages usually render read-only until an Edit/pencil control is clicked. Before filling an existing record's fields, click the Edit affordance and wait for the inputs to become editable.",
    fixer: "If an input on a detail page is not found or not editable, look for an Edit/pencil button to click first.",
  },
  {
    title: "Never OR many generic selectors (avoid strict-mode violations)",
    spec: "Do NOT build broad fallback unions like 'table, [role=table], .x-table, [class*=table], main' — they resolve to multiple elements and trigger strict-mode errors. Pick ONE stable selector (data-testid > role > label), scope to the nearest container, and use .first() deliberately only when a match set is expected.",
    fixer: "For 'strict mode violation: resolved to N elements', replace the broad union with a single scoped testid/role locator or add an explicit .first().",
  },
  {
    title: "Use valid, supported locators only",
    spec: "Use getByRole / getByLabel / getByTestId / getByText. Avoid hand-built CSS that mixes Playwright pseudo-classes with CSS negation (e.g. 'input:not([type]):visible') — such selectors don't resolve. Prefer role/label/testid over raw CSS.",
    fixer: "If a selector errors as invalid/unresolvable, rewrite it with getByRole/getByLabel/getByTestId instead of complex CSS.",
  },
  {
    title: "Wait for enabled, not just visible, before clicking",
    spec: "Primary actions are often disabled until a form is valid or content has streamed in. Before clicking, await expect(locator).toBeEnabled({ timeout: 15000 }) (not just toBeVisible). Never use 'networkidle'.",
    fixer: "If a click times out on a visible element, it was probably disabled — add toBeEnabled() (and select required options first).",
  },
  {
    title: "Lists/view/edit/search need existing data — don't assert empty, don't skip",
    spec: "For list/view/edit/delete/search flows, act on a seeded record (look it up by its marker) instead of asserting on an empty state. If no data is visible, create one via the UI first. Never use test.skip()/test.fixme() for a missing-data precondition.",
    fixer: "If a list/detail test fails with 'no rows'/'not found', use the seeded marker to locate a record, or create one first — do not skip.",
  },
  {
    title: "Prefer stable locators over guessed visible text",
    spec: "Target elements by data-testid or role/label, not hard-coded button copy. When text is the only option and may vary, use a permissive regex (e.g. /add|create|new/i) rather than an exact guessed string.",
    fixer: "If an element 'not found' was matched by exact text, switch to its data-testid/role or widen the text to a regex.",
  },
  {
    title: "Auth-gated pages — log in via the verified flow first",
    spec: "For anything behind auth, perform login through the app's real login route using the seeded credentials, and wait for the post-login redirect (URL leaves the login page or a known authenticated element appears) BEFORE navigating to the target page. Don't assume the login route/field names — use the discovered selectors/credentials provided.",
    fixer: "If a test lands back on the login page or auth-gated content is missing, the login step failed — fix the login route/credentials and wait for the redirect before proceeding.",
  },
];

function baselineSpecSection(): string {
  const lines = [
    "## Baseline Best Practices (ALWAYS APPLY — generic to any app)",
    "These prevent the most common avoidable failures. Follow them in every spec.",
    "",
  ];
  for (const g of BASELINE_GUIDELINES) {
    lines.push(`**${g.title}**`);
    lines.push(`> ${g.spec}`);
    lines.push("");
  }
  return lines.join("\n");
}

function baselineFixerSection(): string {
  const lines = ["## Baseline Checks (generic — apply to any failure)", ""];
  for (const g of BASELINE_GUIDELINES) lines.push(`- **${g.title}**: ${g.fixer}`);
  lines.push("");
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Read — format learnings for injection into prompts
// ─────────────────────────────────────────────────────────────────────────────

export function loadLearnings(): string {
  // Baseline always applies, even with an empty learnings.json.
  let out = baselineSpecSection();

  const store = loadStore();
  if (store.learnings.length) {
    const lines = [
      "## Accumulated Learnings From Previous Sessions",
      "Apply these proven guidelines — they reflect real failures encountered across past runs.",
      "",
    ];
    for (const l of store.learnings) {
      const freq = l.seenCount > 1 ? ` (seen ${l.seenCount}× across sessions)` : "";
      lines.push(`**${l.id} — ${l.title}**${freq}`);
      lines.push(`> ${l.specGuideline}`);
      lines.push("");
    }
    out += "\n" + lines.join("\n");
  }
  return out;
}

export function loadFixerLearnings(): string {
  let out = baselineFixerSection();

  const store = loadStore();
  if (store.learnings.length) {
    const lines = ["## Known Failure Patterns From Previous Sessions", ""];
    for (const l of store.learnings) {
      lines.push(`- **${l.title}**: ${l.fixerGuideline}`);
    }
    out += "\n" + lines.join("\n");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write — extract and persist learnings after a session
// ─────────────────────────────────────────────────────────────────────────────

export async function saveSessionLearnings(
  allResults: TestRunResult[],
  fixes: TestFix[],
  bugs: BugReport[]
): Promise<void> {
  const appliedFixes = fixes.filter((f) => f.applied);
  const failures = allResults.filter(
    (r) => r.status === "failed" || r.status === "timedout"
  );

  if (appliedFixes.length === 0 && failures.length === 0) return;

  const fixSummaries = appliedFixes
    .map((f) => `${f.specId} [${f.failureClass}]: ${f.rootCause} → fix: ${f.explanation}`)
    .join("\n");

  const failureSummaries = failures
    .map((f) => `${f.specId}: ${f.errorMessage ?? "unknown error"}`)
    .join("\n");

  const bugSummaries = bugs
    .map((b) => `${b.id} in ${b.file}: ${b.rootCause}`)
    .join("\n");

  const prompt = `You are a QA automation expert. Extract generalizable learnings from this test session.

## Fixes That Were Applied (what was broken and how it was resolved)
${fixSummaries || "(no fixes applied)"}

## Tests Still Failing After All Fix Rounds
${failureSummaries || "(all tests passing)"}

## Application Bugs Found
${bugSummaries || "(none)"}

## Your Task
Extract 3-8 generalizable, reusable learnings. Each learning must apply beyond this specific app — it should be a pattern useful for any similar technology stack.

Focus on:
- Framework-specific gotchas (SSR streaming, server actions, SPA routing, async rendering)
- Selector patterns that commonly fail (strict mode, wrong element scope, dynamic content)
- Flow prerequisites that tests often miss (auth state, required data setup, navigation order)
- Timing patterns (when to use toBeEnabled vs toBeVisible, waitForResponse, waitForURL)

Do NOT include app-specific facts like specific user credentials, test data values, or hardcoded URL paths.

Return ONLY a valid JSON array. No markdown fences:
[
  {
    "category": "flow|selector|framework|timing|app-pattern",
    "title": "concise title under 10 words",
    "detail": "full explanation of the failure pattern",
    "specGuideline": "concrete instruction for spec writers to avoid this (2-3 sentences max)",
    "fixerGuideline": "what to check first when a test fails with this pattern (1-2 sentences)"
  }
]`;

  try {
    const response = await createMessage({
      max_tokens: 2000,
      system: "You are a QA automation expert. Respond ONLY with a valid JSON array. No markdown fences.",
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].text
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    const extracted: Array<Omit<Learning, "id" | "seenCount" | "firstSeen" | "lastSeen" | "sources">> =
      JSON.parse(raw);

    const store = loadStore();
    const today = new Date().toISOString().split("T")[0];
    const existingByTitle = new Map(store.learnings.map((l) => [l.title.toLowerCase(), l]));

    for (const nl of extracted) {
      const key = nl.title.toLowerCase();
      if (existingByTitle.has(key)) {
        const existing = existingByTitle.get(key)!;
        existing.seenCount++;
        existing.lastSeen = today;
        // Refresh with latest understanding
        existing.detail = nl.detail;
        existing.specGuideline = nl.specGuideline;
        existing.fixerGuideline = nl.fixerGuideline;
      } else {
        const id = `L${String(store.learnings.length + 1).padStart(3, "0")}`;
        const sources = appliedFixes
          .filter((f) =>
            f.rootCause.toLowerCase().includes(nl.title.split(" ").slice(0, 2).join(" ").toLowerCase())
          )
          .map((f) => f.specId);

        const learning: Learning = {
          id,
          ...nl,
          seenCount: 1,
          firstSeen: today,
          lastSeen: today,
          sources,
        };
        store.learnings.push(learning);
        existingByTitle.set(key, learning);
      }
    }

    // Reassign IDs sequentially to keep them stable
    store.learnings.forEach((l, i) => {
      l.id = `L${String(i + 1).padStart(3, "0")}`;
    });
    store.updatedAt = new Date().toISOString();

    fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(store, null, 2), "utf-8");
    console.log(
      `      Learnings saved → agents/learnings.json (${store.learnings.length} patterns stored)`
    );
  } catch (err) {
    console.log(
      `      [learner] Warning: could not save learnings — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadStore(): LearningsStore {
  if (!fs.existsSync(LEARNINGS_FILE)) {
    return { version: 1, updatedAt: new Date().toISOString(), learnings: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LEARNINGS_FILE, "utf-8"));
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), learnings: [] };
  }
}
