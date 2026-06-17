import * as fs from "fs";
import * as path from "path";
import { readCodebaseContext } from "./codebase-reader";
import { bootstrapRegistration } from "./registrar";
import { bootstrapSeedData } from "./seeder";
import { loadSeedState } from "./seed-state";
import { runPlanner } from "./planner";
import { runAutomator } from "./automator";
import { runPlaywright, failingIds, buildGrepPattern, mergeBlobReports } from "./runner";
import { setupFileLogging, getLogFilePath } from "./logger";
import { analyseAndFix } from "./fixer";
import { generateCoverageReport, writeCoverageReport, wrapHtmlReportWithCoverageTab } from "./reporter";
import { loadLearnings, loadFixerLearnings, saveSessionLearnings } from "./learner";
import { checkSourceMatchesApp } from "./recon-check";
import { authSmokeTest } from "./auth-smoke";
import type { GeneratedSpec, TestRunResult, TestFix, BugReport } from "./types";

const GENERATED_DIR = path.join(__dirname, "../../tests/generated");
const PLAN_ONLY = process.argv.includes("--plan-only");
const GENERATE_ONLY = process.argv.includes("--generate-only");
const RUN_ONLY = process.argv.includes("--run-only"); // skip recon/plan/gen, just run+fix
const MAX_FIX_ROUNDS = parseInt(process.env.MAX_FIX_ROUNDS ?? "3", 10);
const APP_NAME = process.env.APP_NAME ?? "Application";

