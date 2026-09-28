import path from "node:path";

/**
 * Path helpers that follow the style of the paths in a transcript, not the
 * machine reading it. A run recorded on Windows has `C:\...` paths, and a
 * replay on Linux must still compare them the way Windows would.
 */
export interface RecordedPaths {
  style: "win32" | "posix";
  join(...parts: string[]): string;
  resolve(base: string, p: string): string;
  same(a: string, b: string): boolean;
  /** `child` is `parent` or inside it. */
  inside(child: string, parent: string): boolean;
}

export function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

export function recordedPaths(sample: string): RecordedPaths {
  const win = isWindowsPath(sample);
  const api = win ? path.win32 : path.posix;
  const key = (p: string) => {
    const r = api.resolve(p);
    return win ? r.toLowerCase() : r;
  };
  return {
    style: win ? "win32" : "posix",
    join: (...parts) => api.join(...parts),
    resolve: (base, p) => api.resolve(base, p),
    same: (a, b) => key(a) === key(b),
    inside: (child, parent) => {
      const rel = api.relative(key(parent), key(child));
      return rel === "" || (!(rel === ".." || rel.startsWith(".." + api.sep)) && !api.isAbsolute(rel));
    },
  };
}

/**
 * The directory an instruction file belongs to, relative to the repository
 * root: the parent of `.claude/` for files inside it, else the file's own
 * directory. `.` for the root.
 */
export function ownerDir(relFile: string): string {
  const parts = relFile.split("/");
  const dot = parts.lastIndexOf(".claude");
  const dir = dot >= 0 ? parts.slice(0, dot) : parts.slice(0, -1);
  return dir.length ? dir.join("/") : ".";
}
