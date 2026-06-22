import * as fs from "fs";
import * as path from "path";
import type {
  TestPlan,
  GeneratedSpec,
  CoverageReport,
  TestRunResult,
  TestStatus,
  TestFix,
  BugReport,
} from "./types";

const REPORTS_DIR = path.join(__dirname, "../../tests/generated");
const HTML_REPORT_DIR = path.join(__dirname, "../../tests/playwright-report");

export function generateCoverageReport(
  plan: TestPlan,
  specs: GeneratedSpec[],
  runResults: TestRunResult[],
  fixes: TestFix[],
  bugs: BugReport[],
  applicationName = "Application",
  // specId -> reason for specs that failed to compile and were quarantined (never run).
  invalidSpecs: Map<string, string> = new Map()
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
    const invalidReason = invalidSpecs.get(s.testCase.id);
    // A quarantined (uncompilable) spec is "invalid", not "skipped" — it never ran
    // because its source was broken, not because a precondition was unmet.
    const status: TestStatus = invalidReason ? "invalid" : (run?.status ?? "skipped");
    const reason = invalidReason;
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
      ...(reason ? { reason } : {}),
      durationMs: run?.durationMs ?? 0,
      fixRoundsNeeded: roundsNeeded,
    };
  });

  const totalPassed = specRows.filter((r) => r.status === "passed").length;
  const totalFailed = specRows.filter((r) => r.status === "failed" || r.status === "timedout").length;
  const totalSkipped = specRows.filter((r) => r.status === "skipped").length;
  const totalInvalid = specRows.filter((r) => r.status === "invalid").length;
  // Pass rate is over RUNNABLE specs — invalid (uncompilable) ones aren't counted
  // against the rate, so a generation glitch doesn't read as a test failure.
  const runnable = specs.length - totalInvalid;
  const passRate = runnable > 0 ? `${Math.round((totalPassed / runnable) * 100)}%` : "0%";

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
    totalInvalid,
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
    `| Invalid (failed to compile) | ${r.totalInvalid > 0 ? `⚠️ **${r.totalInvalid}** — quarantined; see below` : "0"} |`,
    `| Pass rate | **${r.passRate}**${r.totalInvalid > 0 ? ` (of ${r.totalGenerated - r.totalInvalid} runnable)` : ""} |`,
    `| Application bugs found | ${r.bugsFound.length > 0 ? `⚠️ **${r.bugsFound.length} — REVIEW REQUIRED** (see below)` : "0"} |`,
    `| UI changes detected | ${(() => { const n = new Set(r.fixLog.filter((f) => f.failureClass === "UI_CHANGE" && f.applied).map((f) => f.specId)).size; return n > 0 ? `🔧 **${n}** (see below)` : "0"; })()} |`,
    `| Fix rounds applied | ${[...new Set(r.fixLog.map((f) => f.round))].length} |`,
    `| Specs needing fixes | ${[...new Set(r.fixLog.filter((f) => f.applied).map((f) => f.specId))].length} |`,
    "",
  );

  // ── Application Bugs (surfaced near the top so they don't get buried) ───────
  if (r.bugsFound.length > 0) {
    const bySeverity: Record<string, number> = { high: 0, medium: 0, low: 0 };
    for (const b of r.bugsFound) bySeverity[b.severity] = (bySeverity[b.severity] ?? 0) + 1;
    const breakdown = (["high", "medium", "low"] as const)
      .filter((s) => bySeverity[s] > 0)
      .map((s) => `${bySeverity[s]} ${s}`)
      .join(", ");

    lines.push(
      `## ⚠️ Application Bugs Found — Manual Review Required`,
      "",
      `**${r.bugsFound.length} bug(s) detected in the application source code** (${breakdown}).`,
      "",
      `The agent does **not** modify application source. Each bug below was detected during test execution and is documented for a developer to review and fix manually. The affected tests have been patched to skip gracefully so they don't fail the run.`,
      "",
    );
    for (const bug of r.bugsFound) {
      const sevIcon = bug.severity === "high" ? "🔴" : bug.severity === "medium" ? "🟡" : "🟢";
      lines.push(
        `### ${sevIcon} ${bug.id}: ${bug.title}`,
        "",
        `| | |`,
        `| --- | --- |`,
        `| **Severity** | ${bug.severity} |`,
        `| **File** | \`${bug.file}\` |`,
        `| **Impacted tests** | ${bug.impactedTests.join(", ") || "—"} |`,
        "",
        `**Description:** ${bug.description}`,
        "",
        `**Root cause:** ${bug.rootCause}`,
        "",
        `**📌 Suggested fix (developer action required):** ${bug.suggestedFix}`,
        "",
        "---",
        "",
      );
    }
  }

  // ── Detected UI changes (deliberate app UI shifts the agent adapted to) ─────
  // Group by spec so multiple rounds on the same test collapse into one entry,
  // keeping the latest UI_CHANGE rootCause/explanation (which is usually the
  // most refined diagnosis).
  const uiChangesBySpec = new Map<string, TestFix>();
  for (const f of r.fixLog) {
    if (f.failureClass !== "UI_CHANGE" || !f.applied) continue;
    const existing = uiChangesBySpec.get(f.specId);
    if (!existing || f.round > existing.round) uiChangesBySpec.set(f.specId, f);
  }
  if (uiChangesBySpec.size > 0) {
    lines.push(
      `## 🔧 Detected UI Changes — Spec Auto-Adapted`,
      "",
      `**${uiChangesBySpec.size} test(s)** failed because the application's UI changed (text rename, label shift, markup reorder). The agent adapted the spec automatically — no developer action required, but these are surfaced so you can confirm the change was intentional.`,
      "",
      `| TC | Title | What changed | Patched in round |`,
      `| -- | ----- | ------------ | ---------------- |`,
    );
    const titleById = new Map(r.specs.map((s) => [s.id, s.title]));
    for (const fix of [...uiChangesBySpec.values()].sort((a, b) => a.specId.localeCompare(b.specId))) {
      const title = titleById.get(fix.specId) ?? fix.specId;
      const rootCause = fix.rootCause.replace(/\|/g, "\\|");
      lines.push(`| ${fix.specId} | ${title} | ${rootCause} | ${fix.round} |`);
    }
    lines.push("");
  }

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
      s.status === "invalid" ? "⚠️ invalid" :
      "⏭ skipped";
    const dur = s.durationMs > 0 ? `${(s.durationMs / 1000).toFixed(1)}s` : "-";
    const fix = s.fixRoundsNeeded > 0 ? `${s.fixRoundsNeeded} fix(es)` : "-";
    const title = s.reason ? `${s.title} — _${s.reason}_` : s.title;
    lines.push(`| ${s.id} | ${title} | ${s.priority} | ${s.category} | ${statusIcon} | ${dur} | ${fix} |`);
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

