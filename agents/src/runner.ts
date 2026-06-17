import * as fs from "fs";
import * as path from "path";
import { spawnTeed } from "./logger";
import type { TestRunResult, TestStatus, FailureClass } from "./types";

const TESTS_DIR = path.join(__dirname, "../../tests");
// Must match outputFile in tests/playwright.config.ts
const RESULTS_FILE = path.join(TESTS_DIR, "test-results", "results.json");

interface PlaywrightSuiteResult {
  suites: PlaywrightSuite[];
  stats: {
    expected: number;
    unexpected: number;
    skipped: number;
    duration: number;
  };
}

interface PlaywrightSuite {
  title: string;
  file: string;
  suites?: PlaywrightSuite[];
  specs?: PlaywrightSpec[];
}

interface PlaywrightSpec {
  id: string;
  title: string;
  ok: boolean;
  tests: PlaywrightTest[];
}

interface PlaywrightTestResult {
  status: string;
  duration: number;
  errors: Array<{ message: string; location?: { file: string; line: number } }>;
  attachments: Array<{ name: string; path?: string }>;
}

interface PlaywrightTest {
  // Playwright JSON reporter nests per-retry results under test.results[]
  results: PlaywrightTestResult[];
  // top-level status may also exist as an aggregate
  status?: string;
  duration?: number;
}

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  results: TestRunResult[];
}

/**
 * Run playwright tests (optionally filtered by grep pattern) and return structured results.
 * Uses playwright.config.ts reporters — list reporter streams live output; json reporter
 * writes structured results to test-results/results.json for programmatic parsing.
 */
