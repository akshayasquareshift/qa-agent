Healer Agent Prompt


# Agent 2 — Self-Healing Test Executor

The second stage in the Agentic QA pipeline. Where the **generator** agent
(`@qa/agents`) produces a Playwright suite, the **healer** agent (`@qa/healer`)
keeps that suite running when the application's UI inevitably drifts.

## Why this exists

Every QA team carries a maintenance tax: a developer renames a button, moves a
field, reorders a form — and ten tests start failing in CI. Each failure costs
~10–20 min to triage and patch. Multiply by every sprint, every team.

The healer agent attacks that tax directly. Tests don't break when the UI
changes — they self-recover, mid-run, with a paper trail.

## How it works

1. **Healable suite format.** Each step declares an **intent** in plain
   language (`"Click the primary sign-in button in the top nav"`) alongside a
   locator. Intent is what survives UI drift; locator is what breaks.
2. **Execute against the live app.** Playwright drives Chromium step by step.
3. **Detect locator failure.** Timeouts, "element not visible", "no node
   found", strict-mode violations all classify as locator-failure (not, say,
   a network error). Non-locator failures bubble up unchanged.
4. **DOM reasoning.** On a locator failure the agent:
   - Captures a trimmed DOM snapshot (scripts/styles stripped, noise
     attributes removed, capped at ~24KB).
   - Sends `{ intent, action, old locator, error, DOM }` to Claude.
   - Receives `{ newLocator, reasoning, confidence, candidatesConsidered }`.
5. **Retry with the new locator.** If it works, the step is marked `healed`
   and we continue. If it doesn't, the step fails — but the report still
   shows what was attempted and why.
6. **Report.**
   - **Console:** colored diff per heal event (red old / green new) plus
     reasoning, confidence, recovery time, and a "time saved vs manual fix"
     tally.
   - **Markdown:** `tests/generated/healing/<slug>.md` with full diff blocks,
     reasoning, candidates considered, and the Playwright error before heal.
   - **JSON:** machine-readable counterpart for dashboards / CI gates.

## Run it

```bash
# Bundled demo (login + create-patient flow)
pnpm run heal:demo

# Your own suite(s)
pnpm run heal path/to/login.suite.ts

# Headed mode for debugging the visual flow
pnpm --filter @qa/healer heal:demo --headed
```

A suite is any `.suite.ts` / `.suite.json` exporting a `HealableSuite`. Place
them under `agents-healer/suites/` to be auto-discovered.

## What you'll see when a locator drifts

```
[2/14] click          Click the primary login / sign-in entry button in the top nav
        ↳ locator failed → invoking healer (DOM reasoning)...
        ✓ healed → role=button[name="Log in"]  (high, 1.4s)

  ▸ Step 2: Click the primary login / sign-in entry button in the top nav
    action: click   confidence: high
    locator diff:
      - [data-testid='sign-in-button']
      + role=button[name="Log in"]
    reasoning: The data-testid attribute no longer exists; the top-nav now
               contains a single <button> with accessible name "Log in"
               which fulfils the same sign-in entry intent.
    other candidates considered: text=Log in  |  nav button:first-of-type
    recovery: 1.4s  (LLM: 1.1s)
```

## Pipeline position

```
┌────────────────────┐    ┌──────────────────────────┐
│  @qa/agents        │ →  │  @qa/healer              │
│  generate suite    │    │  execute + self-heal     │
└────────────────────┘    └──────────────────────────┘
       writes specs              keeps them green
       (Stage 1)                 across UI drift
                                 (Stage 2)
```

Stage 1 ships intent-rich specs once. Stage 2 keeps them passing forever.

