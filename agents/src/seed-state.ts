import * as fs from "fs";
import * as path from "path";
import type { SeedState } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Read / write tests/.qa-seed-state.json
//
// This file is the contract between the Seed Bootstrap (Phase 1.6) and the
// downstream Automator + Fixer. It records:
//   - the credentials the auth bootstrap registered
//   - the marker strings that were baked into the create-* forms
//
// Every spec the Automator generates is shown this state and instructed to
// use it (e.g. "search /patients for the marker 'QA_Patient_xxx'") rather
// than skip with "no seed data". The Fixer follows the same rule when patching
// a failing spec.
// ─────────────────────────────────────────────────────────────────────────────

const STATE_FILE = path.join(__dirname, "../../tests/.qa-seed-state.json");

export function writeSeedState(state: SeedState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function loadSeedState(): SeedState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as SeedState;
  } catch {
    return null;
  }
}

export function clearSeedState(): void {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

/**
 * Format the seed state as a prompt-ready block for the Automator and Fixer.
 * Returns an empty string when no state is available — callers can drop it
 * into the prompt template unconditionally.
 */
export function formatSeedStateForPrompt(state: SeedState | null): string {
  if (!state) return "";

  const lines: string[] = [];
  lines.push("## Seeded Test Data — USE THIS, DO NOT SKIP");
  lines.push(
    "The agent has already populated the application with the records below.",
    "When a test needs an existing user, patient, order, or any record listed here,",
    "USE THE MARKER STRING below to look it up (search by exact match, find-by-name,",
    "etc. — the description hints how). Do NOT use test.skip() to bypass a precondition;",
    "the precondition is already satisfied.",
    "",
  );

  if (state.credentials) {
    lines.push("**Login credentials (already registered, use these for every test that requires auth):**");
    lines.push(`- username: \`${state.credentials.username}\``);
    lines.push(`- password: \`${state.credentials.password}\``);
    if (state.credentials.email) {
      lines.push(`- email:    \`${state.credentials.email}\``);
    }
    lines.push("");
  }

  if (state.entities.length > 0) {
    lines.push("**Seeded entities (one of each — already exists in the application database):**");
    lines.push("");
    lines.push("| Entity | Marker (exact string in the record) | How to look it up |");
    lines.push("| --- | --- | --- |");
    for (const e of state.entities) {
      lines.push(`| ${e.entityName} | \`${e.marker}\` | ${e.description} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
