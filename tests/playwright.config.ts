import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./generated",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  // Per-run output: one `blob` zip per round in `test-results/blob/`, file named
  // via QA_BLOB_NAME env var (must end in .zip). The agent sets PWTEST_BLOB_DO_NOT_REMOVE=1
  // so Playwright does not wipe the directory between rounds. After the fix loop
  // completes the agent runs `playwright merge-reports test-results/blob --reporter=html`
  // so the final HTML report at `playwright-report/` contains every test from every round.
  // The `json` reporter is consumed by the agent's runner to parse per-round results.
  reporter: [
    ["blob", {
      outputDir: "test-results/blob",
      fileName: process.env.QA_BLOB_NAME ?? "default.zip",
    }],
    ["json", { outputFile: "test-results/results.json" }],
    ["list"],
  ],
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
