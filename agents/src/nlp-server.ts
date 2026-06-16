import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { readCodebaseContext } from "./codebase-reader";
import { loadSeedState } from "./seed-state";
import { authorTestFromNaturalLanguage, healNlpSpec } from "./nlp-authoring";
import {
  runFullPipeline,
  cleanGeneratedArtifacts,
  ALLOWED_CONFIG_KEYS,
  type PipelineControls,
  type PipelineMode,
} from "./nlp-pipeline";
import type { AppContext } from "./types";

const MAX_HEAL_ROUNDS = parseInt(process.env.NLP_MAX_HEAL_ROUNDS ?? "3", 10);

// Only one full-suite pipeline may run at a time (it drives browsers + the DB).
let pipelineRunning = false;
// Reference to the in-flight run's controls so the out-of-band pause/resume/stop
// endpoints can reach the streaming run while its response is still open.
let activeControls: PipelineControls | null = null;
const TEST_PLAN_FILE = path.join(__dirname, "../../tests", "generated", "test-plan.json");

// ─────────────────────────────────────────────────────────────────────────────
// Natural-Language Test Authoring — web server
//
// A zero-dependency HTTP server (Node built-ins only) that powers a browser UI
// where a non-technical user types plain English, the agent generates Playwright
// code, runs it, and reports pass/fail with a step timeline — then adapts the
// test when the instruction changes.
//
// Run:  pnpm --filter @qa/agents run author   (or: pnpm author from the repo root)
// ─────────────────────────────────────────────────────────────────────────────

// Default 5180 — 5173 (Vite's default) is commonly taken by a dev/Docker server.
// Override with NLP_PORT if 5180 is busy too.
const PORT = parseInt(process.env.NLP_PORT ?? "5180", 10);
const PUBLIC_DIR = path.join(__dirname, "../public");
const TESTS_DIR = path.join(__dirname, "../../tests");
const NLP_SPEC_DIR = path.join(TESTS_DIR, "nlp-authored");
const NLP_SPEC_FILE = path.join(NLP_SPEC_DIR, "authored.spec.ts");
const NLP_RESULTS = path.join(TESTS_DIR, "test-results", "nlp-results.json");
const NLP_CONFIG = "playwright.nlp.config.ts";

// Read the app-under-test context once at startup (routes + selectors + framework).
// Degrade gracefully if env vars aren't configured so the UI still loads.
let appContext: AppContext;
try {
  appContext = readCodebaseContext();
  console.log(
    `  Loaded app context: ${appContext.framework} — ${appContext.routes.length} routes, ${appContext.selectors.length} selectors`
  );
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`  ⚠ Could not read app context (${msg.split("\n")[0]}). The UI will still load.`);
  appContext = {
    framework: "unknown",
    renderingModel: "unknown",
    routes: [],
    selectors: [],
    actionLabels: [],
    seedData: [],
    baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
    countryCode: process.env.COUNTRY_CODE ?? "",
  };
}

// ── small helpers ────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webm": "video/webm",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".zip": "application/zip",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

const REPORT_DIR = path.join(__dirname, "../../tests/playwright-report");

// ── route handlers ─────────────────────────────────────────────────────────

function handleContext(res: http.ServerResponse): void {
  const seedState = loadSeedState();
  // De-dupe selectors for display.
  const seen = new Set<string>();
  const selectors = appContext.selectors
    .filter((s) => (seen.has(s.testId) ? false : (seen.add(s.testId), true)))
    .slice(0, 200)
    .map((s) => ({ testId: s.testId, context: s.context }));

  sendJson(res, 200, {
    appName: process.env.APP_NAME ?? "the application",
    baseUrl: appContext.baseUrl,
    framework: appContext.framework,
    renderingModel: appContext.renderingModel,
    localePrefix: appContext.countryCode ? `/${appContext.countryCode}` : "",
    routeCount: appContext.routes.length,
    selectorCount: selectors.length,
    actionCount: appContext.actionLabels.length,
    routes: appContext.routes.slice(0, 60),
    selectors,
    hasCredentials: Boolean(seedState?.credentials || (process.env.TEST_USERNAME && process.env.TEST_PASSWORD)),
    seedEntities: seedState?.entities?.map((e) => e.entityName) ?? [],
  });
}

