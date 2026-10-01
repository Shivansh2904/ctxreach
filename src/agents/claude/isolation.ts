/**
 * What a probed Claude Code session runs with, apart from the repository:
 * which settings turn instruction files off (refused), which model it runs
 * (pinned and checked), and the experimental `clean` isolation.
 *
 * Isolation `machine` (the default) is the user's own set-up: their
 * settings, plugins, skills and `~/.claude/CLAUDE.md` apply, as in their own
 * sessions, so the result answers "what do I get". Isolation `clean` is
 * meant to answer "what does the repository alone deliver":
 *
 * - `--setting-sources project,local`, which drops the user's settings,
 *   `~/.claude/CLAUDE.md`, `~/.claude/rules/` and user skills (Agent SDK
 *   docs, "Claude Code features"); observed once to keep
 *   `agents-md@builtin` (2.1.280);
 * - `--settings` with the Project instructions value map used (user settings
 *   no longer carry it), `claudeMdExcludes` with the exact paths of every
 *   instruction file a directory above the copy could hold (an ancestor,
 *   including `~/.claude/CLAUDE.md` for a copy under the home directory, is a
 *   project source), and the hook;
 * - `--disable-slash-commands`, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`;
 * - a model pin, required: dropping the user's settings drops their model
 *   (observed: `fable` became `opus` under `--setting-sources project,local`).
 *
 * EXPERIMENTAL: four parts are unverified (docs/rules.md, "Probe"):
 * `--disable-slash-commands`, `claudeMdExcludes` with Windows absolute paths,
 * the auto-memory variable's effect, and whether user plugins still load
 * without the `user` source. The asserts in src/probe/score.ts (the
 * `agents-md` plugin present, no other plugin, the model equal to the pin,
 * no hook event outside the copy) are what would show one of them failing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { SafetyError } from "../../probe/types.js";
import { AGENTS_MD_PLUGIN } from "./settings.js";

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/**
 * Variables that turn instruction files off: bare mode (which skips
 * CLAUDE.md), safe mode, CLAUDE.md files disabled, and attachments
 * disabled (instruction files reach the model as attachments). A probe
 * under any of them would measure nothing, so it refuses to run.
 */
export const KILL_SWITCHES = [
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
  "CLAUDE_CODE_DISABLE_ATTACHMENTS",
] as const;

/** Flags that skip CLAUDE.md (`--bare`, `--safe-mode`) or load only managed settings and `--settings` (`--restricted`). */
export const KILL_FLAGS = ["--bare", "--safe-mode", "--restricted"] as const;

export function killSwitchesIn(env: NodeJS.ProcessEnv): string[] {
  return KILL_SWITCHES.filter((k) => truthy(env[k]));
}

export function killFlagsIn(args: readonly string[]): string[] {
  return KILL_FLAGS.filter((f) => args.some((a) => a === f || a.startsWith(`${f}=`)));
}

/**
 * The built-in plugin that reads AGENTS.md. 2.1.280 lists it as
 * `agents-md@builtin`; 2.1.285 as `cc-plugin-agents-md@builtin` (seen by
 * the oracle's capture runs).
 */
export const AGENTS_MD_PLUGINS = [AGENTS_MD_PLUGIN, `cc-plugin-${AGENTS_MD_PLUGIN}`] as const;

export function hasAgentsMdPlugin(plugins: readonly string[]): boolean {
  return plugins.some((p) => (AGENTS_MD_PLUGINS as readonly string[]).includes(p));
}

export interface ModelPin {
  pin: string;
  /** Where it came from: `--model`, `ANTHROPIC_MODEL`, or the settings file. */
  from: string;
}

/**
 * The model to pin, in Claude Code's own order of precedence below
 * `--model`: the `ANTHROPIC_MODEL` variable, then `model` in the user's
 * settings. Undefined when neither sets one: then no `--model` is passed,
 * and the report says the model was not pinned.
 */
