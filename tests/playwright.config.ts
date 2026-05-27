import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./generated",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  // Per-run output: each round writes its blob into its OWN outputDir under
  // `blob-store/round-N/`, set via the QA_BLOB_DIR env var, with the file named
  // via QA_BLOB_NAME. The blob store lives OUTSIDE `test-results/` because the
  // `--output=test-results` flag wipes that dir at the start of every run, which
  // would otherwise destroy earlier rounds' blobs. After the fix loop the agent
  // collects every round-N.zip into a flat `blob-archive/` directory and runs
  //   `playwright merge-reports blob-archive --reporter=html`
  // so the final HTML report at `playwright-report/` contains every test from
  // every round. The `json` reporter is consumed by the agent's runner to parse
  // per-round results.
  reporter: [
    ["blob", {
      outputDir: process.env.QA_BLOB_DIR ?? "blob-store/default",
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
