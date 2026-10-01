/**
 * The Codex oracle: `codex debug prompt-input`.
 *
 * The command builds the model-visible input the way a session would and
 * prints it as JSON, without a login and without running a model. The
 * `AGENTS.md` text arrives as one `user` message whose metadata tags it
 * `agents_md.instructions`:
 *
 *     # AGENTS.md instructions for <cwd>
 *
 *     <INSTRUCTIONS>
 *     <global file>\n--- project-doc ---\n\n<root file>\n\n<next file>...
 *     </INSTRUCTIONS>
 *
 * (joins measured on 0.159.2 renders: `codex.join` in docs/rules.md). The
 * next content item of that message is `<environment_context>`, whose
 * `<cwd>` is the render's working directory. The last message is the prompt
 * ctxreach passed, which carries a fresh token: the render must repeat it,
 * or it is not this run's.
 *
 * The renderer sits behind one function (`Renderer`) so that a better
 * oracle, such as the proposed `codex debug agents-md`, can replace it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { OracleError, RenderShapeError, type ChainPiece, type Segment } from "./types.js";

export const AGENTS_KIND = "agents_md.instructions";
export const ENVIRONMENT_KIND = "environments.environment_context";
export const USER_KIND = "user.text";
export const CHAIN_JOIN = "\n\n";
export const PROJECT_DOC_SEPARATOR = "\n--- project-doc ---\n\n";
/** The stderr line Codex prints when its home is under the temp directory; harmless, and recorded. */
export const HELPER_BINARIES_WARNING = "Refusing to create helper binaries";

const TextBlock = z.looseObject({ type: z.string(), text: z.string().optional() });
/**
 * A content item a saved render holds only as a digest (see `reduceRender`): its kind, and the SHA-256 and
 * UTF-8 length of the text it replaced. An item whose text held `<environment_context>` also keeps the one
 * field the scorer reads, its `<cwd>` (null when it had none).
 */
const DigestBlock = z.strictObject({
  kind: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  cwd: z.string().nullable().optional(),
});
const Block = z.union([TextBlock, DigestBlock]);
type Block = z.infer<typeof Block>;
export type DigestBlock = z.infer<typeof DigestBlock>;
const isDigest = (c: Block): c is DigestBlock => DigestBlock.safeParse(c).success;
const textOf = (c: Block | undefined): string => (c === undefined || isDigest(c) ? "" : (c.text ?? ""));
const ENVIRONMENT_TAG = "<environment_context>";
const cwdIn = (text: string): string | undefined => /<cwd>([\s\S]*?)<\/cwd>/.exec(text)?.[1];
const Item = z.looseObject({
  type: z.literal("message"),
  role: z.string(),
  content: z.array(Block),
  internal_chat_message_metadata_passthrough: z
    .looseObject({ content_item_kinds: z.array(z.string()).optional() })
    .optional(),
});
export const PromptInputJson = z.array(Item).min(1);

export interface ParsedRender {
  items: number;
  /** The kinds each item carries, in order. */
  kinds: string[][];
  /** The working directory from the block header, if a block was rendered. */
  headerCwd?: string;
  /** The `<INSTRUCTIONS>` body, without the header and the closing tag; undefined when no AGENTS block was rendered. */
  body?: string;
  /** The `<cwd>` from `<environment_context>`. */
  environmentCwd: string;
  /** The last `user.text` item's text: where the prompt's token must appear. */
  lastUserText?: string;
}

function issuePath(err: z.ZodError): string {
  const first = err.issues[0];
  return first ? `$${first.path.map((p) => `[${JSON.stringify(p)}]`).join("")}: ${first.message}` : "$: invalid";
}

