import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";

// ─────────────────────────────────────────────────────────────────────────────
// App-source resolver — lets the agent test an app whose source lives on GitHub
// (e.g. a cloud-hosted app) without a manual clone.
//
// When APP_REPO_URL is set, this shallow-clones the repo into a temp cache dir
// and rewrites APP_SOURCE_DIR / APP_MODULES_DIR to point INSIDE that clone — i.e.
// those two vars are interpreted as paths RELATIVE TO THE REPO ROOT (e.g.
// "src/app", "src/modules"). When APP_REPO_URL is empty, this is a no-op and the
// vars keep their normal meaning (absolute local paths).
//
// The running app's URL is unrelated to this — set BASE_URL to the cloud URL.
//
// Env:
//   APP_REPO_URL     — https/ssh git URL of the app repo (enables this path)
//   APP_REPO_BRANCH  — branch to fetch (default: the repo's default branch)
//   APP_REPO_REFRESH — "false" to reuse the cached clone without re-fetching
//   GITHUB_TOKEN     — optional; injected into https github URLs for private repos
// ─────────────────────────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`      ${msg}`);
}

function git(args: string[], cwd?: string) {
  return spawnSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
}

function withinDir(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * If APP_REPO_URL is set, clone it (shallow, cached) and rewrite
 * APP_SOURCE_DIR / APP_MODULES_DIR to absolute paths inside the clone.
 * Throws with a clear message on any failure. No-op when APP_REPO_URL is empty.
 */
export function resolveAppSource(): void {
  const repoUrl = process.env.APP_REPO_URL?.trim();
  if (!repoUrl) return; // local mode — nothing to do

  if (git(["--version"]).status !== 0) {
    throw new Error(
      "APP_REPO_URL is set but `git` was not found on PATH. Install git, or use local " +
      "absolute APP_SOURCE_DIR / APP_MODULES_DIR paths instead."
    );
  }

  const branch = process.env.APP_REPO_BRANCH?.trim();
  const token = process.env.GITHUB_TOKEN?.trim();
  const refresh = (process.env.APP_REPO_REFRESH ?? "true").toLowerCase() !== "false";

  // Inject a token for private https://github.com repos (optional).
  let cloneUrl = repoUrl;
  if (token && /^https:\/\/github\.com\//.test(repoUrl)) {
    cloneUrl = repoUrl.replace("https://", `https://${token}@`);
  }
  const scrub = (s: string) => (token ? s.split(token).join("***") : s);

  const slug = crypto.createHash("sha1").update(`${repoUrl}#${branch ?? "default"}`).digest("hex").slice(0, 16);
  const dir = path.join(os.tmpdir(), "qa-agent-sources", slug);
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  if (fs.existsSync(path.join(dir, ".git"))) {
    if (refresh) {
      log(`Refreshing cached repo: ${repoUrl}${branch ? ` (${branch})` : ""}`);
      const f = git(["-C", dir, "fetch", "--depth", "1", "origin", branch ?? "HEAD"]);
      if (f.status === 0) git(["-C", dir, "reset", "--hard", "FETCH_HEAD"]);
      else log("(fetch failed — using the cached copy)");
    } else {
      log(`Using cached repo at ${dir}`);
    }
  } else {
    log(`Cloning ${repoUrl}${branch ? ` (branch ${branch})` : ""} …`);
    const args = ["clone", "--depth", "1"];
    if (branch) args.push("--branch", branch);
    args.push(cloneUrl, dir);
    const c = git(args);
    if (c.status !== 0) {
      const err = scrub((c.stderr || c.stdout || "").trim()).slice(0, 600);
      throw new Error(
        `Failed to clone APP_REPO_URL (${repoUrl}${branch ? `, branch ${branch}` : ""}).\n${err}\n` +
        `Check the URL/branch — for a private repo, set GITHUB_TOKEN.`
      );
    }
  }

  // APP_SOURCE_DIR / APP_MODULES_DIR are repo-relative in this mode.
  const srcRel = (process.env.APP_SOURCE_DIR ?? "").trim();
  const modRel = (process.env.APP_MODULES_DIR ?? "").trim();
  const srcAbs = path.resolve(dir, srcRel);
  const modAbs = path.resolve(dir, modRel);

  for (const [label, rel, abs] of [
    ["APP_SOURCE_DIR", srcRel, srcAbs],
    ["APP_MODULES_DIR", modRel, modAbs],
  ] as const) {
    if (!withinDir(dir, abs)) {
      throw new Error(`${label}="${rel}" escapes the repo root — it must be a path inside the repo.`);
    }
    if (!fs.existsSync(abs)) {
      const top = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")).slice(0, 25).join(", ")
        : "(empty)";
      throw new Error(
        `${label}="${rel || "(empty)"}" does not exist inside the cloned repo.\n` +
        `Repo top-level entries: ${top}\n` +
        `Set ${label} to a path relative to the repo root (e.g. "src/app" / "src/modules").`
      );
    }
  }

  process.env.APP_SOURCE_DIR = srcAbs;
  process.env.APP_MODULES_DIR = modAbs;
  // APP_PACKAGE_JSON is auto-detected by walking up from APP_SOURCE_DIR (now inside the clone).

  log(`Source ready (repo): ${repoUrl} → source "${srcRel || "."}", modules "${modRel || "."}"`);
}