export async function runPlaywright(
  round: number,
  grepPattern?: string
): Promise<RunSummary> {
  const resultsDir = path.join(TESTS_DIR, "test-results");
  fs.mkdirSync(resultsDir, { recursive: true });

  // Remove stale results file so we never silently read data from a previous run
  if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

  // Each round writes its blob into its own outputDir under `blob-store/`. The
  // blob store lives OUTSIDE `test-results/` because the `--output=test-results`
  // flag below makes Playwright wipe that directory at the start of every run,
  // which would destroy any prior-round blobs stored inside it. On round 0 we
  // wipe `blob-store/` and `blob-archive/` to start clean.
  const blobRoot = path.join(TESTS_DIR, "blob-store");
  const roundBlobDir = path.join(blobRoot, `round-${round}`);
  const archiveDir = path.join(TESTS_DIR, "blob-archive");
  if (round === 0) {
    if (fs.existsSync(blobRoot)) fs.rmSync(blobRoot, { recursive: true, force: true });
    if (fs.existsSync(archiveDir)) fs.rmSync(archiveDir, { recursive: true, force: true });
  }
  fs.mkdirSync(roundBlobDir, { recursive: true });
  fs.mkdirSync(archiveDir, { recursive: true });
  const blobName = `round-${round}.zip`;
  // Relative to TESTS_DIR (cwd of the child) — playwright.config.ts resolves it from there.
  const blobDirRel = path.join("blob-store", `round-${round}`);

  const args = [
    "playwright",
    "test",
    `--output=${resultsDir}`,
  ];

  if (grepPattern) {
    args.push(`--grep=${grepPattern}`);
  }

  const t0 = Date.now();
  await spawnTeed("npx", args, {
    cwd: TESTS_DIR,
    env: {
      ...process.env,
      QA_BLOB_DIR: blobDirRel,
      QA_BLOB_NAME: blobName,
    },
  });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n      ─── completed in ${elapsedSec}s ───`);

  if (!fs.existsSync(RESULTS_FILE)) {
    console.log("      Warning: results file not written — Playwright may have failed to start");
    return { passed: 0, failed: 0, skipped: 0, results: [] };
  }

  let raw: PlaywrightSuiteResult | null = null;
  try {
    raw = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf-8"));
  } catch {
    console.log("      Warning: could not parse results JSON");
  }

  if (!raw) {
    return { passed: 0, failed: 0, skipped: 0, results: [] };
  }

  const results: TestRunResult[] = [];
  collectResults(raw.suites, results, round);

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed" || r.status === "timedout").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return { passed, failed, skipped, results };
}

function collectResults(
  suites: PlaywrightSuite[],
  acc: TestRunResult[],
  round: number
): void {
  for (const suite of suites) {
    if (suite.suites) collectResults(suite.suites, acc, round);
    if (!suite.specs) continue;

    for (const spec of suite.specs) {
      const testObj = spec.tests[0];
      if (!testObj) continue;

      // Playwright JSON reporter nests per-attempt data under test.results[]
      const result = testObj.results?.[0];
      const rawStatus = result?.status ?? testObj.status ?? "failed";
      const status: TestStatus =
        rawStatus === "passed"
          ? "passed"
          : rawStatus === "skipped"
          ? "skipped"
          : rawStatus === "timedOut" || rawStatus === "timedout"
          ? "timedout"
          : "failed";

      const firstError = result?.errors?.[0];
      const errorMessage = firstError?.message?.split("\n")[0]?.trim();
      const failingLine = firstError?.location?.line;
      const screenshot = result?.attachments?.find((a) => a.name === "screenshot");

      // Extract TC ID from the spec title (e.g. "TC006 - User login with valid credentials")
      const idMatch = spec.title.match(/TC\d+/i);
      const specId = idMatch ? idMatch[0].toUpperCase() : spec.title.slice(0, 10);

      acc.push({
        specId,
        title: spec.title,
        status,
        durationMs: result?.duration ?? testObj.duration ?? 0,
        errorMessage,
        errorStack: firstError?.message,
        screenshotPath: screenshot?.path,
        failingLine,
        failureClass: status !== "passed" && status !== "skipped"
          ? classifyFailure(errorMessage ?? "", firstError?.message ?? "")
          : undefined,
        round,
      });
    }
  }
}

/**
 * Heuristic failure classification based on error message content.
 * The fixer can override this with a more precise classification after deeper analysis.
 */
function classifyFailure(line: string, stack: string): FailureClass {
  const text = (line + " " + stack).toLowerCase();

  if (text.includes("strict mode violation") || text.includes("resolved to")) {
    return "STRICT_MODE";
  }
  if (text.includes("timeout") && text.includes("waiting for locator")) {
    // Distinguish timing from URL issues by checking common patterns
    if (text.includes("404") || text.includes("not found")) return "URL_WRONG";
    return "TIMING";
  }
  if (text.includes("timeout") && text.includes("waiting for response")) {
    return "STATE"; // Server action never fired — likely precondition missing
  }
  if (text.includes("net::err") || text.includes("failed to navigate")) {
    return "URL_WRONG";
  }
  return "UNKNOWN";
}

/**
 * Return only the results that are still failing (for re-run filtering).
 */
export function failingIds(results: TestRunResult[]): string[] {
  return results
    .filter((r) => r.status === "failed" || r.status === "timedout")
    .map((r) => r.specId);
}

/**
 * Build a grep pattern that matches any of the given TC IDs.
 * e.g. ["TC006", "TC012"] → "TC006|TC012"
 */
export function buildGrepPattern(ids: string[]): string {
  return ids.join("|");
}

/**
 * Run a single tagged spec (by grep) and return whether it passed. Used for
 * one-off pre-flight specs (e.g. the auth smoke test) where we only need a
 * pass/fail verdict, not the full per-test result parsing.
 */
export async function runTaggedSpec(grep: string): Promise<boolean> {
  const resultsDir = path.join(TESTS_DIR, "test-results");
  fs.mkdirSync(resultsDir, { recursive: true });
  if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

  await spawnTeed("npx", ["playwright", "test", `--grep=${grep}`, `--output=${resultsDir}`], {
    cwd: TESTS_DIR,
  });

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

/**
 * Merge every per-round blob zip into one unified HTML report.
 *
 * Each round writes its blob into its own `blob-store/round-N/` directory (see
 * runPlaywright). Here we flatten them into `blob-archive/` and hand that to
 * `playwright merge-reports`.
 *
 *   - Round 0's blob has results for every generated spec
 *   - Each fix round's blob has results only for the previously-failing tests
 *   - merge-reports overlays later rounds onto earlier ones — for any test that
 *     appears in multiple rounds, the latest result wins
 *
 * Result: `tests/playwright-report/index.html` shows every test case from the
 * suite with its final status (and full failure details for anything still failing).
 * View it with `pnpm -C tests exec playwright show-report`.
 */
export async function mergeBlobReports(): Promise<void> {
  const blobRoot = path.join(TESTS_DIR, "blob-store");
  const archiveDir = path.join(TESTS_DIR, "blob-archive");
  fs.mkdirSync(archiveDir, { recursive: true });

  // Collect every round's blob into a flat archive directory for merge-reports.
  if (fs.existsSync(blobRoot)) {
    for (const entry of fs.readdirSync(blobRoot)) {
      const roundDir = path.join(blobRoot, entry);
      if (!fs.statSync(roundDir).isDirectory()) continue;
      for (const file of fs.readdirSync(roundDir)) {
        if (!file.endsWith(".zip")) continue;
        fs.copyFileSync(path.join(roundDir, file), path.join(archiveDir, file));
      }
    }
  }

  if (fs.readdirSync(archiveDir).filter((f) => f.endsWith(".zip")).length === 0) {
    console.log("      No blob reports found — skipping HTML merge.");
    return;
  }

  const reportDir = path.join(TESTS_DIR, "playwright-report");
  if (fs.existsSync(reportDir)) {
    fs.rmSync(reportDir, { recursive: true, force: true });
  }

  // PLAYWRIGHT_HTML_OPEN=never stops merge-reports from launching a static server
  // for the merged HTML report. Without it, Playwright sees failing tests in the
  // report and auto-serves on a local port, blocking the parent process forever —
  // which prevents wrapHtmlReportWithCoverageTab from ever running.
  const proc = await spawnTeed(
    "npx",
    ["playwright", "merge-reports", "blob-archive", "--reporter=html"],
    {
      cwd: TESTS_DIR,
      env: { ...process.env, PLAYWRIGHT_HTML_OPEN: "never" },
    },
  );

  if (proc.status !== 0) {
    console.log(`      Warning: merge-reports exited with code ${proc.status}.`);
  }
}
