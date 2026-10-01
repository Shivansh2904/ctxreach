/**
 * The Claude Code oracle: a headless session whose model endpoint is the
 * loopback recorder (`capture.ts`).
 *
 * Claude Code sends its first request before it needs any answer, and the
 * instruction files it loaded at launch are in that request, as
 * `<system-reminder>` text blocks of the first user message: a line of
 * Claude Code's own text, then one section per file,
 *
 *     <system-reminder>
 *     (Claude Code's preamble)
 *
 *     Contents of C:\...\repo\AGENTS.md (project instructions, checked into the codebase):
 *
 *     # Root agents
 *     ...
 *     </system-reminder>
 *
 * (shape from 2.1.285 captures, 2026-09-30). The recorder answers 400, the
 * session reports the error and stops; nothing is billed and no model runs.
 *
 * Everything else in the request is Claude Code's own prompt text (its
 * system prompt, the environment and git status blocks, the preambles),
 * which is not ctxreach's to publish. A request is saved reduced to what
 * the scorer reads (`reduceCaptureBody`).
 *
 * The run needs: Claude Code 2.1.281 or later (AGENTS.md reaches gateway
 * sessions from that version); a fresh, empty `CLAUDE_CONFIG_DIR` (or a
 * scratch home given with `--home`, for the `~/.claude/CLAUDE.md` cells);
 * a dummy `ANTHROPIC_API_KEY`; `ANTHROPIC_BASE_URL` at the recorder; the
 * parent session's variables removed (as the probe adapter removes them);
 * the probe's flags; and `--model` pinned, asserted against `system/init`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { agentEnv, claudeArgs } from "../agents/claude/adapter.js";
import { AGENTS_MD_PLUGIN, compareVersions } from "../agents/claude/settings.js";
import { OracleError } from "./types.js";
import type { DeliveredFile } from "./types.js";

export const CAPTURE_MIN_VERSION = "2.1.281";
export const DUMMY_API_KEY = "ctxr-dummy-not-a-key";
/** Settings that turn instruction files off; a run with one of them set is refused. */
export const KILL_SWITCHES = [
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
  "CLAUDE_CODE_DISABLE_ATTACHMENTS",
] as const;

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/** Throws `OracleError` when a variable that skips instruction files is set. */
export function assertNoKillSwitch(env: NodeJS.ProcessEnv): void {
  const on = KILL_SWITCHES.filter((k) => truthy(env[k]));
  if (on.length)
    throw new OracleError(`${on.join(", ")} is set, which turns instruction files off; unset it before verifying`);
}

/** Throws `OracleError` when the version cannot deliver AGENTS.md to a custom endpoint. */
export function assertCaptureVersion(version: string): void {
  if (compareVersions(version, CAPTURE_MIN_VERSION) < 0)
    throw new OracleError(
      `Claude Code ${version} sends CLAUDE.md only to a custom base URL; capture needs ${CAPTURE_MIN_VERSION} or later`,
    );
}

export interface CaptureEnvOptions {
  baseUrl: string;
  /** A fresh, empty directory: the default isolation. */
  configDir?: string;
  /** A scratch home directory instead: `~` follows it and `CLAUDE_CONFIG_DIR` is unset (the `$HOME` cells). */
  home?: string;
}

/**
 * The agent's environment: the caller's, minus the parent session's
 * variables, every `ANTHROPIC_*` and cloud-provider setting, every OAuth
 * token and every proxy (the endpoint is loopback), plus the capture
 * settings.
 */
export function captureEnv(
  base: NodeJS.ProcessEnv,
  options: CaptureEnvOptions,
): { env: NodeJS.ProcessEnv; removed: string[] } {
  assertNoKillSwitch(base);
  const stripped = agentEnv(base);
  const removed = [...stripped.removed];
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(stripped.env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(k)) {
      removed.push(k);
      continue;
    }
    env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = options.baseUrl;
  env.ANTHROPIC_API_KEY = DUMMY_API_KEY;
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_AUTOUPDATER = "1";
  env.NO_PROXY = "127.0.0.1,localhost";
  if (options.home !== undefined) {
    env.USERPROFILE = options.home;
    env.HOME = options.home;
    delete env.CLAUDE_CONFIG_DIR;
    delete env.HOMEDRIVE;
    delete env.HOMEPATH;
  } else {
    if (options.configDir === undefined)
      throw new OracleError("a capture run needs a fresh CLAUDE_CONFIG_DIR or a scratch home");
    env.CLAUDE_CONFIG_DIR = options.configDir;
  }
  return { env, removed: removed.sort() };
}

