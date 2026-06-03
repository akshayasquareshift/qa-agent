# Autonomous QA Agent

An AI-powered Playwright test generation, execution, and self-healing pipeline. Point it at any web application and it will:

**Core objective:** the agent aims for **maximum coverage** of the target application — every route, every entity's CRUD operations, happy paths *and* realistic failure modes, permission boundaries, form validation, navigation, search/filter/sort, and responsive layouts where applicable. It does not stop at a minimum quota.

1. **Discover** routes, `data-testid` selectors, and framework details from your source code
2. **Bootstrap auth** — if a register/signup flow exists, register a fresh user and seed the credentials into `.env` so every downstream auth-required test runs against a known-good account
3. **Bootstrap seed data** — walk every `/new`/`/create`/`/add` route and populate the DB with one record per entity, so list/view/edit/search tests find data to act on
4. **Plan** a full E2E test suite via Claude — prioritised by user flow and dependency order, sized for maximum coverage of the discovered surface area
5. **Generate** self-contained Playwright TypeScript spec files — one per test case
6. **Run** all tests with live terminal output
7. **Fix** failures automatically — AI root-cause analysis patches broken specs (never touches app source)
8. **Learn** — accumulates patterns in `agents/learnings.json` and reuses them on future runs
9. **Report** — produces a Markdown coverage report with any discovered application bugs prominently flagged for developer review

