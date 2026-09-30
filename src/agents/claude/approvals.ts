import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "../../util/errors.js";
import { ancestors, samePath } from "../../util/fs.js";

/**
 * The one key ctxreach reads from `~/.claude.json` (rule `claude.imports`).
 * Every other key in that file, and every other key of a project's entry, is
 * never looked at.
 */
export const APPROVAL_KEY = "hasClaudeMdExternalIncludesApproved";

const ProjectEntry = z.looseObject({ [APPROVAL_KEY]: z.boolean().optional() });
const ClaudeJson = z.looseObject({ projects: z.record(z.string(), z.unknown()).optional() });

export interface ExternalImportApproval {
  /** The `.claude.json` file read. */
  file: string;
  /** The `projects` key looked up: the repository's main worktree, or the launch directory outside git. */
  project: string;
  /** True only when `.claude.json` records that external imports were approved for that project. */
  approved: boolean;
  /** Why, in words, for messages: "approved in ~/.claude.json", "no entry for ...", and so on. */
  why: string;
}

/**
 * The main worktree of the repository holding `dir`: the nearest directory at
 * or above it with a `.git`, or, when that `.git` is a file pointing into
 * `<main>/.git/worktrees/<name>`, that `<main>`. Undefined outside git.
 */
export function mainWorktree(dir: string, ceiling?: string): string | undefined {
  for (const d of ancestors(path.resolve(dir), ceiling)) {
    const dotGit = path.join(d, ".git");
    let st;
    try {
      st = lstatSync(dotGit);
    } catch {
      continue;
    }
    if (!st.isFile()) return d;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m?.[1]) return d;
    const gitdir = path.resolve(d, m[1]);
    const parts = gitdir.split(/[\\/]+/);
    // <main>/.git/worktrees/<name>: a linked worktree of <main>.
    if (parts.length >= 3 && parts.at(-3) === ".git" && parts.at(-2) === "worktrees")
      return path.dirname(path.dirname(path.dirname(gitdir)));
    return d;
  }
  return undefined;
}

/**
 * Whether Claude Code has a recorded approval of external imports for the
 * project `launchDir` belongs to. Reads only
 * `projects[<main worktree>].hasClaudeMdExternalIncludesApproved`. No file,
 * no entry, or no key means no approval: Claude Code has not asked, or was
 * told no. Throws ConfigError when the file is not JSON or the key is not a
 * boolean, rather than guessing.
 */
export function externalImportApproval(launchDir: string, file: string, ceiling?: string): ExternalImportApproval {
  const project = mainWorktree(launchDir, ceiling) ?? path.resolve(launchDir);
  const answer = (approved: boolean, why: string): ExternalImportApproval => ({ file, project, approved, why });
  if (!existsSync(file)) return answer(false, `no ${path.basename(file)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  const top = ClaudeJson.safeParse(raw);
  if (!top.success) throw new ConfigError(`${file}: projects: ${top.error.issues[0]?.message ?? "invalid"}`);
  const key = Object.keys(top.data.projects ?? {}).find((k) => samePath(k, project));
  if (key === undefined) return answer(false, "no entry for this project");
  const entry = ProjectEntry.safeParse(top.data.projects?.[key]);
  if (!entry.success) {
    const issue = entry.error.issues[0];
    throw new ConfigError(
      `${file}: projects["${key}"].${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"}`,
    );
  }
  const approved = entry.data[APPROVAL_KEY] === true;
  return answer(approved, approved ? "approved" : "not approved");
}
