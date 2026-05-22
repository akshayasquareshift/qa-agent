import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
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
export function runPlaywright(
  round: number,
  grepPattern?: string
): RunSummary {
  const resultsDir = path.join(TESTS_DIR, "test-results");
  fs.mkdirSync(resultsDir, { recursive: true });

  // Remove stale results file so we never silently read data from a previous run
  if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

  const args = [
    "playwright",
    "test",
    `--output=${resultsDir}`,
  ];

  if (grepPattern) {
    args.push(`--grep=${grepPattern}`);
  }

  // stdio:'inherit' lets the list reporter stream each test result live to the terminal.
  // JSON results are written to RESULTS_FILE by the json reporter in playwright.config.ts.
  const t0 = Date.now();
  spawnSync("npx", args, {
    cwd: TESTS_DIR,
    stdio: "inherit",
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

      // Extract TC ID from the spec title (e.g. "TC006 - Remove item from cart")
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