async function handleGenerate(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: { instruction?: string; previousCode?: string };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  const instruction = (body.instruction ?? "").trim();
  if (!instruction) {
    return sendJson(res, 400, { error: "Please describe the test you want in plain English." });
  }

  try {
    const result = await authorTestFromNaturalLanguage({
      instruction,
      ctx: appContext,
      seedState: loadSeedState(),
      previousCode: body.previousCode,
    });
    sendJson(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: `Generation failed: ${msg}` });
  }
}

/**
 * Run the supplied spec, streaming Playwright output to the client as
 * newline-delimited JSON events, then a final parsed result.
 */
async function handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: { code?: string; autoHeal?: boolean; maxRounds?: number };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  let code = (body.code ?? "").trim();
  if (!code) {
    return sendJson(res, 400, { error: "No test code to run." });
  }
  const autoHeal = body.autoHeal !== false; // default on
  const maxRounds = Math.max(0, Math.min(body.maxRounds ?? MAX_HEAL_ROUNDS, 5));

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const emit = (event: unknown) => res.write(JSON.stringify(event) + "\n");

  // ── round 0: run as-authored ─────────────────────────────────────────────
  emit({ type: "status", message: "Launching Playwright…" });
  let result = await runSpecOnce(code, emit);

  let round = 0;
  // ── heal loop: while failing, fix → re-run, up to maxRounds ──────────────
  while (
    autoHeal &&
    round < maxRounds &&
    (result.status === "failed" || result.status === "timedout")
  ) {
    round++;
    const failingStep = result.steps.find((s) => s.error)?.title;
    const passedSteps = result.steps.filter((s) => !s.error).map((s) => s.title);
    emit({
      type: "heal",
      round,
      maxRounds,
      message: `Test failed — auto-healing (round ${round}/${maxRounds})…`,
      failingStep,
    });

    try {
      const healed = await healNlpSpec({
        code,
        errorMessage: result.error ?? "Test failed with no error message.",
        failingStep,
        passedSteps,
        ctx: appContext,
        seedState: loadSeedState(),
      });
      code = healed.code;
      emit({ type: "heal-fix", round, rootCause: healed.rootCause, code });
      emit({ type: "status", message: `Re-running (round ${round})…` });
      result = await runSpecOnce(code, emit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: "log", line: `heal error: ${msg}` });
      break;
    }
  }

  // Final result. `code` is the latest (possibly healed) spec so the UI can
  // update its code panel and use the healed version for future adaptations.
  emit({ type: "result", ...result, healRounds: round, code });
  res.end();
}

/**
 * Write the spec, run Playwright once, stream its output via `emit`, and resolve
 * with the parsed result when the process exits.
 */
function runSpecOnce(
  code: string,
  emit: (event: unknown) => void
): Promise<ParsedResult> {
  // Fresh spec dir each run so only this test executes.
  fs.rmSync(NLP_SPEC_DIR, { recursive: true, force: true });
  fs.mkdirSync(NLP_SPEC_DIR, { recursive: true });
  fs.writeFileSync(NLP_SPEC_FILE, code, "utf-8");
  if (fs.existsSync(NLP_RESULTS)) fs.unlinkSync(NLP_RESULTS);

  return new Promise((resolve) => {
    const proc = spawn("npx", ["playwright", "test", "--config", NLP_CONFIG], {
      cwd: TESTS_DIR,
      env: { ...process.env },
    });

    const onChunk = (buf: Buffer) => {
      for (const line of buf.toString("utf-8").split("\n")) {
        if (line.trim()) emit({ type: "log", line });
      }
    };
    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);

    proc.on("error", (err) => {
      emit({ type: "error", message: `Failed to start Playwright: ${err.message}` });
      resolve({ status: "unknown", title: "", durationMs: 0, steps: [] });
    });

    proc.on("close", () => resolve(parseNlpResults()));
  });
}

