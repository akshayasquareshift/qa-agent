import { defineConfig, devices } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Dedicated config for Natural-Language-authored tests.
//
// These specs are written interactively from the NLP authoring UI and live in
// `nlp-authored/`, kept OUT of the main agent suite (`generated/`) so the two
// never run together. The JSON reporter feeds structured results (status, steps,
// errors, attachments) back to the UI; the line reporter streams live progress.
// ─────────────────────────────────────────────────────────────────────────────

export default defineConfig({
  testDir: "./nlp-authored",
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  timeout: 60_000,
  reporter: [
    ["json", { outputFile: "test-results/nlp-results.json" }],
    ["line"],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
