import { spawnSync } from "child_process";

// Shells out to the local `claude` CLI in headless JSON mode. Identical pattern
// to ../../agents/src/ai-client.ts — kept inline so this package has no
// cross-package source dependency.

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

interface CliJsonResponse {
  is_error?: boolean;
  result?: string;
  error?: string;
  subtype?: string;
}

export async function askClaude(opts: {
  system?: string;
  prompt: string;
  model?: string;
}): Promise<string> {
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
          `or set CLAUDE_BIN to the absolute path of the claude binary.`
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
