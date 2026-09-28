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
 *
 * The copy never holds a link (symlink or junction). A link would let the
 * agent, or the removal of the files above, reach outside the copy: removing
 * `.claude/settings.json` through a linked `.claude` deletes the real file
 * the link points to. So a link to a file or directory inside the repository
 * is copied as that file or directory, and a link that leads outside the
 * repository, to nothing, or to a directory that contains it (which would
 * copy forever) is left out and reported.
 */
import { execFileSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
  /**
   * Paths not copied, relative to the copy, with forward slashes. A link that
   * was left out says why, e.g. `.claude (a link to outside the repository)`.
   */
  skipped: string[];
  /** Every link in the repository and what the copy holds in its place, e.g. `CLAUDE.md: copied as a file (a link to AGENTS.md)`. */
  links: string[];
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
 * Checks every sandbox directory must pass before an agent runs in it or it
 * is deleted: its name starts with `ctxreach-probe-`, and it is inside the
 * system temp directory.
 */
function assertSandboxPlace(base: string): void {
  if (!path.basename(base).startsWith(SANDBOX_PREFIX))
    throw new SafetyError(`${base} is not named like a ctxreach sandbox (${SANDBOX_PREFIX}...)`);
  const tmp = realpathSync(os.tmpdir());
  if (!isInside(base, tmp) || samePath(base, tmp))
    throw new SafetyError(`${base} is not inside the system temp directory (${tmp})`);
}

interface CopyState {
  src: string;
  sandbox: Sandbox;
  limits: SandboxLimits;
}

function copyFile(state: CopyState, from: string, to: string, size: number): void {
  const { sandbox, limits } = state;
  sandbox.files++;
  sandbox.bytes += size;
  if (sandbox.files > limits.maxFiles || sandbox.bytes > limits.maxBytes)
    throw new SafetyError(
      `refusing to copy ${state.src}: more than ${limits.maxFiles} files or ${limits.maxBytes} bytes (not counting ${[...SKIP_NAMES].join(", ")})`,
    );
  // COPYFILE_EXCL: never write through something already at the destination.
  copyFileSync(from, to, constants.COPYFILE_EXCL);
}

/**
 * Copy the directory `from` to `to`, which must not exist. `chain` holds the
 * real paths of the directories being copied on the way down, including
 * those reached through a link, to catch links that loop.
 */
function copyTree(state: CopyState, from: string, to: string, chain: readonly string[]): void {
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const fromEntry = path.join(from, entry.name);
    const toEntry = path.join(to, entry.name);
    if (SKIP_NAMES.has(entry.name)) {
      state.sandbox.skipped.push(rel(state.sandbox.repo, toEntry));
      continue;
    }
    // lstat: a symlink, or a junction on Windows, is a link here, never what it points to.
    const st = lstatSync(fromEntry);
    if (st.isSymbolicLink()) copyLink(state, fromEntry, toEntry, chain);
    else if (st.isDirectory()) copyTree(state, fromEntry, toEntry, [...chain, realpathSync(fromEntry)]);
    else if (st.isFile()) copyFile(state, fromEntry, toEntry, st.size);
    else state.sandbox.skipped.push(`${rel(state.sandbox.repo, toEntry)} (not a file, directory or link)`);
  }
}

/** Copy what a link points to, as a plain file or directory, or leave it out and say why. */
function copyLink(state: CopyState, from: string, to: string, chain: readonly string[]): void {
  const shown = rel(state.sandbox.repo, to);
  const skip = (why: string) => {
    state.sandbox.skipped.push(`${shown} (${why})`);
    state.sandbox.links.push(`${shown}: not copied (${why})`);
  };
  let target: string;
  try {
    target = realpathSync(from);
  } catch {
    skip("a link to nothing");
    return;
  }
  if (!isInside(target, state.src)) {
    skip("a link to outside the repository");
    return;
  }
  const inSkipped = rel(state.src, target)
    .split("/")
    .find((part) => SKIP_NAMES.has(part));
  if (inSkipped !== undefined) {
    skip(`a link into ${inSkipped}, which is not copied`);
    return;
  }
  const st = statSync(target);
  const pointsTo = rel(state.src, target);
  if (st.isFile()) {
    copyFile(state, target, to, st.size);
    state.sandbox.links.push(`${shown}: copied as a file (a link to ${pointsTo})`);
  } else if (st.isDirectory()) {
    if (chain.some((dir) => isInside(dir, target))) {
      skip("a link to a directory that contains it");
      return;
    }
    state.sandbox.links.push(`${shown}: copied as a directory (a link to ${pointsTo})`);
    copyTree(state, target, to, [...chain, target]);
  } else {
    skip("a link to something that is not a file or directory");
  }
}

