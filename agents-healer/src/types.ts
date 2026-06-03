// Shared types for the self-healing test execution agent.

export type ActionKind =
  | "goto"
  | "click"
  | "fill"
  | "select"
  | "check"
  | "press"
  | "expectVisible"
  | "expectText"
  | "expectUrl"
  | "wait";

export interface HealableStep {
  /** Human-readable intent — fed to the LLM to disambiguate when the locator breaks. */
  intent: string;
  action: ActionKind;
  /** CSS / Playwright locator string. Optional for `goto`, `wait`, `expectUrl`. */
  locator?: string;
  /** Value for `fill`, `select`, `press`, `expectText`, `expectUrl`. URL for `goto`. */
  value?: string;
  /** Tags help group/filter steps in reports. */
  tags?: string[];
}

export interface HealableSuite {
  name: string;
  baseUrl?: string;
  steps: HealableStep[];
}

export interface HealEvent {
  stepIndex: number;
  intent: string;
  action: ActionKind;
  oldLocator: string;
  newLocator: string;
  reasoning: string;
  confidence: "high" | "medium" | "low";
  candidatesConsidered: string[];
  errorBeforeHeal: string;
  llmLatencyMs: number;
  recoveryLatencyMs: number;
  /** Estimated minutes a human would spend triaging + patching this kind of failure. */
  manualFixMinutesEstimate: number;
}

export interface StepResult {
  stepIndex: number;
  intent: string;
  action: ActionKind;
  status: "passed" | "healed" | "failed";
  originalLocator?: string;
  finalLocator?: string;
  healEvent?: HealEvent;
  errorMessage?: string;
  durationMs: number;
}

export interface SuiteResult {
  suiteName: string;
  baseUrl: string;
  startedAt: string;
  totalDurationMs: number;
  steps: StepResult[];
  healEvents: HealEvent[];
  passed: number;
  healed: number;
  failed: number;
}