/** The probe's recall-mode flags, plus the model pin and, when given, a `--settings` file (for example L3's hook). */
export function captureArgs(model: string, settingsFile?: string): string[] {
  if (!model) throw new OracleError("a capture run needs --model: the model is asserted from system/init");
  return [
    ...claudeArgs("recall"),
    "--model",
    model,
    ...(settingsFile !== undefined ? ["--settings", settingsFile] : []),
  ];
}

export interface InitInfo {
  found: boolean;
  cwd?: string;
  model?: string;
  version?: string;
  /** Each plugin as `source`, or `name@path` when it has no source. */
  plugins: string[];
}

/** The `system/init` event's facts, read leniently from the raw stream (before or after redaction). */
export function initInfo(stdout: string): InitInfo {
  for (const raw of stdout.split("\n")) {
    if (!raw.includes('"init"')) continue;
    let e: {
      type?: unknown;
      subtype?: unknown;
      cwd?: unknown;
      model?: unknown;
      claude_code_version?: unknown;
      plugins?: unknown;
    };
    try {
      e = JSON.parse(raw) as typeof e;
    } catch {
      continue;
    }
    if (e.type !== "system" || e.subtype !== "init") continue;
    const plugins = Array.isArray(e.plugins)
      ? (e.plugins as { name?: unknown; path?: unknown; source?: unknown }[]).map((p) =>
          typeof p.source === "string" ? p.source : `${String(p.name)}@${String(p.path)}`,
        )
      : [];
    return {
      found: true,
      ...(typeof e.cwd === "string" ? { cwd: e.cwd } : {}),
      ...(typeof e.model === "string" ? { model: e.model } : {}),
      ...(typeof e.claude_code_version === "string" ? { version: e.claude_code_version } : {}),
      plugins,
    };
  }
  return { found: false, plugins: [] };
}

export function hasAgentsMdPlugin(init: InitInfo): boolean {
  // 2.1.280 listed the built-in as `agents-md@builtin`; 2.1.285 lists it as `cc-plugin-agents-md@builtin`.
  return init.plugins.some((p) => p === AGENTS_MD_PLUGIN || p === `cc-plugin-${AGENTS_MD_PLUGIN}`);
}

/**
 * Block-level HTML comments, which Claude Code strips from an instruction
 * file before injecting it (memory docs): a comment that fills whole lines.
 */
export function stripHtmlComments(text: string): string {
  return text.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*(?:\r?\n|$)/gm, "");
}

const REMINDER = /<system-reminder>\n([\s\S]*?)\n<\/system-reminder>/g;
const CONTENTS = /^Contents of (.+) \(([^\n]*)\):$/;

export interface CaptureBody {
  model?: string;
  /** The `Primary working directory` the request's Environment block names, when it has one. */
  cwd?: string;
  /**
   * The text of every block of the system prompt and of every message, in order, as far as it is saved:
   * ctxreach's prompt whole; for a block saved as a digest, the instruction files it carried and the
   * canary-form tokens it held. Where the must-appear token is looked for.
   */
  texts: string[];
  /** The instruction files the reminders carry, in order. */
  files: DeliveredFile[];
}

const PRIMARY_CWD = /^\s*- Primary working directory: (.+?)\s*$/m;
/** Every token of the canary form, overlapping ones included, never followed by another hex digit (as `score.ts` matches). */
const CANARY_FORM = /(?=(CTXR-[0-9a-fA-F]{8})(?![0-9a-fA-F]))/g;

/**
 * What a saved capture holds in place of a part of the request: its kind, the SHA-256 and UTF-8 length of
 * its text (of its JSON when it has no text), and, from a text, only what the scorer reads: the working
 * directory an Environment block names, the instruction files its reminders carry, and the canary-form
 * tokens it held outside those files.
 */
export const CaptureDigestJson = z.strictObject({
  kind: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  cwd: z.string().optional(),
  files: z.array(z.strictObject({ path: z.string(), label: z.string(), text: z.string() })).optional(),
  tokens: z.array(z.string()).optional(),
});
export type CaptureDigest = z.infer<typeof CaptureDigestJson>;
const isDigest = (v: unknown): v is CaptureDigest => CaptureDigestJson.safeParse(v).success;

/** One block of the request as the scorer reads it. */
interface Piece {
  text: string;
  files: DeliveredFile[];
  cwd?: string;
}

const tokensIn = (text: string): string[] => [...text.matchAll(CANARY_FORM)].map((m) => m[1] ?? "");

