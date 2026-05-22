import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import type { TestRunResult, TestFix, BugReport, Learning, LearningsStore } from "./types";

const LEARNINGS_FILE = path.join(__dirname, "../learnings.json");
const client = new Anthropic();

// ─────────────────────────────────────────────────────────────────────────────
// Read — format learnings for injection into prompts
// ─────────────────────────────────────────────────────────────────────────────

export function loadLearnings(): string {
  const store = loadStore();
  if (!store.learnings.length) return "";

  const lines = [
    "## Accumulated Learnings From Previous Sessions",
    "Apply these proven guidelines — they reflect real failures encountered across past runs.",
    "",
  ];

  for (const l of store.learnings) {
    const freq = l.seenCount > 1 ? ` (seen ${l.seenCount}× across sessions)` : "";
    lines.push(`**${l.id} — ${l.title}**${freq}`);
    lines.push(`> ${l.specGuideline}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function loadFixerLearnings(): string {
  const store = loadStore();
  if (!store.learnings.length) return "";

  const lines = [
    "## Known Failure Patterns From Previous Sessions",
    "",
  ];

  for (const l of store.learnings) {
    lines.push(`- **${l.title}**: ${l.fixerGuideline}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Write — extract and persist learnings after a session
// ─────────────────────────────────────────────────────────────────────────────

export async function saveSessionLearnings(
  allResults: TestRunResult[],
  fixes: TestFix[],
  bugs: BugReport[]
): Promise<void> {
  const appliedFixes = fixes.filter((f) => f.applied);
  const failures = allResults.filter(
    (r) => r.status === "failed" || r.status === "timedout"
  );

  if (appliedFixes.length === 0 && failures.length === 0) return;

  const fixSummaries = appliedFixes
    .map((f) => `${f.specId} [${f.failureClass}]: ${f.rootCause} → fix: ${f.explanation}`)
    .join("\n");

  const failureSummaries = failures
    .map((f) => `${f.specId}: ${f.errorMessage ?? "unknown error"}`)
    .join("\n");

  const bugSummaries = bugs
    .map((b) => `${b.id} in ${b.file}: ${b.rootCause}`)
    .join("\n");

  const prompt = `You are a QA automation expert. Extract generalizable learnings from this test session.

## Fixes That Were Applied (what was broken and how it was resolved)
${fixSummaries || "(no fixes applied)"}

## Tests Still Failing After All Fix Rounds
${failureSummaries || "(all tests passing)"}

## Application Bugs Found
${bugSummaries || "(none)"}

## Your Task
Extract 3-8 generalizable, reusable learnings. Each learning must apply beyond this specific app — it should be a pattern useful for any similar technology stack.

Focus on:
- Framework-specific gotchas (e.g. Next.js SSR streaming, server actions, parallel routes)
- Selector patterns that commonly fail (strict mode, wrong element scope)
- Flow prerequisites that tests often miss
- Timing patterns (when to use toBeEnabled vs toBeVisible, waitForResponse)

Do NOT include app-specific facts like specific product slugs, test user emails, or URL paths.

Return ONLY a valid JSON array. No markdown fences:
[
  {
    "category": "flow|selector|framework|timing|app-pattern",
    "title": "concise title under 10 words",
    "detail": "full explanation of the failure pattern",
    "specGuideline": "concrete instruction for spec writers to avoid this (2-3 sentences max)",
    "fixerGuideline": "what to check first when a test fails with this pattern (1-2 sentences)"
  }
]`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: "You are a QA automation expert. Respond ONLY with a valid JSON array. No markdown fences.",
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();

    const extracted: Array<Omit<Learning, "id" | "seenCount" | "firstSeen" | "lastSeen" | "sources">> =
      JSON.parse(raw);

    const store = loadStore();
    const today = new Date().toISOString().split("T")[0];
    const existingByTitle = new Map(store.learnings.map((l) => [l.title.toLowerCase(), l]));

    for (const nl of extracted) {
      const key = nl.title.toLowerCase();
      if (existingByTitle.has(key)) {
        const existing = existingByTitle.get(key)!;
        existing.seenCount++;
        existing.lastSeen = today;
        // Refresh with latest understanding
        existing.detail = nl.detail;
        existing.specGuideline = nl.specGuideline;
        existing.fixerGuideline = nl.fixerGuideline;
      } else {
        const id = `L${String(store.learnings.length + 1).padStart(3, "0")}`;
        const sources = appliedFixes
          .filter((f) =>
            f.rootCause.toLowerCase().includes(nl.title.split(" ").slice(0, 2).join(" ").toLowerCase())
          )
          .map((f) => f.specId);

        const learning: Learning = {
          id,
          ...nl,
          seenCount: 1,
          firstSeen: today,
          lastSeen: today,
          sources,
        };
        store.learnings.push(learning);
        existingByTitle.set(key, learning);
      }
    }

    // Reassign IDs sequentially to keep them stable
    store.learnings.forEach((l, i) => {
      l.id = `L${String(i + 1).padStart(3, "0")}`;
    });
    store.updatedAt = new Date().toISOString();

    fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(store, null, 2), "utf-8");
    console.log(
      `      Learnings saved → agents/learnings.json (${store.learnings.length} patterns stored)`
    );
  } catch (err) {
    console.log(
      `      [learner] Warning: could not save learnings — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function loadStore(): LearningsStore {
  if (!fs.existsSync(LEARNINGS_FILE)) {
    return { version: 1, updatedAt: new Date().toISOString(), learnings: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LEARNINGS_FILE, "utf-8"));
  } catch {
    return { version: 1, updatedAt: new Date().toISOString(), learnings: [] };
  }
}