// ─────────────────────────────────────────────────────────────────────────────
// HTML wrapper — wraps the merged Playwright HTML report with a tabbed page
// that adds a "Coverage" tab showing the markdown coverage report (rendered).
//
// After mergeBlobReports() produces tests/playwright-report/index.html, call
// this function to:
//   1. Rename that index.html → tests.html
//   2. Render coverage-report.md as coverage.html
//   3. Write a new index.html with two tabs, each loading the corresponding
//      file in an iframe
//
// `pnpm -C tests exec playwright show-report` serves the dir over HTTP, so the
// iframes load fine same-origin.
// ─────────────────────────────────────────────────────────────────────────────

export function wrapHtmlReportWithCoverageTab(): void {
  const indexPath = path.join(HTML_REPORT_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    console.log("      No Playwright HTML report at tests/playwright-report/index.html — skipping wrap.");
    return;
  }

  const testsHtmlPath = path.join(HTML_REPORT_DIR, "tests.html");
  fs.renameSync(indexPath, testsHtmlPath);

  const mdPath = path.join(REPORTS_DIR, "coverage-report.md");
  let coverageBody = fs.existsSync(mdPath)
    ? markdownToHtml(fs.readFileSync(mdPath, "utf-8"))
    : "<p><em>coverage-report.md not found.</em></p>";

  // Wrap the "⚠️ Application Bugs Found" section in a styled callout div so it
  // visually pops against the rest of the report. Matches the h2 with the
  // warning emoji and everything up to (but not including) the next h2.
  coverageBody = coverageBody.replace(
    /(<h2>⚠️[\s\S]*?)(?=<h2>|$)/,
    '<div class="bugs-callout">$1</div>',
  );
  // Same treatment for the "🔧 Detected UI Changes" section, with a calmer
  // (informational, not alarming) palette since no dev action is required.
  coverageBody = coverageBody.replace(
    /(<h2>🔧[\s\S]*?)(?=<h2>|$)/,
    '<div class="ui-change-callout">$1</div>',
  );

  fs.writeFileSync(
    path.join(HTML_REPORT_DIR, "coverage.html"),
    coveragePage(coverageBody),
    "utf-8",
  );

  fs.writeFileSync(indexPath, wrapperPage(), "utf-8");
  console.log(`      Wrapped HTML report with Tests + Coverage tabs.`);
}

function wrapperPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>QA Agent — Run Report</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f7; color: #1d1d1f; }
  .tabs { display: flex; gap: 4px; padding: 12px 20px 0 20px; background: #fff; border-bottom: 1px solid #d2d2d7; }
  .tab { padding: 10px 18px; border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 14px; color: #515154; background: transparent; user-select: none; }
  .tab:hover { color: #1d1d1f; background: #f5f5f7; }
  .tab.active { background: #f5f5f7; color: #1d1d1f; border-color: #d2d2d7; font-weight: 600; position: relative; top: 1px; }
  .frame { width: 100%; height: calc(100vh - 49px); border: 0; display: none; background: #fff; }
  .frame.active { display: block; }
  .label { padding: 8px 16px 0 20px; font-size: 12px; color: #86868b; }
</style>
</head>
<body>
  <div class="tabs">
    <div class="tab active" data-tab="tests">Tests</div>
    <div class="tab" data-tab="coverage">Coverage</div>
    <div class="label" style="margin-left:auto; align-self:center;">QA Agent run report</div>
  </div>
  <iframe class="frame active" data-frame="tests" src="tests.html"></iframe>
  <iframe class="frame" data-frame="coverage" src="coverage.html"></iframe>
  <script>
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.frame').forEach(f => f.classList.toggle('active', f.dataset.frame === target));
      });
    });
  </script>
</body>
</html>`;
}

function coveragePage(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Coverage</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1100px; margin: 0 auto; padding: 32px 40px 80px; color: #1d1d1f; line-height: 1.55; }
  h1 { font-size: 28px; margin-top: 0; border-bottom: 1px solid #d2d2d7; padding-bottom: 12px; }
  h2 { font-size: 20px; margin-top: 36px; border-bottom: 1px solid #e5e5ea; padding-bottom: 6px; }
  h3 { font-size: 16px; margin-top: 28px; }
  table { border-collapse: collapse; margin: 14px 0 22px; font-size: 14px; }
  th, td { border: 1px solid #d2d2d7; padding: 8px 12px; text-align: left; }
  th { background: #f5f5f7; font-weight: 600; }
  tr:nth-child(even) td { background: #fafafa; }
  code { font-family: ui-monospace, "SF Mono", Menlo, monospace; background: #f0f0f2; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
  pre { background: #1d1d1f; color: #f5f5f7; padding: 14px 18px; border-radius: 6px; overflow-x: auto; font-size: 13px; line-height: 1.45; }
  pre code { background: transparent; color: inherit; padding: 0; }
  strong { font-weight: 600; }
  ul { padding-left: 24px; }
  li { margin: 4px 0; }
  hr { border: 0; border-top: 1px solid #d2d2d7; margin: 32px 0; }
  /* Bugs callout — wrapHtmlReportWithCoverageTab post-processes the rendered HTML
     to wrap the "⚠️ Application Bugs Found" section in a div with this class. */
  .bugs-callout { background: #fff8e1; border-left: 5px solid #f59f00; padding: 18px 26px 8px; margin: 28px 0; border-radius: 4px; }
  .bugs-callout h2 { color: #b22222; margin-top: 4px; border-bottom-color: #f5deb3; }
  .bugs-callout h3 { color: #8b0000; }
  .bugs-callout table th, .bugs-callout table td { background: #fff; }
  .bugs-callout p strong { color: #1d1d1f; }
  /* UI-change callout — informational (the agent already adapted), not alarming. */
  .ui-change-callout { background: #e7f1ff; border-left: 5px solid #1971c2; padding: 18px 26px 8px; margin: 28px 0; border-radius: 4px; }
  .ui-change-callout h2 { color: #0b3d91; margin-top: 4px; border-bottom-color: #c0d6ee; }
  .ui-change-callout table th, .ui-change-callout table td { background: #fff; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/**
 * Minimal markdown → HTML for the subset of features the coverage report uses:
 * #/##/### headers, pipe-tables, bullet lists, **bold**, `code`, ``` fenced
 * blocks ```, ---, and paragraphs. Intentionally limited — keeps the agent
 * dependency-free. If the coverage report ever uses richer markdown, swap in
 * the `marked` npm package.
 */
function markdownToHtml(md: string): string {
  const escape = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const inline = (s: string): string =>
    escape(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(escape(lines[i]));
        i++;
      }
      i++; // skip closing ```
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // Headers
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      out.push("<hr>");
      i++;
      continue;
    }

    // Table: a line of pipes followed by a separator row (---)
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*[-:|\s]+\|?\s*$/.test(lines[i + 1])) {
      const parseRow = (s: string): string[] =>
        s.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const headers = parseRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(parseRow(lines[i]));
        i++;
      }
      out.push("<table>");
      out.push("<thead><tr>" + headers.map((h) => `<th>${inline(h)}</th>`).join("") + "</tr></thead>");
      out.push("<tbody>");
      for (const r of rows) {
        out.push("<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
      }
      out.push("</tbody></table>");
      continue;
    }

    // Bulleted list
    if (/^\s*[-*]\s+/.test(line)) {
      out.push("<ul>");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        out.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push("</ul>");
      continue;
    }

    // Blank line → paragraph break
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — gather consecutive non-empty, non-special lines
    const paraBuf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("#") &&
      !lines[i].startsWith("```") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && /^\s*\|?\s*[-:|\s]+\|?\s*$/.test(lines[i + 1]))
    ) {
      paraBuf.push(lines[i]);
      i++;
    }
    out.push(`<p>${paraBuf.map(inline).join("<br>")}</p>`);
  }

  return out.join("\n");
}
