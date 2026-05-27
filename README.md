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
│   │   └── types.ts            ← Shared TypeScript types
│   ├── AGENT_PROMPT.md         ← Full architecture spec and prompt reference
│   ├── learnings.json          ← Auto-generated; commit to persist across runs
│   ├── package.json
│   └── tsconfig.json
├── tests/
│   ├── generated/              ← Spec files written here by the agent
│   ├── test-results/           ← Playwright artefacts (git-ignored)
│   ├── playwright.config.ts
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