/** Parse and validate one render. Throws `RenderShapeError` naming the JSON path when the shape is not the one known. */
export function parseRender(raw: string): ParsedRender {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RenderShapeError("$", "the render is not JSON");
  }
  const parsed = PromptInputJson.safeParse(value);
  if (!parsed.success) throw new RenderShapeError(issuePath(parsed.error), "the render does not match the known shape");
  const items = parsed.data;
  const kinds = items.map((it) => it.internal_chat_message_metadata_passthrough?.content_item_kinds ?? []);
  const out: ParsedRender = { items: items.length, kinds, environmentCwd: "" };

  const envIndex = kinds.findIndex((k) => k.includes(ENVIRONMENT_KIND));
  if (envIndex < 0)
    throw new RenderShapeError(
      "$[*].internal_chat_message_metadata_passthrough.content_item_kinds",
      `no item carries ${ENVIRONMENT_KIND}`,
    );
  // A saved render holds the environment context as a digest that kept its cwd (see reduceRender).
  const envBlock = items[envIndex]?.content.find(
    (c) => textOf(c).includes(ENVIRONMENT_TAG) || (isDigest(c) && c.cwd !== undefined),
  );
  const cwd = envBlock !== undefined && isDigest(envBlock) ? envBlock.cwd : cwdIn(textOf(envBlock));
  if (!cwd) throw new RenderShapeError(`$[${envIndex}].content`, "no <environment_context> with a <cwd>");
  out.environmentCwd = cwd;

  const agentsIndex = kinds.findIndex((k) => k.includes(AGENTS_KIND));
  if (agentsIndex >= 0) {
    const item = items[agentsIndex];
    const text = item?.content.map(textOf).find((t) => t.startsWith("# AGENTS.md instructions for "));
    if (text === undefined)
      throw new RenderShapeError(
        `$[${agentsIndex}].content`,
        `the item tagged ${AGENTS_KIND} has no "# AGENTS.md instructions for" text`,
      );
    const m = /^# AGENTS\.md instructions for ([^\n]+)\n\n<INSTRUCTIONS>\n([\s\S]*)\n<\/INSTRUCTIONS>$/.exec(text);
    if (!m?.[1] || m[2] === undefined)
      throw new RenderShapeError(
        `$[${agentsIndex}].content[*].text`,
        "the AGENTS block is not header + <INSTRUCTIONS>...</INSTRUCTIONS>",
      );
    out.headerCwd = m[1];
    out.body = m[2];
  }

  const userIndex = kinds
    .map((k, i) => (k.includes(USER_KIND) ? i : -1))
    .filter((i) => i >= 0)
    .at(-1);
  if (userIndex !== undefined) {
    const text = items[userIndex]?.content.map(textOf).join("\n");
    if (text !== undefined) out.lastUserText = text;
  }
  return out;
}

/** The kind a digest carries for content Codex did not tag, or that is not a message at all. */
export const UNTAGGED_KIND = "(untagged)";
/** The longest `type` or `role` a reduced render keeps as it is; a longer one is text, and is digested. */
const SHORT_FIELD = 64;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** A digest of one piece of a render: its kind, and the SHA-256 and UTF-8 length of its text (of its JSON when it has none). */
function digestOf(kind: string, value: unknown): DigestBlock {
  const text = (value as { text?: unknown } | null | undefined)?.text;
  const hashed = typeof text === "string" ? text : (JSON.stringify(value) ?? "");
  const out: DigestBlock = { kind, sha256: sha256(hashed), bytes: Buffer.byteLength(hashed, "utf8") };
  if (typeof text === "string" && text.includes(ENVIRONMENT_TAG)) out.cwd = cwdIn(text) ?? null;
  return out;
}

function reduceBlock(block: unknown, kind: string | undefined): unknown {
  if (DigestBlock.safeParse(block).success) return block;
  const b = block as { type?: unknown; text?: unknown } | null | undefined;
  const whole = kind === AGENTS_KIND || kind === USER_KIND;
  if (whole && typeof b?.type === "string" && (b.text === undefined || typeof b.text === "string"))
    return b.text === undefined ? { type: b.type } : { type: b.type, text: b.text };
  return digestOf(kind ?? UNTAGGED_KIND, block);
}