/** Throws `SafetyError` when anything under `root` is a link (symlink or junction). */
function assertNoLinks(root: string): void {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink())
        throw new SafetyError(`the temporary copy holds a link at ${rel(root, p)}; refusing to use it`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
}

/**
 * Copy `source` into a new temporary directory, strip it, and `git init` it.
 * `tmpRoot` (default: the system temp directory) must be inside the system
 * temp directory and not inside `source`.
 */
export function createSandbox(source: string, options: { tmpRoot?: string; limits?: SandboxLimits } = {}): Sandbox {
  const src = realpathSync(source);
  assertCopyable(src);
  const tmpRoot = realpathSync(options.tmpRoot ?? os.tmpdir());
  if (!isInside(tmpRoot, realpathSync(os.tmpdir())))
    throw new SafetyError(`refusing to put the temporary copy outside the system temp directory (${tmpRoot})`);
  if (isInside(tmpRoot, src))
    throw new SafetyError(`refusing to put the temporary copy inside the repository being copied (${tmpRoot})`);
  const limits = options.limits ?? DEFAULT_LIMITS;

  const base = realpathSync(mkdtempSync(path.join(tmpRoot, SANDBOX_PREFIX)));
  const repo = path.join(base, "repo");
  const sandbox: Sandbox = { base, repo, source: src, stripped: [], skipped: [], links: [], files: 0, bytes: 0 };
  writeFileSync(path.join(base, MARKER), JSON.stringify({ tool: "ctxreach", base, source: src }) + "\n");

  try {
    copyTree({ src, sandbox, limits }, src, repo, [src]);
    // Nothing is removed from a copy that holds a link.
    assertNoLinks(repo);
    stripTree(sandbox);
    gitInit(repo);
    assertNoLinks(repo);
    sandbox.skipped.sort();
    sandbox.links.sort();
  } catch (err) {
    removeSandbox(sandbox);
    throw err;
  }
  return sandbox;
}

/**
 * Remove the `STRIP` paths wherever they appear in the copy. Refuses (with
 * `SafetyError`) to remove anything whose directory, links resolved, is not
 * inside the copy: the copy holds no links, so that would be a fault.
 */
export function stripTree(sandbox: Pick<Sandbox, "repo" | "stripped">): void {
  const repoReal = realpathSync(sandbox.repo);
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
      if (!isInside(realpathSync(path.dirname(target)), repoReal))
        throw new SafetyError(
          `refusing to remove ${rel(sandbox.repo, target)}: a link leads it outside the temporary copy`,
        );
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
 * `SafetyError` when `dir` is not inside a sandbox's `repo/`, when the
 * sandbox is not a `ctxreach-probe-` directory inside the system temp
 * directory, or when it is inside the repository it was copied from.
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
      assertSandboxPlace(cursor);
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
  if (!existsSync(sandbox.base)) return;
  if (!existsSync(path.join(sandbox.base, MARKER)))
    throw new SafetyError(`refusing to delete ${sandbox.base}: it does not look like a ctxreach sandbox`);
  try {
    assertSandboxPlace(realpathSync(sandbox.base));
  } catch (err) {
    if (!(err instanceof SafetyError)) throw err;
    throw new SafetyError(`refusing to delete ${sandbox.base}: ${err.message}`);
  }
  rmSync(sandbox.base, { recursive: true, force: true });
}
