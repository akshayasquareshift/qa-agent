import * as fs from "fs";
import * as path from "path";
import type { AppContext, RouteInfo, SelectorInfo, ActionLabel } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Path configuration — driven by environment variables so this module works
// for any application without modifying source code.
//
// Required env vars:
//   APP_SOURCE_DIR   — absolute path to the app router / pages directory
//                      Next.js App Router: /path/to/app/src/app
//                      Next.js Pages Router: /path/to/app/pages
//   APP_MODULES_DIR  — absolute path to the components directory
//                      (scanned for data-testid attributes)
//
// Optional:
//   APP_PACKAGE_JSON — absolute path to the app's package.json
//                      (used for framework detection; auto-detected if omitted)
//   SEED_DATA        — comma-separated test record identifiers seeded in the database
//                      e.g. "patient-001,doctor-001" or "record-abc,report-xyz"
// ─────────────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Copy .env.example to .env and fill in the paths for your application.`
    );
  }
  return val;
}

const APP_PATH = requireEnv("APP_SOURCE_DIR");
const MODULES_PATH = requireEnv("APP_MODULES_DIR");
const APP_PACKAGE_JSON = process.env.APP_PACKAGE_JSON ?? autoDetectPackageJson(APP_PATH);

function autoDetectPackageJson(appSourceDir: string): string {
  // Walk up from APP_SOURCE_DIR looking for the nearest package.json
  let dir = appSourceDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────────────
// File walking
// ─────────────────────────────────────────────────────────────────────────────

function walkDir(dir: string, exclude: string[] = []): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const item of fs.readdirSync(dir)) {
    if (exclude.includes(item)) continue;
    const full = path.join(dir, item);
    if (fs.statSync(full).isDirectory()) {
      files.push(...walkDir(full, exclude));
    } else {
      files.push(full);
    }
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selector extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractTestIds(content: string): string[] {
  const ids: string[] = [];
  const re = /data-testid="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) ids.push(m[1]);
  return ids;
}

// ─────────────────────────────────────────────────────────────────────────────
// Action-label extraction
//
// Many CTAs (especially primary buttons) carry NO data-testid, so a generator
// that only sees testids has to GUESS the visible text — and guesses wrong
// (e.g. "Add to cart" when the button actually says "Add item"). Here we scan
// interactive elements and capture their REAL visible label — including the
// literal branches of dynamic text like `cond ? "Add item" : "Out of stock"` —
// paired with any data-testid on the same element. The generator then targets
// real text or the real testid instead of inventing names.
// ─────────────────────────────────────────────────────────────────────────────

// Interactive JSX tags whose text is a user-clickable label. The first group
// captures the opening-tag attributes; the second captures the inner content.
const INTERACTIVE_TAGS = [
  "Button", "button", "a", "Link", "LocalizedClientLink", "InteractiveLink",
  "IconButton", "SubmitButton", "Tab", "MenuItem", "NavLink",
];

// Reject strings that are clearly not human-facing labels: identifiers,
// classNames, paths, template fragments, etc.
function isLabelLike(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t.length > 40) return false;
  if (!/[A-Za-z]/.test(t)) return false;                 // must contain a letter
  if (/[<>{}=/\\@#:;_|`$]/.test(t)) return false;        // paths / css / template / identifiers
  if (/^[a-z]+[A-Z]/.test(t)) return false;              // camelCase identifier (e.g. selectedVariant)
  if (/\b(flex|grid|rounded|absolute|relative|hidden)\b/.test(t)) return false; // stray tailwind
  // words made of letters/digits with simple CTA punctuation only
  return /^[A-Za-z0-9][A-Za-z0-9 '!?,.()&%+-]*$/.test(t);
}

function extractActionLabels(content: string, context: string): ActionLabel[] {
  const out: ActionLabel[] = [];
  const seen = new Set<string>();

  for (const tag of INTERACTIVE_TAGS) {
    // <Tag ...attrs...>inner</Tag>  — non-greedy inner; bounded to avoid runaway.
    const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]{0,500}?)</${tag}>`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const attrs = m[1];
      const inner = m[2];
      const testId = attrs.match(/data-testid="([^"]+)"/)?.[1];
      const element = tag === "a" || /Link/.test(tag) || tag === "NavLink" ? "link" : "button";

      // Candidate labels: quoted string literals inside the element (covers the
      // branches of ternary text), plus any bare static text node.
      const candidates: string[] = [];
      let q: RegExpExecArray | null;
      const quoted = /["']([^"'<>{}\n]{2,40})["']/g;
      while ((q = quoted.exec(inner)) !== null) candidates.push(q[1]);
      const bareText = inner.replace(/\{[\s\S]*?\}/g, " ").replace(/<[^>]+>/g, " ").trim();
      if (bareText) candidates.push(bareText);

      for (const c of candidates) {
        if (!isLabelLike(c)) continue;
        const key = `${c.trim()}::${testId ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ label: c.trim(), testId, element, context });
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route discovery — Next.js App Router
// ─────────────────────────────────────────────────────────────────────────────

function extractRoutes(appDir: string, countryCode: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const sampleHandle = (process.env.SEED_DATA ?? "item").split(",")[0];

  function walk(dir: string, prefix: string = "") {
    if (!fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir)) {
      if (item === "node_modules") continue;
      const full = path.join(dir, item);
      if (!fs.statSync(full).isDirectory()) {
        if (item === "page.tsx" || item === "page.ts") {
          const pattern = prefix || "/";
          routes.push({
            urlPattern: pattern,
            displayUrl: pattern
              .replace("[countryCode]", countryCode || "us")
              .replace("[handle]", sampleHandle)
              .replace("[...category]", "category")
              .replace("[id]", "order_123")
              .replace("[token]", "token_abc")
              .replace("[slug]", sampleHandle),
            description: `Page: ${pattern}`,
          });
        }
        continue;
      }

      // Group routes (parentheses) and parallel routes (@...) don't add URL segments
      const isGroup = item.startsWith("(") && item.endsWith(")");
      const isParallel = item.startsWith("@");
      const segment = isGroup || isParallel ? null : item;
      const nextPrefix = segment !== null ? `${prefix}/${segment}` : prefix;
      walk(full, nextPrefix);
    }
  }

  walk(appDir);
  return routes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Framework detection
// ─────────────────────────────────────────────────────────────────────────────

function detectFramework(packageJsonPath: string, appSourceDir: string): AppContext["framework"] {
  if (packageJsonPath && fs.existsSync(packageJsonPath)) {
    try {
      const json = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const deps = { ...json.dependencies, ...json.devDependencies };
      if (deps["next"]) {
        // Presence of an "app" subdirectory = App Router
        const appDir = path.join(path.dirname(packageJsonPath), "src", "app");
        const appDirAlt = path.join(path.dirname(packageJsonPath), "app");
        if (
          fs.existsSync(appDir) ||
          fs.existsSync(appDirAlt) ||
          appSourceDir.includes("/app")
        ) {
          return "nextjs-app-router";
        }
        return "nextjs-pages";
      }
      if (deps["react"] && (deps["vite"] || deps["react-scripts"])) return "spa";
    } catch { /* fall through */ }
  }

  // Fallback: infer from the source directory name
  if (appSourceDir.includes("/app")) return "nextjs-app-router";
  if (appSourceDir.includes("/pages")) return "nextjs-pages";
  return "unknown";
}

function detectRenderingModel(
  modulesPath: string,
  framework: AppContext["framework"]
): AppContext["renderingModel"] {
  if (framework !== "nextjs-app-router") return "unknown";

  if (fs.existsSync(modulesPath)) {
    const files = walkDir(modulesPath, ["node_modules"]).filter((f) => f.endsWith(".tsx"));
    let suspenseCount = 0;
    for (const f of files.slice(0, 30)) {
      try {
        const content = fs.readFileSync(f, "utf-8");
        if (content.includes("<Suspense") || content.includes("use client")) suspenseCount++;
        if (suspenseCount >= 3) return "ssr-streaming";
      } catch { /* ignore */ }
    }
  }
  return "ssr-static";
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

export function readCodebaseContext(): AppContext {
  const countryCode = process.env.COUNTRY_CODE ?? "";
  const framework = detectFramework(APP_PACKAGE_JSON, APP_PATH);
  const renderingModel = detectRenderingModel(MODULES_PATH, framework);
  const routes = extractRoutes(APP_PATH, countryCode);

  const selectorMap = new Map<string, string>();
  const moduleFiles = walkDir(MODULES_PATH, ["node_modules"]).filter(
    (f) => f.endsWith(".tsx") || f.endsWith(".ts")
  );

  const actionMap = new Map<string, ActionLabel>();
  for (const file of moduleFiles) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      const contextName = path.relative(MODULES_PATH, file).split(path.sep)[0];

      const ids = extractTestIds(content);
      for (const id of ids) {
        if (!selectorMap.has(id)) selectorMap.set(id, contextName);
      }

      for (const a of extractActionLabels(content, contextName)) {
        // Prefer the first occurrence; upgrade if a later one carries a testid.
        const existing = actionMap.get(a.label);
        if (!existing || (!existing.testId && a.testId)) actionMap.set(a.label, a);
      }
    } catch { /* ignore unreadable files */ }
  }

  const selectors: SelectorInfo[] = Array.from(selectorMap.entries()).map(
    ([testId, context]) => ({ testId, context })
  );

  const actionLabels: ActionLabel[] = Array.from(actionMap.values());

  const seedData = process.env.SEED_DATA
    ? process.env.SEED_DATA.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    framework,
    renderingModel,
    routes,
    selectors,
    actionLabels,
    seedData,
    baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
    countryCode,
  };
}