/**
 * A render reduced to what ctxreach scores, for saving. `codex debug
 * prompt-input` prints Codex's whole model input, and most of it is
 * OpenAI's own prompt text (the developer items: skills, permissions,
 * collaboration mode, multi-agent role), which ctxreach does not publish.
 *
 * Kept, per message: `type`, `role` and `content_item_kinds`. Kept whole,
 * per content item: the one tagged `agents_md.instructions` and
 * ctxreach's own prompt (`user.text`). Every other content item becomes
 * `{kind, sha256, bytes}` (the hash and UTF-8 length of its text), and an
 * environment context also keeps its `<cwd>`, the one field the scorer
 * reads. Ids, timestamps and every other field are dropped.
 *
 * `parseRender` reads a reduced render of the known shape (one kind per
 * content item, as 0.159.2 prints) exactly as it read the whole one, so a
 * run scores the same from either. Any other shape is still refused: a
 * message whose kinds do not line up with its content has every item
 * digested, since which one is the AGENTS block cannot be told. Reducing a
 * reduced render changes nothing.
 */
export function reduceRender(value: unknown): unknown {
  if (!Array.isArray(value)) return digestOf(UNTAGGED_KIND, value);
  return value.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return digestOf(UNTAGGED_KIND, item);
    const message = item as Record<string, unknown>;
    const meta = message.internal_chat_message_metadata_passthrough as { content_item_kinds?: unknown } | undefined;
    const tagged = meta?.content_item_kinds;
    const kinds =
      Array.isArray(tagged) && tagged.every((k) => typeof k === "string") ? (tagged as string[]) : undefined;
    const content = message.content;
    const aligned = Array.isArray(content) && kinds !== undefined && kinds.length === content.length ? kinds : [];
    const out: Record<string, unknown> = {};
    for (const key of ["type", "role"]) {
      const v = message[key];
      if (v !== undefined) out[key] = typeof v === "string" && v.length <= SHORT_FIELD ? v : digestOf(key, v);
    }
    if (Array.isArray(content)) out.content = content.map((block, j) => reduceBlock(block, aligned[j]));
    else if (content !== undefined) out.content = digestOf(UNTAGGED_KIND, content);
    if (kinds !== undefined) out.internal_chat_message_metadata_passthrough = { content_item_kinds: kinds };
    return out;
  });
}

