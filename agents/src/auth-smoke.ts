import * as fs from "fs";
import * as path from "path";
import { createMessage } from "./ai-client";
import { runTaggedSpec } from "./runner";
import type { AppContext, RouteInfo, SeedState } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Auth smoke test (pre-flight)
//
// Before generating the whole suite, verify ONCE that login actually works with
// the configured/seeded credentials. Auth-gated tests all depend on a working
// login — if it's broken (wrong route, wrong field names, no redirect), every
// such test cascades to failure. Catching it here turns a silent 0%-on-auth
// collapse into one loud, actionable warning.
//
// Skippable via SKIP_AUTH_SMOKE=true. With STRICT_AUTH=true a failure aborts the
// run (exit 1) instead of warning-and-continuing.
// ─────────────────────────────────────────────────────────────────────────────

const GENERATED_DIR = path.join(__dirname, "../../tests/generated");
const SPEC_FILE = path.join(GENERATED_DIR, "tc000-auth-smoke.spec.ts");
const GREP = "TC000AUTH";

const LOGIN_KEYWORDS = ["login", "signin", "sign-in", "sign_in", "log-in", "auth", "session"];
const PLACEHOLDER_USERNAMES = new Set(["", "your_test_username", "test_username", "username", "user"]);

export interface AuthSmokeResult {
  attempted: boolean;
  success: boolean;
  reason: string;
}

function detectLoginRoute(ctx: AppContext): RouteInfo | null {
  for (const r of ctx.routes) {
    const hay = `${r.urlPattern} ${r.displayUrl}`.toLowerCase();
    if (LOGIN_KEYWORDS.some((k) => hay.includes(k)) && !hay.includes("logout")) return r;
  }
  return null;
}

function detectLoginSelectors(ctx: AppContext): string[] {
  const hits: string[] = [];
  for (const s of ctx.selectors) {
    if (/(email|username|user|password|submit|login|sign|continue)/i.test(s.testId)) hits.push(s.testId);
  }
  return hits.slice(0, 20);
}

function resolveCreds(seedState: SeedState | null): { username: string; password: string } | null {
  const envUser = (process.env.TEST_USERNAME ?? "").trim();
  const envPass = (process.env.TEST_PASSWORD ?? "").trim();
  if (envUser && envPass && !PLACEHOLDER_USERNAMES.has(envUser)) {
    return { username: envUser, password: envPass };
  }
  if (seedState?.credentials?.username && seedState.credentials.password) {
    return { username: seedState.credentials.username, password: seedState.credentials.password };
  }
  return null;
}

async function generateLoginSpec(
  ctx: AppContext,
  loginRoute: RouteInfo | null,
  selectors: string[],
  creds: { username: string; password: string },
): Promise<string> {
  const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";
  const discovered = loginRoute ? `${ctx.baseUrl}${localePrefix}${loginRoute.displayUrl}` : "(none discovered in source)";
  const selectorBlock = selectors.length
    ? selectors.map((s) => `  page.getByTestId('${s}')`).join("\n")
    : "  (no login-related testids found — use getByLabel / input[name=...] / getByRole)";

  const framework = ctx.framework === "nextjs-app-router" && ctx.renderingModel === "ssr-streaming"
    ? "## Next.js SSR streaming\n- Wait for inputs to be ENABLED before filling.\n- After submit, wait for navigation/redirect, not 'networkidle'.\n"
    : "";

  const prompt = `You are an expert Playwright engineer. Write ONE self-contained spec that logs into this app and verifies an authenticated session. This is a pre-flight smoke test — keep it minimal and robust.

## Application
- Base URL: ${ctx.baseUrl}${localePrefix ? `\n- Locale prefix: ${localePrefix}` : ""}
- Discovered login page: ${discovered}
- Framework: ${ctx.framework} (${ctx.renderingModel})

## Credentials to use VERBATIM
- username/email: ${creds.username}
- password:       ${creds.password}

## Known login-related selectors (prefer these; fall back to getByLabel/getByRole/input[name])
${selectorBlock}

${framework}## Requirements
1. import { test, expect } from '@playwright/test';
2. test.describe('auth — smoke', ...) with the test function named EXACTLY: "${GREP} - login smoke"
3. Navigate to the login page. If the discovered route is "(none discovered...)" or 404s, TRY common admin/app login paths in order until a login form appears: ${ctx.baseUrl}${localePrefix}/login, ${ctx.baseUrl}${localePrefix}/app/login, ${ctx.baseUrl}${localePrefix}/auth/login, ${ctx.baseUrl}${localePrefix}/admin/login. await page.waitForLoadState('load').
4. Fill the identifier field (email OR username — whichever the form shows) and the password field with the credentials above, then submit. The identifier may be type=email; handle either.
5. VERIFY authentication succeeded by asserting at least one of: URL no longer contains "login"/"signin"/"auth", OR a known post-login element (dashboard/account/logout/nav) is visible. Use a generous timeout (15s) for the post-submit redirect.
6. If the login form itself never renders at any path, FAIL with a clear message including the last URL tried (so the operator knows the login route is wrong).
7. Self-contained, no fixture imports. No waitForLoadState('networkidle').

Return ONLY the TypeScript source — no markdown, no fences.`;

  const response = await createMessage({ max_tokens: 2500, messages: [{ role: "user", content: prompt }] });
  return response.content[0].text
    .replace(/^```(?:typescript|ts)?\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();
}

export async function authSmokeTest(ctx: AppContext, seedState: SeedState | null): Promise<AuthSmokeResult> {
  if ((process.env.SKIP_AUTH_SMOKE ?? "").toLowerCase() === "true") {
    return { attempted: false, success: false, reason: "SKIP_AUTH_SMOKE=true" };
  }

  const creds = resolveCreds(seedState);
  const loginRoute = detectLoginRoute(ctx);

  // No way to test auth: no credentials available. (If there's also no login
  // route, the app probably has no auth — nothing to verify.)
  if (!creds) {
    return {
      attempted: false,
      success: false,
      reason: loginRoute
        ? "a login route exists but no credentials are configured (set TEST_USERNAME/TEST_PASSWORD or run auth bootstrap)"
        : "no credentials and no login route detected — app appears to have no auth",
    };
  }

  try {
    const spec = await generateLoginSpec(ctx, loginRoute, detectLoginSelectors(ctx), creds);
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    fs.writeFileSync(SPEC_FILE, spec, "utf-8");

    const passed = await runTaggedSpec(GREP);
    return passed
      ? { attempted: true, success: true, reason: "login verified" }
      : { attempted: true, success: false, reason: "login spec failed — see the run output above" };
  } catch (err) {
    return { attempted: true, success: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    // Always remove the smoke spec so it never runs in the main suite.
    if (fs.existsSync(SPEC_FILE)) {
      try { fs.unlinkSync(SPEC_FILE); } catch { /* ignore */ }
    }
  }
}
