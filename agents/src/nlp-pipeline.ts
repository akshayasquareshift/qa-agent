import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Full-suite pipeline orchestration for the UI.
//
// Runs the EXACT `pnpm generate` flow (recon → auth → seed → plan → generate →
// run → fix loop → report) as a subprocess, with env injected from the UI form,
// AND runs the self-healing executor (@qa/healer) concurrently in the background.
//
// It tails both processes' stdout, parses the agent's human log into structured
// progress events (phases, per-test-case status, counts), and surfaces the final
// coverage + healing reports — so the browser shows a sophisticated live view
// instead of raw terminal noise.
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.join(__dirname, "../..");
const GENERATED_DIR = path.join(REPO_ROOT, "tests", "generated");
const TEST_PLAN_JSON = path.join(GENERATED_DIR, "test-plan.json");
const COVERAGE_JSON = path.join(GENERATED_DIR, "coverage-report.json");
const HEALING_DIR = path.join(GENERATED_DIR, "healing");
// Per-phase durations, persisted so the run-step report can show planning +
// generating times captured during the (separate) generate step. Survives a
// page refresh between the two steps.
const TIMINGS_FILE = path.join(GENERATED_DIR, ".pipeline-timings.json");

export type Emit = (event: unknown) => void;

export interface PipelineControls {
  /** Stop the run: kill the whole subprocess tree. */
  abort?: () => void;
  /** Suspend the run (SIGSTOP the process tree). */
  pause?: () => void;
  /** Resume a paused run (SIGCONT the process tree). */
  resume?: () => void;
  /** True while the run is suspended. */
  paused?: boolean;
}

// The ordered phases shown in the UI stepper. Each maps to a marker in the
// agent's log output (see phaseForLine). The two modes show different subsets:
// "generate" stops after spec generation; "run" begins at test execution.
type Phase = { key: string; label: string };

export const GENERATE_PHASES: Phase[] = [
  { key: "recon", label: "Reconnaissance" },
  { key: "auth", label: "Auth bootstrap" },
  { key: "seed", label: "Seed data" },
  { key: "plan", label: "Test planning" },
  { key: "gen", label: "Generating specs" },
];

export const RUN_PHASES: Phase[] = [
  { key: "run", label: "Running tests" },
  { key: "fix", label: "Self-healing & fixing" },
  { key: "report", label: "Final report" },
];

export type PipelineMode = "generate" | "run";

// Env keys the UI is allowed to set (everything else is inherited from the
// server process / .env). Keeps the browser from injecting arbitrary env.
export const ALLOWED_CONFIG_KEYS = [
  "BASE_URL",
  "APP_SOURCE_DIR",
  "APP_MODULES_DIR",
  "APP_PACKAGE_JSON",
  "COUNTRY_CODE",
  "SEED_DATA",
  "APP_NAME",
  "TEST_USERNAME",
  "TEST_PASSWORD",
  "FORCE_REGISTER",
  "ANTHROPIC_MODEL",
];

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function phaseForLine(line: string): string | null {
  if (/Reconnaissance/.test(line)) return "recon";
  if (/Auth bootstrap/.test(line)) return "auth";
  if (/Seed bootstrap/.test(line)) return "seed";
  if (/Planning —/.test(line) || /Planning -/.test(line)) return "plan";
  if (/Generating specs/.test(line)) return "gen";
  if (/initial run/.test(line)) return "run";
  if (/Fix round/.test(line)) return "fix";
  if (/Generating final report/.test(line)) return "report";
  return null;
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

// The automator writes specs as `<tcid-lowercase>-<slug>.spec.ts`. Find the file
// for a given TC id (e.g. "TC003" → tests/generated/tc003-....spec.ts).
function findSpecFile(id: string): string | null {
  if (!fs.existsSync(GENERATED_DIR)) return null;
  const prefix = `${id.toLowerCase()}-`;
  const match = fs
    .readdirSync(GENERATED_DIR)
    .find((f) => f.toLowerCase().startsWith(prefix) && f.endsWith(".spec.ts"));
  return match ? path.join(GENERATED_DIR, match) : null;
}

/**
 * "Start over" cleanup — narrow scope per product decision: delete generated
 * test cases (`*.spec.ts`), the test plan, and the run logs. Leaves prior
 * coverage / HTML reports until the next run overwrites them. Returns the
 * removed paths (relative to the repo root) for reporting back to the UI.
 */
export function cleanGeneratedArtifacts(): string[] {
  const removed: string[] = [];
  const rm = (p: string) => {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      removed.push(path.relative(REPO_ROOT, p));
    }
  };
  if (fs.existsSync(GENERATED_DIR)) {
    for (const f of fs.readdirSync(GENERATED_DIR)) {
      if (f.endsWith(".spec.ts")) rm(path.join(GENERATED_DIR, f));
    }
  }
  rm(TEST_PLAN_JSON);
  rm(TIMINGS_FILE);
  rm(path.join(GENERATED_DIR, "logs"));
  return removed;
}

