import * as fs from "fs";
import * as path from "path";
import { createMessage } from "./ai-client";
import { spawnTeed } from "./logger";
import { writeSeedState, clearSeedState } from "./seed-state";
import type { AppContext, RouteInfo, SeedEntity, SeedState } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Seed Data Bootstrap (Phase 1.6)
//
// Runs AFTER auth bootstrap. Detects "create" routes in the app source
// (/new, /create, /add, /register-something) and asks the AI to generate a
// single Playwright spec that:
//   1. Logs in with the seeded TEST_USERNAME / TEST_PASSWORD
//   2. Navigates to each create route in order
//   3. Fills the form with plausible test data and submits
//
// The spec runs once; on success the records persist in the application DB
// for the rest of the test suite — so the read/list/view tests that previously
// skipped with "no seed data" now find real records to interact with.
//
// The spec is deleted after a successful run so it does not re-execute as part
// of the main test suite (which would create duplicate records every run).
// ─────────────────────────────────────────────────────────────────────────────

const GENERATED_DIR = path.join(__dirname, "../../tests/generated");
const TESTS_DIR = path.join(__dirname, "../../tests");
const RESULTS_FILE = path.join(TESTS_DIR, "test-results", "results.json");

const CREATE_KEYWORDS = [
  "/new",
  "/create",
  "/add",
];

// Domain entities that should be seeded BEFORE their dependents
// (e.g. patients before appointments, customers before orders). The first
// keyword that matches a route's URL determines its bucket; lower index = earlier.
const SEED_ORDER_HINTS = [
  "user",
  "customer",
  "patient",
  "person",
  "doctor",
  "product",
  "item",
  "appointment",
  "booking",
  "order",
  "note",
  "prescription",
  "document",
  "record",
];

export interface SeedResult {
  attempted: boolean;
  success: boolean;
  reason: string;
  createRoutesFound: number;
  specFile?: string;
  state?: SeedState;
}

export async function bootstrapSeedData(ctx: AppContext): Promise<SeedResult> {
  // Always start with a clean slate — stale markers from a previous run would
  // mislead the automator/fixer if seeding now fails.
  clearSeedState();

  const username = (process.env.TEST_USERNAME ?? "").trim();
  const password = (process.env.TEST_PASSWORD ?? "").trim();
  const email = (process.env.TEST_EMAIL ?? "").trim();
  if (!username || !password) {
    return {
      attempted: false,
      success: false,
      reason: "no TEST_USERNAME/TEST_PASSWORD in env — auth bootstrap must run first",
      createRoutesFound: 0,
    };
  }

  const createRoutes = detectCreateRoutes(ctx);
  if (createRoutes.length === 0) {
    // Still persist the credentials so the automator can use them downstream.
    const state: SeedState = {
      generatedAt: new Date().toISOString(),
      credentials: { username, password, email: email || undefined },
      entities: [],
    };
    writeSeedState(state);
    return {
      attempted: false,
      success: false,
      reason: "no create/new/add routes detected — only credentials seeded",
      createRoutesFound: 0,
      state,
    };
  }

  const sorted = orderByDependencyHint(createRoutes);

  // Compute a marker per route up-front. These exact strings are baked into
  // the seed spec AND written to the state file, so dependent specs can find
  // the records by exact match.
  const stamp = Date.now().toString(36);
  const entities: SeedEntity[] = sorted.map((route) => {
    const entityName = deriveEntityName(route.urlPattern);
    return {
      entityName,
      routePattern: route.urlPattern,
      marker: `QA_${capitalize(entityName)}_${stamp}`,
      description: `Search the corresponding list page for an exact-match record whose primary text field equals the marker.`,
    };
  });

  const specContent = await generateSeedSpec(ctx, sorted, entities, { username, password });
  const specFile = "tc000a-seed-data.spec.ts";
  const specPath = path.join(GENERATED_DIR, specFile);
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(specPath, specContent, "utf-8");

  const passed = await runSeedSpec();
  if (!passed) {
    // Persist credentials only — entities can't be trusted to exist if the spec failed.
    const state: SeedState = {
      generatedAt: new Date().toISOString(),
      credentials: { username, password, email: email || undefined },
      entities: [],
    };
    writeSeedState(state);
    return {
      attempted: true,
      success: false,
      reason: "seed spec did not pass — see Playwright output above (records may have been partially created)",
      createRoutesFound: sorted.length,
      specFile,
      state,
    };
  }

  try { fs.unlinkSync(specPath); } catch { /* ignore */ }

  const state: SeedState = {
    generatedAt: new Date().toISOString(),
    credentials: { username, password, email: email || undefined },
    entities,
  };
  writeSeedState(state);

  return {
    attempted: true,
    success: true,
    reason: `seeded ${entities.length} entity record(s): ${entities.map((e) => e.entityName).join(", ")}`,
    createRoutesFound: sorted.length,
    specFile,
    state,
  };
}

