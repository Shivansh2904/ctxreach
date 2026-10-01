/**
 * The probe's second Claude Code instrument: an `InstructionsLoaded` hook.
 *
 * Claude Code runs this hook "when a CLAUDE.md or `.claude/rules/*.md` file
 * is loaded into context", with the file's absolute path, its memory type
 * and why it was loaded (docs: hooks, "InstructionsLoaded"). It does not run
 * for an AGENTS.md read through the Project instructions setting (rule
 * `claude.hook-blind`), which is why the canary stays the primary
 * instrument and the hook is compared with it (src/probe/instruments.ts).
 *
 * The hook is installed without touching any of the user's files: ctxreach
 * writes a script and a settings file into the sandbox's base directory
 * (outside the copy, deleted with it) and passes the settings with
 * `--settings`, which adds a settings layer. It never sets
 * `disableAllHooks`, which would turn this hook off too. The hook uses the
 * exec form (`command` plus `args`, Claude Code 2.1.139 and later), so no
 * shell parses the paths, and an absolute Node executable, so `PATH` plays
 * no part.
 *
 * Each event is appended to a log in the base directory. After a trial,
 * the log is reduced to the fields below, checked with zod, redacted like
 * the transcript, and saved in the recording as `trial-N.hooks.jsonl`.
 */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Redaction } from "../../probe/types.js";
import { redactString } from "./events.js";

export const HOOK_SCRIPT = "ctxr-hook.mjs";
export const HOOK_SETTINGS = "settings.json";
/** The log the hook appends to, in the sandbox's base directory; emptied before each trial. */
export const HOOK_LIVE_LOG = "ctxr-hooks.jsonl";

/**
 * The hook itself. It reads one event (JSON) from stdin and appends it, as
 * one line, to the log named by its first argument. Anything that is not
 * JSON is kept as `{"ctxreachUnparsed": ...}`, so a change in the payload
 * shows up as an invalid line rather than a lost one.
 */
export const HOOK_SCRIPT_TEXT = `// Written by ctxreach probe, in its temporary directory. Appends each
// InstructionsLoaded event (one JSON object on stdin) to the log named by the
// first argument, one line per event.
import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let line;
  try {
    line = JSON.stringify(JSON.parse(input));
  } catch {
    line = JSON.stringify({ ctxreachUnparsed: input.slice(0, 2000) });
  }
  appendFileSync(process.argv[2], line + "\\n");
});
`;

export const MEMORY_TYPES = ["User", "Project", "Local", "Managed"] as const;
export const LOAD_REASONS = ["session_start", "nested_traversal", "path_glob_match", "include", "compact"] as const;

/**
 * One event as saved in a recording: the documented event fields, the
 * session's working directory, and whether the event's session is the
 * trial's own (`session_id` against the transcript's, compared before
 * either is discarded). Session ids, transcript paths and anything else
 * are not saved.
 */
export const HookEventJson = z
  .object({
    hook_event_name: z.literal("InstructionsLoaded"),
    file_path: z.string().min(1),
    memory_type: z.enum(MEMORY_TYPES),
    load_reason: z.enum(LOAD_REASONS),
    globs: z.array(z.string()).optional(),
    trigger_file_path: z.string().optional(),
    parent_file_path: z.string().optional(),
    cwd: z.string().optional(),
    /** `same`: the trial's session; `other`: another session's; `unknown`: either id was missing. */
    session: z.enum(["same", "other", "unknown"]),
  })
  .strict();

export type HookEvent = z.infer<typeof HookEventJson>;

/** The event as Claude Code sends it: the fields ctxreach keeps, plus any others (dropped). */
const RawHookEvent = z.looseObject({
  session_id: z.string().optional(),
  hook_event_name: z.literal("InstructionsLoaded"),
  file_path: z.string().min(1),
  memory_type: z.enum(MEMORY_TYPES),
  load_reason: z.enum(LOAD_REASONS),
  globs: z.array(z.string()).optional(),
  trigger_file_path: z.string().optional(),
  parent_file_path: z.string().optional(),
  cwd: z.string().optional(),
});

export interface HookFiles {
  /** The settings file to pass with `--settings`. */
  settings: string;
  script: string;
  /** The live log the hook appends to. */
  log: string;
}

export function hookFiles(base: string): HookFiles {
  return {
    settings: path.join(base, HOOK_SETTINGS),
    script: path.join(base, HOOK_SCRIPT),
    log: path.join(base, HOOK_LIVE_LOG),
  };
}

