import { chromium, Browser, Page, Locator } from "playwright";
import { resolveNewLocator } from "./healer";
import type { HealEvent, HealableStep, HealableSuite, StepResult, SuiteResult } from "./types";

// Per-step locator timeout. Kept tight on purpose: the faster we surface a
// failure, the faster the healer can recover. Default Playwright timeout (30s)
// would burn ~30s of wall-clock for every healed step.
const STEP_TIMEOUT_MS = 6_000;

// Rough industry estimate. Mid-level QA engineer averages 10–20 min to triage
// a flaky locator (open PR, repro locally, edit, re-run CI). We pick the
// midpoint to keep "time saved" claims defensible.
const MANUAL_FIX_MINUTES_PER_LOCATOR = 15;

function locatorFor(page: Page, selector: string): Locator {
  // Accept Playwright-style prefixes (role=, text=, etc.) verbatim; otherwise
  // hand the raw string to page.locator() which understands CSS and pierce/.
  return page.locator(selector);
}

async function performAction(
  page: Page,
  step: HealableStep,
  selector: string | undefined
): Promise<void> {
  const value = step.value ?? "";
  switch (step.action) {
    case "goto":
      await page.goto(value, { waitUntil: "domcontentloaded", timeout: STEP_TIMEOUT_MS * 3 });
      return;
    case "wait":
      await page.waitForTimeout(Number(value) || 500);
      return;
    case "expectUrl": {
      const current = page.url();
      if (!current.includes(value)) {
        throw new Error(`expectUrl: current url "${current}" does not include "${value}"`);
      }
      return;
    }
  }
  if (!selector) throw new Error(`Action ${step.action} requires a locator`);
  const loc = locatorFor(page, selector);
  switch (step.action) {
    case "click":
      await loc.click({ timeout: STEP_TIMEOUT_MS });
      return;
    case "fill":
      await loc.fill(value, { timeout: STEP_TIMEOUT_MS });
      return;
    case "select":
      await loc.selectOption(value, { timeout: STEP_TIMEOUT_MS });
      return;
    case "check":
      await loc.check({ timeout: STEP_TIMEOUT_MS });
      return;
    case "press":
      await loc.press(value, { timeout: STEP_TIMEOUT_MS });
      return;
    case "expectVisible":
      await loc.first().waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
      return;
    case "expectText": {
      const txt = await loc.first().innerText({ timeout: STEP_TIMEOUT_MS });
      if (!txt.includes(value)) {
        throw new Error(`expectText: "${txt.trim().slice(0, 80)}" does not include "${value}"`);
      }
      return;
    }
  }
}

function isLocatorFailure(err: Error, action: string): boolean {
  if (action === "goto" || action === "wait" || action === "expectUrl") return false;
  const msg = err.message;
  return (
    /Timeout .* exceeded/.test(msg) ||
    /waiting for locator/.test(msg) ||
    /strict mode violation/.test(msg) ||
    /element is not (visible|attached|enabled)/i.test(msg) ||
    /No node found/.test(msg) ||
    /resolved to (0|hidden)/.test(msg)
  );
}

export async function runSuite(
  suite: HealableSuite,
  opts: { headless?: boolean; onProgress?: (msg: string) => void } = {}
): Promise<SuiteResult> {
  const onProgress = opts.onProgress ?? (() => {});
  const startedAt = new Date().toISOString();
  const runStart = Date.now();

  const browser: Browser = await chromium.launch({ headless: opts.headless ?? true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const stepResults: StepResult[] = [];
  const healEvents: HealEvent[] = [];

  for (let i = 0; i < suite.steps.length; i++) {
    const step = suite.steps[i];
    const stepStart = Date.now();
    const label = `[${i + 1}/${suite.steps.length}] ${step.action.padEnd(13)} ${step.intent.slice(0, 60)}`;
    onProgress(`  ${label}`);

    // For goto with relative URL, prefix baseUrl.
    if (step.action === "goto" && suite.baseUrl && step.value && !/^https?:/i.test(step.value)) {
      step.value = new URL(step.value, suite.baseUrl).toString();
    }

    let finalLocator = step.locator;
    let status: StepResult["status"] = "passed";
    let healEvent: HealEvent | undefined;
    let errorMessage: string | undefined;

    try {
      await performAction(page, step, step.locator);
    } catch (err) {
      const e = err as Error;
      if (step.locator && isLocatorFailure(e, step.action)) {
        onProgress(`        ↳ locator failed → invoking healer (DOM reasoning)...`);
        const healStart = Date.now();
        try {
          const resolution = await resolveNewLocator({
            intent: step.intent,
            action: step.action,
            failingLocator: step.locator,
            errorMessage: e.message,
            page,
          });

          if (!resolution.newLocator) {
            status = "failed";
            errorMessage = `Healer could not propose a locator. ${resolution.reasoning}`;
            onProgress(`        ✗ healer gave up: ${resolution.reasoning.slice(0, 80)}`);
          } else {
            // Retry with the new locator.
            try {
              await performAction(page, step, resolution.newLocator);
              finalLocator = resolution.newLocator;
              status = "healed";
              healEvent = {
                stepIndex: i,
                intent: step.intent,
                action: step.action,
                oldLocator: step.locator,
                newLocator: resolution.newLocator,
                reasoning: resolution.reasoning,
                confidence: resolution.confidence,
                candidatesConsidered: resolution.candidatesConsidered,
                errorBeforeHeal: e.message.slice(0, 240),
                llmLatencyMs: resolution.llmLatencyMs,
                recoveryLatencyMs: Date.now() - healStart,
                manualFixMinutesEstimate: MANUAL_FIX_MINUTES_PER_LOCATOR,
              };
              healEvents.push(healEvent);
              onProgress(`        ✓ healed → ${resolution.newLocator}  (${resolution.confidence}, ${healEvent.recoveryLatencyMs}ms)`);
            } catch (retryErr) {
              status = "failed";
              errorMessage = `Heal candidate also failed: ${(retryErr as Error).message}`;
              onProgress(`        ✗ heal candidate did not work: ${(retryErr as Error).message.slice(0, 80)}`);
            }
          }
        } catch (healerErr) {
          status = "failed";
          errorMessage = `Healer error: ${(healerErr as Error).message}`;
          onProgress(`        ✗ healer crashed: ${(healerErr as Error).message.slice(0, 80)}`);
        }
      } else {
        status = "failed";
        errorMessage = e.message;
        onProgress(`        ✗ ${e.message.slice(0, 100)}`);
      }
    }

    stepResults.push({
      stepIndex: i,
      intent: step.intent,
      action: step.action,
      status,
      originalLocator: step.locator,
      finalLocator,
      healEvent,
      errorMessage,
      durationMs: Date.now() - stepStart,
    });

    // A failed step in a sequential E2E flow usually invalidates subsequent
    // steps (you can't fill a field after you fail to click into a modal).
    // Stop early — better signal in the report than a cascade of false fails.
    if (status === "failed") {
      onProgress(`  Aborting suite — step ${i + 1} failed and downstream steps depend on it.`);
      break;
    }
  }

  await context.close();
  await browser.close();

  const passed = stepResults.filter((r) => r.status === "passed").length;
  const healed = stepResults.filter((r) => r.status === "healed").length;
  const failed = stepResults.filter((r) => r.status === "failed").length;

  return {
    suiteName: suite.name,
    baseUrl: suite.baseUrl ?? "",
    startedAt,
    totalDurationMs: Date.now() - runStart,
    steps: stepResults,
    healEvents,
    passed,
    healed,
    failed,
  };
}
