import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "examples");

/** Directories `materialise` and `tempDir` made in this test file, removed by test/setup.ts after it. */
const made: string[] = [];

export interface Materialised {
  /** Temporary directory holding `repo/` and `home/`; also the ceiling for upward walks. */
  base: string;
  repo: string;
  home: string;
  codexHome: string;
  claudeHome: string;
  at: (rel: string) => string;
}

/**
 * Copy `test/fixtures/<name>` into a fresh temporary directory. Its `repo/`
 * becomes a repository root (an empty `.git` directory is created, since a
 * fixture cannot commit one) and its optional `home/` stands in for the
 * user's home directory, so the user's real ~/.codex and ~/.claude never
 * leak into a test.
 */
export function materialise(name: string, options: { git?: boolean; example?: boolean } = {}): Materialised {
  const source = options.example ? path.join(EXAMPLES, name) : path.join(FIXTURES, name);
  if (!existsSync(source)) throw new Error(`no fixture named ${name}`);
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), `ctxreach-${name}-`)));
  made.push(base);
  const repo = path.join(base, "repo");
  const home = path.join(base, "home");
  // An example is a repository itself; a fixture keeps its repository in repo/.
  cpSync(options.example ? source : path.join(source, "repo"), repo, { recursive: true });
  if (!options.example && existsSync(path.join(source, "home")))
    cpSync(path.join(source, "home"), home, { recursive: true });
  else mkdirSync(home);
  if (options.git !== false) mkdirSync(path.join(repo, ".git"));
  return {
    base,
    repo,
    home,
    codexHome: path.join(home, ".codex"),
    claudeHome: path.join(home, ".claude"),
    at: (rel) => path.join(repo, ...rel.split("/")),
  };
}

/** A new empty temporary directory, deleted by test/setup.ts after the test file. */
export function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), `ctxreach-${label}-`)));
  made.push(dir);
  return dir;
}

/** Delete every directory `materialise` or `tempDir` has made so far. */
export function removeMaterialised(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
