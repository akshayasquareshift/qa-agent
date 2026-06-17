import * as fs from "fs";
import * as path from "path";
import { runSuite } from "./executor";
import { printConsoleReport, writeMarkdownReport, writeJsonReport } from "./reporter";
import type { HealableSuite } from "./types";

const ROOT = path.join(__dirname, "..");
const SUITES_DIR = path.join(ROOT, "suites");
const OUT_DIR = path.join(__dirname, "../../tests/generated/healing");

function banner(title: string) {
  const pad = Math.max(0, 50 - title.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log("╔══════════════════════════════════════════════════╗");
  console.log(`║${" ".repeat(left)}${title}${" ".repeat(right)}║`);
  console.log("╚══════════════════════════════════════════════════╝");
}

async function loadSuite(suitePath: string): Promise<HealableSuite> {
  if (suitePath.endsWith(".json")) {
    return JSON.parse(fs.readFileSync(suitePath, "utf-8")) as HealableSuite;
  }
  // .ts / .js — require it; expect `default` or `suite` export.
  const mod = require(suitePath);
  const suite = mod.default ?? mod.suite;
  if (!suite) throw new Error(`Suite file ${suitePath} must export 'default' or 'suite'`);
  return suite as HealableSuite;
}

function discoverSuites(): string[] {
  if (!fs.existsSync(SUITES_DIR)) return [];
  return fs
    .readdirSync(SUITES_DIR)
    .filter((f) => f.endsWith(".suite.ts") || f.endsWith(".suite.json"))
    .map((f) => path.join(SUITES_DIR, f));
}

async function main() {
  banner("Self-Healing Test Executor");
  const demo = process.argv.includes("--demo");
  const headless = !process.argv.includes("--headed");

  const explicit = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  let suitePaths: string[];

  if (explicit.length > 0) {
    suitePaths = explicit.map((p) => path.resolve(p));
  } else if (demo) {
    suitePaths = [path.join(SUITES_DIR, "demo.suite.ts")];
  } else {
    suitePaths = discoverSuites();
  }

  if (suitePaths.length === 0) {
    console.error("No suites found. Place files in agents-healer/suites/ or pass a path:");
    console.error("  pnpm --filter @qa/healer heal path/to/suite.ts");
    console.error("Or run the bundled demo:");
    console.error("  pnpm --filter @qa/healer heal:demo");
    process.exit(1);
  }

  console.log(`\nDiscovered ${suitePaths.length} suite(s):`);
  for (const s of suitePaths) console.log(`  - ${path.relative(process.cwd(), s)}`);
  console.log("");

  let totalHealed = 0;
  let totalFailed = 0;

  for (const sp of suitePaths) {
    const suite = await loadSuite(sp);
    console.log(`\n▶ Running suite: ${suite.name}`);
    console.log(`  Base URL: ${suite.baseUrl ?? "(none)"}`);
    console.log(`  Steps:    ${suite.steps.length}\n`);

    const result = await runSuite(suite, {
      headless,
      onProgress: (msg) => console.log(msg),
    });

    printConsoleReport(result);

    const slug = suite.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    writeMarkdownReport(result, path.join(OUT_DIR, `${slug}.md`));
    writeJsonReport(result, path.join(OUT_DIR, `${slug}.json`));
    console.log(`\n  Report: ${path.relative(process.cwd(), path.join(OUT_DIR, `${slug}.md`))}`);

    totalHealed += result.healed;
    totalFailed += result.failed;
  }

  banner("Done");
  console.log(`  Suites: ${suitePaths.length}  |  Healed steps: ${totalHealed}  |  Failed: ${totalFailed}`);
  console.log(`  Reports: ${path.relative(process.cwd(), OUT_DIR)}/\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFatal:", err);
  process.exit(1);
});
