// Copy one pilot artefact into study/pilot, reduced to what the study needs
// and nothing a public repository should hold. Kept as the method, so the
// reduction can be checked against the originals (their SHA-256 values are
// in study/pilot/SHA256SUMS-sources.txt).
//
// - Paths: the scratch folder (CTXR_SCRATCH) becomes <scratch>, the home
//   folder <home>, and the scratch folder in Claude Code's project-folder
//   spelling (every other character a dash) <scratch-slug>.
// - Identifiers: session, device, account, installation and window ids,
//   and credential headers, become REDACTED; any other UUID (a transcript's
//   file name, which is its session id, a request or thread id) becomes
//   <uuid>, in every mode.
// - Vendor prompt text in a recorded request or a Codex render is not kept
//   at all, however short (--codex, --claude, --opencode): only what
//   ctxreach scores stays, and every other item becomes {kind, sha256,
//   bytes}, the SHA-256 and UTF-8 size of the original text. Kept: the
//   instruction files the agent delivered (their path and text, never the
//   agent's words around them), ctxreach's own prompt, the working
//   directory, and short identifiers (model names, versions, flags).
//   See reduceClaudeRequest, reduceOpenCodeRequest, reduceCodexRequest and
//   reduceCodexRender below; the Codex render shape is the oracle's
//   (src/oracle/codex-render.ts, reduceRender).
// - Anywhere else (a session's stream, a hook payload): any string over 300
//   characters that carries no ctxreach token (CTXR-), no "# AGENTS.md
//   instructions" block and no "Contents of" instruction-file block becomes
//   "[vendor text redacted: <bytes> bytes, sha256 <hex>]".
// - Local configuration lists in a session's init event (skills, agents,
//   slash commands, MCP servers) become counts.
// - --third-party: instruction text from someone else's repository is
//   redacted too (the census publishes measurements and blob ids, never
//   contents).
// - --paths-only: for ctxreach's own recordings, which ctxreach already
//   redacted: only the paths change.
// - Nothing is written when the local user name or a UUID survives the
//   reduction, or when a request or render keeps text outside its kept items.
//
// Usage: CTXR_SCRATCH=<scratch folder> node study/pilot/redact.mjs <src> <dst> [--codex | --claude | --opencode] [--third-party | --paths-only]
//        CTXR_SCRATCH=<scratch folder> node study/pilot/redact.mjs --all
// --all rebuilds every file listed in SHA256SUMS-sources.txt, after checking
// that each original still has its recorded SHA-256.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The folders to hide, from this machine rather than written here: the home
// folder, and the scratch folder the pilot ran in (CTXR_SCRATCH).
const slashes = (p) => p.split(path.sep).join("/");
const HOME = slashes(os.homedir());
const SCRATCH = process.env.CTXR_SCRATCH ? slashes(path.resolve(process.env.CTXR_SCRATCH)) : undefined;
const USER = path.basename(os.homedir());
const ID_KEYS = new Set([
  "session_id",
  "sessionId",
  "device_id",
  "account_uuid",
  "installation_id",
  "uuid",
  "x-claude-code-session-id",
  "session-id",
  "x-session-id",
  "x-session-affinity",
  "x-codex-window-id",
  "x-codex-turn-metadata",
  "authorization",
  "x-api-key",
  "cookie",
  "user_id",
  "prompt_cache_key",
  "messaging_socket_path",
]);
const LIST_KEYS = new Set([
  "skills",
  "agents",
  "slash_commands",
  "terminal_slash_commands",
  "mcp_servers",
  "output_styles",
]);
const KEEP = /CTXR-|# AGENTS\.md instructions|Contents of /;

/** Every spelling of a Windows path prefix: forward slashes, backslashes, and backslashes escaped for JSON. */
function spellings(prefix) {
  const back = prefix.split("/").join("\\");
  return [prefix, back, back.split("\\").join("\\\\"), prefix.replace(/^C:/, "c:"), "/c" + prefix.slice(2)];
}

/** A UUID in any case, not inside a longer run of hex digits. */
export const UUID =
  /(?<![0-9A-Fa-f])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f])/g;

