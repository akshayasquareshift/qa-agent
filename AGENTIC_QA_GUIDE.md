# Agentic QA — Complete Guide

> A shareable, self-contained guide to the Agentic QA system: what it does, how it's built,
> how it flows, and exactly how to set it up and run it. Hand this file to anyone who wants to
> try the agent — it covers everything from a clean machine to a green test suite.

---

## 1. What it is

**Agentic QA** points an AI agent at any running web application and autonomously **generates,
runs, self-heals, and reports** a Playwright end-to-end test suite — no test code written by
hand. It has three ways to use it:

1. **Autonomous full-suite QA** — discover the app → plan for maximum coverage → generate specs
   → run → auto-fix failures → report.
2. **Natural-language authoring** — a non-technical user types a test in plain English; the
   agent writes the Playwright code, runs it, and self-heals it.
3. **Self-healing executor** — keeps an existing suite green when the UI drifts (a button is
   renamed, a field moves) by re-deriving locators at runtime.

All three are usable from a **browser UI** (`pnpm author`) or the **command line**.

> **AI provider:** the agent calls Claude through the **Claude Code CLI** (`claude`), using your
> existing Claude Code login. **No API key is required** — calls run against your Claude
> Pro/Max subscription.

---

## 2. Use cases handled

### A. Autonomous full-suite QA
Aims for **maximum coverage** of the target app, not a token smoke test:

- Every **route / page** discovered from the source
- **CRUD** for each entity (create / view / edit / delete / list)
- **Authentication** (login, registration, logout, protected-route redirects)
- **Form validation** (required fields, format errors, empty submits)
- **Navigation** (menus, breadcrumbs, links)
- **Search / filter / sort / pagination**
- **Permission boundaries** (logged-out users blocked from private pages)
- **Happy paths *and* realistic failure modes** (invalid input, empty states, 404s)
- **Responsive layouts** where applicable

It also **finds real application bugs** (missing `data-testid`, broken server actions, etc.) and
flags them in the report — **without ever editing your app's source code**.

