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
 * can run commands too; the copy gets a fresh `git init` with no template,
 * and git, run from the copy's root and from the launch directory, must find
 * that `.git` and no other. `node_modules` and other version-control
 * directories are not copied. These names are matched without case (see
 * `nameKey`): on Windows and macOS, `.GIT` is `.git`.
 *
 * The copy never holds a link (symlink or junction). A link would let the
 * agent, or the removal of the files above, reach outside the copy: removing
 * `.claude/settings.json` through a linked `.claude` deletes the real file
 * the link points to. So a link to a file or directory inside the repository
 * is copied as that file or directory, and a link that leads outside the
 * repository, to nothing, to a directory that contains it (which would copy
 * forever), or to a directory another link already copied (which could copy
 * exponentially often) is left out and reported.
 *
 * The marker file says the copy is finished (stripped, with a nonce) only
 * once all of that is done, and the adapter checks it, and the copy itself,
 * again right before the agent starts.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  type Stats,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ancestors, canonicalPath, isInside, isInsideReal, samePath } from "../util/fs.js";
import { SafetyError } from "./types.js";

export const SANDBOX_PREFIX = "ctxreach-probe-";
const MARKER = "ctxreach-sandbox.json";

/**
 * How a name is compared with `SKIP_NAMES` and `STRIP`: without case, since
 * Windows and macOS open `.GIT` for `.git`, and without trailing dots and
 * spaces, which Windows drops from a name. The same on every system, since a
 * case-sensitive directory can be copied onto a disk that is not.
 */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[. ]+$/, "");
}

/** Not copied at all, compared by `nameKey`. */
const SKIP_NAMES = new Set([".git", ".hg", ".svn", ".sl", ".jj", "node_modules"]);
/** Removed from the copy wherever they appear, relative to the directory that holds them, compared by `nameKey`. */
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
  /** Files, directories and links, counted together. */
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
  /** Written into the marker when the copy was finished; an agent runs only with it (`RunRequest.sandboxNonce`). */
  nonce: string;
}

/** A sandbox as `sandboxOf` finds it on disk. */
export interface SandboxInfo {
  base: string;
  repo: string;
  source: string;
  /** The marker says the copy was stripped of every path in the current `STRIP` list. */
  finished: boolean;
  nonce: string | undefined;
}

function rel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/") || ".";
}

/**
 * Refuse sources that are never a repository: a filesystem root, the home
 * directory or anything above it. Compared as directories, not as spellings:
 * `\\?\C:\Users\x` and `\\localhost\C$\Users\x` are the home directory too.
 */
function assertCopyable(source: string): void {
  const home = os.homedir();
  if (path.dirname(source) === source) throw new SafetyError(`refusing to copy ${source}: it is a filesystem root`);
  if (isInsideReal(home, source))
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
  /** Files, directories and links met so far. */
  entries: number;
  /** Directories copied through a link, by device and inode, and the first link that copied each. */
  linkedDirs: Map<string, string>;
}

/** Count one file, directory or link (and its bytes) against the limits. */
function count(state: CopyState, bytes = 0): void {
  const { sandbox, limits } = state;
  state.entries++;
  sandbox.bytes += bytes;
  if (state.entries > limits.maxFiles || sandbox.bytes > limits.maxBytes)
    throw new SafetyError(
      `refusing to copy ${state.src}: more than ${limits.maxFiles} files, directories and links, or ${limits.maxBytes} bytes (not counting ${[...SKIP_NAMES].join(", ")})`,
    );
}

function copyFile(state: CopyState, from: string, to: string, size: number): void {
  state.sandbox.files++;
  count(state, size);
  // COPYFILE_EXCL: never write through something already at the destination.
  copyFileSync(from, to, constants.COPYFILE_EXCL);
}

/**
 * Copy the directory `from` to `to`, which must not exist. `chain` holds the
 * real paths of the directories being copied on the way down, including
 * those reached through a link, to catch links that loop.
 */
