import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Names in a directory, matched exactly. `existsSync("AGENTS.md")` would also
 * match `agents.md` on Windows and macOS, which would make predictions depend
 * on the machine running ctxreach; listing the directory keeps them the same
 * everywhere.
 */
export function entryNames(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
}

/** True when `dir/name` exists under exactly that name and is a regular file (symlinks followed). */
export function isFileNamed(dir: string, name: string): boolean {
  if (name.includes("/")) {
    const parts = name.split("/");
    const leaf = parts.pop() as string;
    let current = dir;
    for (const part of parts) {
      if (!entryNames(current).has(part)) return false;
      current = path.join(current, part);
    }
    return isFileNamed(current, leaf);
  }
  if (!entryNames(dir).has(name)) return false;
  try {
    return statSync(path.join(dir, name)).isFile();
  } catch {
    return false;
  }
}

/** True when `dir/name` exists under exactly that name, whatever its type. */
export function existsNamed(dir: string, name: string): boolean {
  return entryNames(dir).has(name);
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readBytes(p: string): Uint8Array {
  return new Uint8Array(readFileSync(p));
}

/** Directories from `top` down to `bottom`, inclusive. `bottom` must be inside `top`. */
export function dirsBetween(top: string, bottom: string): string[] {
  const dirs: string[] = [];
  let cursor = bottom;
  for (;;) {
    dirs.push(cursor);
    if (samePath(cursor, top)) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return dirs.reverse();
}

/** `dir` and each of its ancestors, nearest first, stopping after `ceiling` if given. */
export function ancestors(dir: string, ceiling?: string): string[] {
  const out: string[] = [];
  let cursor = dir;
  for (;;) {
    out.push(cursor);
    if (ceiling !== undefined && samePath(cursor, ceiling)) break;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return out;
}

export function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** True when a relative path climbs out of its base (".." or "../x"), not for names like "..cache". */
function isParentStep(rel: string): boolean {
  return rel === ".." || rel.startsWith(".." + path.sep);
}

/** True when `child` is `parent` or inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!isParentStep(rel) && !path.isAbsolute(rel));
}

/**
 * The spelling the operating system gives an existing path: links resolved,
 * and on Windows the `\\?\` and `\\?\UNC\` prefixes removed. Two spellings
 * of one directory can still differ (`\\localhost\C$\Users` and `C:\Users`),
 * so safety checks compare with `isInsideReal`, not with this alone.
 */
export function canonicalPath(p: string): string {
  const real = realpathSync.native(p);
  if (process.platform !== "win32") return real;
  if (real.startsWith("\\\\?\\UNC\\")) return "\\\\" + real.slice(8);
  if (real.startsWith("\\\\?\\")) return real.slice(4);
  return real;
}

/** Device and inode (on Windows, volume serial number and file index), or undefined when unknown. */
function fileId(p: string): string | undefined {
  try {
    const st = statSync(p, { bigint: true });
    // A filesystem that reports no inode cannot be compared this way.
    return st.ino === 0n ? undefined : `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * True when `child` is `parent` or inside it, however either is spelled:
 * `\\?\C:\Users\x`, `\\localhost\C$\Users\x` and `C:\Users\x` are one
 * directory. Compares canonical spellings, then each of `child`'s ancestors
 * with `parent` by device and inode. Paths that do not exist are compared as
 * spelled. For checks that must refuse when a path IS inside another.
 */
export function isInsideReal(child: string, parent: string): boolean {
  const spelled = (p: string) => {
    try {
      return canonicalPath(p);
    } catch {
      return path.resolve(p);
    }
  };
  const c = spelled(child);
  const p = spelled(parent);
  if (isInside(c, p)) return true;
  const target = fileId(p);
  if (target === undefined) return false;
  return ancestors(c).some((dir) => fileId(dir) === target);
}

/** `p` if it exists, or its nearest ancestor that does. */
export function nearestExisting(p: string): string {
  let cursor = path.resolve(p);
  while (!existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return cursor;
}

/** A path relative to `base`, with forward slashes, for display and JSON. */
export function displayPath(p: string, base: string): string {
  const rel = path.relative(base, p);
  if (rel === "") return ".";
  if (isParentStep(rel) || path.isAbsolute(rel)) return p.split(path.sep).join("/");
  return rel.split(path.sep).join("/");
}
