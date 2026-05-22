import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import type {
  TestRunResult,
  TestFix,
  FailureClass,
  AppContext,
  BugReport,
} from "./types";

const client = new Anthropic();
const TESTS_DIR = path.join(__dirname, "../../tests/generated");
const MODULES_PATH = process.env.APP_MODULES_DIR ?? "";

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point — analyse a batch of failing tests and return fixes
// ─────────────────────────────────────────────────────────────────────────────

export async function analyseAndFix(
  failures: TestRunResult[],
  ctx: AppContext,
  round: number,
  learnings?: string
): Promise<{ fixes: TestFix[]; bugs: BugReport[] }> {
  const fixes: TestFix[] = [];
  const bugs: BugReport[] = [];
  let bugCounter = 1;
  const total = failures.length;

  console.log(`      Analysing ${total} failure(s) with AI...`);

  for (const [index, failure] of failures.entries()) {
    const position = `[${index + 1}/${total}]`;
    const errorPreview = (failure.errorMessage ?? "no error details").slice(0, 80);
    const classification = failure.failureClass ?? "UNKNOWN";

    console.log(`      ├─ ${position} ${failure.specId} (${classification})`);
    console.log(`      │     ${errorPreview}`);

    const specFile = findSpecFile(failure.specId);
    if (!specFile) {
      console.log(`      │  └─ ✗ spec file not found, skipping`);
      continue;
    }

    const specContent = fs.readFileSync(specFile, "utf-8");
    const sourceExcerpts = gatherSourceContext(failure, ctx);
    const screenshotSummary = summariseScreenshot(failure);

    const fix = await callFixer(
      failure,
      specContent,
      sourceExcerpts,
      screenshotSummary,
      round,
      learnings
    );

    console.log(`      │     root cause: ${fix.rootCause.slice(0, 90)}`);

    // Apply spec patches only — the agent never modifies application source code
    let applied = false;

    if (fix.specPatch) {
      const updated = specContent.replace(fix.specPatch.oldStr, fix.specPatch.newStr);
      if (updated !== specContent) {
        fs.writeFileSync(specFile, updated, "utf-8");
        applied = true;
        console.log(`      │  └─ ✓ spec patched`);
      } else {
        console.log(`      │  └─ ✗ spec patch could not be applied (old string not found)`);
      }
    }

    // Source fixes are NEVER applied — they are reported as bugs for developers to fix
    if (fix.sourceFix) {
      if (applied) {
        console.log(`      │     ⚠ app bug also identified: ${fix.sourceFix.file}`);
      } else {
        console.log(`      │  └─ ⚠ app bug: ${fix.sourceFix.file} (reported, not modified)`);
      }
    }

    if (!fix.specPatch && !fix.sourceFix) {
      console.log(`      │  └─ — no fix proposed`);
    }

    fix.applied = applied;
    fixes.push(fix);

    // Elevate SOURCE_BUG entries to BugReport — developers must fix these manually
    if (fix.failureClass === "SOURCE_BUG" && fix.sourceFix) {
      bugs.push({
        id: `BUG-${String(bugCounter++).padStart(3, "0")}`,
        title: `Application bug in ${path.basename(fix.sourceFix.file)}`,
        severity: failure.specId.match(/TC00[1-8]/) ? "high" : "medium",
        file: fix.sourceFix.file,
        description: fix.rootCause,
        impactedTests: [failure.specId],
        suggestedFix: fix.explanation,
        rootCause: fix.rootCause,
      });
    }
  }
  console.log(`      └─ done`);

  return { fixes, bugs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Call Claude to analyse a single failure and propose a fix
// ─────────────────────────────────────────────────────────────────────────────

async function callFixer(
  failure: TestRunResult,
  specContent: string,
  sourceExcerpts: string,
  screenshotSummary: string,
  round: number,
  learnings?: string
): Promise<TestFix> {
  const learningsSection = learnings
    ? `\n${learnings}\n`
    : "";

  const prompt = `You are a Playwright debugging expert.

## IMPORTANT CONSTRAINT
You must NEVER suggest changes to the application source code. Your role is:
1. Fix the test spec so it correctly tests what the application currently provides
2. If the application is genuinely broken (missing a required attribute, wrong behaviour), classify as SOURCE_BUG and describe the bug — the developer will fix it manually
3. For SOURCE_BUG: still provide a specPatch that gracefully handles the missing element (e.g. skip the broken assertion), so the test fails cleanly rather than throwing

## Failing Test
Spec ID: ${failure.specId}
Title: ${failure.title}
Status: ${failure.status}
Error: ${failure.errorMessage ?? "unknown"}
Failing line: ${failure.failingLine ?? "unknown"}
Initial classification: ${failure.failureClass ?? "UNKNOWN"}

## Screenshot
${screenshotSummary}

## Current Spec Content
\`\`\`typescript
${specContent}
\`\`\`

## Relevant Application Source
\`\`\`
${sourceExcerpts || "(none identified)"}
\`\`\`

## Error Stack
${failure.errorStack ?? "(none)"}
${learningsSection}
## Common failure patterns to check
- STRICT_MODE: locator resolves to N elements — scope to parent container
- TIMING: SSR streaming — wait for toBeEnabled() not just toBeVisible() before clicking
- STATE: server action POST never detected — use page.waitForResponse() pattern; or missing cart precondition
- URL_WRONG: checkout form uses ?step=address query param; parallel routes need soft-nav via link click
- SOURCE_BUG: component renders but data-testid attribute missing from inner element (not wrapper div)
- FLAKY: parallel test load — scope selectors more tightly, increase modal timeouts to 30s

## Your Task
Classify the root cause and provide the minimal spec fix.
- specPatch: exact old/new strings that are unique within the file (required for all fixes)
- sourceFix: DOCUMENTATION ONLY — file path + description of the app bug (never written to disk)
- Be minimal — only change what is necessary

Respond with ONLY a valid JSON object:
{
  "rootCause": "one sentence",
  "failureClass": "SELECTOR_STALE|STRICT_MODE|TIMING|STATE|URL_WRONG|SOURCE_BUG|FLAKY|UNKNOWN",
  "fixTarget": "spec|source|both",
  "specPatch": { "oldStr": "...", "newStr": "..." } | null,
  "sourceFix": { "file": "relative/path/from/repo/root.tsx", "oldStr": "existing code snippet", "newStr": "corrected code snippet" } | null,
  "explanation": "one sentence on the fix (for spec) or the required developer action (for source bugs)"
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: "You are a Playwright debugging expert. Respond ONLY with a valid JSON object. No markdown fences.",
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```\s*$/m, "")
    .trim();

  let parsed: {
    rootCause: string;
    failureClass: FailureClass;
    fixTarget: "spec" | "source" | "both";
    specPatch: { oldStr: string; newStr: string } | null;
    sourceFix: { file: string; oldStr: string; newStr: string } | null;
    explanation: string;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {
      rootCause: `Parse error on fixer response for ${failure.specId}`,
      failureClass: "UNKNOWN",
      fixTarget: "spec",
      specPatch: null,
      sourceFix: null,
      explanation: "Could not parse fixer response",
    };
  }

  return {
    specId: failure.specId,
    round,
    failureClass: parsed.failureClass ?? failure.failureClass ?? "UNKNOWN",
    rootCause: parsed.rootCause,
    fixTarget: parsed.fixTarget,
    specPatch: parsed.specPatch,
    sourceFix: parsed.sourceFix,
    explanation: parsed.explanation,
    applied: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function findSpecFile(specId: string): string | null {
  if (!fs.existsSync(TESTS_DIR)) return null;
  const files = fs.readdirSync(TESTS_DIR);
  const match = files.find((f) => f.toLowerCase().startsWith(specId.toLowerCase() + "-"));
  return match ? path.join(TESTS_DIR, match) : null;
}

/**
 * Heuristically gather relevant source file excerpts based on the error context.
 * Looks for selector names mentioned in the error and finds the source files that define them.
 */
function gatherSourceContext(failure: TestRunResult, ctx: AppContext): string {
  const errorText = (failure.errorMessage ?? "") + " " + (failure.errorStack ?? "");

  // Extract testid names mentioned in the error
  const testidMatches = errorText.match(/data-testid="([^"]+)"/g) ?? [];
  const testids = testidMatches.map((m) => m.replace(/data-testid="([^"]+)"/, "$1"));

  // Also look for locator patterns like locator('[data-testid="xxx"]')
  const locatorMatches = errorText.match(/\[data-testid="([^"]+)"\]/g) ?? [];
  locatorMatches.forEach((m) => {
    const id = m.match(/\[data-testid="([^"]+)"\]/)?.[1];
    if (id) testids.push(id);
  });

  if (testids.length === 0) return "";

  const excerpts: string[] = [];

  for (const testid of [...new Set(testids)]) {
    // Find which source file contains this testid
    const ownerModule = ctx.selectors.find((s) => s.testId === testid)?.context;
    if (!ownerModule || !MODULES_PATH) continue;

    const moduleDir = path.join(MODULES_PATH, ownerModule);
    if (!fs.existsSync(moduleDir)) continue;

    const sourceFiles = walkForTestid(moduleDir, testid);
    for (const file of sourceFiles.slice(0, 2)) {
      try {
        const content = fs.readFileSync(file, "utf-8");
        const lines = content.split("\n");
        const idx = lines.findIndex((l) => l.includes(`data-testid="${testid}"`));
        if (idx >= 0) {
          const start = Math.max(0, idx - 5);
          const end = Math.min(lines.length - 1, idx + 10);
          excerpts.push(
            `// ${path.relative(MODULES_PATH, file)} (lines ${start + 1}–${end + 1})\n` +
            lines.slice(start, end + 1).join("\n")
          );
        }
      } catch {
        // ignore read errors
      }
    }
  }

  return excerpts.join("\n\n---\n\n");
}

function walkForTestid(dir: string, testid: string): string[] {
  const matches: string[] = [];
  if (!fs.existsSync(dir)) return matches;
  for (const item of fs.readdirSync(dir)) {
    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) {
      matches.push(...walkForTestid(full, testid));
    } else if ((item.endsWith(".tsx") || item.endsWith(".ts")) && !item.includes("node_modules")) {
      try {
        const content = fs.readFileSync(full, "utf-8");
        if (content.includes(`data-testid="${testid}"`)) matches.push(full);
      } catch {
        // ignore
      }
    }
  }
  return matches;
}

function summariseScreenshot(failure: TestRunResult): string {
  if (!failure.screenshotPath || !fs.existsSync(failure.screenshotPath)) {
    return "(no screenshot available)";
  }
  // For now return the path — in a full implementation this could use Claude's vision API
  // to describe the screenshot and provide more context to the fixer
  return `Screenshot saved at: ${failure.screenshotPath}\n(Review manually for visual context)`;
}