function copyTree(state: CopyState, from: string, to: string, chain: readonly string[]): void {
  count(state);
  mkdirSync(to);
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const fromEntry = path.join(from, entry.name);
    const toEntry = path.join(to, entry.name);
    // Whatever it is: a .git file (a gitdir link) is left out like a .git directory.
    if (SKIP_NAMES.has(nameKey(entry.name))) {
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
  count(state);
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
    .find((part) => SKIP_NAMES.has(nameKey(part)));
  if (inSkipped !== undefined) {
    skip(`a link into ${inSkipped}, which is not copied`);
    return;
  }
  const st = statSync(target, { bigint: true });
  const pointsTo = rel(state.src, target);
  if (st.isFile()) {
    copyFile(state, target, to, Number(st.size));
    state.sandbox.links.push(`${shown}: copied as a file (a link to ${pointsTo})`);
  } else if (st.isDirectory()) {
    if (chain.some((dir) => isInside(dir, target))) {
      skip("a link to a directory that contains it");
      return;
    }
    // Links to links to the same directory would copy it once per path to it.
    const id = st.ino === 0n ? `path:${target}` : `${st.dev}:${st.ino}`;
    const first = state.linkedDirs.get(id);
    if (first !== undefined) {
      skip(`a duplicate target: ${pointsTo}, already copied through ${first}`);
      return;
    }
    state.linkedDirs.set(id, shown);
    state.sandbox.links.push(`${shown}: copied as a directory (a link to ${pointsTo})`);
    copyTree(state, target, to, [...chain, target]);
  } else {
    skip("a link to something that is not a file or directory");
  }
}

/** Every file and directory in the copy, depth first, found with `lstat`: `visit` may throw to refuse one. */
function walkCopy(root: string, visit: (p: string, st: Stats) => void): void {
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = lstatSync(p);
      visit(p, st);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
    }
  };
  walk(root);
}

/** Throws `SafetyError` when anything under `root` is a link (symlink or junction). */
function assertNoLinks(root: string): void {
  walkCopy(root, (p, st) => {
    if (st.isSymbolicLink())
      throw new SafetyError(`the temporary copy holds a link at ${rel(root, p)}; refusing to use it`);
  });
}

/**
 * The `STRIP` paths under `dir` itself, whatever their case: on a disk that
 * tells case apart, `.claude` and `.Claude` are both found.
 */
function stripTargets(dir: string): string[] {
  const found: string[] = [];
  const match = (at: string, parts: readonly string[]) => {
    const [head, ...rest] = parts;
    let names: string[];
    try {
      names = readdirSync(at);
    } catch {
      return;
    }
    for (const name of names) {
      if (nameKey(name) !== head) continue;
      const p = path.join(at, name);
      if (rest.length === 0) found.push(p);
      else match(p, rest);
    }
  };
  for (const item of STRIP) {
    match(dir, item.split("/"));
  }
  return found;
}

/**
 * Throws `SafetyError` when the copy holds any `STRIP` path, in any case, or
 * any link: checked again right before an agent runs.
 */
export function assertStripped(repo: string): void {
  const check = (dir: string) => {
    const left = stripTargets(dir);
    if (left.length)
      throw new SafetyError(
        `the temporary copy still holds ${rel(repo, left[0] as string)}, which is never left in it; refusing to use it`,
      );
  };
  check(repo);
  walkCopy(repo, (p, st) => {
    if (st.isSymbolicLink())
      throw new SafetyError(`the temporary copy holds a link at ${rel(repo, p)}; refusing to use it`);
    if (st.isDirectory()) check(p);
  });
}

/**
 * git, found on PATH in an absolute directory. Run by name with the copy as
 * its working directory, git would be looked for in the copy itself first:
 * on Windows unless NoDefaultCurrentDirectoryInExePath is set, and anywhere
 * through a relative PATH entry such as `.`.
 */