It also ships a **[Natural-Language Test Authoring UI](#natural-language-test-authoring-web-ui)** (`pnpm author`) — a browser tool where a non-technical user types a test in plain English, and the agent generates the Playwright code, runs it, and reports pass/fail.

---

## Prerequisites

| Requirement | Version |
| ----------- | ------- |
| Node.js | 18+ |
| pnpm | 8+ |
| Chromium | installed via `pnpm run install:browsers` |

---

## Installation

```bash
# Clone the repo
git clone https://github.com/YOUR_ORG/qa-agent.git
cd qa-agent

# Install all workspace dependencies
pnpm install

# Install Playwright's Chromium browser
pnpm run install:browsers
```

---

## Configuration

Copy the example env file and fill in the values for your application:

```bash
cp .env.example .env
```

### Required variables

| Variable | Description |
| -------- | ----------- |
| `ANTHROPIC_API_KEY` | Your Anthropic API key (`sk-ant-...`) |
| `APP_SOURCE_DIR` | Absolute path to the app router / pages directory |
| `APP_MODULES_DIR` | Absolute path to the components directory (scanned for `data-testid` attributes) |

### Optional variables

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `BASE_URL` | `http://localhost:3000` | URL of the running application |
| `COUNTRY_CODE` | _(empty)_ | Locale prefix used in URLs — e.g. `us`, `gb`. Leave empty if your app has no locale segment |
| `PRODUCT_HANDLES` | _(none)_ | Comma-separated item slugs seeded in the database — e.g. `t-shirt,sweatshirt` |
| `APP_NAME` | `Application` | Display name used in the coverage report |
| `MAX_FIX_ROUNDS` | `3` | Maximum AI fix iterations per failing test |
| `APP_PACKAGE_JSON` | _(auto-detected)_ | Absolute path to the app's `package.json` (for framework detection) |

### Example `.env` for a Next.js app

```bash
ANTHROPIC_API_KEY=sk-ant-...
BASE_URL=http://localhost:3000
APP_SOURCE_DIR=/home/user/projects/my-store/src/app
APP_MODULES_DIR=/home/user/projects/my-store/src/components
COUNTRY_CODE=us
PRODUCT_HANDLES=t-shirt,hoodie,pants
APP_NAME="My Store"
```

### Example `.env` for a React SPA

```bash
ANTHROPIC_API_KEY=sk-ant-...
BASE_URL=http://localhost:5173
APP_SOURCE_DIR=/home/user/projects/my-spa/src/pages
APP_MODULES_DIR=/home/user/projects/my-spa/src/components
APP_NAME="My Dashboard"
```

---

## Running the agent

Make sure your application is running at `BASE_URL` before starting.

```bash
# Full pipeline — recon → plan → generate → run → fix → learn → report
pnpm run generate
```

### Flags

| Flag | Effect |
| ---- | ------ |
| _(none)_ | Full 7-phase pipeline |
| `--plan-only` | Stop after planning — saves `test-plan.json` and exits |
| `--generate-only` | Stop after spec generation — writes `.spec.ts` files and exits |
| `--run-only` | Skip recon/plan/gen, load existing plan from disk, run + fix |

```bash
# Just preview the test plan (no spec generation, no test run)
pnpm --filter @qa/agents run plan-only

# Re-run and fix existing specs without regenerating
pnpm --filter @qa/agents run run-only
```

---

## Natural-Language Test Authoring (web UI)

A browser UI where a **non-technical user** (product owner, business analyst) types a
test in plain English. The agent translates it into executable Playwright code, runs it,
and reports the result — no code required. Change the instruction and the agent adapts the
test in place.

> Plain English → generated Playwright code → live test run → pass/fail with a step
> timeline. Then modify the instruction (e.g. *"now test with a coupon code applied"*) and
> watch the agent adapt.

### Start it

Make sure your application is running at `BASE_URL`, then:

```bash
pnpm author
```

This launches a local server and prints the URL — open it in your browser:

```
▸ Open  http://localhost:5180
```

The default port is **5180**. If it's taken, set a different one:

```bash
NLP_PORT=4100 pnpm author
```

> **Note:** `5173` (Vite's default) is intentionally *not* used — it's frequently occupied
> by another dev/Docker server. If you hit a blank page or an **"Upgrade Required"** (HTTP
> 426) response, something else is squatting on the port — pick a free one via `NLP_PORT`.

### Using it

1. **Describe the test** in the text box, or click one of the example chips.
   *e.g. "Verify that a user who adds 3 items to the cart and removes 1 sees the correct total at checkout."*
2. Click **Generate test** — the agent writes a self-contained Playwright spec (shown on
   the right), using your app's real routes, selectors, base URL, and seeded credentials.
3. Click **▶ Run test** — Playwright output streams live, and you get a pass/fail badge, a
   ✓/✕ **step timeline**, the duration, the error message, and a screenshot on failure.
4. **Auto-heal (on by default).** If the test fails and the *"Auto-heal on failure"* box is
   ticked, the agent automatically diagnoses the failure, rewrites the spec, and re-runs —
   up to 3 rounds. You see each round's root cause in a heal timeline, the code panel updates
   live to the healed version, and the result shows *"✦ self-healed in N rounds"* when it
   goes green. Untick the box to get a single one-shot run instead.
5. **Adapt it** — the box switches to *"Modify the test"*. Describe a change
   (*"now test with a coupon code applied"*) and click **Adapt test**; the agent edits the
   existing spec minimally rather than starting over. **Start over** clears everything.

### How it works

| Piece | Role |
| ----- | ---- |
| `agents/src/nlp-server.ts` | Zero-dependency HTTP server (Node built-ins). Serves the UI and exposes `/api/context`, `/api/generate`, and `/api/run` (streams Playwright output live, and drives the auto-heal loop). |
| `agents/src/nlp-authoring.ts` | Translates plain English → Playwright spec. Three operations: **fresh** (new test), **adapt** (minimal edit of the current spec), and **heal** (rewrite a failed spec from the error + step timeline). Wraps each phase in `test.step()` so the UI can show a readable timeline. |
| `agents/public/index.html` | The single-page UI. |
| `tests/playwright.nlp.config.ts` | Isolated Playwright config — NLP-authored specs live in `tests/nlp-authored/` (git-ignored, regenerated per run), kept out of the main `generated/` suite. |

The UI reuses the same context the autonomous agent does: it reads your app's routes,
`data-testid` selectors, **and the real labels of clickable elements** (button/link text
paired with their testids) via `APP_SOURCE_DIR` / `APP_MODULES_DIR`, plus any seeded login
credentials. This action vocabulary stops the generator from guessing button text (e.g.
targeting the real `add-product-button` instead of a guessed *"Add to cart"*). The auto-heal
loop (max rounds configurable via `NLP_MAX_HEAL_ROUNDS`, default 3) then closes the remaining
last-mile gaps — strict-mode selector clashes, missing preconditions — without the user
touching code.

---

## Output files

| File | Description |
| ---- | ----------- |
| `tests/generated/test-plan.json` | Structured test plan (TC IDs, titles, priorities, categories) |
| `tests/generated/tc*.spec.ts` | Generated Playwright spec files |
| `tests/generated/coverage-report.md` | Human-readable coverage report |
| `tests/generated/coverage-report.json` | Machine-readable coverage data |
| `tests/generated/logs/run-<timestamp>.log` | Full terminal transcript of the run (agent + Playwright output) |
| `tests/playwright-report/` | Merged HTML report — every test from every fix round with final status, error messages, screenshots, traces |
| `agents/learnings.json` | Accumulated patterns — **commit this file** so learnings persist across CI runs |

---

## Viewing reports

After a run completes, four artefacts give you different angles on the results:

```bash
# 1. Markdown coverage summary (open in any editor / Markdown viewer)
cat tests/generated/coverage-report.md
code tests/generated/coverage-report.md     # or your editor of choice

# 2. Machine-readable coverage data (for CI scripts, dashboards)
cat tests/generated/coverage-report.json | jq .

# 3. Interactive HTML report — every test, every fix round, with failure traces
pnpm -C tests exec playwright show-report   # opens http://localhost:9323
# or directly:
npx -p @playwright/test playwright show-report tests/playwright-report

# 4. Full run log (agent output + Playwright output, one file per run)
less tests/generated/logs/run-*.log         # all past runs
less "$(ls -t tests/generated/logs/run-*.log | head -1)"   # just the latest
```

**Tip:** the HTML report is the best place to debug failures — click any failed test for the error message, stack trace, screenshot, and (on retried tests) the Playwright trace viewer.

---

## Repository layout

```
qa-agent/
├── agents/                     ← AI orchestration (TypeScript, runs via tsx)
│   ├── src/
│   │   ├── index.ts            ← Entry point / phase orchestration
│   │   ├── codebase-reader.ts  ← Reads routes and selectors from your app source
│   │   ├── planner.ts          ← Claude: generates the test plan
│   │   ├── automator.ts        ← Claude: generates individual Playwright specs
│   │   ├── runner.ts           ← Executes Playwright, parses results
│   │   ├── fixer.ts            ← Claude: analyses failures, patches specs
│   │   ├── learner.ts          ← Reads/writes learnings.json
│   │   ├── reporter.ts         ← Builds the Markdown coverage report
│   │   ├── nlp-server.ts       ← Natural-Language authoring web server (`pnpm author`)
│   │   ├── nlp-authoring.ts    ← Claude: plain English → Playwright spec (fresh + adapt)
│   │   └── types.ts            ← Shared TypeScript types
│   ├── public/
│   │   └── index.html          ← Natural-Language authoring UI (single page)
│   ├── AGENT_PROMPT.md         ← Full architecture spec and prompt reference
│   ├── learnings.json          ← Auto-generated; commit to persist across runs
│   ├── package.json
│   └── tsconfig.json
├── tests/
│   ├── generated/              ← Spec files written here by the agent
│   ├── nlp-authored/           ← NLP-authored spec (git-ignored, regenerated per run)
│   ├── test-results/           ← Playwright artefacts (git-ignored)
│   ├── playwright.config.ts    ← Config for the autonomous agent suite
│   ├── playwright.nlp.config.ts ← Config for NLP-authored tests
│   └── package.json
├── .env.example                ← Copy to .env and fill in your paths
├── .gitignore
├── package.json
└── pnpm-workspace.yaml
```

---

## How self-learning works

After each run the agent calls Claude to extract generalizable patterns from failures and fixes. These are written to `agents/learnings.json` and injected into the spec generation and fixer prompts on the next run — so the agent avoids repeating the same mistakes.

**Commit `agents/learnings.json`** so patterns accumulate across developers and CI runs.

```json
{
  "version": 1,
  "learnings": [
    {
      "id": "L001",
      "category": "timing",
      "title": "SSR streaming: wait for toBeEnabled not toBeVisible",
      "specGuideline": "Before clicking any option or variant button, await expect(btn).toBeEnabled({ timeout: 15000 }) — the server renders a disabled fallback before the real component streams in.",
      "fixerGuideline": "If a click on a product option times out, check whether SSR streaming is active and add toBeEnabled() wait before the click.",
      "seenCount": 4
    }
  ]
}
```

---

## Auth bootstrap

Phase 1.5 looks for a register/signup route in your app source. If it finds one:

1. Generates fresh credentials (`qaagent_<timestamp>@example.com` + strong password)
2. Generates and runs a one-off Playwright spec that registers that user
3. On success, writes `TEST_USERNAME` / `TEST_PASSWORD` / `TEST_EMAIL` to `.env`
4. Deletes the bootstrap spec so subsequent phases don't re-register

Every downstream auth-required test then uses the seeded credentials.

**Opting out:** set `TEST_USERNAME` in `.env` to any real account (i.e. not the
`your_test_username` placeholder) and the bootstrap will skip. Setting
`FORCE_REGISTER=true` overrides this and re-registers on every run.

If the bootstrap fails (no register route, network issue, etc.) the pipeline
continues with whatever credentials are already in `.env`.

---

## Bug reporting policy

The agent **never modifies application source code**. When it detects a genuine app bug (missing `data-testid`, wrong server action URL, broken component), it:

1. Classifies the failure as `SOURCE_BUG`
2. Patches the spec to fail gracefully
3. Adds a `BugReport` entry to `coverage-report.md` with file, description, and suggested fix

Developers find all bugs under **Application Bugs Found** in the coverage report.

---

## Sample output

```
╔══════════════════════════════════════════════════╗
║             Autonomous QA Agent                  ║
╚══════════════════════════════════════════════════╝

[1/7] Reconnaissance — reading codebase...
      Framework:  nextjs-app-router (ssr-streaming)
      Routes:     17
      Selectors:  84 unique data-testid values
      Items:      t-shirt, hoodie, pants
      Base URL:   http://localhost:3000
      Learnings:  6 pattern(s) loaded from agents/learnings.json
      Done        (0.4s)

[2/7] Planning — mapping flows and generating test plan...
      Test cases:    20
      Skipped flows: 4
        high      7
        medium    9
        low       4
      Saved → tests/generated/test-plan.json  (9.1s)

[3/7] Generating specs — 20 test cases...
      [1/20] TC001: Homepage loads and displays hero section       ✓  (3.8s)
      [2/20] TC002: User registration with valid credentials       ✓  (5.2s)
      ...
      [20/20] TC020: Filter products by category                   ✓  (4.1s)

      Result: 20/20 specs generated  (87.3s)

[4/7] Running 20 tests — initial run...
  ✓  TC001 ... ✓  TC018
  ✗  TC019 - Complete checkout flow (60.0s)
  ✗  TC020 - Apply discount at checkout (60.0s)

      ─── completed in 94.2s ───
      Initial result: 18 passed  2 failed  0 skipped  (96.4s)

[5/7] Fix round 1/3 — analysing 2 failure(s)...
      Failing: TC019, TC020
      ├─ [1/2] TC019 (STATE)
      │     root cause: Checkout requires active cart — add-to-cart precondition missing
      │  └─ ✓ spec patched
      ├─ [2/2] TC020 (TIMING)
      │     root cause: Discount input only renders after address step completes
      │  └─ ✓ spec patched
      └─ done
      Analysis done  (11.8s) — 2/2 spec patches applied

      Re-running 2 previously-failing test(s)...
      Round 1 result: 2 passed  0 failed  (+2 recovered)  (44.1s)

      ✓ All tests passing.

      Extracting learnings for future sessions...
      Learnings saved → agents/learnings.json (8 patterns stored)

[7/7] Generating final report...
      Saved → tests/generated/coverage-report.md

╔══════════════════════════════════════════════════╗
║                 Final Summary                    ║
╚══════════════════════════════════════════════════╝

  Application:     My Store
  Total time:      4m 2s
  Tests:           20 generated  |  20 passed  |  0 failed
  Pass rate:       100%
  Fix rounds:      1
  App bugs found:  0

  By category:
    ✓ account         3/3  ███
    ✓ auth            3/3  ███
    ✓ cart            2/2  ██
    ✓ checkout        2/2  ██
    ✓ navigation      3/3  ███
    ✓ product         4/4  ████
    ✓ search          3/3  ███

  Report: tests/generated/coverage-report.md
  Specs:  tests/generated/  (20 files)
```

---

## Troubleshooting

**`Missing required environment variable: APP_SOURCE_DIR`**

Copy `.env.example` to `.env` and set the required paths.

**`results.json` not written — Playwright may have failed to start**

Run `pnpm run install:browsers` to install Chromium.

**All tests time out immediately**

Your application is not running. Start it and verify `BASE_URL`:
```bash
curl $BASE_URL   # should return HTML
```

**Selector discovery returns 0 `data-testid` values**

`APP_MODULES_DIR` points to the wrong directory. Check that the directory exists and contains `.tsx`/`.ts` component files with `data-testid="..."` attributes.

**Framework detected as `unknown`**

Set `APP_PACKAGE_JSON` to the absolute path of your app's `package.json` so the agent can read its dependencies for accurate detection.
