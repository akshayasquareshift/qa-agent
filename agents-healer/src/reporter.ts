import * as fs from "fs";
import * as path from "path";
import type { SuiteResult, HealEvent } from "./types";

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function diffBlock(ev: HealEvent): string {
  return [
    `\x1b[31m- ${ev.oldLocator}\x1b[0m`,
    `\x1b[32m+ ${ev.newLocator}\x1b[0m`,
  ].join("\n");
}

export function printConsoleReport(result: SuiteResult): void {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(`Self-healing run: ${result.suiteName}`);
  console.log(line);
  console.log(`  Steps:    ${result.steps.length}`);
  console.log(`  Passed:   ${result.passed}`);
  console.log(`  Healed:   ${result.healed}  ← UI changed mid-run, agent recovered`);
  console.log(`  Failed:   ${result.failed}`);
  console.log(`  Duration: ${fmtMs(result.totalDurationMs)}`);

  if (result.healEvents.length === 0) {
    console.log(`\n  No healing needed — every locator matched as written.`);
    return;
  }

  let totalHealMs = 0;
  let totalManualMin = 0;
  console.log(`\n  Heal events:`);
  for (const ev of result.healEvents) {
    totalHealMs += ev.recoveryLatencyMs;
    totalManualMin += ev.manualFixMinutesEstimate;
    console.log(`\n  ▸ Step ${ev.stepIndex + 1}: ${ev.intent}`);
    console.log(`    action: ${ev.action}   confidence: ${ev.confidence}`);
    console.log(`    locator diff:`);
    console.log(diffBlock(ev).split("\n").map((l) => `      ${l}`).join("\n"));
    console.log(`    reasoning: ${ev.reasoning}`);
    if (ev.candidatesConsidered.length) {
      console.log(`    other candidates considered: ${ev.candidatesConsidered.join("  |  ")}`);
    }
    console.log(`    recovery: ${fmtMs(ev.recoveryLatencyMs)}  (LLM: ${fmtMs(ev.llmLatencyMs)})`);
  }

  const savedMin = totalManualMin - totalHealMs / 60_000;
  console.log(`\n${line}`);
  console.log(`  Time saved vs manual fix:`);
  console.log(`    Estimated manual triage+patch: ${totalManualMin} min  (${result.healEvents.length} × ${result.healEvents[0]?.manualFixMinutesEstimate} min)`);
  console.log(`    Agent recovery time:           ${fmtMs(totalHealMs)}`);
  console.log(`    Net saved:                     ~${savedMin.toFixed(1)} min`);
  console.log(line);
}

export function writeMarkdownReport(result: SuiteResult, outPath: string): void {
  const md: string[] = [];
  md.push(`# Self-Healing Run: ${result.suiteName}`);
  md.push("");
  md.push(`- Base URL: \`${result.baseUrl}\``);
  md.push(`- Started: ${result.startedAt}`);
  md.push(`- Duration: **${fmtMs(result.totalDurationMs)}**`);
  md.push("");
  md.push("| Steps | Passed | Healed | Failed |");
  md.push("| ----- | ------ | ------ | ------ |");
  md.push(`| ${result.steps.length} | ${result.passed} | **${result.healed}** | ${result.failed} |`);
  md.push("");

  if (result.healEvents.length > 0) {
    const totalHealMs = result.healEvents.reduce((s, e) => s + e.recoveryLatencyMs, 0);
    const totalManualMin = result.healEvents.reduce((s, e) => s + e.manualFixMinutesEstimate, 0);
    md.push(`## Maintenance tax avoided`);
    md.push("");
    md.push(`The agent recovered **${result.healEvents.length}** broken locator(s) mid-run.`);
    md.push("");
    md.push(`- Estimated manual fix cost: **${totalManualMin} min** (~${result.healEvents[0].manualFixMinutesEstimate} min per locator: triage → repro → edit → CI re-run)`);
    md.push(`- Agent recovery time: **${fmtMs(totalHealMs)}**`);
    md.push(`- **Net engineer time saved: ~${(totalManualMin - totalHealMs / 60_000).toFixed(1)} min**`);
    md.push("");

    md.push(`## Heal events`);
    md.push("");
    for (const ev of result.healEvents) {
      md.push(`### Step ${ev.stepIndex + 1} — ${ev.intent}`);
      md.push("");
      md.push(`**Action:** \`${ev.action}\` · **Confidence:** ${ev.confidence} · **Recovery:** ${fmtMs(ev.recoveryLatencyMs)} (LLM ${fmtMs(ev.llmLatencyMs)})`);
      md.push("");
      md.push("**Locator diff**");
      md.push("");
      md.push("```diff");
      md.push(`- ${ev.oldLocator}`);
      md.push(`+ ${ev.newLocator}`);
      md.push("```");
      md.push("");
      md.push(`**Agent reasoning:** ${ev.reasoning}`);
      md.push("");
      if (ev.candidatesConsidered.length) {
        md.push(`**Other candidates considered:**`);
        for (const c of ev.candidatesConsidered) md.push(`- \`${c}\``);
        md.push("");
      }
      md.push(`<details><summary>Playwright error before heal</summary>`);
      md.push("");
      md.push("```");
      md.push(ev.errorBeforeHeal);
      md.push("```");
      md.push("</details>");
      md.push("");
    }
  }

  md.push(`## All steps`);
  md.push("");
  md.push("| # | Action | Intent | Status | Locator (final) | Duration |");
  md.push("| - | ------ | ------ | ------ | --------------- | -------- |");
  for (const s of result.steps) {
    const icon = s.status === "passed" ? "✓" : s.status === "healed" ? "🩹" : "✗";
    md.push(
      `| ${s.stepIndex + 1} | ${s.action} | ${s.intent} | ${icon} ${s.status} | \`${s.finalLocator ?? "—"}\` | ${fmtMs(s.durationMs)} |`
    );
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md.join("\n") + "\n", "utf-8");
}

export function writeJsonReport(result: SuiteResult, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
}