export function redactPaths(text) {
  let out = text;
  for (const [prefix, name] of [
    [SCRATCH, "<scratch>"],
    [HOME, "<home>"],
  ])
    if (prefix) for (const s of spellings(prefix)) out = out.split(s).join(name);
  if (SCRATCH?.startsWith(HOME)) {
    const rest = SCRATCH.slice(HOME.length);
    // The scratch folder as ctxreach prints it (~/...), and as a ctxreach
    // recording prints it after its own redaction of the home folder.
    out = out.split("~" + rest).join("<scratch>");
    out = out.split(path.posix.dirname(HOME) + "/user" + rest).join("<scratch>");
  }
  // Claude Code names its project folders after the path, every other character a dash.
  if (SCRATCH) out = out.split(SCRATCH.replace(/[^A-Za-z0-9]/g, "-")).join("<scratch-slug>");
  out = out.split(HOME.replace(/[:/]/g, "-")).join("<home-slug>");
  return out.replace(UUID, "<uuid>");
}

/** The redaction's own check: neither the local user name nor any UUID may survive. */
export function leftovers(text, user = USER) {
  const at = [];
  const lower = text.toLowerCase();
  for (let i = lower.indexOf(user.toLowerCase()); i >= 0; i = lower.indexOf(user.toLowerCase(), i + 1))
    at.push(text.slice(Math.max(0, i - 30), i + user.length + 30));
  for (const m of text.matchAll(UUID)) at.push(m[0]);
  return at;
}

function hashNote(s, what = "vendor text") {
  return `[${what} redacted: ${Buffer.byteLength(s)} bytes, sha256 ${createHash("sha256").update(s).digest("hex")}]`;
}

/**
 * Paths, identifiers and local lists, everywhere. `longText` (the default)
 * also turns a long string without a ctxreach token or an instruction block
 * into a hash note; a reduced request or render has no such string left
 * except its kept items, so it is passed false there.
 */
export function redactValue(v, key, thirdParty, longText = true) {
  if (typeof v === "string") {
    if (ID_KEYS.has(String(key).toLowerCase())) return "REDACTED";
    if (key === "body" && v.trim().startsWith("{")) {
      try {
        return JSON.stringify(redactValue(JSON.parse(v), "", thirdParty, longText));
      } catch {
        // not JSON after all
      }
    }
    const long = longText && v.length > 300;
    if (long && !KEEP.test(v)) return hashNote(v);
    if (long && thirdParty) return hashNote(v, "third-party repository text");
    return redactPaths(v);
  }
  if (Array.isArray(v)) {
    if (LIST_KEYS.has(key)) return { count: v.length, names: "(removed)" };
    return v.map((x) => redactValue(x, "", thirdParty, longText));
  }
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (ID_KEYS.has(k.toLowerCase()) && x !== null && typeof x !== "object") out[redactPaths(k)] = "REDACTED";
      else if (k === "metadata" && x && typeof x === "object")
        out[k] = Object.fromEntries(Object.keys(x).map((m) => [m, "REDACTED"]));
      else out[redactPaths(k)] = redactValue(x, k, thirdParty, longText);
    }
    return out;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Requests and renders: only what ctxreach scores is kept.

export const AGENTS_KIND = "agents_md.instructions";
export const USER_KIND = "user.text";
const AGENTS_BLOCK = "# AGENTS.md instructions for ";
const ENVIRONMENT_TAG = "<environment_context>";
/** The kind a digest carries for content Codex did not tag, or that is not a message at all (as the oracle names it). */
const UNTAGGED_KIND = "(untagged)";
/** The longest `type` or `role` a reduced render keeps as it is (as the oracle's reduceRender). */
const SHORT_FIELD = 64;
/**
 * A string a reduced request may keep outside its kept items: an identifier,
 * a model name, a version, a flag. Anything with a space in it, or longer,
 * is text, and becomes a digest.
 */
export const IDENT = /^[A-Za-z0-9_.:<>@/+-]{0,80}$/;

