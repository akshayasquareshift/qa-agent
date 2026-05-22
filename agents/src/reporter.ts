import * as fs from "fs";
import * as path from "path";
import type {
  TestPlan,
  GeneratedSpec,
  CoverageReport,
  TestRunResult,
  TestFix,
  BugReport,
} from "./types";

const REPORTS_DIR = path.join(__dirname, "../../tests/generated");

export function generateCoverageReport(
  plan: TestPlan,
  specs: GeneratedSpec[],
  runResults: TestRunResult[],
  fixes: TestFix[],
  bugs: BugReport[],
  applicationName = "Application"
): CoverageReport {
  const byCategory: Record<string, { total: number; passed: number; failed: number }> = {};
  const byPriority: Record<string, { total: number; passed: number; failed: number }> = {};

  // Build lookup for final status of each spec
  const finalStatus = new Map<string, TestRunResult>();
  for (const r of runResults) {
    // Later round results override earlier ones
    const existing = finalStatus.get(r.specId);
    if (!existing || r.round > existing.round) {
      finalStatus.set(r.specId, r);
    }
  }

  const specRows = specs.map((s) => {
    const run = finalStatus.get(s.testCase.id);
    const status = run?.status ?? "skipped";
    const roundsNeeded = fixes.filter((f) => f.specId === s.testCase.id && f.applied).length;

    const cat = s.testCase.category;
    const pri = s.testCase.priority;

    if (!byCategory[cat]) byCategory[cat] = { total: 0, passed: 0, failed: 0 };
    if (!byPriority[pri]) byPriority[pri] = { total: 0, passed: 0, failed: 0 };

    byCategory[cat].total++;
    byPriority[pri].total++;

    if (status === "passed") {
      byCategory[cat].passed++;
      byPriority[pri].passed++;
    } else if (status === "failed" || status === "timedout") {
      byCategory[cat].failed++;
      byPriority[pri].failed++;
    }

    return {
      id: s.testCase.id,
      title: s.testCase.title,
      file: s.fileName,
      priority: s.testCase.priority,
      category: s.testCase.category,
      status,
      durationMs: run?.durationMs ?? 0,
      fixRoundsNeeded: roundsNeeded,
    };
  });

  const totalPassed = specRows.filter((r) => r.status === "passed").length;
  const totalFailed = specRows.filter((r) => r.status === "failed" || r.status === "timedout").length;
  const totalSkipped = specRows.filter((r) => r.status === "skipped").length;
  const passRate =
    specs.length > 0 ? `${Math.round((totalPassed / specs.length) * 100)}%` : "0%";

  const knownFailures = specRows
    .filter((r) => r.status === "failed" || r.status === "timedout")
    .map((r) => {
      const lastResult = finalStatus.get(r.id);
      const fix = fixes.filter((f) => f.specId === r.id).at(-1);
      return {
        specId: r.id,
        title: r.title,
        rootCause: fix?.rootCause ?? lastResult?.errorMessage ?? "Unknown",
        recommendedAction: fix?.explanation ?? "Manual investigation required",
      };
    });

  return {
    generatedAt: plan.generatedAt,
    applicationName,
    baseUrl: "",
    totalGenerated: specs.length,
    totalPassed,
    totalFailed,
    totalSkipped,
    passRate,
    byCategory,
    byPriority,
    skippedFlows: plan.skippedFlows,
    specs: specRows,
    bugsFound: bugs,
    fixLog: fixes,
    knownFailures,
  };
}

