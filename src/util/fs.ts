import { readdirSync, readFileSync, statSync } from "node:fs";
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

/** True when `child` is `parent` or inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A path relative to `base`, with forward slashes, for display and JSON. */
export function displayPath(p: string, base: string): string {
  const rel = path.relative(base, p);
  if (rel === "") return ".";
  if (rel.startsWith("..") || path.isAbsolute(rel)) return p.split(path.sep).join("/");
  return rel.split(path.sep).join("/");
}