interface ParsedStep {
  title: string;
  durationMs: number;
  error?: string;
}
interface ParsedResult {
  status: "passed" | "failed" | "timedout" | "skipped" | "unknown";
  title: string;
  durationMs: number;
  error?: string;
  steps: ParsedStep[];
  screenshot?: string; // path relative to /api/artifact
}

function parseNlpResults(): ParsedResult {
  const empty: ParsedResult = { status: "unknown", title: "", durationMs: 0, steps: [] };
  if (!fs.existsSync(NLP_RESULTS)) return empty;

  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(NLP_RESULTS, "utf-8"));
  } catch {
    return empty;
  }

  // Walk suites → specs → tests → results[0]; we only ever run one test.
  const found: ParsedResult[] = [];
  const walk = (suites: any[]) => {
    for (const suite of suites ?? []) {
      if (suite.suites) walk(suite.suites);
      for (const spec of suite.specs ?? []) {
        const test = spec.tests?.[0];
        const r = test?.results?.[0];
        if (!r) continue;
        const rawStatus: string = r.status ?? "unknown";
        const status =
          rawStatus === "passed"
            ? "passed"
            : rawStatus === "skipped"
            ? "skipped"
            : rawStatus === "timedOut"
            ? "timedout"
            : rawStatus === "failed" || rawStatus === "interrupted"
            ? "failed"
            : "unknown";

        const steps: ParsedStep[] = flattenSteps(r.steps ?? []);
        const firstError = r.errors?.[0]?.message ?? r.error?.message;
        const screenshot = r.attachments?.find((a: any) => a.name === "screenshot")?.path;

        found.push({
          status: status as ParsedResult["status"],
          title: spec.title,
          durationMs: r.duration ?? 0,
          error: firstError ? stripAnsi(firstError) : undefined,
          steps,
          screenshot: screenshot ? toArtifactPath(screenshot) : undefined,
        });
      }
    }
  };
  walk(raw.suites ?? []);
  return found[0] ?? empty;
}

// Surface the user-meaningful test.step() entries with any error attached.
// Playwright's JSON reporter tags internal work with categories like "hook",
// "fixture", "pw:api", and "expect"; test.step() entries are tagged "test.step"
// — or, in some reporter versions, carry no category at all. We therefore keep
// steps whose category is "test.step" or absent, and drop the known-internal
// categories.
const INTERNAL_STEP_CATEGORIES = new Set(["hook", "fixture", "pw:api", "expect", "attach"]);

function flattenSteps(steps: any[]): ParsedStep[] {
  const out: ParsedStep[] = [];
  const visit = (list: any[]) => {
    for (const s of list ?? []) {
      const cat = s.category;
      const isUserStep = cat === "test.step" || cat == null;
      if (isUserStep && !INTERNAL_STEP_CATEGORIES.has(cat)) {
        out.push({
          title: s.title,
          durationMs: s.duration ?? 0,
          error: s.error?.message ? stripAnsi(s.error.message) : undefined,
        });
      } else if (s.steps) {
        // Only descend into internal steps to fish out nested user steps;
        // user steps are shown as-is without expanding their children.
        visit(s.steps);
      }
    }
  };
  visit(steps);
  return out;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "");
}

function toArtifactPath(absOrRel: string): string {
  // Store paths are absolute from Playwright; expose them relative to TESTS_DIR
  // so the /api/artifact handler can serve them safely.
  const abs = path.isAbsolute(absOrRel) ? absOrRel : path.join(TESTS_DIR, absOrRel);
  return path.relative(TESTS_DIR, abs);
}