/** An item reduced to its kind, the SHA-256 of its UTF-8 text and its size in bytes. */
export function itemDigest(kind, text) {
  const bytes = Buffer.from(text, "utf8");
  return { kind, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

const cwdIn = (text) => /<cwd>([\s\S]*?)<\/cwd>/.exec(text)?.[1];

/** A digest of one item: of its text, or of its JSON when it has none; an environment context keeps its `<cwd>`. */
function digestOf(kind, value) {
  const text = value?.text;
  const out = itemDigest(kind, typeof text === "string" ? text : (JSON.stringify(value) ?? ""));
  if (typeof text === "string" && text.includes(ENVIRONMENT_TAG)) out.cwd = cwdIn(text) ?? null;
  return out;
}

/**
 * ctxreach's own prompt: a short text that asks for CTXR tokens, and is not
 * an agent's system reminder or AGENTS.md block.
 */
export function isCtxreachPrompt(text) {
  return (
    typeof text === "string" &&
    Buffer.byteLength(text, "utf8") <= 1000 &&
    text.includes("CTXR") &&
    !text.includes("<system-reminder>") &&
    !text.startsWith(AGENTS_BLOCK)
  );
}

/** Every field but the kept items: identifiers stay, ids are REDACTED, any other string becomes a digest. */
function reduceRest(v, key) {
  if (typeof v === "string") {
    if (ID_KEYS.has(String(key).toLowerCase())) return "REDACTED";
    return IDENT.test(v) ? v : itemDigest(String(key), v);
  }
  if (Array.isArray(v)) return v.map((x) => reduceRest(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, reduceRest(x, k)]));
  return v;
}

const toolDigests = (tools) => tools.map((t) => itemDigest(`tool:${t?.name ?? t?.type ?? "?"}`, JSON.stringify(t)));

// --claude: a Claude Code /v1/messages request. Claude Code delivers the
// instruction files it loaded as `<system-reminder>` text blocks of the first
// user message ("Contents of <path> (<label>):", a blank line, the file):
// such a block becomes {kind: "claude.instructions", sha256, bytes, files:
// [{path, text}]}, the files in order and nothing of the reminder's own
// words, label included. The block naming the working directory keeps it
// as `cwd`. ctxreach's prompt stays whole. Every other block (the system
// prompt, the other reminders) and every tool is {kind, sha256, bytes}.
const REMINDER = /<system-reminder>\n([\s\S]*?)\n<\/system-reminder>/g;
const CONTENTS = /^Contents of (.+) \(([^\n]*)\):$/;
const PRIMARY_CWD = /^\s*- Primary working directory: (.+?)\s*$/m;

/** The files a Claude Code reminder carries, read as the oracle reads them (src/oracle/claude-capture.ts). */
export function claudeInstructionFiles(text) {
  const out = [];
  for (const m of text.matchAll(REMINDER)) {
    let current;
    const flush = () => {
      // One blank line separates the header from the text and the text from the next header.
      if (current)
        out.push({ path: current.path, text: current.lines.join("\n").replace(/^\n/, "").replace(/\n$/, "") });
      current = undefined;
    };
    for (const line of (m[1] ?? "").split("\n")) {
      const c = CONTENTS.exec(line);
      if (c?.[1] !== undefined) {
        flush();
        current = { path: c[1], lines: [] };
      } else if (current) current.lines.push(line);
    }
    flush();
  }
  return out;
}

function claudeBlock(block, role) {
  const c = typeof block === "string" ? { type: "text", text: block } : block;
  const text = c?.text;
  if (typeof text !== "string") return itemDigest(`${role}.${c?.type ?? "item"}`, JSON.stringify(c) ?? "");
  const files = claudeInstructionFiles(text);
  if (files.length) return { ...itemDigest("claude.instructions", text), files };
  if (isCtxreachPrompt(text)) return { type: c.type, text };
  const out = itemDigest(`${role}.${text.startsWith("<system-reminder>") ? "system-reminder" : c.type}`, text);
  const cwd = PRIMARY_CWD.exec(text)?.[1];
  if (cwd !== undefined) out.cwd = cwd;
  return out;
}

export function reduceClaudeRequest(body) {
  if (!Array.isArray(body?.messages)) throw new Error("--claude: a request body without messages");
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "system") out.system = (Array.isArray(v) ? v : [v]).map((b) => claudeBlock(b, "system"));
    else if (k === "messages")
      out.messages = v.map((m) => {
        const { content, ...rest } = m;
        const role = typeof m.role === "string" ? m.role : "message";
        return {
          ...reduceRest(rest, "message"),
          content: Array.isArray(content) ? content.map((b) => claudeBlock(b, role)) : claudeBlock(content, role),
        };
      });
    else if (k === "tools" && Array.isArray(v)) out.tools = toolDigests(v);
    else out[k] = reduceRest(v, k);
  }
  return out;
}

