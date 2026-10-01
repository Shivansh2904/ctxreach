/**
 * The throwaway `CODEX_HOME` a Codex render runs with.
 *
 * `codex debug prompt-input` writes into whatever `CODEX_HOME` it is given
 * (`installation_id`, `.sandbox_migration`, `skills/`), so it never gets the
 * user's own. It gets a fresh directory inside the sandbox instead, seeded
 * from the user's home with a whitelist and nothing else:
 *
 * - the global instruction file (`AGENTS.override.md`, `AGENTS.md`);
 * - from `config.toml`, only `project_doc_max_bytes`,
 *   `project_doc_fallback_filenames` and `project_root_markers`;
 * - the trust level of the repository that was copied, written for the
 *   copy's path, so a trusted repository's own `.codex/config.toml` applies
 *   in the copy as it does at home.
 *
 * Never `auth.json`, model providers, MCP servers, hooks, profiles or
 * history. With `clean`, nothing is seeded at all.
 *
 * The sandbox strips every `.codex/` from the copy (it can hold hooks and
 * MCP servers). `prepareProjectConfig` writes back, for each layer on the
 * root-to-launch path, a `.codex/config.toml` holding only the three
 * instruction keys, so `map` and Codex see the same budget.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCodexHome, readCodexToml, type TrustLevel } from "../agents/codex/config.js";
import { SafetyError } from "../probe/types.js";
import { dirsBetween, isFileNamed, isInsideReal, samePath } from "../util/fs.js";

export const INSTRUCTION_KEYS = [
  "project_doc_max_bytes",
  "project_doc_fallback_filenames",
  "project_root_markers",
] as const;
export type InstructionKey = (typeof INSTRUCTION_KEYS)[number];

const GLOBAL_NAMES = ["AGENTS.override.md", "AGENTS.md"] as const;

export interface SeedOptions {
  /** The user's Codex home to seed from; undefined seeds nothing. */
  from?: string;
  /** The repository that was copied, and the launch directory in it. */
  sourceRoot: string;
  sourceLaunch: string;
  /** The copy, and the launch directory in it. */
  copyRoot: string;
  copyLaunch: string;
  /** Use this trust level for the copy instead of the one found for the source. */
  trustOverride?: TrustLevel;
}

export interface SeededHome {
  home: string;
  /** What was taken from the user's home; recorded so a report can say what applied. */
  from?: string;
  keys: InstructionKey[];
  globalFiles: string[];
  trust: TrustLevel;
  /** `config.toml` of the source home, `override`, or `not set`. */
  trustFrom: string;
}

/**
 * Throws `SafetyError` unless `home` is inside the sandbox and is neither the
 * user's home directory nor the Codex home Codex would use by default. The
 * sandbox may itself be under the user's home (on Windows the temp directory
 * is), so "inside the sandbox" is the check, not "outside the home".
 */
export function assertThrowawayHome(home: string, sandboxBase: string): void {
  const resolved = path.resolve(home);
  const forbidden = [os.homedir(), defaultCodexHome(), process.env.CODEX_HOME].filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  for (const p of forbidden)
    if (samePath(resolved, p) || isInsideReal(p, resolved))
      throw new SafetyError(`refusing to use ${home} as the throwaway CODEX_HOME: it is, or contains, ${p}`);
  if (!isInsideReal(resolved, sandboxBase))
    throw new SafetyError(
      `refusing to use ${home} as the throwaway CODEX_HOME: it is not inside the sandbox ${sandboxBase}`,
    );
}

