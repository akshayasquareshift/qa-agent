import { spawnSync } from "child_process";

// ─────────────────────────────────────────────────────────────────────────────
// AI client — shells out to the `claude` CLI (Claude Code) in headless mode.
//
// Auth: uses your existing Claude Code OAuth login (`claude login`).
// No API key required. Calls count against your Claude Pro/Max subscription.
//
// Override the binary path or model via env:
//   CLAUDE_BIN        — defaults to `claude` (must be on PATH)
//   ANTHROPIC_MODEL   — defaults to `claude-opus-4-7` (aliases like `opus`,
//                       `sonnet`, `haiku` also work)
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

interface CliJsonResponse {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
  session_id?: string;
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

export async function createMessage(params: {
  model?: string;
  max_tokens: number; // accepted for API parity; the CLI manages its own output budget
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ content: Array<{ type: "text"; text: string }>; stop_reason: string }> {
  const prompt = buildPrompt(params.messages);

  const args = [
    "-p",
    "--output-format", "json",
    "--model", params.model ?? MODEL,
  ];
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
        `and run \`claude login\`, or set CLAUDE_BIN to the absolute path of the claude binary.`
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