// --opencode: an OpenCode Responses request. OpenCode puts the instruction
// files in its system prompt, each as "Instructions from: <path>" and the
// file's text; that item becomes {kind, sha256, bytes, cwd, root, files:
// [{path, text}]}, with the working directory and workspace root its <env>
// block names. Where a file's text ends cannot be told from the prompt, so
// each is read from disk and must be there, byte for byte, right after its
// header; otherwise nothing is written. ctxreach's prompt stays whole;
// every other item (the prompt's own text, the title prompt) and every tool
// is {kind, sha256, bytes}.
const OPENCODE_FILE = /(?:^|\n)Instructions from: ([^\n]+)\n/g;

export function openCodeInstructionFiles(text, readFile = (p) => readFileSync(p, "utf8")) {
  const out = [];
  for (const m of text.matchAll(OPENCODE_FILE)) {
    const file = m[1];
    const start = (m.index ?? 0) + m[0].length;
    let body;
    try {
      body = readFile(file);
    } catch {
      throw new Error(`--opencode: cannot read ${file}, so where its text ends in the prompt cannot be told`);
    }
    if (text.slice(start, start + body.length) !== body)
      throw new Error(`--opencode: the prompt's text after "Instructions from: ${file}" is not that file`);
    out.push({ path: file, text: body });
  }
  return out;
}

function openCodeText(text, kind, type, readFile) {
  if (isCtxreachPrompt(text)) return type === undefined ? text : { type, text };
  const files = openCodeInstructionFiles(text, readFile);
  const out = itemDigest(kind, text);
  if (!files.length) return out;
  const cwd = /^\s*Working directory: (.+?)\s*$/m.exec(text)?.[1];
  const root = /^\s*Workspace root folder: (.+?)\s*$/m.exec(text)?.[1];
  return { ...out, ...(cwd !== undefined ? { cwd } : {}), ...(root !== undefined ? { root } : {}), files };
}

export function reduceOpenCodeRequest(body, readFile) {
  if (!Array.isArray(body?.input)) throw new Error("--opencode: a request body without input");
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "input")
      out.input = v.map((m) => {
        const { content, ...rest } = m;
        const role = typeof m.role === "string" ? m.role : "input";
        const r = reduceRest(rest, "input");
        if (typeof content === "string") r.content = openCodeText(content, role, undefined, readFile);
        else if (Array.isArray(content))
          r.content = content.map((c) =>
            typeof c?.text === "string"
              ? openCodeText(c.text, `${role}.${c.type ?? "item"}`, c.type, readFile)
              : itemDigest(`${role}.${c?.type ?? "item"}`, JSON.stringify(c) ?? ""),
          );
        else if (content !== undefined) r.content = itemDigest(role, JSON.stringify(content));
        return r;
      });
    else if (k === "instructions" && typeof v === "string")
      out.instructions = openCodeText(v, "instructions", undefined, readFile);
    else if (k === "tools" && Array.isArray(v)) out.tools = toolDigests(v);
    else out[k] = reduceRest(v, k);
  }
  return out;
}

// --codex: Codex's own prompt text (OpenAI's). A `codex debug prompt-input`
// render keeps, per message, `type`, `role` and `content_item_kinds`, the
// AGENTS.md block and ctxreach's prompt (`user.text`) whole, and every other
// content item as {kind, sha256, bytes} (an environment context also keeps
// its `cwd`); ids and timestamps go. This is the oracle's reduceRender shape,
// so a pilot render reads like a recorded verify render. A recorded
// Responses request keeps the AGENTS.md block and ctxreach's prompt whole;
// its instructions, every other input item and every tool are digests.
// With --third-party the AGENTS.md block goes the same way (someone else's
// repository text).

/** A `codex debug prompt-input` render: an array of messages whose content items each have a kind. */
export function isCodexRender(v) {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every(
      (m) =>
        Array.isArray(m?.content) && Array.isArray(m?.internal_chat_message_metadata_passthrough?.content_item_kinds),
    )
  );
}

