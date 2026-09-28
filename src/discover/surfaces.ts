import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { displayPath } from "../util/fs.js";

/**
 * The instruction files ctxreach knows about. Which agent reads which of
 * them, and when, is decided by the resolvers, not here.
 */
export type SurfaceKind =
  | "AGENTS.override.md"
  | "AGENTS.md"
  | "AGENTS.local.md"
  | "fallback"
  | "CLAUDE.md"
  | ".claude/CLAUDE.md"
  | "CLAUDE.local.md"
  | ".claude/AGENTS.md"
  | ".claude/rules";

export interface Surface {
  /** Absolute path. */
  path: string;
  /** Path relative to the scanned root, with forward slashes. */
  rel: string;
  /** The directory the file belongs to. For files under `.claude/` this is the parent of `.claude`. */
  dir: string;
  kind: SurfaceKind;
  bytes: number;
}

const TOP_LEVEL: Record<string, SurfaceKind> = {
  "AGENTS.override.md": "AGENTS.override.md",
  "AGENTS.md": "AGENTS.md",
  "AGENTS.local.md": "AGENTS.local.md",
  "CLAUDE.md": "CLAUDE.md",
  "CLAUDE.local.md": "CLAUDE.local.md",
};

const IN_DOT_CLAUDE: Record<string, SurfaceKind> = {
  "CLAUDE.md": ".claude/CLAUDE.md",
  "AGENTS.md": ".claude/AGENTS.md",
};

const SKIP_DIRS = new Set([".git", ".hg", ".sl", ".svn", "node_modules"]);

export interface DiscoverOptions {
  /** Codex `project_doc_fallback_filenames`, so those files are listed too. */
  fallbackNames?: readonly string[];
}

/**
 * Every instruction file under `root`, sorted by path. Version-control
 * directories and `node_modules` are skipped, and symlinked directories are
 * not followed.
 */
export function discoverSurfaces(root: string, options: DiscoverOptions = {}): Surface[] {
  const fallbacks = new Set(options.fallbackNames ?? []);
  const found: Surface[] = [];

  const add = (file: string, dir: string, kind: SurfaceKind) => {
    let bytes: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) return;
      bytes = st.size;
    } catch {
      return;
    }
    found.push({ path: file, rel: displayPath(file, root), dir, kind, bytes });
  };

  const walkRules = (dir: string, owner: string) => {
    for (const entry of safeReaddir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkRules(full, owner);
      else if (entry.name.endsWith(".md")) add(full, owner, ".claude/rules");
    }
  };

  const walk = (dir: string) => {
    for (const entry of safeReaddir(dir)) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".claude") {
          for (const inner of safeReaddir(full)) {
            const innerFull = path.join(full, inner.name);
            const kind = IN_DOT_CLAUDE[inner.name];
            if (kind && !inner.isDirectory()) add(innerFull, dir, kind);
            else if (inner.name === "rules" && inner.isDirectory()) walkRules(innerFull, dir);
          }
          continue;
        }
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      const kind = TOP_LEVEL[entry.name];
      if (kind) add(full, dir, kind);
      else if (fallbacks.has(entry.name)) add(full, dir, "fallback");
    }
  };

  walk(root);
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** Every `.md` file under `dir`, recursively, sorted. Symlinked directories are not followed. */
export function markdownFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of safeReaddir(d)) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

function safeReaddir(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
