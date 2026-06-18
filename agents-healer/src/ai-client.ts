import { spawnSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

// Dual-mode AI client (same pattern as ../../agents/src/ai-client.ts, kept inline
// so this package has no cross-package source dependency):
//   • ANTHROPIC_API_KEY set → Anthropic Messages API via @anthropic-ai/sdk (cloud/headless)
//   • otherwise            → local `claude` CLI (Claude Code login; local dev)

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const USE_API = Boolean(process.env.ANTHROPIC_API_KEY);
const DEFAULT_MAX_TOKENS = 4000; // healer prompts return a small JSON locator object

interface CliJsonResponse {
  is_error?: boolean;
  result?: string;
  error?: string;
  subtype?: string;
}

function resolveApiModel(model: string): string {
  const aliases: Record<string, string> = {
    opus: "claude-opus-4-8",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
  };
  return aliases[model.toLowerCase()] ?? model;
}

export async function askClaude(opts: {
  system?: string;
  prompt: string;
  model?: string;
}): Promise<string> {
  return USE_API ? askViaApi(opts) : askViaCli(opts);
}

// ── API mode ─────────────────────────────────────────────────────────────────

let apiClient: Anthropic | null = null;
function getApiClient(): Anthropic {
  if (!apiClient) apiClient = new Anthropic(); // reads ANTHROPIC_API_KEY
  return apiClient;
}

async function askViaApi(opts: { system?: string; prompt: string; model?: string }): Promise<string> {
  const system = opts.system
    ? [{ type: "text" as const, text: opts.system, cache_control: { type: "ephemeral" as const } }]
    : undefined;
  try {
    const resp = await getApiClient().messages.create({
      model: resolveApiModel(opts.model ?? MODEL),
      max_tokens: DEFAULT_MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: opts.prompt }],
    });
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("ANTHROPIC_API_KEY is missing/invalid or lacks access to the requested model.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Anthropic API error ${err.status ?? ""}: ${err.message}`);
    }
    throw err;
  }
}

// ── CLI mode ─────────────────────────────────────────────────────────────────

function askViaCli(opts: { system?: string; prompt: string; model?: string }): string {
  const args = ["-p", "--output-format", "json", "--model", opts.model ?? MODEL];
  if (opts.system) args.push("--append-system-prompt", opts.system);

  const proc = spawnSync(CLAUDE_BIN, args, {
    input: opts.prompt,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });

  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `'${CLAUDE_BIN}' not found on PATH. Install Claude Code and run \`claude login\`, ` +
          `set CLAUDE_BIN to the claude binary path, or set ANTHROPIC_API_KEY to use the API instead.`
      );
    }
    throw new Error(`Failed to spawn '${CLAUDE_BIN}': ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(`claude CLI exited with code ${proc.status}.\nstderr:\n${proc.stderr?.slice(0, 800)}`);
  }

  let parsed: CliJsonResponse;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch (err) {
    throw new Error(`Failed to parse claude JSON output: ${err}\nRaw: ${proc.stdout.slice(0, 400)}`);
  }
  if (parsed.is_error || !parsed.result) {
    throw new Error(`claude returned error: ${parsed.error ?? parsed.subtype ?? "(no message)"}`);
  }
  return parsed.result;
}

export function extractJson<T = unknown>(text: string): T {
  // Strip ```json fences and surrounding prose; tolerate leading commentary.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1) {
    throw new Error(`No JSON object found in response: ${text.slice(0, 200)}`);
  }
  return JSON.parse(raw.slice(first, last + 1)) as T;
}
