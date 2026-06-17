import * as fs from "fs";
import * as path from "path";
import { createMessage } from "./ai-client";
import { spawnTeed } from "./logger";
import type { AppContext, RouteInfo } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Auth Bootstrap (Phase 1.5)
//
// If the application exposes a register / signup flow, this module:
//   1. Generates fresh test credentials
//   2. Asks the AI to write a one-off Playwright spec that registers the user
//   3. Runs that spec
//   4. On success, persists the credentials to .env as TEST_USERNAME / TEST_PASSWORD / TEST_EMAIL
//   5. Updates process.env so the planner + automator pick them up downstream
//
// All subsequent auth-required test cases will then exercise login with a real,
// freshly-seeded account — no more flaky tests caused by stale placeholder credentials.
// ─────────────────────────────────────────────────────────────────────────────

const GENERATED_DIR = path.join(__dirname, "../../tests/generated");
const TESTS_DIR = path.join(__dirname, "../../tests");
const ENV_FILE = path.join(__dirname, "../../.env");
const RESULTS_FILE = path.join(TESTS_DIR, "test-results", "results.json");

const REGISTER_KEYWORDS = [
  "register",
  "signup",
  "sign-up",
  "sign_up",
  "create-account",
  "createaccount",
  "join",
  "onboard",
];

const PLACEHOLDER_USERNAMES = new Set([
  "",
  "your_test_username",
  "test_username",
  "username",
  "user",
]);

export interface RegistrationResult {
  attempted: boolean;
  success: boolean;
  reason: string;
  username?: string;
  email?: string;
  routePath?: string;
  specFile?: string;
}