export function resolveModelPin(options: {
  model?: string | undefined;
  env: NodeJS.ProcessEnv;
  claudeHome: string;
}): ModelPin | undefined {
  if (options.model) return { pin: options.model, from: "--model" };
  if (options.env.ANTHROPIC_MODEL) return { pin: options.env.ANTHROPIC_MODEL, from: "ANTHROPIC_MODEL" };
  const file = path.join(options.claudeHome, "settings.json");
  try {
    const settings = JSON.parse(readFileSync(file, "utf8")) as { model?: unknown };
    if (typeof settings.model === "string" && settings.model.trim() !== "")
      return { pin: settings.model.trim(), from: "settings.json (model)" };
  } catch {
    // No settings file, or one map has already reported as malformed.
  }
  return undefined;
}

/**
 * Whether the model a session reports is the pinned one. A full id must
 * match exactly; an alias of one word (`fable`, `opus`) matches its family
 * (`claude-fable-5-1`). A context-window suffix such as `[1m]` is ignored on
 * both sides. Any other alias (`default`, `opusplan`) cannot be checked and
 * does not match.
 */
export function modelMatches(pin: string, reported: string): boolean {
  const norm = (m: string) =>
    m
      .trim()
      .toLowerCase()
      .replace(/\[[^\]]*\]$/, "");
  const p = norm(pin);
  const r = norm(reported);
  if (p === r) return true;
  return /^[a-z]+$/.test(p) && p !== "default" && r.startsWith(`claude-${p}-`);
}

/** Flags `clean` isolation adds. */
export const CLEAN_ARGS = ["--setting-sources", "project,local", "--disable-slash-commands"] as const;
/** Variables `clean` isolation sets for the agent. */
export const CLEAN_ENV: Readonly<Record<string, string>> = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };

/** Instruction files a directory can hold that Claude Code reads from an ancestor of the launch directory. */
export const ANCESTOR_FILES = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", ".claude/AGENTS.md"];

/**
 * `claudeMdExcludes` entries for every directory above `copyRoot`: the exact
 * path of each file in `ANCESTOR_FILES` and every rule under `.claude/rules/`,
 * whether or not they exist, with forward slashes. Never a `**` pattern that
 * is not anchored to an ancestor: it would exclude the copy's own files too.
 */
export function ancestorExcludes(copyRoot: string): string[] {
  const out: string[] = [];
  const api = /^[A-Za-z]:[\\/]/.test(copyRoot) || copyRoot.startsWith("\\\\") ? path.win32 : path.posix;
  let dir = api.dirname(api.resolve(copyRoot));
  for (;;) {
    const slash = (p: string) => p.split("\\").join("/");
    for (const f of ANCESTOR_FILES) out.push(slash(api.join(dir, ...f.split("/"))));
    out.push(`${slash(api.join(dir, ".claude", "rules"))}/**`);
    const up = api.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return out;
}

/** The settings `clean` isolation passes with `--settings` (the hook is added by the adapter). */
export function cleanSettings(options: { copyRoot: string; claudeMode?: string | undefined }): Record<string, unknown> {
  return {
    claudeMdExcludes: ancestorExcludes(options.copyRoot),
    ...(options.claudeMode !== undefined
      ? { pluginConfigs: { [AGENTS_MD_PLUGIN]: { options: { instructionFiles: options.claudeMode } } } }
      : {}),
  };
}

/** The first version with AGENTS.md support, and so with the `agents-md` built-in plugin (rule `claude.version`). */
export const AGENTS_MD_PLUGIN_SINCE = "2.1.277";

/**
 * Refuse a session that could not see instruction files (a kill switch in
 * `env`, a kill flag in `args`) or whose settings would turn the hook off.
 */
export function assertRunnable(options: {
  env: NodeJS.ProcessEnv;
  args: readonly string[];
  settings?: Record<string, unknown> | undefined;
}): void {
  const on = killSwitchesIn(options.env);
  if (on.length)
    throw new SafetyError(
      `${on.join(", ")} ${on.length > 1 ? "are" : "is"} set, which turns instruction files off, so a probe would measure nothing; unset ${on.length > 1 ? "them" : "it"} first`,
    );
  const flags = killFlagsIn(options.args);
  if (flags.length)
    throw new SafetyError(`refusing to run Claude Code with ${flags.join(", ")}, which skips instruction files`);
  if (options.settings !== undefined && "disableAllHooks" in options.settings)
    throw new SafetyError("refusing to pass disableAllHooks: it would turn the InstructionsLoaded hook off too");
}
