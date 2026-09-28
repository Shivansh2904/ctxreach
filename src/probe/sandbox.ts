/**
 * The throwaway copy of a repository that `probe` runs an agent in.
 *
 * `claude -p` without `--bare` runs a project's hooks and connects its
 * `.mcp.json` servers even in a folder that was never trusted (docs/rules.md,
 * rule `claude.bare`), so before any run the copy loses everything in the
 * repository that can make the agent execute something:
 *
 * - `.claude/settings.json` and `.claude/settings.local.json` (hooks, the
 *   `env` block, helper commands such as `apiKeyHelper`, plugin settings);
 * - `.claude/skills/`, `.claude/agents/`, `.claude/hooks/` (skill and
 *   subagent hooks, and the scripts hooks call);
 * - `.claude-plugin/` (a plugin shipped in the repository);
 * - `.mcp.json` (MCP servers);
 * - `.codex/` (Codex project config, which can also run commands).
 *
 * The repository's own `.git` is never copied, since its config and hooks
 * can run commands too; the copy gets a fresh `git init` with no template.
 * `node_modules` and other version-control directories are not copied.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInside, samePath } from "../util/fs.js";
import { SafetyError } from "./types.js";

export const SANDBOX_PREFIX = "ctxreach-probe-";
const MARKER = "ctxreach-sandbox.json";

/** Not copied at all. */
const SKIP_NAMES = new Set([".git", ".hg", ".svn", ".sl", ".jj", "node_modules"]);
/** Removed from the copy wherever they appear, relative to the directory that holds them. */
export const STRIP = [
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/skills",
  ".claude/agents",
  ".claude/hooks",
  ".claude-plugin",
  ".mcp.json",
  ".codex",
] as const;

export interface SandboxLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: SandboxLimits = { maxFiles: 20000, maxBytes: 200 * 1024 * 1024 };

export interface Sandbox {
  /** The temporary directory; holds the marker file and `repo/`. */
  base: string;
  /** The copy of the repository. */
  repo: string;
  /** The repository that was copied. */
  source: string;
  /** Paths removed from the copy, relative to it, with forward slashes. */
  stripped: string[];
  /** Directories not copied, relative to the source, with forward slashes. */
  skipped: string[];
  files: number;
  bytes: number;
}

function rel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/") || ".";
}

/** Refuse sources that are never a repository: a filesystem root, the home directory or anything above it. */
function assertCopyable(source: string): void {
  const home = os.homedir();
  if (path.dirname(source) === source) throw new SafetyError(`refusing to copy ${source}: it is a filesystem root`);
  if (isInside(home, source))
    throw new SafetyError(`refusing to copy ${source}: it is your home directory or contains it`);
}

/**
 * Copy `source` into a new temporary directory, strip it, and `git init` it.
 * `tmpRoot` (default: the system temp directory) must not be inside `source`.
 */
export function createSandbox(source: string, options: { tmpRoot?: string; limits?: SandboxLimits } = {}): Sandbox {
  const src = realpathSync(source);
  assertCopyable(src);
  const tmpRoot = realpathSync(options.tmpRoot ?? os.tmpdir());
  if (isInside(tmpRoot, src))
    throw new SafetyError(`refusing to put the temporary copy inside the repository being copied (${tmpRoot})`);
  const limits = options.limits ?? DEFAULT_LIMITS;

  const base = realpathSync(mkdtempSync(path.join(tmpRoot, SANDBOX_PREFIX)));
  const repo = path.join(base, "repo");
  const sandbox: Sandbox = { base, repo, source: src, stripped: [], skipped: [], files: 0, bytes: 0 };
  writeFileSync(path.join(base, MARKER), JSON.stringify({ tool: "ctxreach", base, source: src }) + "\n");

  try {
    cpSync(src, repo, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (from) => {
        const name = path.basename(from);
        if (from !== src && SKIP_NAMES.has(name)) {
          sandbox.skipped.push(rel(src, from));
          return false;
        }
        const st = lstatSync(from);
        if (st.isFile()) {
          sandbox.files++;
          sandbox.bytes += st.size;
          if (sandbox.files > limits.maxFiles || sandbox.bytes > limits.maxBytes)
            throw new SafetyError(
              `refusing to copy ${src}: more than ${limits.maxFiles} files or ${limits.maxBytes} bytes (not counting ${[...SKIP_NAMES].join(", ")})`,
            );
        }
        return true;
      },
    });
    stripTree(sandbox);
    gitInit(repo);
  } catch (err) {
    removeSandbox(sandbox);
    throw err;
  }
  return sandbox;
}

function stripTree(sandbox: Sandbox): void {
  const walk = (dir: string) => {
    for (const item of STRIP) {
      const target = path.join(dir, ...item.split("/"));
      let exists = false;
      try {
        lstatSync(target);
        exists = true;
      } catch {
        // Not there.
      }
      if (!exists) continue;
      rmSync(target, { recursive: true, force: true });
      sandbox.stripped.push(rel(sandbox.repo, target));
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) walk(path.join(dir, e.name));
  };
  walk(sandbox.repo);
  sandbox.stripped.sort();
}

function gitInit(repo: string): void {
  // Variables such as GIT_DIR would point git init somewhere else.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
  execFileSync("git", ["init", "-q", "--template="], { cwd: repo, env, stdio: ["ignore", "ignore", "pipe"] });
}

/**
 * The sandbox that `dir` is inside, found by its marker file. Throws
 * `SafetyError` when `dir` is not inside a sandbox's `repo/`, or when the
 * sandbox is inside the repository it was copied from.
 */
export function sandboxOf(dir: string): { base: string; repo: string; source: string } {
  const real = realpathSync(dir);
  let cursor = real;
  for (;;) {
    const marker = path.join(cursor, MARKER);
    if (existsSync(marker)) {
      let data: { tool?: unknown; base?: unknown; source?: unknown };
      try {
        data = JSON.parse(readFileSync(marker, "utf8")) as typeof data;
      } catch {
        throw new SafetyError(`${marker} is not a ctxreach sandbox marker`);
      }
      if (data.tool !== "ctxreach" || typeof data.base !== "string" || typeof data.source !== "string")
        throw new SafetyError(`${marker} is not a ctxreach sandbox marker`);
      if (!samePath(data.base, cursor)) throw new SafetyError(`${marker} names a different directory`);
      const repo = path.join(cursor, "repo");
      if (!isInside(real, repo)) throw new SafetyError(`${dir} is not inside the sandbox's copy of the repository`);
      if (isInside(cursor, data.source) || isInside(data.source, cursor))
        throw new SafetyError(`sandbox ${cursor} overlaps the repository it copies (${data.source})`);
      return { base: cursor, repo, source: data.source };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new SafetyError(`${dir} is not inside a ctxreach sandbox`);
    cursor = parent;
  }
}

export function removeSandbox(sandbox: { base: string }): void {
  const name = path.basename(sandbox.base);
  if (!name.startsWith(SANDBOX_PREFIX) || !existsSync(path.join(sandbox.base, MARKER))) {
    if (existsSync(sandbox.base))
      throw new SafetyError(`refusing to delete ${sandbox.base}: it does not look like a ctxreach sandbox`);
    return;
  }
  rmSync(sandbox.base, { recursive: true, force: true });
}