export async function bootstrapRegistration(ctx: AppContext): Promise<RegistrationResult> {
  const route = detectRegisterRoute(ctx);
  if (!route) {
    return {
      attempted: false,
      success: false,
      reason: "no register/signup route detected in app source",
    };
  }

  const force = (process.env.FORCE_REGISTER ?? "").toLowerCase() === "true";
  const currentUser = (process.env.TEST_USERNAME ?? "").trim();
  if (!force && currentUser && !PLACEHOLDER_USERNAMES.has(currentUser)) {
    return {
      attempted: false,
      success: false,
      reason: `TEST_USERNAME already set to "${currentUser}" — set FORCE_REGISTER=true to override`,
    };
  }

  const selectors = detectRegisterSelectors(ctx);
  const creds = generateCredentials();

  const specContent = await generateRegistrationSpec(ctx, route, selectors, creds);
  const specFile = "tc000-bootstrap-register-seed-user.spec.ts";
  const specPath = path.join(GENERATED_DIR, specFile);
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  fs.writeFileSync(specPath, specContent, "utf-8");

  const passed = await runRegistrationSpec();
  if (!passed) {
    return {
      attempted: true,
      success: false,
      reason: "registration spec did not pass — see Playwright output above",
      username: creds.username,
      email: creds.email,
      routePath: route.displayUrl,
      specFile,
    };
  }

  writeEnv({
    TEST_USERNAME: creds.username,
    TEST_PASSWORD: creds.password,
    TEST_EMAIL: creds.email,
  });

  // Bootstrap spec has served its purpose. Remove it so the main test run does
  // not try to register the same user a second time (which would fail).
  try { fs.unlinkSync(specPath); } catch { /* ignore */ }

  return {
    attempted: true,
    success: true,
    reason: "registered new user and seeded credentials into .env",
    username: creds.username,
    email: creds.email,
    routePath: route.displayUrl,
    specFile,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────────

function detectRegisterRoute(ctx: AppContext): RouteInfo | null {
  for (const r of ctx.routes) {
    const hay = `${r.urlPattern} ${r.displayUrl}`.toLowerCase();
    if (REGISTER_KEYWORDS.some((k) => hay.includes(k))) return r;
  }
  return null;
}

function detectRegisterSelectors(ctx: AppContext): string[] {
  const hits: string[] = [];
  for (const s of ctx.selectors) {
    const id = s.testId.toLowerCase();
    const inRegisterContext = REGISTER_KEYWORDS.some(
      (k) => id.includes(k) || s.context.toLowerCase().includes(k),
    );
    if (inRegisterContext) hits.push(s.testId);
  }
  // Always allow common form-field testids even if not register-prefixed
  for (const s of ctx.selectors) {
    const id = s.testId.toLowerCase();
    if (
      /(email|username|password|confirm|name|phone|submit|next|continue)/.test(id) &&
      !hits.includes(s.testId)
    ) {
      hits.push(s.testId);
    }
  }
  return hits;
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential generation
// ─────────────────────────────────────────────────────────────────────────────

function generateCredentials(): { username: string; email: string; password: string } {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  const slug = `qaagent_${stamp}${rand}`;
  return {
    username: slug,
    email: `${slug}@example.com`,
    // Mix of upper/lower/digit/symbol to satisfy common password-strength rules
    password: `QaAgent!${stamp.toUpperCase()}9`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec generation
// ─────────────────────────────────────────────────────────────────────────────

async function generateRegistrationSpec(
  ctx: AppContext,
  route: RouteInfo,
  selectors: string[],
  creds: { username: string; email: string; password: string },
): Promise<string> {
  const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";
  const fullUrl = `${ctx.baseUrl}${localePrefix}${route.displayUrl}`;

  const selectorBlock = selectors.length
    ? selectors.map((s) => `  page.locator('[data-testid="${s}"]')`).join("\n")
    : "  (no register-related testid selectors found — fall back to input[name=...] / role / label)";

  const framework = ctx.framework === "nextjs-app-router" && ctx.renderingModel === "ssr-streaming"
    ? "## CRITICAL — Next.js SSR streaming\n" +
      "- Wait for inputs to be ENABLED, not just visible: await expect(loc.first()).toBeEnabled({ timeout: 15000 })\n" +
      "- After clicking submit, wait for the POST: page.waitForResponse(r => r.request().method() === 'POST', { timeout: 20000 })\n" +
      "- NEVER use 'networkidle' — use 'load' or element waits.\n"
    : "";

  const prompt = `You are an expert Playwright test engineer. Write a single TypeScript spec that registers a new user account in this application.

## Application
- Base URL: ${ctx.baseUrl}
- Register page: ${fullUrl}
- Framework: ${ctx.framework}
- Rendering: ${ctx.renderingModel}

## Seed credentials to use VERBATIM (do not invent your own)
- username: ${creds.username}
- email:    ${creds.email}
- password: ${creds.password}

## Known register-related selectors (use ONLY these data-testid values; fall back to input[name=...] for any field not in this list)
${selectorBlock}

${framework}
## Spec requirements
1. Start with: import { test, expect } from '@playwright/test';
2. test.describe('auth — Bootstrap register seed user', ...)
3. Test function MUST be named exactly: "TC000 - Bootstrap register seed user"
4. Navigate to ${fullUrl}; await page.waitForLoadState('load')
5. Fill EVERY visible required form field. For a typical register form fill: email, username (if present), password, confirm password. For any optional fields that are required (full name, phone, etc.) fill plausible values derived from "${creds.username}"
6. Click the submit / register / create-account button
7. After submit, assert success in at least ONE of these ways (whichever applies):
   - URL changes away from ${route.displayUrl} (toHaveURL with a regex that excludes the register path)
   - A dashboard/home/welcome element becomes visible
   - A success toast / message becomes visible
8. The test MUST be self-contained — no imports from fixture files
9. Use generous timeouts (15s) on the post-submit assertion to absorb redirect / SSR delay
10. Do NOT use waitForLoadState('networkidle')

Return ONLY the TypeScript source. No markdown, no fences, no commentary.`;

  const response = await createMessage({
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }],
  });

  let spec = response.content[0].text;
  spec = spec
    .replace(/^```(?:typescript|ts)?\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
  return spec;
}

// ─────────────────────────────────────────────────────────────────────────────
// Run the registration spec (single grep, no JSON parsing needed beyond stats)
// ─────────────────────────────────────────────────────────────────────────────

async function runRegistrationSpec(): Promise<boolean> {
  const resultsDir = path.join(TESTS_DIR, "test-results");
  fs.mkdirSync(resultsDir, { recursive: true });
  if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

  await spawnTeed(
    "npx",
    ["playwright", "test", "--grep=TC000", `--output=${resultsDir}`],
    { cwd: TESTS_DIR },
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

// ─────────────────────────────────────────────────────────────────────────────
// .env persistence
// ─────────────────────────────────────────────────────────────────────────────

function writeEnv(updates: Record<string, string>): void {
  const existing = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, "utf-8").split("\n")
    : [];

  const seen = new Set<string>();
  const next = existing.map((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (m && updates[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });

  const appended: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) appended.push(`${k}=${v}`);
  }
  if (appended.length) {
    if (next.length && next[next.length - 1] !== "") next.push("");
    next.push("# ─── Seeded by Auth Bootstrap (registrar.ts) ────────────────────────────");
    next.push(...appended);
  }

  fs.writeFileSync(ENV_FILE, next.join("\n"), "utf-8");

  for (const [k, v] of Object.entries(updates)) {
    process.env[k] = v;
  }
}
