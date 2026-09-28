/**
 * Parse `claude -p --output-format stream-json --verbose` transcripts.
 *
 * Every line is one JSON event. The events ctxreach relies on are validated
 * with zod, so a change in Claude Code's format fails loudly (a
 * `TranscriptError` naming the line) instead of silently producing an empty
 * result. Event types and content blocks that ctxreach does not use are
 * tolerated, and counted, so a report can say how much of the stream it did
 * not understand.
 *
 * Shapes checked against Claude Code 2.1.280 on 2026-09-28 (see
 * docs/rules.md, section "Probe").
 */
import { z } from "zod";
import { TranscriptError, type Redaction, type Transcript, type TranscriptItem } from "../../probe/types.js";

const Init = z.looseObject({
  type: z.literal("system"),
  subtype: z.literal("init"),
  cwd: z.string(),
  tools: z.array(z.string()),
  model: z.string(),
  claude_code_version: z.string().optional(),
});

const TextBlock = z.looseObject({ type: z.literal("text"), text: z.string() });
const ToolUseBlock = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const AnyBlock = z.looseObject({ type: z.string() });

const Assistant = z.looseObject({
  type: z.literal("assistant"),
  message: z.looseObject({ content: z.array(AnyBlock) }),
});

const ToolResultContent = z.union([
  z.string(),
  z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
]);
const ToolResultBlock = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: ToolResultContent.optional(),
  is_error: z.boolean().optional(),
});

const User = z.looseObject({
  type: z.literal("user"),
  message: z.looseObject({ content: z.union([z.string(), z.array(AnyBlock)]) }),
});

const Result = z.looseObject({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
});

/** Event types the parser reads. */
const READ = new Set(["system", "assistant", "user", "result"]);
/** Event types that are known and deliberately not used. */
const IGNORED = new Set(["rate_limit_event", "stream_event"]);
/**
 * `system` subtypes that are known and change nothing the classifier needs
 * (retries, hook and plugin progress, command lists, permission denials).
 * Any other subtype is counted as unknown.
 */
const KNOWN_SYSTEM = new Set([
  "init",
  "api_retry",
  "commands_changed",
  "plugin_install",
  "hook_started",
  "hook_progress",
  "hook_response",
  "permission_denied",
  "status",
  "compact_boundary",
]);
/** Content blocks that carry nothing the classifier needs. */
const IGNORED_BLOCKS = new Set(["thinking", "redacted_thinking", "image"]);

function issue(err: z.ZodError): string {
  const first = err.issues[0];
  return first ? `${first.path.join(".") || "(event)"}: ${first.message}` : "invalid";
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, line: number, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new TranscriptError(line, `${what} does not match the expected shape (${issue(r.error)})`);
  return r.data;
}

function resultText(content: z.infer<typeof ToolResultContent> | undefined): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((c) => c.text ?? "").join("\n");
}

const EventHead = z.looseObject({ type: z.string(), subtype: z.string().optional() });

/** Parse a whole stream-json transcript. */
export function parseClaudeTranscript(text: string): Transcript {
  const out: Transcript = {
    items: [],
    finished: false,
    isError: false,
    events: { total: 0, byType: {}, unknown: {} },
  };
  const count = (bucket: Record<string, number>, key: string) => (bucket[key] = (bucket[key] ?? 0) + 1);
  const items: TranscriptItem[] = out.items;

  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === "") return;
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new TranscriptError(line, "not JSON");
    }
    const head = parseWith(EventHead, event, line, "event");
    out.events.total++;
    const label = head.subtype !== undefined ? `${head.type}/${head.subtype}` : head.type;
    count(out.events.byType, label);
    if (!READ.has(head.type)) {
      if (!IGNORED.has(head.type)) count(out.events.unknown, head.type);
      return;
    }

    switch (head.type) {
      case "system": {
        if (head.subtype === undefined || !KNOWN_SYSTEM.has(head.subtype)) count(out.events.unknown, label);
        if (head.subtype === "init") {
          const init = parseWith(Init, event, line, "system/init");
          out.cwd = init.cwd;
          out.model = init.model;
          out.toolsOffered = init.tools;
          if (init.claude_code_version !== undefined) out.cliVersion = init.claude_code_version;
        }
        return;
      }
      case "assistant": {
        const a = parseWith(Assistant, event, line, "assistant");
        for (const block of a.message.content) {
          if (block.type === "text") {
            items.push({ kind: "text", text: parseWith(TextBlock, block, line, "assistant text block").text });
          } else if (block.type === "tool_use") {
            const t = parseWith(ToolUseBlock, block, line, "assistant tool_use block");
            items.push({ kind: "tool-use", id: t.id, name: t.name, input: t.input });
          } else if (!IGNORED_BLOCKS.has(block.type)) {
            count(out.events.unknown, `assistant.content/${block.type}`);
          }
        }
        return;
      }
      case "user": {
        const u = parseWith(User, event, line, "user");
        if (typeof u.message.content === "string") return;
        for (const block of u.message.content) {
          if (block.type === "tool_result") {
            const r = parseWith(ToolResultBlock, block, line, "user tool_result block");
            items.push({
              kind: "tool-result",
              toolUseId: r.tool_use_id,
              text: resultText(r.content),
              isError: r.is_error ?? false,
            });
          } else if (block.type !== "text" && !IGNORED_BLOCKS.has(block.type)) {
            count(out.events.unknown, `user.content/${block.type}`);
          }
        }
        return;
      }
      case "result": {
        const r = parseWith(Result, event, line, "result");
        out.finished = true;
        out.isError = r.is_error;
        if (r.result !== undefined) out.finalText = r.result;
        return;
      }
    }
  });
  return out;
}