/** TOML for a value ctxreach writes: numbers, strings and arrays of strings only. */
function tomlValue(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => tomlValue(v)).join(", ")}]`;
  throw new SafetyError(`cannot write a ${typeof value} into a Codex config`);
}

/** The instruction keys present in a parsed config, as TOML lines. */
export function instructionLines(config: Record<string, unknown> | undefined): {
  keys: InstructionKey[];
  lines: string[];
} {
  const keys: InstructionKey[] = [];
  const lines: string[] = [];
  for (const key of INSTRUCTION_KEYS) {
    const value = config?.[key];
    if (value === undefined) continue;
    keys.push(key);
    lines.push(`${key} = ${tomlValue(value)}`);
  }
  return { keys, lines };
}

/** The trust level the user's config gives the source repository, and which of its keys said so. */
function sourceTrust(
  userConfig: ReturnType<typeof readCodexToml>,
  sourceLaunch: string,
  sourceRoot: string,
): { trust: TrustLevel; key?: "launch" | "root" } {
  const projects = userConfig?.projects;
  if (!projects) return { trust: "unknown" };
  const lookup = (dir: string): TrustLevel | undefined => {
    for (const [key, value] of Object.entries(projects)) {
      if (!samePath(key, dir)) continue;
      if (value.trust_level === "trusted" || value.trust_level === "untrusted") return value.trust_level;
    }
    return undefined;
  };
  const byLaunch = lookup(sourceLaunch);
  if (byLaunch) return { trust: byLaunch, key: "launch" };
  const byRoot = lookup(sourceRoot);
  if (byRoot) return { trust: byRoot, key: "root" };
  return { trust: "unknown" };
}

/**
 * Create `home` (which must not exist yet) and seed it. Returns what was
 * seeded, for the recording.
 */
export function seedCodexHome(home: string, options: SeedOptions): SeededHome {
  if (existsSync(home)) throw new SafetyError(`${home} already exists; the throwaway CODEX_HOME must be new`);
  mkdirSync(home, { recursive: true });
  const seeded: SeededHome = { home, keys: [], globalFiles: [], trust: "unknown", trustFrom: "not set" };
  const lines: string[] = [];

  if (options.from !== undefined) {
    seeded.from = options.from;
    for (const name of GLOBAL_NAMES) {
      if (!isFileNamed(options.from, name)) continue;
      copyFileSync(path.join(options.from, name), path.join(home, name));
      seeded.globalFiles.push(name);
    }
    const user = readCodexToml(path.join(options.from, "config.toml"));
    const instructions = instructionLines(user);
    seeded.keys = instructions.keys;
    lines.push(...instructions.lines);
    const found = sourceTrust(user, options.sourceLaunch, options.sourceRoot);
    seeded.trust = found.trust;
    if (found.key !== undefined) seeded.trustFrom = path.join(options.from, "config.toml");
    // Mirrored to the copy at the same place the user's key named.
    if (found.trust !== "unknown") {
      const dir = found.key === "launch" ? options.copyLaunch : options.copyRoot;
      lines.push("", `[projects.${JSON.stringify(dir)}]`, `trust_level = ${JSON.stringify(found.trust)}`);
    }
  }
  if (options.trustOverride !== undefined) {
    seeded.trust = options.trustOverride;
    seeded.trustFrom = "override";
    if (options.trustOverride !== "unknown")
      lines.push(
        "",
        `[projects.${JSON.stringify(options.copyRoot)}]`,
        `trust_level = ${JSON.stringify(options.trustOverride)}`,
      );
  }
  if (lines.length) writeFileSync(path.join(home, "config.toml"), lines.join("\n") + "\n");
  return seeded;
}

export interface ProjectConfigLayer {
  /** Relative to the copy, forward slashes. */
  file: string;
  keys: InstructionKey[];
}

/**
 * For each `.codex/config.toml` on the source's root-to-launch path, write
 * the copy's counterpart holding only the three instruction keys. Nothing
 * else in those files (hooks, MCP servers, providers) reaches the copy.
 */
export function prepareProjectConfig(
  copyRoot: string,
  sourceRoot: string,
  sourceLaunch: string,
  codexHome: string,
): ProjectConfigLayer[] {
  const layers: ProjectConfigLayer[] = [];
  for (const dir of dirsBetween(sourceRoot, sourceLaunch)) {
    const dotCodex = path.join(dir, ".codex");
    // Codex skips a project .codex that is its own home; so does map.
    if (samePath(dotCodex, codexHome)) continue;
    const config = readCodexToml(path.join(dotCodex, "config.toml"));
    if (!config) continue;
    const { keys, lines } = instructionLines(config);
    if (keys.length === 0) continue;
    const rel = path.relative(sourceRoot, dir);
    const target = path.join(copyRoot, rel, ".codex", "config.toml");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, lines.join("\n") + "\n");
    layers.push({ file: path.relative(copyRoot, target).split(path.sep).join("/"), keys });
  }
  return layers;
}