function handleArtifact(res: http.ServerResponse, relPath: string): void {
  const abs = path.resolve(TESTS_DIR, relPath);
  // Prevent path traversal outside the tests directory.
  if (!abs.startsWith(TESTS_DIR) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(abs).pipe(res);
}

// ── Full-suite pipeline (tab 2) ───────────────────────────────────────────

// Pre-fill the config form with the values the server already has (from .env),
// so the user edits rather than retypes. Password included since this is a
// local-only dev tool bound to the user's own test account.
function handlePipelineDefaults(res: http.ServerResponse): void {
  const config: Record<string, string> = {};
  for (const key of ALLOWED_CONFIG_KEYS) config[key] = process.env[key] ?? "";
  sendJson(res, 200, {
    config,
    iterations: parseInt(process.env.MAX_FIX_ROUNDS ?? "3", 10),
    running: pipelineRunning,
  });
}

async function handlePipelineRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: { config?: Record<string, string>; iterations?: number; mode?: PipelineMode };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }

  if (pipelineRunning) {
    return sendJson(res, 409, { error: "A full-suite run is already in progress." });
  }

  const mode: PipelineMode = body.mode === "run" ? "run" : "generate";
  const config = body.config ?? {};
  // Minimal validation — the recon phase needs these to read the app source.
  const missing = ["BASE_URL", "APP_SOURCE_DIR", "APP_MODULES_DIR"].filter((k) => !config[k]?.trim());
  if (missing.length) {
    return sendJson(res, 400, { error: `Missing required field(s): ${missing.join(", ")}` });
  }
  // Run mode replays an existing plan — refuse if nothing has been generated yet.
  if (mode === "run" && !fs.existsSync(TEST_PLAN_FILE)) {
    return sendJson(res, 400, { error: "No generated test plan found — generate test cases first." });
  }
  const iterations = Math.max(0, Math.min(body.iterations ?? 3, 10));

  pipelineRunning = true;
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // Guard against writing to a socket that the client already closed.
  const emit = (event: unknown) => {
    try { if (!res.writableEnded) res.write(JSON.stringify(event) + "\n"); } catch { /* socket gone */ }
  };

  const controls: PipelineControls = {};
  activeControls = controls;
  let finished = false;
  // Kill the child process tree if the browser navigates away / closes the
  // stream mid-run. `res.on('close')` is the reliable client-disconnect signal
  // during a streaming response (req 'close' may fire once the body is read).
  res.on("close", () => { if (!finished) controls.abort?.(); });

  try {
    await runFullPipeline(config, iterations, emit, controls, mode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: "log", source: "agent", line: `Pipeline error: ${msg}` });
    emit({ type: "done", mode, agentExitCode: 1, hasReport: false });
  } finally {
    finished = true;
    pipelineRunning = false;
    activeControls = null;
    res.end();
  }
}

// ── pause / resume / stop / clean (out-of-band controls) ──────────────────────
function handlePipelinePause(res: http.ServerResponse): void {
  if (!activeControls) return sendJson(res, 409, { error: "No run in progress." });
  activeControls.pause?.();
  sendJson(res, 200, { paused: true });
}

function handlePipelineResume(res: http.ServerResponse): void {
  if (!activeControls) return sendJson(res, 409, { error: "No run in progress." });
  activeControls.resume?.();
  sendJson(res, 200, { paused: false });
}

function handlePipelineStop(res: http.ServerResponse): void {
  if (!activeControls) return sendJson(res, 200, { stopped: false });
  activeControls.abort?.();
  sendJson(res, 200, { stopped: true });
}

function handlePipelineClean(res: http.ServerResponse): void {
  if (pipelineRunning) {
    return sendJson(res, 409, { error: "Stop the current run before starting over." });
  }
  const removed = cleanGeneratedArtifacts();
  sendJson(res, 200, { removed });
}