export function reduceCodexRender(messages, thirdParty = false) {
  return messages.map((m) => {
    const kinds = m.internal_chat_message_metadata_passthrough.content_item_kinds;
    if (kinds.length !== m.content.length) throw new Error("a render message without one kind per content item");
    const out = {};
    for (const key of ["type", "role"]) {
      const v = m[key];
      if (v !== undefined) out[key] = typeof v === "string" && v.length <= SHORT_FIELD ? v : digestOf(key, v);
    }
    out.content = m.content.map((c, i) => {
      const whole = (kinds[i] === AGENTS_KIND && !thirdParty) || kinds[i] === USER_KIND;
      if (whole && typeof c?.type === "string" && (c.text === undefined || typeof c.text === "string"))
        return c.text === undefined ? { type: c.type } : { type: c.type, text: c.text };
      return digestOf(kinds[i] ?? UNTAGGED_KIND, c);
    });
    out.internal_chat_message_metadata_passthrough = { content_item_kinds: kinds };
    return out;
  });
}

function codexRequestItem(c, role, thirdParty) {
  const text = typeof c?.text === "string" ? c.text : undefined;
  if (text !== undefined && !thirdParty && text.startsWith(AGENTS_BLOCK)) return { type: c.type, text };
  if (text !== undefined && role === "user" && isCtxreachPrompt(text)) return { type: c.type, text };
  return digestOf(`${role}.${c?.type ?? "item"}`, c);
}

/** A recorded Responses API request body from Codex. */
export function reduceCodexRequest(body, thirdParty = false) {
  if (!Array.isArray(body?.input)) throw new Error("--codex: a request body without input");
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "instructions" && typeof v === "string") out.instructions = itemDigest("instructions", v);
    else if (k === "input")
      out.input = v.map((m) => {
        const { content, ...rest } = m;
        const role = typeof m.role === "string" ? m.role : "input";
        const r = reduceRest(rest, "input");
        if (Array.isArray(content)) r.content = content.map((c) => codexRequestItem(c, role, thirdParty));
        else if (content !== undefined) r.content = itemDigest(role, JSON.stringify(content));
        return r;
      });
    else if (k === "tools" && Array.isArray(v)) out.tools = toolDigests(v);
    else out[k] = reduceRest(v, k);
  }
  return out;
}

/**
 * The reduction's own check on a reduced body or render: every string must
 * be an identifier, a digest's kind or hash, or part of a kept item (an
 * instruction file's path and text, an AGENTS.md block, ctxreach's prompt,
 * a working directory). Returns where text survives.
 */
export function proseOutsideKept(v, where = "$") {
  if (typeof v === "string") return IDENT.test(v) ? [] : [where];
  if (Array.isArray(v)) return v.flatMap((x, i) => proseOutsideKept(x, `${where}[${i}]`));
  if (!v || typeof v !== "object") return [];
  const keys = Object.keys(v).sort().join(",");
  const keptText =
    keys === "text,type" &&
    typeof v.text === "string" &&
    (v.text.startsWith(AGENTS_BLOCK) || isCtxreachPrompt(v.text) || IDENT.test(v.text));
  if (keptText) return [];
  return Object.entries(v).flatMap(([k, x]) => {
    if ((k === "cwd" || k === "root") && (typeof x === "string" || x === null)) return [];
    if (k === "files" && Array.isArray(x))
      return x.flatMap((f, i) =>
        f && typeof f === "object" && Object.keys(f).sort().join(",") === "path,text"
          ? []
          : [`${where}.files[${i}]: not {path, text}`],
      );
    return proseOutsideKept(x, `${where}.${k}`);
  });
}

const REQUEST_REDUCERS = {
  codex: (body, thirdParty) => reduceCodexRequest(body, thirdParty),
  claude: (body) => reduceClaudeRequest(body),
  opencode: (body) => reduceOpenCodeRequest(body),
};

/** One recorded value under a request mode: a render (Codex only), or a recorder record whose body is a request. */
function reduceStructured(v, mode, thirdParty, name) {
  if (mode === "codex" && isCodexRender(v)) {
    const out = reduceCodexRender(v, thirdParty);
    const left = proseOutsideKept(out);
    if (left.length) throw new Error(`${name}: text survives outside the kept items at ${left.slice(0, 3).join(", ")}`);
    return out;
  }
  if (v && typeof v === "object" && typeof v.body === "string") {
    if (v.body === "") return v;
    if (v.body.trim().startsWith("{")) {
      const body = REQUEST_REDUCERS[mode](JSON.parse(v.body), thirdParty);
      const left = proseOutsideKept(body, "body");
      if (left.length)
        throw new Error(`${name}: text survives outside the kept items at ${left.slice(0, 3).join(", ")}`);
      return { ...v, body: JSON.stringify(body) };
    }
  }
  throw new Error(`--${mode}: ${name} holds neither a prompt-input render nor a recorded request`);
}

