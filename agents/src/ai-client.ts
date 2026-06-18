import { spawnSync } from "child_process";
import Anthropic from "@anthropic-ai/sdk";

// ─────────────────────────────────────────────────────────────────────────────
// AI client — dual-mode.
//
//   • If ANTHROPIC_API_KEY is set → call the Anthropic Messages API directly via
//     @anthropic-ai/sdk. This is what you want for headless/cloud deploys (GCP),
//     where the interactive `claude login` CLI isn't available. Billed per-token.
//   • Otherwise → shell out to the local `claude` CLI (Claude Code) in headless
//     JSON mode, using your existing `claude login` (no API key; counts against
//     your Claude Pro/Max subscription). Best for local dev.
//
// Every model call in the agent funnels through createMessage(), so this is the
// single switch point — no call site changes.
//
// Env:
//   ANTHROPIC_API_KEY — when set, use the API instead of the CLI
//   ANTHROPIC_MODEL   — model id (default claude-opus-4-8). Aliases opus/sonnet/
//                       haiku are mapped to current ids in API mode.
//   CLAUDE_BIN        — claude binary path for CLI mode (default `claude`)
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const USE_API = Boolean(process.env.ANTHROPIC_API_KEY);

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
  return USE_API ? createViaApi(params) : createViaCli(params);
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