/** The auto-memory directory Claude Code reports for the session, if any (read before redaction). */
export function memoryDirOf(text: string): string | undefined {
  for (const raw of text.split("\n")) {
    if (!raw.includes('"init"')) continue;
    try {
      const e = JSON.parse(raw) as { type?: unknown; subtype?: unknown; memory_paths?: { auto?: unknown } };
      if (e.type === "system" && e.subtype === "init" && typeof e.memory_paths?.auto === "string")
        return e.memory_paths.auto;
    } catch {
      // Not an event this function needs.
    }
  }
  return undefined;
}

const REMOVED = "(removed by ctxreach)";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace each `from` with its `to`, matching `\` and `/` alike and, for Windows paths, any letter case. */
export function redactString(s: string, redactions: readonly Redaction[]): string {
  let out = s;
  for (const r of redactions) {
    if (!r.from) continue;
    const win = /^[A-Za-z]:[\\/]/.test(r.from) || r.from.startsWith("\\\\");
    const pattern = escapeRegExp(r.from).replace(/\\\\|\//g, "[\\\\/]");
    out = out.replace(new RegExp(pattern, win ? "gi" : "g"), () => r.to);
  }
  return out;
}

function redactValue(v: unknown, redactions: readonly Redaction[]): unknown {
  if (typeof v === "string") return redactString(v, redactions);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, redactions));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x, redactions)]));
  return v;
}

/**
 * Prepare a raw transcript for saving, so it can be replayed on another
 * machine and shared without the user's account details:
 *
 * - every string has each redaction applied (the temporary copy's path and
 *   the home directory become fixed placeholders);
 * - `system/init` loses the user's own lists of slash commands, skills,
 *   agents and non-built-in plugins (their count is kept), and the memory
 *   and messaging paths;
 * - `system/commands_changed` keeps only the number of commands;
 * - `rate_limit_event` loses its quota and billing details.
 *
 * Everything the classifier reads (messages, tool calls, tool results, the
 * reported working directory, tools, model and version) is kept. A line that
 * is not JSON is kept, with the redactions applied to its text.
 */
export function redactClaudeTranscript(text: string, redactions: readonly Redaction[]): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.trim() === "") return line;
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return redactString(line, redactions);
      }
      if (e.type === "rate_limit_event") e = { ...e, rate_limit_info: REMOVED };
      if (e.type === "system" && e.subtype === "init") {
        const init: Record<string, unknown> = { ...e };
        for (const key of ["slash_commands", "skills", "agents"]) {
          if (Array.isArray(init[key])) init[key] = { count: (init[key] as unknown[]).length, names: REMOVED };
        }
        if (Array.isArray(init.plugins)) {
          const plugins = init.plugins as { source?: unknown }[];
          const builtin = plugins.filter((p) => typeof p.source === "string" && p.source.endsWith("@builtin"));
          init.plugins = builtin;
          if (plugins.length > builtin.length) init.other_plugins = { count: plugins.length - builtin.length };
        }
        delete init.memory_paths;
        delete init.messaging_socket_path;
        e = init;
      }
      if (e.type === "system" && e.subtype === "commands_changed" && Array.isArray(e.commands))
        e = { ...e, commands: { count: e.commands.length, names: REMOVED } };
      return JSON.stringify(redactValue(e, redactions));
    })
    .join("\n");
}
