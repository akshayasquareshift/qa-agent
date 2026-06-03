// ─────────────────────────────────────────────────────────────────────────────
// Core context — populated by the codebase reader before anything else runs
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteInfo {
  urlPattern: string;
  displayUrl: string;
  description: string;
}

export interface SelectorInfo {
  testId: string;
  context: string; // module / component that owns this selector
}

export interface AppContext {
  framework: "nextjs-app-router" | "nextjs-pages" | "spa" | "unknown";
  renderingModel: "ssr-streaming" | "ssr-static" | "csr" | "unknown";
  routes: RouteInfo[];
  selectors: SelectorInfo[];
  seedData: string[]; // test records / seed slugs — domain-agnostic (set via SEED_DATA env var)
  baseUrl: string;
  countryCode: string; // locale prefix — empty string for non-locale apps
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow graph — identified in Phase 2 before test cases are written
// ─────────────────────────────────────────────────────────────────────────────

export type FlowCategory = string; // inferred from the app's domain by the planner

export interface AppFlow {
  id: string;           // e.g. "flow-auth-register"
  name: string;
  category: FlowCategory;
  description: string;
  dependsOn: string[];  // flow IDs that must be verified before this flow
  priority: Priority;
  skipped: boolean;
  skipReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test plan — output of Phase 2 (planner)
// ─────────────────────────────────────────────────────────────────────────────

export type Priority = "high" | "medium" | "low";

export interface TestCase {
  id: string;
  title: string;
  pageUrl: string;
  priority: Priority;
  category: FlowCategory;
  dependsOn: string[];    // TC IDs that must pass before this test can be meaningful
  rationale: string;
  stateSetup: string[];
  steps: string[];
  expectedOutcome: string;
  selectorsToUse: string[];
  requiresAuth: boolean;
}

export interface SkippedFlow {
  flow: string;
  reason: string;
  enabledBy?: string; // what infrastructure change would unlock this flow
}

export interface TestPlan {
  testCases: TestCase[];
  skippedFlows: SkippedFlow[];
  generatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Generated spec — output of Phase 3 (automator)
// ─────────────────────────────────────────────────────────────────────────────

export interface GeneratedSpec {
  testCase: TestCase;
  specContent: string;
  fileName: string;
  filePath: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test run results — output of Phase 4 (runner)
// ─────────────────────────────────────────────────────────────────────────────

export type TestStatus = "passed" | "failed" | "timedout" | "skipped";

export type FailureClass =
  | "SELECTOR_STALE"  // testid changed or never existed in source
  | "STRICT_MODE"     // locator resolves to > 1 element
  | "TIMING"          // element not visible within timeout (SSR race, slow load)
  | "STATE"           // wrong preconditions (e.g. missing auth, required data not set up)
  | "URL_WRONG"       // page not found, wrong step param, soft-nav required
  | "SOURCE_BUG"      // application code is missing attr or broken
  | "UI_CHANGE"       // app UI changed deliberately (text rename, markup shift) — spec adapted but worth surfacing
  | "FLAKY"           // passes alone, fails under parallel load
  | "UNKNOWN";

export interface TestRunResult {
  specId: string;
  title: string;
  status: TestStatus;
  durationMs: number;
  errorMessage?: string;
  errorStack?: string;
  screenshotPath?: string;
  failingLine?: number;
  failureClass?: FailureClass;
  round: number; // which fix round this result is from (0 = initial run)
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixes — output of Phase 5 (fixer)
// ─────────────────────────────────────────────────────────────────────────────

export interface SpecPatch {
  oldStr: string;
  newStr: string;
}

export interface SourceFix {
  file: string;    // relative path from repo root
  oldStr: string;
  newStr: string;
}

export interface TestFix {
  specId: string;
  round: number;
  failureClass: FailureClass;
  rootCause: string;
  fixTarget: "spec" | "source" | "both";
  specPatch: SpecPatch | null;
  sourceFix: SourceFix | null;
  explanation: string;
  applied: boolean;
  resultAfterFix?: TestStatus;
}

// ─────────────────────────────────────────────────────────────────────────────
// Application bugs — SOURCE_BUG entries elevated to bug reports
// ─────────────────────────────────────────────────────────────────────────────

export interface BugReport {
  id: string;           // e.g. "BUG-001"
  title: string;
  severity: "high" | "medium" | "low";
  file: string;
  description: string;
  impactedTests: string[];  // TC IDs that failed because of this bug
  suggestedFix: string;     // developer action required — NOT applied by the agent
  rootCause: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Seed state — entity markers + creds the seeder phase wrote to disk, so
// downstream specs (and the fixer) can reference seeded data instead of
// skipping for "no seed data" / "session not persisted" preconditions.
// File: tests/.qa-seed-state.json
// ─────────────────────────────────────────────────────────────────────────────

export interface SeedEntity {
  entityName: string;     // e.g. "patient", "appointment", "order"
  routePattern: string;   // e.g. "/patients/new"
  marker: string;         // unique identifier baked into the create form, e.g. "QA_Patient_1748284800"
  description: string;    // how a test should find this entity (e.g. "Search /patients list by exact name match")
}

export interface SeedState {
  generatedAt: string;
  credentials: {
    username: string;
    password: string;
    email?: string;
  } | null;
  entities: SeedEntity[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-learning — accumulated patterns from past sessions
// ─────────────────────────────────────────────────────────────────────────────

export type LearningCategory = "selector" | "flow" | "framework" | "timing" | "app-pattern";

export interface Learning {
  id: string;              // e.g. "L001"
  category: LearningCategory;
  title: string;           // short summary
  detail: string;          // full explanation
  specGuideline: string;   // what spec writers should do to avoid this
  fixerGuideline: string;  // what to check when a test fails with this pattern
  seenCount: number;
  firstSeen: string;       // ISO date
  lastSeen: string;
  sources: string[];       // TC IDs where this was observed
}

export interface LearningsStore {
  version: 1;
  updatedAt: string;
  learnings: Learning[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Coverage report — output of Phase 6 (reporter)
// ─────────────────────────────────────────────────────────────────────────────

export interface CoverageReport {
  generatedAt: string;
  applicationName: string;
  baseUrl: string;
  totalGenerated: number;
  totalPassed: number;
  totalFailed: number;
  totalSkipped: number;
  passRate: string; // e.g. "92%"
  byCategory: Record<string, { total: number; passed: number; failed: number }>;
  byPriority: Record<string, { total: number; passed: number; failed: number }>;
  skippedFlows: SkippedFlow[];
  specs: Array<{
    id: string;
    title: string;
    file: string;
    priority: string;
    category: string;
    status: TestStatus;
    durationMs: number;
    fixRoundsNeeded: number;
  }>;
  bugsFound: BugReport[];
  fixLog: TestFix[];
  knownFailures: Array<{
    specId: string;
    title: string;
    rootCause: string;
    recommendedAction: string;
  }>;
}