// Save an edited generated spec back to disk so the next "Run test cases" uses
// the user's edits. Only existing *.spec.ts files under tests/generated/ may be
// written, and not while a run is in progress.
const GENERATED_DIR = path.join(__dirname, "../../tests", "generated");
async function handlePipelineSpecSave(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: { file?: string; code?: string };
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { error: "Invalid JSON body" });
  }
  if (pipelineRunning) {
    return sendJson(res, 409, { error: "Cannot edit a test case while a run is in progress." });
  }
  const code = body.code ?? "";
  const abs = path.resolve(path.join(__dirname, "../.."), body.file ?? "");
  if (!abs.startsWith(GENERATED_DIR + path.sep) || !abs.endsWith(".spec.ts")) {
    return sendJson(res, 400, { error: "Invalid spec path." });
  }
  if (!fs.existsSync(abs)) {
    return sendJson(res, 404, { error: "Spec file not found — regenerate first." });
  }
  try {
    fs.writeFileSync(abs, code, "utf-8");
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 500, { error: `Failed to save: ${err instanceof Error ? err.message : String(err)}` });
  }
}

// Serve the merged Playwright HTML report (index.html wrapper + tests.html +
// coverage.html + data/ assets) under /report/ so the "View report" button can
// open it same-origin (its iframes/asset paths are relative).
function serveReport(res: http.ServerResponse, urlPath: string): void {
  let rel = urlPath.replace(/^\/report\/?/, "");
  if (rel === "") rel = "index.html";
  const abs = path.resolve(REPORT_DIR, rel);
  if (!abs.startsWith(REPORT_DIR) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    if (!fs.existsSync(path.join(REPORT_DIR, "index.html"))) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" })
        .end("<h2>No report yet</h2><p>Run the test cases first — the HTML report is generated at the end of a run.</p>");
      return;
    }
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(abs).pipe(res);
}

function serveStatic(res: http.ServerResponse, urlPath: string): void {
  const file = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const abs = path.resolve(PUBLIC_DIR, file);
  if (!abs.startsWith(PUBLIC_DIR) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(abs).toLowerCase();
  // No-cache: this is a dev tool that ships UI updates frequently — never let
  // the browser serve a stale index.html (which would run outdated JS).
  res.writeHead(200, {
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  fs.createReadStream(abs).pipe(res);
}

// ── server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /api/context") return handleContext(res);
    if (route === "POST /api/generate") return void (await handleGenerate(req, res));
    if (route === "POST /api/run") return void (await handleRun(req, res));
    if (route === "GET /api/pipeline/defaults") return handlePipelineDefaults(res);
    if (route === "POST /api/pipeline/run") return void (await handlePipelineRun(req, res));
    if (route === "POST /api/pipeline/pause") return handlePipelinePause(res);
    if (route === "POST /api/pipeline/resume") return handlePipelineResume(res);
    if (route === "POST /api/pipeline/stop") return handlePipelineStop(res);
    if (route === "POST /api/pipeline/clean") return handlePipelineClean(res);
    if (route === "POST /api/pipeline/spec") return void (await handlePipelineSpecSave(req, res));
    if (route === "GET /api/artifact") return handleArtifact(res, url.searchParams.get("path") ?? "");

    if (req.method === "GET" && (url.pathname === "/report" || url.pathname.startsWith("/report/"))) {
      return serveReport(res, url.pathname);
    }

    if (req.method === "GET") return serveStatic(res, url.pathname);

    res.writeHead(405).end("Method not allowed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) sendJson(res, 500, { error: msg });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log("\n╔══════════════════════════════════════════════════╗");
  console.log("║      Natural-Language Test Authoring  ·  QA Agent  ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`\n  ▸ Open  http://localhost:${PORT}\n`);
  console.log(`  App under test: ${process.env.APP_NAME ?? appContext.baseUrl}`);
  console.log(`  Base URL:       ${appContext.baseUrl}\n`);
});