/** The `<INSTRUCTIONS>` body `map`'s chain predicts: global file, separator, chain files joined by a blank line. */
export function expectedBody(pieces: readonly ChainPiece[]): string {
  const global = pieces.find((p) => p.status === "global" && p.text !== "")?.text;
  const project = pieces
    .filter((p) => p.status !== "global" && p.text !== "")
    .map((p) => p.text)
    .join(CHAIN_JOIN);
  if (global !== undefined && project !== "") return global + PROJECT_DOC_SEPARATOR + project;
  return global ?? project;
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/**
 * Split the rendered body into one segment per predicted chain file, in
 * `map`'s order, and say for each whether the render held exactly the bytes
 * `map` predicted. A file predicted absent must not appear at all.
 */
export function blockSegments(
  body: string | undefined,
  pieces: readonly ChainPiece[],
): { segments: Segment[]; whole: boolean } {
  const observed = body ?? "";
  const whole = observed === expectedBody(pieces);
  const segments: Segment[] = [];
  /** The first 40 characters of what a file would contribute, delivered or not; "" when it has none. */
  const headOf = (p: ChainPiece) => (p.text !== "" ? p.text : p.head).trim().slice(0, 40);
  /** Where, in `rest`, the next file after `index` starts (searching from 1, so a file cannot end where it begins), or -1. */
  const boundary = (rest: string, index: number): number => {
    for (const later of pieces.slice(index + 1)) {
      const head = headOf(later);
      if (!head) continue;
      const at = rest.indexOf(head, 1);
      if (at >= 0) return at;
    }
    return -1;
  };
  const trimSeparator = (s: string) => s.replace(/\n\n$|\n--- project-doc ---\n\n$/, "");
  let pos = 0;
  let previous: ChainPiece | undefined;
  pieces.forEach((piece, index) => {
    const base = { file: piece.file, status: piece.status, bytes: piece.bytes, predictedBytes: piece.keptBytes };
    if (piece.text === "") {
      const head = headOf(piece);
      const at = head ? observed.indexOf(head, pos) : -1;
      if (at < 0) {
        segments.push({ ...base, observedBytes: 0, verdict: "EXACT" });
        return;
      }
      const rest = observed.slice(at);
      const end = boundary(rest, index);
      const segment = end >= 0 ? trimSeparator(rest.slice(0, end)) : rest;
      segments.push({
        ...base,
        observedBytes: bytes(segment),
        verdict: "EXTRA",
        note: "predicted absent, but its text is in the render",
      });
      pos = at + segment.length;
      return;
    }
    const sep = previous === undefined ? "" : previous.status === "global" ? PROJECT_DOC_SEPARATOR : CHAIN_JOIN;
    const start = pos + (observed.startsWith(sep, pos) ? sep.length : 0);
    const rest = observed.slice(start);
    // The segment ends where the next file starts, or at the end of the body.
    const end = boundary(rest, index);
    // After the last predicted file, text that follows the whole file and a join is another file
    // (reported as EXTRA below), not more of this one; without the join it is more of this one.
    const bounded = end >= 0 ? trimSeparator(rest.slice(0, end)) : rest;
    const joined = [CHAIN_JOIN, PROJECT_DOC_SEPARATOR].some((j) => bounded.startsWith(piece.text + j));
    const segment = end < 0 && joined ? piece.text : bounded;
    const observedBytes = bytes(segment);
    const prefix = commonPrefix(segment, piece.text);
    if (segment === piece.text) {
      segments.push({ ...base, observedBytes, verdict: "EXACT" });
    } else if (prefix >= Math.min(16, piece.text.length)) {
      const same = prefix === Math.min(segment.length, piece.text.length);
      segments.push({
        ...base,
        observedBytes,
        verdict: "OFF BY",
        offBy: observedBytes - bytes(piece.text),
        ...(same ? {} : { note: `differs after ${bytes(segment.slice(0, prefix))} bytes` }),
      });
    } else {
      segments.push({
        ...base,
        observedBytes: 0,
        verdict: "MISSING",
        note: "predicted delivered, but its text is not in the render",
      });
      return;
    }
    pos = start + segment.length;
    previous = piece;
  });
  if (pos < observed.length && observed.slice(pos).trim() !== "")
    segments.push({
      file: "(text map predicted for no file)",
      status: "loaded",
      bytes: 0,
      predictedBytes: 0,
      observedBytes: bytes(observed.slice(pos)),
      verdict: "EXTRA",
    });
  return { segments, whole };
}

export interface CodexBin {
  command: string;
  args: string[];
  /** How to show it. */
  shown: string;
}

/**
 * The Codex executable. npm installs `codex` as a `.cmd` shim on Windows,
 * which cannot be started without a shell; the JavaScript launcher behind it
 * is run with the current node instead. Only absolute PATH directories are
 * searched, for the same reason as for `claude` (see agents/claude/adapter.ts).
 */
export function resolveCodexBin(given: string | undefined, env: NodeJS.ProcessEnv = process.env): CodexBin | undefined {
  const asBin = (p: string): CodexBin => {
    if (p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs"))
      return { command: process.execPath, args: [p], shown: p };
    if (process.platform === "win32" && path.extname(p).toLowerCase() === ".cmd") {
      const launcher = path.join(path.dirname(p), "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(launcher)) return { command: process.execPath, args: [launcher], shown: launcher };
    }
    return { command: p, args: [], shown: p };
  };
  const chosen = given ?? env.CTXREACH_CODEX_BIN;
  if (chosen) return asBin(path.resolve(chosen));
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((d) => path.isAbsolute(d));
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  for (const dir of dirs)
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (statSync(p).isFile()) return asBin(p);
      } catch {
        // Not in this directory.
      }
    }
  return undefined;
}

/**
 * The environment a render runs with: the user's, minus every API key and
 * proxy, with every proxy variable pointed at a closed port, so the render
 * cannot reach a network even by accident. `CODEX_HOME` is the throwaway.
 */
export function renderEnv(base: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(base).filter(
      ([k]) => !/^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_HOME|HTTPS?_PROXY|ALL_PROXY|NO_PROXY)$/i.test(k),
    ),
  );
  const dead = "http://127.0.0.1:9";
  return { ...env, CODEX_HOME: codexHome, HTTPS_PROXY: dead, HTTP_PROXY: dead, ALL_PROXY: dead, NO_PROXY: "" };
}