/** The instruction files of every `<system-reminder>` in one text. */
function reminderFiles(text: string): DeliveredFile[] {
  return [...text.matchAll(REMINDER)].flatMap((m) => filesInReminder(m[1] ?? ""));
}

function textPiece(text: string): Piece {
  const cwd = PRIMARY_CWD.exec(text)?.[1];
  return { text, files: reminderFiles(text), ...(cwd !== undefined ? { cwd } : {}) };
}

function digestPiece(d: CaptureDigest): Piece {
  const files = d.files ?? [];
  return {
    text: [...files.map((f) => f.text), ...(d.tokens ?? [])].join("\n"),
    files,
    ...(d.cwd !== undefined ? { cwd: d.cwd } : {}),
  };
}

/** Parse a `/v1/messages` request body, whole or as saved. Throws `OracleError` when it is not one. */
export function parseCaptureBody(body: string): CaptureBody {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new OracleError("the captured request body is not JSON");
  }
  const request = (value !== null && typeof value === "object" ? value : {}) as {
    model?: unknown;
    messages?: unknown;
    system?: unknown;
  };
  if (!Array.isArray(request.messages)) throw new OracleError("the captured request body has no messages array");
  const pieces: Piece[] = [];
  const blocks = (content: unknown) => {
    if (typeof content === "string") pieces.push(textPiece(content));
    else if (isDigest(content)) pieces.push(digestPiece(content));
    else if (Array.isArray(content))
      for (const c of content as unknown[]) {
        if (isDigest(c)) pieces.push(digestPiece(c));
        else {
          const text = (c as { text?: unknown } | null)?.text;
          if (typeof text === "string") pieces.push(textPiece(text));
        }
      }
  };
  blocks(request.system);
  for (const m of request.messages as unknown[]) blocks((m as { content?: unknown } | null)?.content);

  const cwd = pieces.map((p) => p.cwd).find((c) => c !== undefined);
  return {
    ...(typeof request.model === "string" ? { model: request.model } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    texts: pieces.map((p) => p.text),
    files: pieces.flatMap((p) => p.files),
  };
}

/** The longest `role` or block `type` a saved capture keeps as it is; a longer one is text, and is digested. */
const SHORT_FIELD = 64;
/** The kind a digest carries for a block that has no short `type`. */
export const UNTYPED_KIND = "(untyped)";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * A digest of one part of a request. With `read` (a text block, or a content given as a string: the parts
 * `parseCaptureBody` reads), it also keeps what the scorer reads from the text.
 */
function digestOf(kind: string, value: unknown, read = false): CaptureDigest {
  const text = typeof value === "string" ? value : (value as { text?: unknown } | null | undefined)?.text;
  const hashed = typeof text === "string" ? text : (JSON.stringify(value) ?? "");
  const out: CaptureDigest = { kind, sha256: sha256(hashed), bytes: Buffer.byteLength(hashed, "utf8") };
  if (!read || typeof text !== "string") return out;
  const piece = textPiece(text);
  const inFiles = new Set(piece.files.flatMap((f) => tokensIn(f.text)));
  const tokens = [...new Set(tokensIn(text))].filter((t) => !inFiles.has(t));
  if (piece.cwd !== undefined) out.cwd = piece.cwd;
  if (piece.files.length) out.files = piece.files;
  if (tokens.length) out.tokens = tokens;
  return out;
}

const shortString = (v: unknown): v is string => typeof v === "string" && v.length <= SHORT_FIELD;

/** A system prompt or a message's content: ctxreach's prompt kept whole, every other block a digest. */
function reduceContent(content: unknown, prompt: string | undefined): unknown {
  if (isDigest(content)) return content;
  if (typeof content === "string") return content === prompt ? content : digestOf("text", content, true);
  if (!Array.isArray(content)) return digestOf(UNTYPED_KIND, content);
  return content.map((block: unknown) => {
    if (isDigest(block)) return block;
    const b = block as { type?: unknown; text?: unknown } | null | undefined;
    if (typeof b?.text === "string" && b.text === prompt)
      return shortString(b.type) ? { type: b.type, text: b.text } : { text: b.text };
    return digestOf(shortString(b?.type) ? b.type : UNTYPED_KIND, block, typeof b?.text === "string");
  });
}

function reduceMessage(message: unknown, prompt: string | undefined): unknown {
  if (message === null || typeof message !== "object" || Array.isArray(message) || isDigest(message))
    return isDigest(message) ? message : digestOf("message", message);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(message)) {
    if (key === "role" && shortString(v)) out.role = v;
    else if (key === "content") out.content = reduceContent(v, prompt);
    else out[key] = isDigest(v) ? v : digestOf(key, v);
  }
  return out;
}