export function redactFile(text, name, thirdParty = false, mode = undefined) {
  const pre = (v) => (mode ? reduceStructured(v, mode, thirdParty, name) : v);
  const longText = mode === undefined;
  if (name.endsWith(".jsonl"))
    return text
      .split("\n")
      .map((l) => {
        if (!l.trim()) return l;
        let v;
        try {
          v = JSON.parse(l);
        } catch {
          if (mode) throw new Error(`${name}: --${mode} on a line that is not JSON`);
          return redactPaths(l);
        }
        return JSON.stringify(redactValue(pre(v), "", thirdParty, longText));
      })
      .join("\n");
  if (name.endsWith(".json")) {
    let v;
    try {
      v = JSON.parse(text);
    } catch {
      if (mode) throw new Error(`${name}: --${mode} on a file that is not JSON`);
      return redactPaths(text);
    }
    return JSON.stringify(redactValue(pre(v), "", thirdParty, longText), null, 1) + "\n";
  }
  if (mode) throw new Error(`${name}: --${mode} on a file that is not JSON`);
  return redactPaths(text);
}

const MODES = ["codex", "claude", "opencode"];

/** Reduce one file; returns the text, or throws when something identifying survives. `flags` is a flag or a list. */
export function reduce(text, name, flags = []) {
  const list = Array.isArray(flags) ? flags : flags ? [flags] : [];
  const modes = MODES.filter((m) => list.includes(`--${m}`));
  if (modes.length > 1) throw new Error(`${name}: one of ${MODES.map((m) => `--${m}`).join(", ")}, not several`);
  const clean = text.replace(/^\uFEFF/, "");
  // --paths-only: a ctxreach recording, which ctxreach already redacted; only its paths (and UUIDs) change.
  const out = list.includes("--paths-only")
    ? redactPaths(clean)
    : redactFile(clean, name, list.includes("--third-party"), modes[0]);
  const left = leftovers(out);
  if (left.length) throw new Error(`${name}: survives redaction: ${left.slice(0, 3).join(" | ")}`);
  return out;
}

/** The lines of SHA256SUMS-sources.txt: sha256, source (under the scratch folder), destination (under study/pilot), flags. */
export function readSums(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([0-9a-f]{64}) {2}(\S+) {2}-> {2}(\S+)(?: \((--[a-z-]+(?: --[a-z-]+)*)\))?$/);
      if (!m) throw new Error(`bad line in SHA256SUMS-sources.txt: ${line}`);
      return { sha256: m[1], src: m[2], dst: m[3], flags: m[4] ? m[4].split(" ") : [] };
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const here = path.dirname(fileURLToPath(import.meta.url));
  let jobs;
  if (args[0] === "--all") {
    if (!SCRATCH) {
      console.error("--all needs CTXR_SCRATCH, the folder the pilot ran in");
      process.exit(2);
    }
    jobs = readSums(readFileSync(path.join(here, "SHA256SUMS-sources.txt"), "utf8")).map((j) => ({
      ...j,
      src: path.join(SCRATCH, ...j.src.split("/")),
      dst: path.join(here, ...j.dst.split("/")),
    }));
  } else {
    const [src, dst, ...flags] = args;
    if (!src || !dst) {
      console.error(
        "usage: node study/pilot/redact.mjs <src> <dst> [--codex | --claude | --opencode] [--third-party | --paths-only] | --all",
      );
      process.exit(2);
    }
    jobs = [{ src, dst, flags }];
  }
  let failed = 0;
  for (const j of jobs) {
    const bytes = readFileSync(j.src);
    if (j.sha256 && createHash("sha256").update(bytes).digest("hex") !== j.sha256) {
      console.error(`${j.src}: not the original (SHA-256 differs); nothing written`);
      failed++;
      continue;
    }
    try {
      const out = reduce(bytes.toString("utf8"), path.basename(j.src), j.flags);
      mkdirSync(path.dirname(j.dst), { recursive: true });
      writeFileSync(j.dst, out);
    } catch (err) {
      console.error(err.message);
      failed++;
    }
  }
  console.log(`${jobs.length - failed}/${jobs.length} files written`);
  process.exitCode = failed ? 1 : 0;
}
