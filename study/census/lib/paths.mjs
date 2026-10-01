// Which paths of a repository tree the census fetches, and which directories
// it launches the agents from. Pure functions over tree paths (forward
// slashes, relative to the repository root).

import { createHash } from "node:crypto";

/**
 * Files the census reconstructs: every file ctxreach's discovery or either
 * resolver reads (study/PREREG.md, "Reconstruction"). Exact case, as the
 * agents match them on a case-sensitive file system.
 */
const FETCH = [
  /(^|\/)(AGENTS\.md|AGENTS\.override\.md|AGENTS\.local\.md|CLAUDE\.md|CLAUDE\.local\.md)$/,
  /(^|\/)\.claude\/(CLAUDE\.md|AGENTS\.md|settings\.json|settings\.local\.json)$/,
  /(^|\/)\.claude\/rules\/.+\.md$/,
  /(^|\/)\.codex\/config\.toml$/,
];

/** Directories ctxreach's discovery never enters (src/discover/surfaces.ts SKIP_DIRS). */
export const SKIP_DIRS = new Set([".git", ".hg", ".sl", ".svn", "node_modules"]);

/** Package manifests that mark a type-3 launch directory. */
export const MANIFESTS = new Set(["package.json", "pyproject.toml", "Cargo.toml", "go.mod"]);

/** Launch-directory type 2: a directory holding one of these (for `.claude/CLAUDE.md`, the parent of `.claude`). */
const OWN_INSTRUCTION = /(^|\/)(AGENTS\.md|AGENTS\.override\.md|CLAUDE\.md|CLAUDE\.local\.md)$/;
const DOT_CLAUDE_MD = /(^|\/)\.claude\/CLAUDE\.md$/;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function skipped(rel) {
  return rel.split("/").some((seg, i, all) => i < all.length - 1 && SKIP_DIRS.has(seg));
}

export function isFetched(rel) {
  return !skipped(rel) && FETCH.some((re) => re.test(rel));
}

/** Why a tree path cannot be written safely on this machine, or undefined. */
export function unsafePath(rel, platform = process.platform) {
  if (rel === "" || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0")) return "malformed";
  const segs = rel.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "malformed";
  if (platform === "win32") {
    if (segs.some((s) => /[<>:"|?*\u0000-\u001f]/.test(s))) return "invalid-on-windows";
    if (segs.some((s) => /[. ]$/.test(s))) return "invalid-on-windows";
    if (segs.some((s) => WINDOWS_RESERVED.test(s))) return "reserved-on-windows";
  }
  return undefined;
}

export function dirOf(rel) {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "." : rel.slice(0, i);
}

/** Resolve `target` (a relative link target or import) against directory `fromDir` inside the tree; undefined if it leaves the root. */
export function joinInside(fromDir, target) {
  if (target.startsWith("/") || /^[A-Za-z]:/.test(target) || target.startsWith("~")) return undefined;
  const out = fromDir === "." ? [] : fromDir.split("/");
  for (const seg of target.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join("/") : undefined;
}

/**
 * Candidate import targets in a file's text: every `@token`, anywhere,
 * including code blocks, plus the token without trailing punctuation. A
 * superset of what Claude Code imports, so the reconstruction never misses a
 * file that ctxreach would then resolve; fetching extra files changes
 * nothing, because `map` decides what loads.
 */
export function importCandidates(text) {
  const out = new Set();
  for (const m of text.matchAll(/@([^\s`'"<>()[\]{}]+)/g)) {
    const t = m[1];
    out.add(t);
    const trimmed = t.replace(/[.,;:!?)]+$/, "");
    if (trimmed && trimmed !== t) out.add(trimmed);
  }
  return [...out];
}

/** Type-2 launch directories: every directory (other than the root) holding an instruction file of its own. */
export function instructionDirs(paths) {
  const dirs = new Set();
  for (const rel of paths) {
    if (skipped(rel)) continue;
    if (DOT_CLAUDE_MD.test(rel)) dirs.add(dirOf(dirOf(rel)));
    else if (OWN_INSTRUCTION.test(rel)) dirs.add(dirOf(rel));
  }
  dirs.delete(".");
  return [...dirs].sort();
}

/** Type-3 candidates: directories 1 to 3 levels deep holding a package manifest, not already type 1 or 2. */
export function manifestDirs(paths, exclude = new Set()) {
  const dirs = new Set();
  for (const rel of paths) {
    if (skipped(rel)) continue;
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    if (!MANIFESTS.has(name)) continue;
    const dir = dirOf(rel);
    if (dir === ".") continue;
    if (dir.split("/").length > 3) continue;
    if (!exclude.has(dir)) dirs.add(dir);
  }
  return [...dirs].sort();
}

/** Git's blob id for these bytes: sha1("blob <length>\0" + bytes). */
export function gitBlobSha(bytes) {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
