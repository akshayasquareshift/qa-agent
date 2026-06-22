import { spawnSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

// Three-provider AI client (same pattern as ../../agents/src/ai-client.ts, kept
// inline so this package has no cross-package source dependency). Provider is
// chosen automatically by which key is set, precedence Gemini → Anthropic → CLI:
//   • GEMINI_API_KEY / GOOGLE_API_KEY set → Google Gemini via @google/genai
//   • else ANTHROPIC_API_KEY set          → Anthropic Messages API via @anthropic-ai/sdk
//   • otherwise                           → local `claude` CLI (Claude Code login)

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
// Gemini defaults to the Flash tier when no model is specified; an explicit
// GEMINI_MODEL is honored as-is (see agents/src/ai-client.ts).
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const DEFAULT_MAX_TOKENS = 4000; // healer prompts return a small JSON locator object

type Provider = "gemini" | "anthropic" | "cli";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const PROVIDER: Provider = GEMINI_API_KEY
  ? "gemini"
  : process.env.ANTHROPIC_API_KEY
    ? "anthropic"
    : "cli";

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

// Default to Flash when unspecified; honor an explicit model (see agents/src/ai-client.ts).
function resolveGeminiModel(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("gemini")) return model;
  if (m === "flash" || m.includes("haiku")) return "gemini-2.5-flash";
  if (m === "pro" || m.includes("opus") || m.includes("sonnet")) return "gemini-2.5-pro";
  return GEMINI_MODEL;
}

export async function askClaude(opts: {
  system?: string;
  prompt: string;
  model?: string;
}): Promise<string> {
  if (PROVIDER === "gemini") return askViaGemini(opts);
  if (PROVIDER === "anthropic") return askViaApi(opts);
  return askViaCli(opts);
}

// ── Gemini mode ────────────────────────────────────────────────────────────────

// Gemini 2.5 spends hidden "thinking" tokens out of maxOutputTokens, starving the
// visible answer when the budget is tuned for Claude. Reserve a separate thinking
// budget on top of the answer budget. See agents/src/ai-client.ts for the detail.
const GEMINI_THINKING_BUDGET = 4096;

let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  return geminiClient;
}

async function askViaGemini(opts: { system?: string; prompt: string; model?: string }): Promise<string> {
  try {
    const resp = await getGeminiClient().models.generateContent({
      model: resolveGeminiModel(opts.model ?? GEMINI_MODEL),
      contents: opts.prompt,
      config: {
        ...(opts.system ? { systemInstruction: opts.system } : {}),
        maxOutputTokens: DEFAULT_MAX_TOKENS + GEMINI_THINKING_BUDGET,
        thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
      },
    });
    const text = resp.text ?? "";
    if (!text) {
      const finishReason = resp.candidates?.[0]?.finishReason;
      throw new Error(
        `Gemini returned no text (finishReason=${finishReason ?? "unknown"}). ` +
        `This is typically a safety filter or blocked prompt.`
      );
    }
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/api[\s_-]?key|invalid|unauthor|permission|403|401|400/i.test(msg)) {
      throw new Error(
        `GEMINI_API_KEY is missing/invalid or lacks access to the requested model. (${msg.slice(0, 200)})`
      );
    }
    throw err;
  }
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