/**
 * Run the full generate+heal pipeline, emitting structured progress events.
 * Resolves when both subprocesses have exited (or the run is aborted).
 */
export async function runFullPipeline(
  config: Record<string, string>,
  iterations: number,
  emit: Emit,
  controls: PipelineControls,
  mode: PipelineMode
): Promise<void> {
  const isRun = mode === "run";

  // ── clean stale artefacts (mode-aware) ────────────────────────────────────
  // generate: fresh plan + results. run: keep the plan/specs we're about to run,
  // only clear the previous run's outputs.
  if (fs.existsSync(COVERAGE_JSON)) fs.rmSync(COVERAGE_JSON, { force: true });
  if (fs.existsSync(HEALING_DIR)) fs.rmSync(HEALING_DIR, { recursive: true, force: true });
  if (!isRun && fs.existsSync(TEST_PLAN_JSON)) fs.rmSync(TEST_PLAN_JSON, { force: true });

  // ── assemble child env: server env + UI overrides + iteration count ───────
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ALLOWED_CONFIG_KEYS) {
    const v = config[key];
    if (v !== undefined && v !== "") childEnv[key] = String(v);
  }
  childEnv.MAX_FIX_ROUNDS = String(iterations);
  // Keep subprocess output uncoloured where possible so our parser is stable.
  childEnv.FORCE_COLOR = "0";

  emit({ type: "phases", phases: isRun ? RUN_PHASES : GENERATE_PHASES });
  emit({
    type: "log",
    source: "agent",
    line: isRun
      ? `Running the generated test suite (max ${iterations} fix/heal iteration(s) per failing test)…`
      : `Generating test cases…`,
  });

  // ── phase stepper state (+ per-phase timing) ────────────────────────────────
  const phaseOrder = (isRun ? RUN_PHASES : GENERATE_PHASES).map((p) => p.key);
  const phaseDone = new Set<string>(); // phases already marked done (dedupe)
  // Run keeps timings recorded during the generate step; generate starts fresh.
  const timings: Record<string, number> = isRun ? (readJsonSafe<Record<string, number>>(TIMINGS_FILE) ?? {}) : {};
  const saveTimings = () => { try { fs.writeFileSync(TIMINGS_FILE, JSON.stringify(timings)); } catch { /* noop */ } };
  saveTimings(); // reset (generate) or persist the loaded baseline (run)
  let currentPhase: string | null = null;
  let phaseStartMs = Date.now();
  let runPhaseStarted = false;
  const finishCurrentPhase = () => {
    if (currentPhase && !phaseDone.has(currentPhase)) {
      phaseDone.add(currentPhase);
      const ms = Date.now() - phaseStartMs;
      timings[currentPhase] = ms;
      saveTimings();
      emit({ type: "phase", key: currentPhase, state: "done", ms });
    }
  };
  const setPhase = (key: string) => {
    if (key === currentPhase) return;
    const targetIdx = phaseOrder.indexOf(key);
    if (targetIdx < 0) return; // phase not part of this mode's stepper — ignore
    // Close out the active phase with its elapsed time.
    finishCurrentPhase();
    // Mark any earlier phases the pipeline skipped done (once, no timing).
    for (let i = 0; i < targetIdx; i++) {
      if (!phaseDone.has(phaseOrder[i])) {
        phaseDone.add(phaseOrder[i]);
        emit({ type: "phase", key: phaseOrder[i], state: "done" });
      }
    }
    currentPhase = key;
    phaseStartMs = Date.now();
    emit({ type: "phase", key, state: "active" });
    if (key === "run" && !runPhaseStarted) {
      runPhaseStarted = true;
      emit({ type: "all-running" });
    }
  };

  // Emit the planned test-case table (from test-plan.json) once it exists.
  let planEmitted = false;
  const emitPlan = (initialStatus: string) => {
    if (planEmitted) return;
    const plan = readJsonSafe<{ testCases: Array<{ id: string; title: string; category: string; priority: string }> }>(TEST_PLAN_JSON);
    if (!plan?.testCases) return;
    planEmitted = true;
    emit({
      type: "testcases",
      cases: plan.testCases.map((tc) => ({
        id: tc.id,
        title: tc.title,
        category: tc.category,
        priority: tc.priority,
        status: initialStatus,
      })),
    });
  };

  // Read a generated spec file and stream its source to the UI's code viewer.
  const emitSpecCode = (id: string) => {
    const file = findSpecFile(id);
    if (!file) return;
    try {
      const code = fs.readFileSync(file, "utf-8");
      emit({ type: "tc-code", id, file: path.relative(REPO_ROOT, file), code });
    } catch { /* ignore unreadable spec */ }
  };

  const handleAgentLine = (raw: string) => {
    const line = stripAnsi(raw);
    if (!line.trim()) return;

    const ph = phaseForLine(line);
    if (ph) setPhase(ph);

    // test plan written → emit the planned test cases
    if (line.includes("test-plan.json") && /Saved/.test(line)) emitPlan("planned");

    // per-spec generation result:  [3/48] TC003: Title ...✓  (12.3s)
    const gen = line.match(/\[(\d+)\/(\d+)\]\s+(TC\d+):/);
    if (gen) {
      emitPlan("planned"); // ensure the table exists before we mutate rows
      const id = gen[3].toUpperCase();
      if (/✓/.test(line)) {
        emit({ type: "tc-status", id, status: "generated" });
        emitSpecCode(id); // stream the generated code to the UI
      } else if (/✗/.test(line)) {
        emit({ type: "tc-status", id, status: "gen-failed" });
      }
    }

    // Playwright list-reporter run result lines reference the spec file.
    if (line.includes(".spec.ts")) {
      const m = line.match(/tc(\d+)/i);
      if (m) {
        const id = "TC" + m[1];
        if (/✘|✗|✕|×/.test(line)) emit({ type: "tc-status", id, status: "failed" });
        else if (/✓/.test(line)) emit({ type: "tc-status", id, status: "passed" });
      }
    }

    emit({ type: "log", source: "agent", line });
  };

  // ── line-buffered stream splitter ─────────────────────────────────────────
  const makeLineHandler = (onLine: (l: string) => void) => {
    let buf = "";
    return (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    };
  };

  // ── run mode: pre-populate the table + code from the existing plan/specs ──
  // (run-only skips planning, so the agent's log won't re-announce the cases).
  if (isRun) {
    emitPlan("generated");
    const plan = readJsonSafe<{ testCases: Array<{ id: string }> }>(TEST_PLAN_JSON);
    for (const tc of plan?.testCases ?? []) emitSpecCode(tc.id);
  }

  // Each child is spawned `detached` so it leads its own process group; that
  // lets us signal/kill the WHOLE tree (pnpm → tsx → playwright/chromium),
  // not just the pnpm wrapper.
  const spawnOpts = { cwd: REPO_ROOT, env: childEnv, detached: true } as const;

  // ── spawn the agent: generate-only or run-only depending on mode ──────────
  const agentScript = isRun ? "generate:ui:run" : "generate:ui:generate";
  const agent: ChildProcess = spawn("pnpm", ["--filter", "@qa/agents", "run", agentScript], spawnOpts);
  agent.stdout?.on("data", makeLineHandler(handleAgentLine));
  agent.stderr?.on("data", makeLineHandler(handleAgentLine));

  // ── spawn the self-healing executor (run mode only; concurrent background) ─
  let healer: ChildProcess | null = null;
  if (isRun) {
    healer = spawn("pnpm", ["--filter", "@qa/healer", "run", "heal:ui"], spawnOpts);
    const healerOut = makeLineHandler((raw) => {
      const line = stripAnsi(raw);
      if (line.trim()) emit({ type: "log", source: "healer", line });
    });
    healer.stdout?.on("data", healerOut);
    healer.stderr?.on("data", healerOut);
  }

  // ── process-tree controls (pause/resume/stop) ─────────────────────────────
  const signalTree = (p: ChildProcess | null, sig: NodeJS.Signals) => {
    if (!p?.pid) return;
    try { process.kill(-p.pid, sig); } catch { /* group gone */ }
  };
  const killTree = (p: ChildProcess | null) => {
    if (!p?.pid) return;
    // Continue first in case the tree is SIGSTOP-paused, then terminate.
    try { process.kill(-p.pid, "SIGCONT"); } catch { /* noop */ }
    try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch { /* gone */ } }
  };
  controls.pause = () => {
    if (controls.paused) return;
    signalTree(agent, "SIGSTOP");
    signalTree(healer, "SIGSTOP");
    controls.paused = true;
    emit({ type: "paused" });
  };
  controls.resume = () => {
    if (!controls.paused) return;
    signalTree(agent, "SIGCONT");
    signalTree(healer, "SIGCONT");
    controls.paused = false;
    emit({ type: "resumed" });
  };
  controls.abort = () => {
    controls.paused = false;
    emit({ type: "stopped" });
    killTree(agent);
    killTree(healer);
  };

  // ── await the agent ───────────────────────────────────────────────────────
  const agentDone = new Promise<number>((resolve) => {
    agent.on("error", (err) => {
      emit({ type: "log", source: "agent", line: `agent failed to start: ${err.message}` });
      resolve(1);
    });
    agent.on("close", (code) => resolve(code ?? 0));
  });
  const healerDone = healer
    ? new Promise<number>((resolve) => {
        healer!.on("error", (err) => {
          emit({ type: "log", source: "healer", line: `healer failed to start: ${err.message}` });
          resolve(1);
        });
        healer!.on("close", (code) => resolve(code ?? 0));
      })
    : Promise.resolve(0);

  const agentCode = await agentDone;
  finishCurrentPhase();

  if (isRun) {
    // ── coverage report (run mode only — generate-only exits before running) ─
    const report = readJsonSafe<any>(COVERAGE_JSON);
    if (report) {
      for (const s of report.specs ?? []) {
        emit({ type: "tc-status", id: String(s.id).toUpperCase(), status: s.status });
      }
      // Authoritative per-step timings (merged generate + run), so the report
      // renders them without depending on accumulated client state.
      emit({ type: "report", report, timings });
    } else {
      emit({
        type: "log",
        source: "agent",
        line: `No coverage report produced (agent exited with code ${agentCode}). Check the log above.`,
      });
    }

    // ── healer reports ──────────────────────────────────────────────────────
    await healerDone;
    const healerSuites: any[] = [];
    if (fs.existsSync(HEALING_DIR)) {
      for (const f of fs.readdirSync(HEALING_DIR).filter((x) => x.endsWith(".json"))) {
        const data = readJsonSafe<any>(path.join(HEALING_DIR, f));
        if (data) healerSuites.push(data);
      }
    }
    emit({ type: "healer-report", suites: healerSuites });
    emit({ type: "done", mode, agentExitCode: agentCode, hasReport: Boolean(report) });
  } else {
    emit({ type: "done", mode, agentExitCode: agentCode, hasReport: false });
  }
}
