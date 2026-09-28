import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { ConfigError } from "../../util/errors.js";
import { dirsBetween, samePath } from "../../util/fs.js";

/** Codex's defaults, from `codex-rs/config/defaults.toml` (see docs/rules.md). */
export const CODEX_DEFAULT_MAX_BYTES = 32 * 1024;
export const CODEX_DEFAULT_ROOT_MARKERS: readonly string[] = [".git"];

export type TrustLevel = "trusted" | "untrusted" | "unknown";

// Only the keys ctxreach uses are checked. Everything else in the file is
// allowed through untouched, so an unrelated Codex setting never breaks `map`,
// but a wrong type on a key we rely on fails loudly instead of being guessed.
const CodexConfigToml = z
  .object({
    project_doc_max_bytes: z.number().int().nonnegative().optional(),
    project_doc_fallback_filenames: z.array(z.string()).optional(),
    project_root_markers: z.array(z.string()).optional(),
    projects: z.record(z.string(), z.looseObject({ trust_level: z.string().optional() })).optional(),
  })
  .loose();

type CodexConfigToml = z.infer<typeof CodexConfigToml>;

export function readCodexToml(file: string): CodexConfigToml | undefined {
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file}: not valid TOML (${(err as Error).message.split("\n")[0]})`);
  }
  const parsed = CodexConfigToml.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`${file}: ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

export interface SettingSource {
  key: "project_doc_max_bytes" | "project_doc_fallback_filenames" | "project_root_markers";
  value: unknown;
  /** Config file the value came from, `default`, or `override` for a command-line value. */
  from: string;
}

export interface IgnoredProjectConfig {
  file: string;
  keys: string[];
}

export interface CodexSettings {
  codexHome: string;
  maxBytes: number;
  fallbackNames: string[];
  rootMarkers: string[];
  projectRoot: string;
  /** False when no root marker was found and Codex searches the launch directory only. */
  rootFound: boolean;
  trust: TrustLevel;
  /** Where the trust level came from. */
  trustFrom: string;
  sources: SettingSource[];
  /** Project `.codex/config.toml` files whose instruction settings Codex ignores because the project is not trusted. */
  ignoredProjectConfig: IgnoredProjectConfig[];
}

export interface CodexSettingsOptions {
  launchDir: string;
  /** Defaults to `$CODEX_HOME`, then `~/.codex`. */
  codexHome?: string;
  /** Like `-c project_doc_max_bytes=N`: wins over every config file. */
  maxBytesOverride?: number;
  /** Skip the trust lookup and use this level. */
  trustOverride?: TrustLevel;
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/** Rule `codex.fallback-names`: entries Codex drops before looking for files. */
export function usableFallbackNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (name === "" || name === "." || name === "..") continue;
    if (name.includes("/") || name.includes("\0")) continue;
    if (process.platform === "win32" && (name.includes("\\") || name.includes(":"))) continue;
    if (name === "AGENTS.override.md" || name === "AGENTS.md" || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/** Rule `codex.root`: nearest directory at or above `launchDir` holding a marker. */
export function findProjectRoot(launchDir: string, markers: readonly string[]): string | undefined {
  if (markers.length === 0) return undefined;
  let cursor = launchDir;
  for (;;) {
    for (const marker of markers) {
      if (existsSync(path.join(cursor, marker))) return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function lookupTrust(projects: CodexConfigToml["projects"], dir: string): TrustLevel | undefined {
  if (!projects) return undefined;
  for (const [key, value] of Object.entries(projects)) {
    if (!samePath(key, dir)) continue;
    if (value.trust_level === "trusted") return "trusted";
    if (value.trust_level === "untrusted") return "untrusted";
  }
  return undefined;
}

/** Resolve the settings that shape Codex's instruction chain (rules `codex.config`, `codex.root`, `codex.untrusted`). */
export function resolveCodexSettings(options: CodexSettingsOptions): CodexSettings {
  const codexHome = options.codexHome ?? defaultCodexHome();
  const userFile = path.join(codexHome, "config.toml");
  const user = readCodexToml(userFile);

  const sources: SettingSource[] = [];
  let maxBytes = CODEX_DEFAULT_MAX_BYTES;
  let fallbackNames: string[] = [];
  let rootMarkers = [...CODEX_DEFAULT_ROOT_MARKERS];
  let maxFrom = "default";
  let fallbackFrom = "default";
  let markersFrom = "default";

  if (user?.project_doc_max_bytes !== undefined) {
    maxBytes = user.project_doc_max_bytes;
    maxFrom = userFile;
  }
  if (user?.project_doc_fallback_filenames !== undefined) {
    fallbackNames = user.project_doc_fallback_filenames;
    fallbackFrom = userFile;
  }
  if (user?.project_root_markers !== undefined) {
    rootMarkers = user.project_root_markers;
    markersFrom = userFile;
  }

  const found = findProjectRoot(options.launchDir, rootMarkers);
  const projectRoot = found ?? options.launchDir;

  let trust: TrustLevel;
  let trustFrom: string;
  if (options.trustOverride) {
    trust = options.trustOverride;
    trustFrom = "override";
  } else {
    const byLaunch = lookupTrust(user?.projects, options.launchDir);
    const byRoot = byLaunch ?? lookupTrust(user?.projects, projectRoot);
    trust = byRoot ?? "unknown";
    trustFrom = byRoot ? userFile : "not set";
  }

  // Project layers: `.codex/config.toml` from the project root down to the
  // launch directory, closer ones winning. Codex skips a `.codex` directory
  // that is Codex home itself.
  const ignoredProjectConfig: IgnoredProjectConfig[] = [];
  for (const dir of dirsBetween(projectRoot, options.launchDir)) {
    const dotCodex = path.join(dir, ".codex");
    if (samePath(dotCodex, codexHome)) continue;
    const file = path.join(dotCodex, "config.toml");
    const project = readCodexToml(file);
    if (!project) continue;
    const keys: string[] = [];
    if (project.project_doc_max_bytes !== undefined) keys.push("project_doc_max_bytes");
    if (project.project_doc_fallback_filenames !== undefined) keys.push("project_doc_fallback_filenames");
    if (keys.length === 0) continue;
    if (trust !== "trusted") {
      ignoredProjectConfig.push({ file, keys });
      continue;
    }
    if (project.project_doc_max_bytes !== undefined) {
      maxBytes = project.project_doc_max_bytes;
      maxFrom = file;
    }
    if (project.project_doc_fallback_filenames !== undefined) {
      fallbackNames = project.project_doc_fallback_filenames;
      fallbackFrom = file;
    }
  }

  if (options.maxBytesOverride !== undefined) {
    maxBytes = options.maxBytesOverride;
    maxFrom = "override";
  }

  sources.push(
    { key: "project_doc_max_bytes", value: maxBytes, from: maxFrom },
    { key: "project_doc_fallback_filenames", value: fallbackNames, from: fallbackFrom },
    { key: "project_root_markers", value: rootMarkers, from: markersFrom },
  );

  return {
    codexHome,
    maxBytes,
    fallbackNames: usableFallbackNames(fallbackNames),
    rootMarkers,
    projectRoot,
    rootFound: found !== undefined,
    trust,
    trustFrom,
    sources,
    ignoredProjectConfig,
  };
}