export function writeCoverageReport(report: CoverageReport): void {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(REPORTS_DIR, "coverage-report.json"),
    JSON.stringify(report, null, 2),
    "utf-8"
  );

  const md = buildMarkdown(report);
  fs.writeFileSync(path.join(REPORTS_DIR, "coverage-report.md"), md, "utf-8");

  console.log(`      Saved → tests/generated/coverage-report.md`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown builder
// ─────────────────────────────────────────────────────────────────────────────

function buildMarkdown(r: CoverageReport): string {
  const ts = new Date(r.generatedAt).toLocaleString();
  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────
  lines.push(
    `# QA Agent — Session Report`,
    "",
    `**Application:** ${r.applicationName}`,
    `**Generated:** ${ts}`,
    "",
    "## Executive Summary",
    "",
    `| Metric | Value |`,
    `| ------ | ----- |`,
    `| Tests generated | ${r.totalGenerated} |`,
    `| Tests passed | ${r.totalPassed} |`,
    `| Tests failed | ${r.totalFailed} |`,
    `| Tests skipped | ${r.totalSkipped} |`,
    `| Pass rate | **${r.passRate}** |`,
    `| Application bugs found | ${r.bugsFound.length} |`,
    `| Fix rounds applied | ${[...new Set(r.fixLog.map((f) => f.round))].length} |`,
    `| Specs needing fixes | ${[...new Set(r.fixLog.filter((f) => f.applied).map((f) => f.specId))].length} |`,
    "",
  );

  // ── Coverage by Category ─────────────────────────────────────────────────────
  lines.push(
    "## Coverage by Category",
    "",
    "| Category | Total | Passed | Failed |",
    "| -------- | ----- | ------ | ------ |",
  );
  for (const [cat, counts] of Object.entries(r.byCategory).sort()) {
    const icon = counts.failed > 0 ? "⚠" : "✓";
    lines.push(`| ${icon} ${cat} | ${counts.total} | ${counts.passed} | ${counts.failed} |`);
  }

  // ── Coverage by Priority ─────────────────────────────────────────────────────
  lines.push(
    "",
    "## Coverage by Priority",
    "",
    "| Priority | Total | Passed | Failed |",
    "| -------- | ----- | ------ | ------ |",
  );
  for (const pri of ["high", "medium", "low"]) {
    const counts = r.byPriority[pri];
    if (!counts) continue;
    const icon = counts.failed > 0 ? "⚠" : "✓";
    lines.push(`| ${icon} ${pri} | ${counts.total} | ${counts.passed} | ${counts.failed} |`);
  }

  // ── Full Test Results ────────────────────────────────────────────────────────
  lines.push(
    "",
    "## Test Results",
    "",
    "| ID | Title | Priority | Category | Status | Duration | Fixes |",
    "| -- | ----- | -------- | -------- | ------ | -------- | ----- |",
  );
  for (const s of r.specs) {
    const statusIcon =
      s.status === "passed" ? "✅ passed" :
      s.status === "failed" ? "❌ failed" :
      s.status === "timedout" ? "⏱ timeout" :
      "⏭ skipped";
    const dur = s.durationMs > 0 ? `${(s.durationMs / 1000).toFixed(1)}s` : "-";
    const fix = s.fixRoundsNeeded > 0 ? `${s.fixRoundsNeeded} fix(es)` : "-";
    lines.push(`| ${s.id} | ${s.title} | ${s.priority} | ${s.category} | ${statusIcon} | ${dur} | ${fix} |`);
  }

  // ── Application Bugs ─────────────────────────────────────────────────────────
  if (r.bugsFound.length > 0) {
    lines.push("", "## Application Bugs Found", "");
    lines.push(
      `The following bugs in the application source code were discovered during test execution.`,
      `These require **developer action** — the agent does not modify application source code.`,
      ""
    );
    for (const bug of r.bugsFound) {
      lines.push(
        `### ${bug.id}: ${bug.title}`,
        "",
        `**Severity:** ${bug.severity}`,
        `**File:** \`${bug.file}\``,
        `**Impacted tests:** ${bug.impactedTests.join(", ")}`,
        "",
        `**Description:** ${bug.description}`,
        "",
        `**Root cause:** ${bug.rootCause}`,
        "",
        `**Suggested fix (developer action required):** ${bug.suggestedFix}`,
        "",
      );
    }
  }

  // ── Fix Iteration Log ────────────────────────────────────────────────────────
  if (r.fixLog.length > 0) {
    lines.push("", "## Fix Iteration Log", "");
    lines.push(
      "All changes applied to spec files and application source during the fix rounds.",
      ""
    );

    const byRound = r.fixLog.reduce<Record<number, TestFix[]>>((acc, f) => {
      (acc[f.round] ??= []).push(f);
      return acc;
    }, {});

    for (const [round, fixes] of Object.entries(byRound).sort()) {
      lines.push(`### Round ${round}`);
      lines.push("");
      for (const fix of fixes) {
        const applied = fix.applied ? "✅ applied" : "⚠ not applied (no match)";
        lines.push(
          `**${fix.specId}** — ${fix.failureClass} — ${applied}`,
          "",
          `- Root cause: ${fix.rootCause}`,
          `- Fix target: ${fix.fixTarget}`,
          `- Explanation: ${fix.explanation}`,
          "",
        );
      }
    }
  }

  // ── Skipped Flows ────────────────────────────────────────────────────────────
  if (r.skippedFlows.length > 0) {
    lines.push("", "## Skipped Flows — Agent Decisions", "");
    lines.push(
      "The following flows were **explicitly excluded** from this test suite.",
      "Each has a specific technical reason and notes on what would enable it in future.",
      ""
    );
    for (const skip of r.skippedFlows) {
      lines.push(
        `### ${skip.flow}`,
        "",
        `**Reason:** ${skip.reason}`,
      );
      if (skip.enabledBy) {
        lines.push(`**To enable:** ${skip.enabledBy}`);
      }
      lines.push("");
    }
  }

  // ── Known Failures (still failing after all fix rounds) ────────────────────
  if (r.knownFailures.length > 0) {
    lines.push("", "## Known Failures (Not Resolved)", "");
    lines.push(
      `${r.knownFailures.length} test(s) remain failing after all fix rounds.`,
      ""
    );
    for (const kf of r.knownFailures) {
      lines.push(
        `### ${kf.specId}: ${kf.title}`,
        "",
        `**Root cause:** ${kf.rootCause}`,
        `**Recommended action:** ${kf.recommendedAction}`,
        "",
      );
    }
  }

  return lines.join("\n");
}
