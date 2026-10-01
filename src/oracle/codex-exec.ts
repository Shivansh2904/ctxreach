/**
 * A second Codex instrument: a real `codex exec` turn whose model provider
 * is the loopback recorder. The session sends one `POST /v1/responses`
 * whose `input` holds the same `# AGENTS.md instructions` block the render
 * shows; the recorder answers 400 and the turn fails at once.
 *
 * It needs no login: the provider is declared in the throwaway
 * `CODEX_HOME`'s `config.toml` with a dummy `env_key`, retries 0. Checked
 * on 0.159.2 (2026-09-30): the request equalled the render on one fixture.
 * `verify` does not run it; the study can, where a render-versus-turn
 * check is wanted.
 */
import { spawnSync } from "node:child_process";
import { OracleError } from "./types.js";
import { type CodexBin } from "./codex-render.js";

export const CAPTURE_PROVIDER = "ctxr_capture";
export const CAPTURE_ENV_KEY = "CTXR_CAPTURE_KEY";

/** `config.toml` lines that route every model request to the recorder. Appended to the throwaway home's config. */
export function captureProviderToml(baseUrl: string, model = "gpt-5.5"): string {
  return [
    `model = ${JSON.stringify(model)}`,
    `model_provider = ${JSON.stringify(CAPTURE_PROVIDER)}`,
    `[model_providers.${CAPTURE_PROVIDER}]`,
    `name = ${JSON.stringify(CAPTURE_PROVIDER)}`,
    `base_url = ${JSON.stringify(`${baseUrl}/v1`)}`,
    `wire_api = "responses"`,
    `env_key = ${JSON.stringify(CAPTURE_ENV_KEY)}`,
    `request_max_retries = 0`,
    `stream_max_retries = 0`,
    "",
  ].join("\n");
}

/** `codex exec --ephemeral --sandbox read-only --json <prompt>`; stdin is closed, or Codex waits on it. */
export function execArgs(prompt: string): string[] {
  return ["exec", "--ephemeral", "--sandbox", "read-only", "--json", "--skip-git-repo-check", prompt];
}

export interface ResponsesBody {
  model?: string;
  /** The `<INSTRUCTIONS>` body of the AGENTS block, if the request carried one. */
  body?: string;
  headerCwd?: string;
  /** The `<cwd>` from `<environment_context>`, if present. */
  environmentCwd?: string;
  /** Every `input_text` of the `input` items, in order. */
  texts: string[];
}

/** Parse a captured `/v1/responses` request body. Throws `OracleError` when it is not one. */
export function parseResponsesBody(raw: string): ResponsesBody {
  let value: { model?: unknown; input?: unknown };
  try {
    value = JSON.parse(raw) as typeof value;
  } catch {
    throw new OracleError("the captured Codex request body is not JSON");
  }
  if (!Array.isArray(value.input)) throw new OracleError("the captured Codex request body has no input array");
  const texts: string[] = [];
  for (const item of value.input as { content?: unknown }[]) {
    if (!Array.isArray(item.content)) continue;
    for (const c of item.content as { type?: unknown; text?: unknown }[])
      if (c.type === "input_text" && typeof c.text === "string") texts.push(c.text);
  }
  const out: ResponsesBody = { ...(typeof value.model === "string" ? { model: value.model } : {}), texts };
  const block = texts.find((t) => t.startsWith("# AGENTS.md instructions for "));
  if (block !== undefined) {
    const m = /^# AGENTS\.md instructions for ([^\n]+)\n\n<INSTRUCTIONS>\n([\s\S]*)\n<\/INSTRUCTIONS>$/.exec(block);
    if (!m?.[1] || m[2] === undefined)
      throw new OracleError("the AGENTS block in the Codex request is not header + <INSTRUCTIONS>");
    out.headerCwd = m[1];
    out.body = m[2];
  }
  const env = texts.find((t) => t.includes("<environment_context>"));
  const cwd = /<cwd>([\s\S]*?)<\/cwd>/.exec(env ?? "");
  if (cwd?.[1]) out.environmentCwd = cwd[1];
  return out;
}

export interface ExecRequest {
  bin: CodexBin;
  cwd: string;
  /** The render environment (throwaway `CODEX_HOME` whose config declares the provider) plus the dummy key. */
  env: NodeJS.ProcessEnv;
  prompt: string;
  timeoutMs: number;
}

export interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

/** Run one turn against the recorder. The request the recorder holds afterwards is the evidence; the turn itself fails. */
export function runCodexExec(request: ExecRequest): ExecOutcome {
  const started = Date.now();
  const r = spawnSync(request.bin.command, [...request.bin.args, ...execArgs(request.prompt)], {
    cwd: request.cwd,
    env: { ...request.env, [CAPTURE_ENV_KEY]: "ctxr-dummy-not-a-key" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: request.timeoutMs,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw new OracleError(`could not run ${request.bin.shown} exec: ${r.error.message}`);
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status, durationMs: Date.now() - started };
}
