import { spawnSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";

// ─────────────────────────────────────────────────────────────────────────────
// AI client — three providers, picked automatically by which key is set.
//
//   1. Gemini  — if GEMINI_API_KEY (or GOOGLE_API_KEY) is set → call the Google
//      Gemini API via @google/genai. Billed per-token; headless-friendly.
//   2. Anthropic API — else if ANTHROPIC_API_KEY is set → call the Anthropic
//      Messages API directly via @anthropic-ai/sdk. This is what you want for
//      headless/cloud deploys (GCP) where `claude login` isn't available.
//      Billed per-token.
//   3. Claude CLI — otherwise → shell out to the local `claude` CLI (Claude
//      Code) in headless JSON mode, using your existing `claude login` (no API
//      key; counts against your Claude Pro/Max subscription). Best for local dev.
//
// Precedence: Gemini → Anthropic API → Claude CLI.
//
// Every model call in the agent funnels through createMessage(), so this is the
// single switch point — no call site changes.
//
// Env:
//   GEMINI_API_KEY / GOOGLE_API_KEY — when set, use Gemini
//   GEMINI_MODEL      — Gemini model id. When unset, defaults to gemini-2.5-flash;
//                       set it explicitly to use any other model (e.g. gemini-2.5-pro).
//   ANTHROPIC_API_KEY — when set (and no Gemini key), use the Anthropic API
//   ANTHROPIC_MODEL   — model id (default claude-opus-4-8). Aliases opus/sonnet/
//                       haiku are mapped to current ids in API mode.
//   CLAUDE_BIN        — claude binary path for CLI mode (default `claude`)
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
// Default the Gemini provider to the Flash tier (faster/cheaper) when no model is
// specified. An explicit GEMINI_MODEL is always honored as-is (including Pro).
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

type Provider = "gemini" | "anthropic" | "cli";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const PROVIDER: Provider = GEMINI_API_KEY
  ? "gemini"
  : process.env.ANTHROPIC_API_KEY
    ? "anthropic"
    : "cli";

interface CliJsonResponse {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
  session_id?: string;
}

export interface CreateMessageParams {
  model?: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

export type CreateMessageResult = {
  content: Array<{ type: "text"; text: string }>;
  stop_reason: string;
};

// Map CLI-style aliases to exact API model ids (the API requires exact ids).
function resolveApiModel(model: string): string {
  const aliases: Record<string, string> = {
    opus: "claude-opus-4-8",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
  };
  return aliases[model.toLowerCase()] ?? model;
}

// Map a model hint to a Gemini id. An explicit "gemini-*" id passes through as-is;
// Claude-style aliases map to a Gemini tier; anything unrecognised falls back to
// GEMINI_MODEL (which defaults to Flash when no model was specified).
function resolveGeminiModel(model: string): string {
  const m = model.toLowerCase();
  if (m.startsWith("gemini")) return model;
  if (m === "flash" || m.includes("haiku")) return "gemini-2.5-flash";
  if (m === "pro" || m.includes("opus") || m.includes("sonnet")) return "gemini-2.5-pro";
  return GEMINI_MODEL;
}

function buildPrompt(messages: Array<{ role: string; content: string }>): string {
  // Fast path — every caller in this codebase currently sends a single user turn.
  if (messages.length === 1 && messages[0].role === "user") {
    return messages[0].content;
  }
  return messages
    .map((m) => `${m.role === "user" ? "Human" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

export async function createMessage(params: CreateMessageParams): Promise<CreateMessageResult> {
  if (PROVIDER === "gemini") return createViaGemini(params);
  if (PROVIDER === "anthropic") return createViaApi(params);
  return createViaCli(params);
}

// ── Gemini mode (GEMINI_API_KEY / GOOGLE_API_KEY) ─────────────────────────────

// Gemini 2.5 models are "thinking" models: hidden reasoning tokens are drawn from
// the SAME maxOutputTokens budget as the visible answer. The callers' max_tokens
// values were tuned for Claude (where the budget is purely answer tokens), so on
// Gemini a chunk gets eaten by thinking and the real output is truncated (or
// empty), producing parse failures. We bound thinking with thinkingBudget AND add
// that budget on top of maxOutputTokens, so the visible answer still gets the full
// requested max_tokens. (gemini-2.5-pro can't fully disable thinking; flash can.)
const GEMINI_THINKING_BUDGET = 4096;

let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  return geminiClient;
}

async function createViaGemini(params: CreateMessageParams): Promise<CreateMessageResult> {
  // Callers send a single user turn (see buildPrompt), so we can pass the prompt
  // text straight through as `contents`.
  const prompt = buildPrompt(params.messages);

  try {
    const resp = await getGeminiClient().models.generateContent({
      model: resolveGeminiModel(params.model ?? GEMINI_MODEL),
      contents: prompt,
      config: {
        ...(params.system ? { systemInstruction: params.system } : {}),
        maxOutputTokens: params.max_tokens + GEMINI_THINKING_BUDGET,
        thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
      },
    });

    const text = resp.text ?? "";
    const finishReason = resp.candidates?.[0]?.finishReason;

    if (!text) {
      // No candidate text — usually a safety block or an empty/blocked response.
      throw new Error(
        `Gemini returned no text (finishReason=${finishReason ?? "unknown"}). ` +
        `This is typically a safety filter or blocked prompt.`
      );
    }

    // Map Gemini's truncation reason to the Anthropic-style stop_reason that
    // planner.ts checks ("max_tokens").
    return {
      content: [{ type: "text", text }],
      stop_reason: finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    };
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

// ── API mode (ANTHROPIC_API_KEY) ─────────────────────────────────────────────

let apiClient: Anthropic | null = null;
function getApiClient(): Anthropic {
  // Reads ANTHROPIC_API_KEY from the environment.
  if (!apiClient) apiClient = new Anthropic();
  return apiClient;
}

async function createViaApi(params: CreateMessageParams): Promise<CreateMessageResult> {
  // Cache the system prompt prefix when present (it's the stable part of a
  // request). We deliberately do NOT cache the user content — it's a fresh,
  // per-test-case prompt, so caching it would only pay the write premium with
  // no reads. (Bigger caching wins would need callers to split a stable prefix
  // from the volatile suffix.)
  const system = params.system
    ? [{ type: "text" as const, text: params.system, cache_control: { type: "ephemeral" as const } }]
    : undefined;

  try {
    const resp = await getApiClient().messages.create({
      model: resolveApiModel(params.model ?? MODEL),
      max_tokens: params.max_tokens,
      ...(system ? { system } : {}),
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    return { content: [{ type: "text", text }], stop_reason: resp.stop_reason ?? "end_turn" };
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

// ── CLI mode (claude login) ──────────────────────────────────────────────────

function createViaCli(params: CreateMessageParams): CreateMessageResult {
  const prompt = buildPrompt(params.messages);

  const args = ["-p", "--output-format", "json", "--model", params.model ?? MODEL];
  if (params.system) {
    args.push("--append-system-prompt", params.system);
  }

  const proc = spawnSync(CLAUDE_BIN, args, {
    input: prompt,
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024, // planner can emit large JSON test plans
  });

  if (proc.error) {
    const code = (proc.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `'${CLAUDE_BIN}' not found on PATH. Install Claude Code (https://docs.claude.com/en/docs/claude-code/quickstart) ` +
        `and run \`claude login\`, set CLAUDE_BIN to the claude binary path, or set ANTHROPIC_API_KEY to use the API instead.`
      );
    }
    throw new Error(`Failed to spawn '${CLAUDE_BIN}': ${proc.error.message}`);
  }

  if (proc.status !== 0) {
    throw new Error(
      `claude CLI exited with code ${proc.status}.\nstderr:\n${proc.stderr?.slice(0, 1000)}`
    );
  }

  let parsed: CliJsonResponse;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch (err) {
    throw new Error(
      `Failed to parse claude CLI JSON output: ${err}\nRaw stdout (first 600 chars):\n${proc.stdout.slice(0, 600)}`
    );
  }

  if (parsed.is_error || !parsed.result) {
    throw new Error(
      `claude CLI returned an error response: ${parsed.error ?? parsed.subtype ?? "(no message)"}\n` +
      `Raw response: ${JSON.stringify(parsed).slice(0, 600)}`
    );
  }

  return {
    content: [{ type: "text", text: parsed.result }],
    stop_reason: "end_turn",
  };
}