function deriveEntityName(urlPattern: string): string {
  // /patients/new → "patient", /appointments/[id]/new → "appointment"
  const segments = urlPattern.toLowerCase().split("/").filter(Boolean);
  for (const seg of segments) {
    if (["new", "create", "add", "edit"].includes(seg)) continue;
    if (seg.startsWith("[")) continue; // dynamic param
    // Strip trailing 's' as a crude singularization
    return seg.replace(/s$/, "");
  }
  return "record";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Route detection + ordering
// ─────────────────────────────────────────────────────────────────────────────

function detectCreateRoutes(ctx: AppContext): RouteInfo[] {
  return ctx.routes.filter((r) => {
    const url = r.urlPattern.toLowerCase();
    return CREATE_KEYWORDS.some((k) => url.includes(k));
  });
}

function orderByDependencyHint(routes: RouteInfo[]): RouteInfo[] {
  const score = (r: RouteInfo): number => {
    const url = r.urlPattern.toLowerCase();
    for (let i = 0; i < SEED_ORDER_HINTS.length; i++) {
      if (url.includes(SEED_ORDER_HINTS[i])) return i;
    }
    return SEED_ORDER_HINTS.length; // unrecognized → last
  };
  return [...routes].sort((a, b) => score(a) - score(b));
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec generation
// ─────────────────────────────────────────────────────────────────────────────

async function generateSeedSpec(
  ctx: AppContext,
  routes: RouteInfo[],
  entities: SeedEntity[],
  creds: { username: string; password: string },
): Promise<string> {
  const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";

  const routeList = routes
    .map((r, i) => {
      const ent = entities.find((e) => e.routePattern === r.urlPattern);
      const markerNote = ent ? `  → use marker: ${ent.marker}` : "";
      return `  ${i + 1}. ${ctx.baseUrl}${localePrefix}${r.displayUrl}  — ${r.description}${markerNote}`;
    })
    .join("\n");

  const markerTable = entities
    .map((e) => `  - ${e.entityName}: place the EXACT STRING "${e.marker}" in the form's primary text field (name / title / label)`)
    .join("\n");

  // Selectors that look form-relevant (any field-like testid + submit/save)
  const formSelectors = ctx.selectors
    .filter((s) =>
      /(input|field|name|email|first|last|phone|address|date|time|amount|qty|quantity|notes?|description|title|submit|save|create|continue|next|add)/i
        .test(s.testId),
    )
    .map((s) => `  [${s.context}] "${s.testId}"`)
    .join("\n");

  const framework =
    ctx.framework === "nextjs-app-router" && ctx.renderingModel === "ssr-streaming"
      ? "## Next.js SSR streaming notes\n" +
        "- Wait for inputs to be ENABLED, not just visible: await expect(loc.first()).toBeEnabled({ timeout: 15000 })\n" +
        "- After clicking submit, wait for the POST: page.waitForResponse(r => r.request().method() === 'POST', { timeout: 20000 })\n" +
        "- NEVER use 'networkidle' — use 'load' or element waits.\n"
      : "";

  const prompt = `You are a Playwright test engineer writing a one-off "seed data" spec.

Goal: log in once, then create ONE record at each of the following routes IN ORDER. Records persist in the application database and will be used by the main test suite (search, view, edit, list flows).

## Application
- Base URL: ${ctx.baseUrl}
- Framework: ${ctx.framework}
- Login credentials to use VERBATIM:
  - username: ${creds.username}
  - password: ${creds.password}

## Create routes (run them in this order — earlier entities are referenced by later ones)
${routeList}

## Required markers — bake these EXACT strings into the form fills
The agent's downstream specs will search for these strings to find the seeded records, so they MUST appear unchanged in whatever primary text field the form uses (typically name, title, or label):
${markerTable}

If a form has a relationship field (e.g. an appointment needs a patient), pick the previously-created marker via the dropdown / search.

## Form-relevant data-testid selectors (use these where they apply; fall back to input[name=...] / label / placeholder otherwise)
${formSelectors || "  (none detected — rely on visible labels and input names)"}

${framework}
## Spec requirements
1. import { test, expect } from '@playwright/test';
2. Single test.describe block: "seed — populate baseline records"
3. Use a beforeAll hook in a shared browser context so the login persists across the create steps. Sketch:
     test.describe.configure({ mode: 'serial' });
4. Test 1: "Seed: login" — log in via the app's login page using the credentials above. After submit, assert the URL is no longer on /login (or similar auth path).
5. One additional test per create route — "Seed: create <entity>" where <entity> is inferred from the URL path (e.g. /patients/new → "Seed: create patient"). For each:
   a. Navigate to the create route.
   b. Fill EVERY visible required field with plausible test data. Use names like "QA Seed Patient", "qaseed+<entity>@example.com", "555-0100", "1990-01-01", etc. — anything that satisfies typical validation.
   c. Click submit / save / create.
   d. Assert success: URL changes off the /new path, OR a success toast / detail page appears.
6. Each test MUST be self-contained except for the shared login context. Use page from the test arg; if you need shared state across tests, store it in module-level let variables.
7. Use generous timeouts (15s) on post-submit assertions.
8. The TEST NAME must start with the prefix "Seed: " so the run can be grep-filtered with --grep="Seed:".

Return ONLY the TypeScript source. No markdown fences, no commentary.`;

  const response = await createMessage({
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  let spec = response.content[0].text;
  spec = spec.replace(/^```(?:typescript|ts)?\n?/m, "").replace(/\n?```\s*$/m, "").trim();
  return spec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run + parse
// ─────────────────────────────────────────────────────────────────────────────

async function runSeedSpec(): Promise<boolean> {
  const resultsDir = path.join(TESTS_DIR, "test-results");
  fs.mkdirSync(resultsDir, { recursive: true });
  if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

  await spawnTeed(
    "npx",
    ["playwright", "test", "--grep=Seed:", `--output=${resultsDir}`],
    {
      cwd: TESTS_DIR,
      env: {
        ...process.env,
        // Seed run writes its own blob so it doesn't clobber the main suite's blobs.
        QA_BLOB_NAME: "seed.zip",
        PWTEST_BLOB_DO_NOT_REMOVE: "1",
      },
    },
  );

  if (!fs.existsSync(RESULTS_FILE)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf-8"));
    const expected = raw?.stats?.expected ?? 0;
    const unexpected = raw?.stats?.unexpected ?? 0;
    return expected > 0 && unexpected === 0;
  } catch {
    return false;
  }
}
