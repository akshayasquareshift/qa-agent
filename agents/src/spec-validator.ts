import * as fs from "fs";
import * as path from "path";
import { transformSync } from "esbuild";

// ─────────────────────────────────────────────────────────────────────────────
// Spec validation gate.
//
// Playwright compiles EVERY file in the test dir before running ANY test, so a
// single uncompilable spec (e.g. a truncated AI generation with no closing
// braces) aborts the whole suite — every test then reports "skipped". We parse
// each generated spec with esbuild first; broken ones can be regenerated or
// quarantined so the rest still run.
// ─────────────────────────────────────────────────────────────────────────────

// Quarantined specs go to a `_invalid/` dir that is a SIBLING of the test dir,
// NOT a subfolder of it — Playwright's default testMatch is recursive (`**`), so
// a subfolder inside `generated/` would still be collected and re-poison the run.
export const QUARANTINE_DIR = "_invalid";

/**
 * Syntax-check a spec's TypeScript source. Returns a one-line error message if it
 * fails to parse, or null if it's valid. esbuild does a real parse (the same
 * class of error Playwright's loader would hit), but is fast and in-process.
 */
export function validateSpecSyntax(code: string, fileName: string): string | null {
  try {
    transformSync(code, { loader: "ts", sourcefile: fileName });
    return null;
  } catch (err) {
    // esbuild throws with a structured `.errors` array (text + location). Prefer
    // it for a precise one-liner; fall back to the message's first useful line.
    const e = err as { errors?: Array<{ text?: string; location?: { line?: number; column?: number } }>; message?: string };
    const first = e.errors?.[0];
    if (first?.text) {
      const loc = first.location?.line != null ? ` (line ${first.location.line})` : "";
      return `${first.text}${loc}`;
    }
    const msg = e.message ?? String(err);
    return msg.split("\n").map((l) => l.trim()).find((l) => l && !/^Transform failed/.test(l)) ?? msg;
  }
}

/**
 * Move a broken spec OUT of the test dir into a sibling `_invalid/` folder (e.g.
 * tests/generated/x.spec.ts → tests/_invalid/x.spec.ts) so Playwright won't try
 * to compile it. Returns the new path.
 */
export function quarantineSpec(filePath: string): string {
  // ".." steps above the test dir so the quarantine folder is not itself scanned.
  const quarantineDir = path.join(path.dirname(filePath), "..", QUARANTINE_DIR);
  fs.mkdirSync(quarantineDir, { recursive: true });
  const dest = path.join(quarantineDir, path.basename(filePath));
  fs.renameSync(filePath, dest);
  return dest;
}