/**
 * A request body reduced to what ctxreach scores, for saving. Claude Code's
 * request carries its whole prompt (system prompt, environment and git
 * status blocks, the preamble of each reminder), which ctxreach does not
 * publish.
 *
 * Kept: `model`, each message's `role`, and every block of the system
 * prompt or a message whose text is exactly `prompt` (ctxreach's own).
 * Every other block, and every other field of the request, becomes
 * `{kind, sha256, bytes}` (the hash and UTF-8 length of its text, or of
 * its JSON when it has none), and a block that had text also keeps what
 * the scorer reads from it: the working directory an Environment block
 * names (`cwd`), the instruction files its reminders carry, each as path,
 * label and text (`files`), and any canary-form token outside those files
 * (`tokens`).
 *
 * `parseCaptureBody` reads a saved body as it read the whole one: the same
 * model, working directory and files, and every token the scorer looks for
 * in the request present in one exactly when it is in the other. A body
 * that is not JSON is not saved: a line giving its length and SHA-256
 * stands in for it, and fails to parse as the body did. Reducing a reduced
 * body with the same prompt changes nothing.
 */
export function reduceCaptureBody(body: string, prompt?: string): string {
  if (body === "") return body;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return `ctxreach: the request body was ${Buffer.byteLength(body, "utf8")} bytes that are not JSON (sha256 ${sha256(body)}); not saved, since they may hold Claude Code's own prompt text.`;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || isDigest(value))
    return JSON.stringify(isDigest(value) ? value : digestOf("body", value));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "model" && typeof v === "string") out.model = v;
    else if (key === "messages" && Array.isArray(v)) out.messages = v.map((m: unknown) => reduceMessage(m, prompt));
    else if (key === "system") out.system = reduceContent(v, prompt);
    else out[key] = isDigest(v) ? v : digestOf(key, v);
  }
  return JSON.stringify(out);
}

/** The `Contents of <path> (<label>):` sections of one reminder body. */
export function filesInReminder(reminder: string): DeliveredFile[] {
  const lines = reminder.split("\n");
  const out: DeliveredFile[] = [];
  let current: { path: string; label: string; lines: string[] } | undefined;
  const flush = () => {
    if (!current) return;
    // One blank line separates the header from the text and the text from the next header.
    const body = current.lines.join("\n").replace(/^\n/, "").replace(/\n$/, "");
    out.push({ path: current.path, label: current.label, text: body });
    current = undefined;
  };
  for (const line of lines) {
    const m = CONTENTS.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) {
      flush();
      current = { path: m[1], label: m[2], lines: [] };
    } else if (current) current.lines.push(line);
  }
  flush();
  return out;
}

export interface CaptureRunRequest {
  /** The executable, and arguments placed before ctxreach's own (a wrapper such as `node fake.mjs`, used by the tests). */
  bin: string;
  prefixArgs?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  args: string[];
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CaptureRunOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

const STDERR_KEEP = 4000;

/** Run one session and return what it printed. The caller has already checked the copy (`assertReadyToRun`). */
export async function runClaudeCapture(request: CaptureRunRequest): Promise<CaptureRunOutcome> {
  const started = Date.now();
  const child = spawn(request.bin, [...(request.prefixArgs ?? []), ...request.args], {
    cwd: request.cwd,
    env: request.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  request.signal?.addEventListener("abort", stop, { once: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d: string) => (stdout += d));
  child.stderr.on("data", (d: string) => {
    if (stderr.length < STDERR_KEEP) stderr += d;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, request.timeoutMs);
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
    child.stdin.on("error", () => undefined);
    child.stdin.end(request.prompt);
  }).finally(() => {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", stop);
  });
  return { stdout, stderr: stderr.slice(0, STDERR_KEEP), exitCode, timedOut, durationMs: Date.now() - started };
}

/** `claude --version` under the same environment as the runs (never without it). */
export async function claudeCaptureVersion(bin: string, prefixArgs: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const out = await runClaudeCapture({
    bin,
    prefixArgs,
    cwd: path.dirname(bin),
    env,
    args: ["--version"],
    prompt: "",
    timeoutMs: 60_000,
  });
  const m = /(\d+\.\d+\.\d+)/.exec(out.stdout);
  if (!m?.[1]) throw new OracleError(`could not read a version from "${out.stdout.trim()}" (${bin} --version)`);
  return m[1];
}
