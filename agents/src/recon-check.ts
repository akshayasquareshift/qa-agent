import type { AppContext } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Recon sanity check — warns (never blocks) when the source the agent analysed
// doesn't appear to match the app actually running at BASE_URL.
//
// The whole pipeline's accuracy depends on recon (routes/selectors) describing
// the SAME code that's serving BASE_URL. If APP_SOURCE_DIR points at a different
// app/version than the deployment, every generated selector/route is a guess and
// the suite fails en masse. We can't prove a match, but a high 404 rate on
// discovered routes is a strong, low-false-positive signal of a mismatch.
//
// Skippable via SKIP_RECON_CHECK=true.
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_CAP = 8;
const FETCH_TIMEOUT_MS = 8000;

function log(msg: string): void {
  console.log(`      ${msg}`);
}

async function fetchStatus(url: string): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "manual", signal: ctrl.signal });
    return res.status;
  } catch {
    return null; // network error / unreachable / timeout
  } finally {
    clearTimeout(timer);
  }
}

export async function checkSourceMatchesApp(ctx: AppContext): Promise<void> {
  if ((process.env.SKIP_RECON_CHECK ?? "").toLowerCase() === "true") return;

  try {
    const base = (ctx.baseUrl ?? "").trim().replace(/\/$/, "");
    if (!base) {
      log("⚠ Source↔app check: BASE_URL is not set — cannot verify the running app.");
      return;
    }
    const localePrefix = ctx.countryCode ? `/${ctx.countryCode}` : "";

    // Sample STATIC routes only (skip dynamic [param] routes — their substituted
    // ids often 404 for reasons unrelated to a source mismatch). Always include root.
    const staticRoutes = ctx.routes.filter((r) => !r.urlPattern.includes("["));
    const paths = Array.from(
      new Set([`${localePrefix}/`, ...staticRoutes.map((r) => r.displayUrl)])
    ).slice(0, SAMPLE_CAP);

    const results = await Promise.all(
      paths.map(async (p) => ({ p, status: await fetchStatus(base + p) }))
    );

    const reachable = results.filter((r) => r.status !== null);
    if (reachable.length === 0) {
      log(`⚠ Source↔app check: BASE_URL (${base}) is not reachable — is the app running?`);
      return;
    }

    const notFound = reachable.filter((r) => r.status === 404).length;
    const ratio = notFound / reachable.length;
    if (ratio >= 0.6) {
      log(
        `⚠ Source↔app check: ${notFound}/${reachable.length} sampled routes return 404 at ${base} — ` +
        `the analysed source may NOT match the running app. Verify APP_SOURCE_DIR (and APP_REPO_URL/branch) ` +
        `point at the same app/version as BASE_URL.`
      );
      for (const r of results.filter((x) => x.status === 404).slice(0, 5)) {
        log(`    404 → ${base}${r.p}`);
      }
    } else {
      log(`✓ Source↔app check: ${reachable.length - notFound}/${reachable.length} sampled routes reachable.`);
    }
  } catch {
    // Never let a best-effort check break the pipeline.
  }
}