### B. Natural-language test authoring
A product owner / analyst types intent in plain English
(*"Verify a user who adds 3 items to the cart and removes 1 sees the correct total at
checkout"*), and the agent produces a runnable spec, executes it, shows a pass/fail step
timeline, **self-heals** on failure, and **adapts** when the instruction changes
(*"now apply a coupon code"*).

### C. Self-healing executor (UI-drift resilience)
Runs **intent-tagged** suites: each step declares a plain-language intent alongside its
locator. When a locator breaks, the agent captures the live DOM, asks Claude for a replacement
that satisfies the intent, retries, and records a before/after diff — so tests survive UI
churn instead of failing in CI.

---

## 3. Architecture

```
                         ┌─────────────────────────────────────────────┐
                         │            Browser UI  (pnpm author)         │
                         │     agents/public/index.html  ·  port 5180   │
                         │   ┌───────────────────┐ ┌──────────────────┐ │
                         │   │ Plain-English tab │ │ Full Suite tab   │ │
                         │   └───────────────────┘ └──────────────────┘ │
                         └───────────────┬─────────────────────────────┘
                                         │ HTTP (ndjson streaming)
                         ┌───────────────▼─────────────────────────────┐
                         │  nlp-server.ts  (zero-dependency HTTP server)│
                         │   ├─ nlp-authoring.ts  (NL → spec: fresh/    │
                         │   │                      adapt/heal)         │
                         │   └─ nlp-pipeline.ts   (spawns the CLI agent │
                         │                         + healer, streams    │
                         │                         structured progress) │
                         └───────────────┬─────────────────────────────┘
                                         │ spawns
            ┌────────────────────────────┴───────────────────────────────┐
            ▼                                                              ▼
┌──────────────────────────────┐                          ┌──────────────────────────────┐
│  @qa/agents   (generator)    │                          │  @qa/healer  (self-healing)  │
│  agents/src/                 │                          │  agents-healer/src/          │
│   index.ts      orchestrator │                          │   index.ts     suite runner  │
│   codebase-reader  discover  │                          │   executor.ts  step executor │
│   registrar     auth boot    │                          │   healer.ts    DOM reasoning │
│   seeder        seed data    │                          │   reporter.ts  heal report   │
│   planner       test plan    │                          │   suites/*.suite.ts          │
│   automator     write specs  │                          └──────────────────────────────┘
│   runner        run+parse    │
│   fixer         patch fails  │            All AI calls go through:
│   learner       learnings    │            ai-client.ts → `claude` CLI (no API key)
│   reporter      coverage rpt │
└──────────────┬───────────────┘
               │ writes / runs
               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  tests/                                                                │
│   generated/        tc*.spec.ts, test-plan.json, coverage-report.*,    │
│                     logs/, healing/                                    │
│   nlp-authored/     scratch spec for the Plain-English tab             │
│   playwright.config.ts        (autonomous suite)                       │
│   playwright.nlp.config.ts    (NL-authored tests)                      │
│   playwright-report/          merged HTML report                       │
└──────────────────────────────────────────────────────────────────────┘
```

| Component | Role |
| --------- | ---- |
| `@qa/agents` | The generator pipeline: discovery → plan → generate → run → fix → learn → report. |
| `@qa/healer` | Stage-2 executor that runs intent-tagged suites and self-heals broken locators. |
| `nlp-server.ts` | Zero-dependency HTTP server behind the browser UI. |
| `nlp-authoring.ts` | Plain English → Playwright spec (operations: **fresh**, **adapt**, **heal**). |
| `nlp-pipeline.ts` | Drives the Full Suite tab: spawns the CLI agent (`--generate-only`/`--run-only`) and the healer, parsing their output into live UI progress. |
| `agents/public/index.html` | The single-page UI (both tabs). |
| `ai-client.ts` | Shells out to the `claude` CLI for all model calls (no API key). |

**Monorepo:** a pnpm workspace with three packages — `agents`, `agents-healer`, `tests`.

---

## 4. Flow

### 4a. Autonomous pipeline (`pnpm generate` / Full Suite tab)

```
[1] Reconnaissance     read routes, data-testid selectors, clickable-element labels, framework
[1.5] Auth bootstrap   if a register route exists → create a fresh user, seed creds into .env
[1.6] Seed bootstrap   walk create/new/add routes → populate one record per entity
[2] Planning           Claude designs a prioritised, dependency-ordered test plan (max coverage)
[3] Generate           Claude writes one self-contained Playwright spec per test case
[4] Run                Playwright executes all specs; results parsed
[5..] Fix loop         Claude root-causes each failure, patches the spec, re-runs
       (repeats up to MAX_FIX_ROUNDS; never edits your app source)
[6] Learn              generalisable patterns saved to agents/learnings.json for next time
[7] Report             coverage-report.md/.json + merged HTML report; app bugs flagged
```

### 4b. Natural-language authoring (Plain-English tab)

```
plain-English instruction
   → generate spec (grounded in real routes / selectors / button labels)
   → run (live step timeline + screenshot on failure)
   → auto-heal loop (diagnose → rewrite → re-run, up to N rounds) if it fails
   → adapt (describe a change → minimal edit of the existing spec)
```

### 4c. Self-healing executor (`@qa/healer`)

```
load HealableSuite (each step = intent + locator)
   → execute step-by-step against the live app
   → on locator failure: capture trimmed DOM → ask Claude for a new locator that
     fulfils the intent → retry
   → step marked "healed" (with before/after diff + confidence) or "failed"
   → write console + Markdown + JSON heal report
```

---

## 5. Prerequisites

| Requirement | Notes |
| ----------- | ----- |
| **Node.js 18+** | |
| **pnpm 8+** | `npm i -g pnpm` |
| **Claude Code CLI** | Install from https://docs.claude.com/en/docs/claude-code/quickstart, then `claude login`. This is the agent's AI provider — **no API key needed**. |
| **Chromium** | Installed via `pnpm run install:browsers`. |
| **The app under test** | Must be running and reachable at `BASE_URL` before you run the agent. |

---

## 6. Setup (step by step)

```bash
# 1. Clone and install
git clone https://github.com/akshayasquareshift/qa-agent.git
cd qa-agent
pnpm install

# 2. Install Playwright's Chromium
pnpm run install:browsers

# 3. Log in to Claude Code (one time) — this is the AI provider, no API key required
claude login

# 4. Configure the app under test
cp .env.example .env
#   then edit .env (see the table below)

# 5. Start YOUR application in another terminal so it's live at BASE_URL
#    e.g. cd /path/to/your-app && npm run dev
```

### `.env` reference

| Variable | Required | Description |
| -------- | :------: | ----------- |
| `BASE_URL` | ✓ | URL of the running app — **local or cloud-hosted** (any `http`/`https` URL). |
| `APP_REPO_URL` | | GitHub URL of the app's source. **Set this to test an app whose code is on GitHub** — the agent shallow-clones it for you (no manual clone). Requires `git` on PATH. |
| `APP_REPO_BRANCH` | | Branch to fetch (default: the repo's default branch). |
| `APP_SOURCE_DIR` | ✓ | App's router/pages dir. **Absolute local path**, or — when `APP_REPO_URL` is set — a path **relative to the repo root** (e.g. `src/app`). |
| `APP_MODULES_DIR` | ✓ | Components dir — **scanned for `data-testid`s and button/link labels**. Absolute local path, or repo-relative when `APP_REPO_URL` is set (e.g. `src/modules` / `src/components`). |
| `APP_PACKAGE_JSON` | | App's `package.json` for framework detection (auto-detected if omitted). |
| `GITHUB_TOKEN` | | Only for **private** GitHub repos — injected into the clone URL. |
| `TEST_USERNAME` / `TEST_PASSWORD` | | Test-account creds. If your app has a register route, auth bootstrap creates a fresh user and overwrites these. |
| `FORCE_REGISTER` | | `true` → register a fresh user on every run. |
| `COUNTRY_CODE` | | Locale/URL prefix (e.g. `us`, `dk`). Leave empty if your app has no locale segment. |
| `SEED_DATA` | | Comma-separated record IDs/slugs already in your DB (any domain: products, patients, …). |
| `APP_NAME` | | Display name shown in the report. |
| `MAX_FIX_ROUNDS` | | Max AI fix/heal iterations per failing test (default `3`). |
| `ANTHROPIC_MODEL` | | Optional model override (e.g. `claude-opus-4-7`; aliases `opus`/`sonnet`/`haiku`). |
| `CLAUDE_BIN` | | Path to the `claude` binary if it isn't on `PATH`. |
| `NLP_PORT` | | Web-UI port (default `5180`). |
| `NLP_MAX_HEAL_ROUNDS` | | Auto-heal rounds in the Plain-English tab (default `3`). |

> **Auth is `claude login`, not an API key.** (An older note in `README.md` mentioning
> `ANTHROPIC_API_KEY` is out of date — ignore it.)

### Testing a cloud-hosted app whose source is on GitHub

The agent needs two things about the app: its **running URL** and its **source code** (to
discover routes, selectors, and button labels). Neither has to be local:

- **Running URL → just set `BASE_URL`** to the cloud URL (e.g. `https://app.example.com`).
  Any `http`/`https` URL works — no code change.
- **Source on GitHub → set `APP_REPO_URL`** and the agent **shallow-clones the repo for you**
  into a temp dir (you never run `git clone`). In this mode, `APP_SOURCE_DIR` and
  `APP_MODULES_DIR` are read **relative to the repo root**.

> Note: a GitHub URL in `APP_SOURCE_DIR` alone does **not** work — the agent reads source from
> a real path. `APP_REPO_URL` is what tells it to fetch the repo first.

Example `.env` for a **public** repo + cloud app:

```bash
BASE_URL=https://your-app.example.com          # the running cloud app
APP_REPO_URL=https://github.com/your-org/your-app
APP_REPO_BRANCH=main                           # optional
APP_SOURCE_DIR=src/app                          # repo-relative (not absolute)
APP_MODULES_DIR=src/modules                     # repo-relative
COUNTRY_CODE=                                   # set if your app has a locale prefix
```

Then run exactly as normal (`pnpm author` or `pnpm generate`). In the **Web UI**, the Full
Suite tab has **GitHub repo URL** + **Branch** fields — fill those and set the two dir fields
to repo-relative paths.

Notes & caveats:
- **`git` must be on PATH** (used for the shallow clone). Private repos: set `GITHUB_TOKEN`.
- **Use a dedicated test environment.** The agent may register a test user and seed records
  against `BASE_URL` (auth + seed bootstrap). Don't point it at production/shared data.
- **Public app + its own login** needs nothing extra. If the cloud app sits behind HTTP basic
  auth, a preview-deploy password, or SSO, that isn't handled yet (would need injected
  credentials/headers).
- Remote latency: if a remote app is slow, tests may need longer timeouts than the local
  defaults (60s/test). Raise `MAX_FIX_ROUNDS` won't help latency — re-run or adjust the
  Playwright timeout if you see timeouts.

---

## 7. Run it — Web UI (recommended)

```bash
pnpm author
```

Open the printed URL — **http://localhost:5180**. If the port is busy:

```bash
NLP_PORT=4100 pnpm author
```

> **Port note:** `5173` (Vite's default) is intentionally avoided. If you see a blank page or an
> **"Upgrade Required" (HTTP 426)**, another server is on the port — pick a free one via `NLP_PORT`.

The UI has **two tabs**:

### Tab 1 — Plain-English Authoring
1. **Describe** the test in plain English (or click an example chip).
2. **Generate test** — the agent writes a self-contained spec. You can **✎ Edit** it in place
   (Save / Cancel); the edited version is what runs.
3. **▶ Run test** — Playwright output streams live; you get a pass/fail badge, a ✓/✕ **step
   timeline**, duration, error, and a screenshot on failure.
4. **Auto-heal** (on by default) — on failure the agent diagnoses, rewrites the spec, and
   re-runs (up to 3 rounds); the result shows *"✦ self-healed in N rounds"* when it goes green.
5. **Adapt** — describe a change and the agent minimally edits the existing test.

### Tab 2 — Full Suite Generation
1. **Configure the app under test** — the form is pre-filled from your `.env`; edit inline.
   Values are used as overrides for this run (nothing is written back to `.env`).
2. **Choose iterations** — *fix/heal iterations per failing test* (maps to `MAX_FIX_ROUNDS`).
3. **① Generate test cases** — recon → auth → seed → plan → generate. Watch the **phase
   stepper** and a **test-case table** fill in (`planned → generated`). **Click any row** to
   view its Playwright code, where you can **✎ Edit** and **Save** (saved to disk, used by the
   next run).
4. **② Run test cases** — runs the suite + self-heal/fix loop; the `@qa/healer` executor runs
   concurrently in the background. Statuses go `running → passed/failed`; the **coverage
   report** renders with pass rate, per-category bars, app bugs, **per-step timings**, and a
   **View full HTML report** button.
5. **Run controls:** **⏸ Pause / ▶ Resume** (truly suspends/resumes the run), **↺ Start over**
   (stops the run, deletes old specs/plan/logs, resets to idle), and **Clear logs**. The
   detailed log accumulates across both steps.

---

## 8. Run it — CLI (power users)

```bash
# Full autonomous pipeline: recon → plan → generate → run → fix → learn → report
pnpm generate

# Self-healing executor (its bundled demo suite)
pnpm heal:demo
# or your own suites placed in agents-healer/suites/*.suite.ts
pnpm heal
```

Pipeline flags (run via the `agents` package):

| Command | Effect |
| ------- | ------ |
| `pnpm generate` | Full pipeline. |
| `pnpm --filter @qa/agents run plan-only` | Stop after planning (writes `test-plan.json`). |
| `pnpm --filter @qa/agents run generate-only` | Recon → plan → generate specs, then stop. |
| `pnpm --filter @qa/agents run run-only` | Skip discovery/plan/gen; run existing specs + fix loop. |

UI ↔ CLI mapping: **① Generate test cases** = `--generate-only`, **② Run test cases** =
`--run-only`, and **Pause/Resume/Start over** wrap the same subprocesses.

---

## 9. Outputs & reports

| File | What it is |
| ---- | ---------- |
| `tests/generated/test-plan.json` | Structured plan (TC IDs, titles, priorities, categories). |
| `tests/generated/tc*.spec.ts` | Generated Playwright specs (one per test case). |
| `tests/generated/coverage-report.md` / `.json` | Human- and machine-readable coverage + flagged app bugs. |
| `tests/playwright-report/` | Merged HTML report (every test, every fix round; screenshots/traces). |
| `tests/generated/logs/run-*.log` | Full terminal transcript per run. |
| `tests/generated/healing/*` | Self-healing reports (heal diffs, confidence, time saved). |
| `agents/learnings.json` | Accumulated patterns reused on future runs (**commit it**). |

View the rich report:

```bash
# From the UI: "View full HTML report" button (served at /report/)
# Or directly:
pnpm -C tests exec playwright show-report      # opens http://localhost:9323
cat tests/generated/coverage-report.md          # quick text summary
```

---

## 10. How key mechanisms work

- **Pre-flight checks (raise pass rate)** — before generating, the agent runs two guards:
  1. **Source ↔ app check** — samples discovered routes against `BASE_URL`; if most 404 it warns
     that `APP_SOURCE_DIR`/`APP_REPO_URL` may not match the running app (the #1 cause of mass
     failures). Warn-only; disable with `SKIP_RECON_CHECK=true`.
  2. **Auth smoke test** — generates and runs a single login spec to confirm auth works; a broken
     login otherwise fails every auth-gated test silently. Warn + continue by default; disable with
     `SKIP_AUTH_SMOKE=true`, or make it abort the run with `STRICT_AUTH=true`.
- **Baseline guidelines** — a built-in, app-agnostic set of best practices (modal/drawer scoping,
  portal/footer submit buttons, edit-affordance-first, no broad selector unions, wait-for-enabled,
  stable locators, seeded-data-for-lists, verified-login-first) is injected into every spec-gen and
  fix prompt — independent of the learned `learnings.json`.
- **Auth bootstrap** — if a register/signup route exists, the agent registers a fresh user,
  writes `TEST_USERNAME`/`TEST_PASSWORD`/`TEST_EMAIL` to `.env`, and every auth-required test
  uses it. Opt out by setting a real `TEST_USERNAME`; force re-registration with `FORCE_REGISTER=true`.
- **Self-learning** — after each run, generalisable patterns are saved to `agents/learnings.json`
  and injected into future generation/fix prompts, so the agent stops repeating mistakes.
- **Bug-reporting policy** — the agent **never edits your application source**. A genuine app
  bug is classified `SOURCE_BUG`, the spec is made to fail gracefully, and the bug is listed
  under **Application Bugs Found** in the report with a suggested fix.
- **Self-heal vs fix loop** — the *fix loop* (in the generator) patches a flaky/broken **spec**
  after a run; the *healer* re-derives a broken **locator** live, mid-run, from intent + DOM.

---

## 11. Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Blank page / **HTTP 426 "Upgrade Required"** at the UI | Another server owns the port — start with `NLP_PORT=4100 pnpm author`. |
| `results.json not written` / Playwright won't start | `pnpm run install:browsers`. |
| All tests time out immediately | Your app isn't running — start it and check `curl $BASE_URL` returns HTML. |
| Selector discovery returns **0 `data-testid`s** | `APP_MODULES_DIR` points at the wrong folder — set it where your components actually live (e.g. `src/modules`). |
| Framework detected as `unknown` | Set `APP_PACKAGE_JSON` to your app's `package.json`. |
| AI calls fail with "claude not found" | Install the Claude Code CLI and run `claude login`, or set `CLAUDE_BIN` to its path. |

---

## 12. Quick start (TL;DR)

```bash
git clone https://github.com/akshayasquareshift/qa-agent.git && cd qa-agent
pnpm install && pnpm run install:browsers
claude login                               # AI provider — no API key
cp .env.example .env                       # set BASE_URL, APP_SOURCE_DIR, APP_MODULES_DIR
# start your app so it's live at BASE_URL, then:
pnpm author                                # open http://localhost:5180
```

Then: **Full Suite tab → ① Generate test cases → ② Run test cases**, or the **Plain-English
tab** to author a single test from a sentence.

---

## 13. Sharing / exporting this guide

This file is plain Markdown — share it as-is (it renders on GitHub), or convert it:

- **VS Code:** the *Markdown PDF* extension → "Export (PDF)".
- **pandoc:** `pandoc AGENTIC_QA_GUIDE.md -o AGENTIC_QA_GUIDE.pdf`
- **HTML:** `pandoc AGENTIC_QA_GUIDE.md -s -o AGENTIC_QA_GUIDE.html`