function findGit(): string {
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter((d) => path.isAbsolute(d));
  for (const dir of dirs)
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // Not in this directory.
      }
    }
  throw new Error("could not find git on PATH (in an absolute directory); probe needs it to give the copy a .git");
}

/** The environment for git: variables such as GIT_DIR would point it somewhere else. */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
}

function gitInit(repo: string): void {
  execFileSync(findGit(), ["init", "-q", "--template="], {
    cwd: repo,
    env: gitEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/**
 * Throws `SafetyError` unless the copy's root holds a directory named
 * exactly `.git` (and nothing else by that name, in any case), and git, run
 * in each of `dirs`, uses it: a `.GIT` copied beside it, or a repository
 * nested in the copy, would give git another config to run commands from.
 */
export function assertOwnGit(repo: string, dirs: readonly string[]): void {
  const own = path.join(repo, ".git");
  const names = readdirSync(repo).filter((n) => nameKey(n) === ".git");
  const st = lstatSync(own, { throwIfNoEntry: false });
  if (names.length !== 1 || names[0] !== ".git" || !st?.isDirectory() || st.isSymbolicLink())
    throw new SafetyError(
      `${repo} has no .git directory of its own (found: ${names.join(", ") || "none"}); refusing to use it`,
    );
  const expected = realpathSync.native(own);
  for (const dir of dirs) {
    let gitDir: string;
    try {
      gitDir = execFileSync(findGit(), ["rev-parse", "--absolute-git-dir"], {
        cwd: dir,
        env: gitEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (err) {
      throw new SafetyError(`git found no repository from ${dir}: ${(err as Error).message.split("\n")[0]}`);
    }
    let real = gitDir;
    try {
      real = realpathSync.native(gitDir);
    } catch {
      // Compared as git printed it.
    }
    if (real !== expected)
      throw new SafetyError(`git, run in ${dir}, uses ${gitDir}, not the copy's own ${expected}; refusing to use it`);
  }
}

interface MarkerData {
  tool: "ctxreach";
  base: string;
  source: string;
  /** Written only when the copy is finished. */
  stripped?: true;
  strip?: string[];
  nonce?: string;
}

function writeMarker(base: string, data: MarkerData): void {
  writeFileSync(path.join(base, MARKER), JSON.stringify(data) + "\n");
}

/**
 * Copy `source` into a new temporary directory, strip it, and `git init` it.
 * `tmpRoot` (default: the system temp directory) must be inside the system
 * temp directory and not inside `source`. `launchDir` (relative to `source`,
 * with forward slashes) is where the agent will run: git must find the copy's
 * own `.git` from there too.
 */
export function createSandbox(
  source: string,
  options: { tmpRoot?: string; limits?: SandboxLimits; launchDir?: string } = {},
): Sandbox {
  const src = canonicalPath(source);
  assertCopyable(src);
  const tmpRoot = realpathSync(options.tmpRoot ?? os.tmpdir());
  // Compared as spelled: a spelling that does not match is refused.
  if (!isInside(tmpRoot, realpathSync(os.tmpdir())))
    throw new SafetyError(`refusing to put the temporary copy outside the system temp directory (${tmpRoot})`);
  // Compared as directories: no spelling of the repository gets past this.
  if (isInsideReal(tmpRoot, src))
    throw new SafetyError(`refusing to put the temporary copy inside the repository being copied (${tmpRoot})`);
  const limits = options.limits ?? DEFAULT_LIMITS;

  const base = realpathSync(mkdtempSync(path.join(tmpRoot, SANDBOX_PREFIX)));
  const repo = path.join(base, "repo");
  const sandbox: Sandbox = {
    base,
    repo,
    source: src,
    stripped: [],
    skipped: [],
    links: [],
    files: 0,
    bytes: 0,
    nonce: "",
  };
  // Not finished yet: an agent refuses to run in it.
  writeMarker(base, { tool: "ctxreach", base, source: src });

  try {
    copyTree({ src, sandbox, limits, entries: 0, linkedDirs: new Map() }, src, repo, [src]);
    // Nothing is removed from a copy that holds a link.
    assertNoLinks(repo);
    stripTree(sandbox);
    gitInit(repo);
    assertStripped(repo);
    const launch = path.join(repo, ...(options.launchDir ?? ".").split("/"));
    assertOwnGit(repo, launch !== repo && existsSync(launch) ? [repo, launch] : [repo]);
    sandbox.skipped.sort();
    sandbox.links.sort();
    sandbox.nonce = randomBytes(16).toString("hex");
    writeMarker(base, { tool: "ctxreach", base, source: src, stripped: true, strip: [...STRIP], nonce: sandbox.nonce });
  } catch (err) {
    removeSandbox(sandbox);
    throw err;
  }
  return sandbox;
}

/**
 * Remove the `STRIP` paths, in any case, wherever they appear in a
 * sandbox's copy. Refuses (with `SafetyError`) when `sandbox.repo` is not
 * exactly a sandbox's `repo/` reached without a link, and refuses to remove
 * anything whose directory, links resolved, is not inside the copy: the copy
 * holds no links, so that would be a fault.
 */
export function stripTree(sandbox: Pick<Sandbox, "repo" | "stripped">): void {
  const box = sandboxOf(sandbox.repo);
  if (!samePath(box.repo, sandbox.repo))
    throw new SafetyError(`refusing to strip ${sandbox.repo}: it is not the copy's root, ${box.repo}`);
  for (const dir of ancestors(path.resolve(sandbox.repo), box.base))
    if (lstatSync(dir).isSymbolicLink()) throw new SafetyError(`refusing to strip ${sandbox.repo}: ${dir} is a link`);
  const repoReal = realpathSync(sandbox.repo);
  const walk = (dir: string) => {
    for (const target of stripTargets(dir)) {
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

/**
 * The sandbox that `dir` is inside, found by its marker file. Throws
 * `SafetyError` when `dir` is not inside a sandbox's `repo/`, when the
 * sandbox is not a `ctxreach-probe-` directory inside the system temp
 * directory, or when it is inside the repository it was copied from.
 */
export function sandboxOf(dir: string): SandboxInfo {
  const real = realpathSync(dir);
  let cursor = real;
  for (;;) {
    const marker = path.join(cursor, MARKER);
    if (existsSync(marker)) {
      let data: Partial<Record<keyof MarkerData, unknown>>;
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
      if (isInsideReal(cursor, data.source) || isInsideReal(data.source, cursor))
        throw new SafetyError(`sandbox ${cursor} overlaps the repository it copies (${data.source})`);
      const finished = data.stripped === true && JSON.stringify(data.strip) === JSON.stringify(STRIP);
      return {
        base: cursor,
        repo,
        source: data.source,
        finished,
        nonce: typeof data.nonce === "string" ? data.nonce : undefined,
      };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new SafetyError(`${dir} is not inside a ctxreach sandbox`);
    cursor = parent;
  }
}

/**
 * The checks made right before an agent starts in `workdir`, inside `box`
 * (from `sandboxOf`): the marker says the copy was finished, by the
 * `createSandbox` call that returned `nonce`; the copy holds no `STRIP` path
 * and no link; and git, from the copy's root and from `workdir`, uses the
 * copy's own `.git`.
 */
export function assertReadyToRun(box: SandboxInfo, nonce: string, workdir: string): void {
  if (!box.finished)
    throw new SafetyError(
      `${box.base} was never finished: its marker does not say the copy was stripped; refusing to run`,
    );
  if (!nonce || box.nonce !== nonce)
    throw new SafetyError(
      `${box.base} is not the sandbox this run made (its marker carries another nonce); refusing to run`,
    );
  assertStripped(box.repo);
  assertOwnGit(box.repo, [box.repo, workdir]);
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
