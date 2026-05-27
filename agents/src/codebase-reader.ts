import * as fs from "fs";
import * as path from "path";
import type { AppContext, RouteInfo, SelectorInfo } from "./types";

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

  for (const file of moduleFiles) {
    try {
      const content = fs.readFileSync(file, "utf-8");
      const ids = extractTestIds(content);
      const contextName = path.relative(MODULES_PATH, file).split(path.sep)[0];
      for (const id of ids) {
        if (!selectorMap.has(id)) selectorMap.set(id, contextName);
      }
    } catch { /* ignore unreadable files */ }
  }

  const selectors: SelectorInfo[] = Array.from(selectorMap.entries()).map(
    ([testId, context]) => ({ testId, context })
  );

  const seedData = process.env.SEED_DATA
    ? process.env.SEED_DATA.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    framework,
    renderingModel,
    routes,
    selectors,
    seedData,
    baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
    countryCode,
  };
}