export interface RenderRequest {
  bin: CodexBin;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** `-c key=value` overrides, each one string. */
  overrides: string[];
  prompt: string;
  timeoutMs: number;
}

export interface RenderOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export type Renderer = (request: RenderRequest) => RenderOutcome;

/** The default renderer: `codex debug prompt-input -c ... "<prompt>"`. */
export const promptInputRenderer: Renderer = (request) => {
  const started = Date.now();
  const args = [
    ...request.bin.args,
    "debug",
    "prompt-input",
    ...request.overrides.flatMap((o) => ["-c", o]),
    request.prompt,
  ];
  const r = spawnSync(request.bin.command, args, {
    cwd: request.cwd,
    env: request.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: request.timeoutMs,
    windowsHide: true,
  });
  if (r.error) throw new OracleError(`could not run ${request.bin.shown}: ${r.error.message}`);
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status, durationMs: Date.now() - started };
};

export type HooksFlag = "accepted" | "rejected";

export interface RenderResult extends RenderOutcome {
  /** Stderr lines that are known and harmless. */
  warnings: string[];
  hooksFlag: HooksFlag;
  /** The overrides the accepted render ran with. */
  overrides: string[];
}

/**
 * Render once. `-c features.hooks=false` is passed first (a render starts
 * no session, and the copy has no project hooks, but the flag costs
 * nothing); if Codex rejects the override, the render is repeated without it
 * and the report says so. The output is saved reduced (`reduceRender`)
 * and parsed only when the run is scored, so a render of an unknown shape
 * is kept, as far as its shape can be told, and fails where it differs.
 */
export function renderCodex(
  request: Omit<RenderRequest, "overrides"> & { overrides?: string[] },
  renderer: Renderer = promptInputRenderer,
): RenderResult {
  const extra = request.overrides ?? [];
  const attempt = (overrides: string[]) => renderer({ ...request, overrides });
  let overrides = ["features.hooks=false", ...extra];
  let hooksFlag: HooksFlag = "accepted";
  let out = attempt(overrides);
  if (out.exitCode !== 0 && /feature|hooks/i.test(out.stderr)) {
    overrides = extra;
    hooksFlag = "rejected";
    out = attempt(overrides);
  }
  const warnings = out.stderr
    .split("\n")
    .filter((l) => l.includes(HELPER_BINARIES_WARNING))
    .map((l) => l.trim());
  return { ...out, warnings, hooksFlag, overrides };
}

/** `codex --version`, e.g. `0.159.2`. */
export function codexVersion(bin: CodexBin, env: NodeJS.ProcessEnv): string {
  const r = spawnSync(bin.command, [...bin.args, "--version"], {
    env,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  if (r.error) throw new OracleError(`could not run ${bin.shown} --version: ${r.error.message}`);
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout ?? "");
  if (!m?.[1])
    throw new OracleError(`could not read a version from "${(r.stdout ?? "").trim()}" (${bin.shown} --version)`);
  return m[1];
}