/** The `hooks` settings entry that runs the hook script with Node, in exec form. */
export function hookSettings(files: Pick<HookFiles, "script" | "log">, node: string = process.execPath) {
  return {
    hooks: {
      InstructionsLoaded: [{ hooks: [{ type: "command", command: node, args: [files.script, files.log] }] }],
    },
  };
}

/**
 * Write the hook script and the settings file into `base`, and empty the
 * live log. `extra` adds settings (clean isolation's); it may not carry
 * `disableAllHooks` or hooks of its own. Returns the files and the settings
 * written.
 */
export function installHook(
  base: string,
  extra: Record<string, unknown> = {},
  node: string = process.execPath,
): { files: HookFiles; settings: Record<string, unknown> } {
  const files = hookFiles(base);
  if ("disableAllHooks" in extra || "hooks" in extra)
    throw new Error("the hook's settings may not set disableAllHooks or other hooks");
  const settings = { ...extra, ...hookSettings(files, node) };
  writeFileSync(files.script, HOOK_SCRIPT_TEXT);
  writeFileSync(files.settings, JSON.stringify(settings, null, 2) + "\n");
  rmSync(files.log, { force: true });
  return { files, settings };
}

/** The session id of the transcript's `system/init` event, read before redaction. */
export function sessionIdOf(stdout: string): string | undefined {
  for (const raw of stdout.split("\n")) {
    if (!raw.includes('"init"')) continue;
    try {
      const e = JSON.parse(raw) as { type?: unknown; subtype?: unknown; session_id?: unknown };
      if (e.type === "system" && e.subtype === "init" && typeof e.session_id === "string") return e.session_id;
    } catch {
      // Not an event this function needs.
    }
  }
  return undefined;
}

/**
 * Wait until the live log has stopped growing: the hook runs asynchronously,
 * so its last events can land just after the agent exits. Waits for
 * `quietMs` without change, and at most `maxMs` in all.
 */
export async function settleLog(file: string, quietMs = 300, maxMs = 3000): Promise<void> {
  const size = () => (existsSync(file) ? statSync(file).size : -1);
  const end = Date.now() + maxMs;
  let last = size();
  let since = Date.now();
  while (Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, quietMs)));
    const now = size();
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) {
      return;
    }
  }
}

/**
 * Reduce a raw hook log to the saved form: one `HookEventJson` line per
 * event that matches the documented shape, with every path redacted; lines
 * that do not match are counted, not saved.
 */
export function reduceHookLog(
  text: string,
  options: { sessionId?: string | undefined; redactions: readonly Redaction[] },
): { text: string; events: number; invalid: number } {
  const out: string[] = [];
  let invalid = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      invalid++;
      continue;
    }
    const parsed = RawHookEvent.safeParse(value);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const e = parsed.data;
    const r = (s: string) => redactString(s, options.redactions);
    const event: HookEvent = {
      hook_event_name: e.hook_event_name,
      file_path: r(e.file_path),
      memory_type: e.memory_type,
      load_reason: e.load_reason,
      ...(e.globs !== undefined ? { globs: e.globs } : {}),
      ...(e.trigger_file_path !== undefined ? { trigger_file_path: r(e.trigger_file_path) } : {}),
      ...(e.parent_file_path !== undefined ? { parent_file_path: r(e.parent_file_path) } : {}),
      ...(e.cwd !== undefined ? { cwd: r(e.cwd) } : {}),
      session:
        options.sessionId === undefined || e.session_id === undefined
          ? "unknown"
          : e.session_id === options.sessionId
            ? "same"
            : "other",
    };
    out.push(JSON.stringify(HookEventJson.parse(event)));
  }
  return { text: out.length ? out.join("\n") + "\n" : "", events: out.length, invalid };
}

/** Read a saved hook log. Lines that do not match `HookEventJson` are counted, not returned. */
export function parseHookLog(text: string): { events: HookEvent[]; invalid: number } {
  const events: HookEvent[] = [];
  let invalid = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    try {
      const parsed = HookEventJson.safeParse(JSON.parse(raw));
      if (parsed.success) events.push(parsed.data);
      else invalid++;
    } catch {
      invalid++;
    }
  }
  return { events, invalid };
}

/** Read the live log, if any, then remove it. */
export function takeLiveLog(file: string): string {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8");
  rmSync(file, { force: true });
  return text;
}
