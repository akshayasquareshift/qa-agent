import type { Page } from "playwright";
import { askClaude, extractJson } from "./ai-client";
import type { ActionKind } from "./types";

// Maximum DOM snippet size sent to the LLM. Pages can easily be 500KB+ of
// markup; we trim to a budget that fits comfortably in context while still
// giving the model enough surrounding structure to reason about candidates.
const MAX_DOM_CHARS = 24_000;

export interface ResolveRequest {
  intent: string;
  action: ActionKind;
  failingLocator: string;
  errorMessage: string;
  page: Page;
}

export interface ResolveResponse {
  newLocator: string;
  reasoning: string;
  confidence: "high" | "medium" | "low";
  candidatesConsidered: string[];
  llmLatencyMs: number;
}

const SYSTEM = `You are a Playwright locator-healing assistant.

A test step has just failed because the locator no longer matches anything on the page.
The UI changed — a button may have been renamed, an element relocated, form fields reordered,
a data-testid removed, or a wrapper class renamed. The underlying intent of the test is still valid;
your job is to find the new element that fulfils that intent.

You are given:
  • the step's INTENT (what the user is trying to do)
  • the OLD LOCATOR that no longer works
  • the ERROR Playwright produced
  • a TRIMMED DOM snapshot of the current page

Return STRICT JSON of this shape, with no prose around it:
{
  "newLocator": "Playwright locator string that uniquely identifies the intended element",
  "reasoning": "1-2 sentence explanation of how you mapped intent → new element, citing visible attributes",
  "confidence": "high" | "medium" | "low",
  "candidatesConsidered": ["other plausible locators you ruled out"]
}

Locator rules:
  • Prefer data-testid, role+name, or visible text — in that order.
  • Output a single Playwright locator expression (e.g. \`[data-testid="submit-btn"]\`,
    \`role=button[name="Sign in"]\`, \`text=Continue\`, or a CSS selector).
  • The locator MUST resolve to exactly one element on the supplied DOM.
  • Do not invent attributes that aren't in the DOM.
  • If no plausible candidate exists, return newLocator="" and confidence="low" with the reason.`;

async function snapshotPage(page: Page): Promise<string> {
  try {
    // Strip <script>, <style>, comments, and noisy SVG paths so the model sees
    // structural markup, not bundled JS.
    const cleaned = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("script, style, noscript, svg path, link[rel=stylesheet]").forEach((n) => n.remove());
      // Drop most attributes except the ones useful for locator resolution.
      const keep = new Set([
        "id",
        "name",
        "class",
        "role",
        "type",
        "href",
        "aria-label",
        "aria-labelledby",
        "placeholder",
        "title",
        "value",
        "for",
      ]);
      const walk = (el: Element) => {
        for (const a of Array.from(el.attributes)) {
          if (a.name.startsWith("data-") || keep.has(a.name)) continue;
          el.removeAttribute(a.name);
        }
        for (const child of Array.from(el.children)) walk(child);
      };
      walk(clone);
      return clone.outerHTML;
    });
    if (cleaned.length <= MAX_DOM_CHARS) return cleaned;
    // Head + tail slice so structural context from both ends is preserved.
    const head = cleaned.slice(0, MAX_DOM_CHARS * 0.7);
    const tail = cleaned.slice(-MAX_DOM_CHARS * 0.3);
    return `${head}\n<!-- … ${cleaned.length - head.length - tail.length} chars trimmed … -->\n${tail}`;
  } catch (err) {
    return `<!-- snapshot failed: ${(err as Error).message} -->`;
  }
}

export async function resolveNewLocator(req: ResolveRequest): Promise<ResolveResponse> {
  const dom = await snapshotPage(req.page);
  const url = req.page.url();

  const prompt = `INTENT: ${req.intent}
ACTION: ${req.action}
OLD LOCATOR (failing): ${req.failingLocator}
PLAYWRIGHT ERROR: ${req.errorMessage.slice(0, 600)}
CURRENT URL: ${url}

TRIMMED DOM SNAPSHOT:
${dom}

Respond with the JSON object only.`;

  const t0 = Date.now();
  const raw = await askClaude({ system: SYSTEM, prompt });
  const llmLatencyMs = Date.now() - t0;

  const parsed = extractJson<{
    newLocator: string;
    reasoning: string;
    confidence?: "high" | "medium" | "low";
    candidatesConsidered?: string[];
  }>(raw);

  return {
    newLocator: parsed.newLocator ?? "",
    reasoning: parsed.reasoning ?? "(no reasoning returned)",
    confidence: parsed.confidence ?? "medium",
    candidatesConsidered: parsed.candidatesConsidered ?? [],
    llmLatencyMs,
  };
}