function elapsed(startMs: number): string {
  const sec = (Date.now() - startMs) / 1000;
  return sec < 60 ? `${sec.toFixed(1)}s` : `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function phase(step: string, label: string, startMs?: number) {
  const time = startMs !== undefined ? `  (${elapsed(startMs)})` : "";
  console.log(`\n${step} ${label}${time}`);
}

function banner(title: string) {
  const pad = Math.max(0, 50 - title.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log("╔══════════════════════════════════════════════════╗");
  console.log(`║${" ".repeat(left)}${title}${" ".repeat(right)}║`);
  console.log("╚══════════════════════════════════════════════════╝\n");
}

async function main() {
  // Tee terminal output to tests/generated/logs/run-<timestamp>.log. Must run
  // before any console output so the banner and every subsequent line are captured.
  const logFile = setupFileLogging();

  const sessionStart = Date.now();
  banner("Autonomous QA Agent");
  console.log(`  Log: ${logFile}\n`);

  // ── Phase 1: Reconnaissance ──────────────────────────────────────────────────
  let t = Date.now();
  phase("[1/7]", "Reconnaissance — reading codebase...");
  const ctx = readCodebaseContext();
  console.log(`      Framework:  ${ctx.framework} (${ctx.renderingModel})`);
  console.log(`      Routes:     ${ctx.routes.length}`);
  console.log(`      Selectors:  ${ctx.selectors.length} unique data-testid values`);
  console.log(`      Seed data:  ${ctx.seedData.length ? ctx.seedData.join(", ") : "(none)"}`);
  console.log(`      Base URL:   ${ctx.baseUrl}`);

  // Load accumulated learnings from previous sessions to inject into generation + fixing
  const specLearnings = loadLearnings();
  const fixerLearnings = loadFixerLearnings();
  const learningsPath = path.join(__dirname, "../learnings.json");
  const learningsCount = specLearnings
    ? (JSON.parse(require("fs").readFileSync(learningsPath, "utf-8")).learnings?.length ?? 0)
    : 0;
  console.log(`      Learnings:  ${learningsCount > 0 ? `${learningsCount} pattern(s) loaded from agents/learnings.json` : "none yet (first run)"}`);
  console.log(`      Done        (${elapsed(t)})`);

  // ── Phase 1.2: Source ↔ running-app sanity check (warn-only) ──────────────────
  // The whole suite's accuracy depends on the analysed source matching the app
  // at BASE_URL. Warn loudly (never block) if discovered routes 404 there.
  await checkSourceMatchesApp(ctx);

  // ── Phase 1.5: Auth Bootstrap ────────────────────────────────────────────────
  // If a register/signup route exists, create a real account and seed credentials
  // into .env so every downstream auth-required test runs against a known-good user.
  if (!RUN_ONLY) {
    t = Date.now();
    phase("[1.5/7]", "Auth bootstrap — checking for register/signup flow...");
    try {
      const reg = await bootstrapRegistration(ctx);
      if (!reg.attempted) {
        console.log(`      Skipped:    ${reg.reason}`);
      } else if (reg.success) {
        console.log(`      Registered: ${reg.username}  (${reg.email})`);
        console.log(`      Route:      ${reg.routePath}`);
        console.log(`      Seeded →    .env  (TEST_USERNAME, TEST_PASSWORD, TEST_EMAIL)`);
      } else {
        console.log(`      ⚠ Registration failed: ${reg.reason}`);
        console.log(`      Continuing with credentials currently in .env.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`      ⚠ Bootstrap error: ${msg}`);
      console.log(`      Continuing with credentials currently in .env.`);
    }
    console.log(`      Done        (${elapsed(t)})`);
  }

  // ── Phase 1.6: Seed Data Bootstrap ───────────────────────────────────────────
  // After auth, walk every create/new/add route once and populate the DB with
  // one record per entity so list / view / edit / search tests have data to act
  // on. This eliminates the "skipped — no seed data" cascade for downstream tests.
  if (!RUN_ONLY) {
    t = Date.now();
    phase("[1.6/7]", "Seed bootstrap — populating baseline DB records...");
    try {
      const seed = await bootstrapSeedData(ctx);
      if (!seed.attempted) {
        console.log(`      Skipped:    ${seed.reason}`);
      } else if (seed.success) {
        console.log(`      Result:     ${seed.reason}`);
      } else {
        console.log(`      ⚠ Seed failed: ${seed.reason}`);
        console.log(`      Tests that depend on seed data may skip with 'no seed data' reasons.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`      ⚠ Seed bootstrap error: ${msg}`);
    }
    console.log(`      Done        (${elapsed(t)})`);
  }

  // ── Phase 1.7: Auth smoke test ───────────────────────────────────────────────
  // Verify login works ONCE before generating the suite — a broken login cascades
  // to every auth-gated test. Warn-and-continue by default; STRICT_AUTH=true aborts.
  if (!RUN_ONLY) {
    t = Date.now();
    phase("[1.7/7]", "Auth smoke test — verifying login before generation...");
    try {
      const smoke = await authSmokeTest(ctx, loadSeedState());
      if (!smoke.attempted) {
        console.log(`      Skipped:    ${smoke.reason}`);
      } else if (smoke.success) {
        console.log(`      ✓ Login verified — auth-gated tests can rely on it.`);
      } else {
        console.log(`      ⚠ AUTH SMOKE TEST FAILED: ${smoke.reason}`);
        console.log(`      ⚠ Every auth-gated test will likely fail. Check the login route + credentials (TEST_USERNAME/TEST_PASSWORD).`);
        if ((process.env.STRICT_AUTH ?? "").toLowerCase() === "true") {
          console.log(`      STRICT_AUTH=true — aborting before generation.`);
          process.exit(1);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`      ⚠ Auth smoke test error: ${msg}`);
    }
    console.log(`      Done        (${elapsed(t)})`);
  }

  // ── Phase 2: Planning / load from disk ──────────────────────────────────────
  let plan: Awaited<ReturnType<typeof runPlanner>>;
  let specs: GeneratedSpec[];

  if (RUN_ONLY) {
    phase("[2/7]", "--run-only: loading existing test plan...");
    const planPath = path.join(GENERATED_DIR, "test-plan.json");
    if (!fs.existsSync(planPath)) {
      console.error("      ERROR: tests/generated/test-plan.json not found. Run without --run-only first.");
      process.exit(1);
    }
    plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
    const specFiles = fs.readdirSync(GENERATED_DIR).filter((f) => f.endsWith(".spec.ts"));
    const tcById = new Map(plan.testCases.map((tc) => [tc.id.toUpperCase(), tc]));
    specs = specFiles.map((fileName) => {
      const id = (fileName.match(/^(tc\d+)/i)?.[1] ?? "").toUpperCase();
      const filePath = path.join(GENERATED_DIR, fileName);
      const specContent = fs.readFileSync(filePath, "utf-8");
      return { testCase: tcById.get(id) ?? plan.testCases[0], specContent, fileName, filePath };
    });
    console.log(`      Test cases: ${plan.testCases.length}  |  Spec files on disk: ${specs.length}`);

    phase("[3/7]", "--run-only: skipping spec generation.");
  } else {
    // ── Phase 2: Planning ───────────────────────────────────────────────────────
    t = Date.now();
    phase("[2/7]", "Planning — mapping flows and generating test plan...");
    plan = await runPlanner(ctx);
    console.log(`      Test cases:    ${plan.testCases.length}`);
    console.log(`      Skipped flows: ${plan.skippedFlows.length}`);
    for (const pri of ["high", "medium", "low"]) {
      const n = plan.testCases.filter((tc) => tc.priority === pri).length;
      if (n) console.log(`        ${pri.padEnd(8)} ${n}`);
    }
    fs.mkdirSync(GENERATED_DIR, { recursive: true });
    fs.writeFileSync(path.join(GENERATED_DIR, "test-plan.json"), JSON.stringify(plan, null, 2), "utf-8");
    console.log(`      Saved → tests/generated/test-plan.json  (${elapsed(t)})`);

    if (PLAN_ONLY) { console.log("\n--plan-only flag set.\n"); process.exit(0); }

    // ── Phase 3: Spec generation ────────────────────────────────────────────────
    t = Date.now();
    phase("[3/7]", `Generating specs — ${plan.testCases.length} test cases...`);
    specs = [];
    const genErrors: Array<{ id: string; error: string }> = [];
    let genOk = 0;

    for (const [i, tc] of plan.testCases.entries()) {
      const counter = `[${i + 1}/${plan.testCases.length}]`;
      const label = `${tc.id}: ${tc.title}`.slice(0, 55).padEnd(56);
      process.stdout.write(`      ${counter} ${label}`);
      const specStart = Date.now();
      try {
        const spec = await runAutomator(tc, ctx, loadSeedState(), specLearnings);
        specs.push(spec);
        genOk++;
        console.log(`✓  (${elapsed(specStart)})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        genErrors.push({ id: tc.id, error: msg });
        console.log(`✗  ${msg.slice(0, 60)}`);
      }
    }

    console.log(`\n      Result: ${genOk}/${plan.testCases.length} specs generated  (${elapsed(t)})`);
    if (genErrors.length) {
      console.log(`      Errors (${genErrors.length}):`);
      for (const e of genErrors) console.log(`        - ${e.id}: ${e.error}`);
    }

    if (GENERATE_ONLY) { console.log("\n--generate-only flag set.\n"); process.exit(0); }
  }

  // ── Phase 4: Initial test run ────────────────────────────────────────────────
  t = Date.now();
  phase("[4/7]", `Running ${specs.length} tests — initial run...`);
  const allResults: TestRunResult[] = [];
  const allFixes: TestFix[] = [];
  const allBugs: BugReport[] = [];

  let runSummary = await runPlaywright(0);
  allResults.push(...runSummary.results);
  console.log(
    `      Initial result: ${runSummary.passed} passed  ${runSummary.failed} failed  ${runSummary.skipped} skipped  (${elapsed(t)})`
  );

  // ── Phase 5–7: Fix loop ──────────────────────────────────────────────────────
  let failing = failingIds(runSummary.results);
  let round = 1;

  while (failing.length > 0 && round <= MAX_FIX_ROUNDS) {
    t = Date.now();
    phase(
      `[${4 + round}/7]`,
      `Fix round ${round}/${MAX_FIX_ROUNDS} — analysing ${failing.length} failure(s)...`
    );
    console.log(`      Failing: ${failing.join(", ")}`);

    const failingResults = runSummary.results.filter(
      (r) => r.status === "failed" || r.status === "timedout"
    );

    const { fixes, bugs } = await analyseAndFix(failingResults, ctx, round, loadSeedState(), fixerLearnings);
    allFixes.push(...fixes);
    allBugs.push(...bugs);

    const appliedCount = fixes.filter((f) => f.applied).length;
    const bugCount = bugs.length;
    console.log(
      `      Analysis done  (${elapsed(t)}) — ${appliedCount}/${fixes.length} spec patches applied  ${bugCount > 0 ? `  ${bugCount} app bug(s) found` : ""}`
    );

    if (appliedCount === 0) {
      console.log("      No patches applied — stopping fix loop to avoid infinite retry.");
      break;
    }

    t = Date.now();
    console.log(`\n      Re-running ${failing.length} previously-failing test(s)...`);
    runSummary = await runPlaywright(round, buildGrepPattern(failing));

    const roundResults = runSummary.results.map((r) => ({ ...r, round }));
    allResults.push(...roundResults);
    for (const result of roundResults) {
      const fix = allFixes.filter((f) => f.specId === result.specId && f.round === round).at(-1);
      if (fix) fix.resultAfterFix = result.status;
    }

    const recovered = failing.length - runSummary.failed;
    console.log(
      `      Round ${round} result: ${runSummary.passed} passed  ${runSummary.failed} failed` +
      (recovered > 0 ? `  (+${recovered} recovered)` : "") +
      `  (${elapsed(t)})`
    );

    failing = failingIds(runSummary.results);
    round++;
  }

  if (failing.length > 0) {
    console.log(`\n      ⚠  ${failing.length} test(s) still failing after ${MAX_FIX_ROUNDS} fix round(s): ${failing.join(", ")}`);
  } else {
    console.log("\n      ✓ All tests passing.");
  }

  // ── Save learnings ───────────────────────────────────────────────────────────
  t = Date.now();
  console.log("\n      Extracting learnings for future sessions...");
  await saveSessionLearnings(allResults, allFixes, allBugs);

  // ── Phase 7: Report ──────────────────────────────────────────────────────────
  // Markdown / JSON coverage first — the HTML wrapper reads coverage-report.md.
  phase("[7/7]", "Generating final report...");
  const report = generateCoverageReport(plan, specs, allResults, allFixes, allBugs, APP_NAME);
  writeCoverageReport(report);

  // ── Merge per-round Playwright blobs + wrap with a Coverage tab ─────────────
  console.log("\n      Merging per-round Playwright blobs into a unified HTML report...");
  await mergeBlobReports();
  wrapHtmlReportWithCoverageTab();

  // ── Final summary ─────────────────────────────────────────────────────────────
  const totalTime = elapsed(sessionStart);
  banner("Final Summary");
  console.log(`  Application:     ${APP_NAME}`);
  console.log(`  Total time:      ${totalTime}`);
  console.log(`  Tests:           ${report.totalGenerated} generated  |  ${report.totalPassed} passed  |  ${report.totalFailed} failed`);
  console.log(`  Pass rate:       ${report.passRate}`);
  console.log(`  Fix rounds:      ${round - 1}`);
  console.log(`  App bugs found:  ${report.bugsFound.length}`);

  if (report.bugsFound.length) {
    console.log("\n  Application bugs (require developer action):");
    for (const bug of report.bugsFound) {
      console.log(`    ${bug.id} [${bug.severity}] ${bug.title}`);
      console.log(`           File: ${bug.file}`);
      console.log(`           Fix:  ${bug.suggestedFix.slice(0, 100)}`);
    }
  }

  console.log("\n  By category:");
  for (const [cat, counts] of Object.entries(report.byCategory).sort()) {
    const icon = counts.failed > 0 ? "⚠" : "✓";
    const bar = "█".repeat(counts.passed) + "░".repeat(counts.failed);
    console.log(`    ${icon} ${cat.padEnd(14)} ${String(counts.passed).padStart(2)}/${counts.total}  ${bar}`);
  }

  if (report.knownFailures.length > 0) {
    console.log("\n  Still failing:");
    for (const kf of report.knownFailures) {
      console.log(`    ✗ ${kf.specId}: ${kf.title}`);
      console.log(`        ${kf.rootCause.slice(0, 110)}`);
    }
  }

  console.log(`\n  Report:      tests/generated/coverage-report.md`);
  console.log(`  HTML report: tests/playwright-report/  (every test across every round; view with \`pnpm -C tests exec playwright show-report\`)`);
  console.log(`  Specs:       tests/generated/  (${specs.length} files)`);
  console.log(`  Run log:     ${getLogFilePath() ?? "(not set)"}\n`);

  process.exit(report.totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
