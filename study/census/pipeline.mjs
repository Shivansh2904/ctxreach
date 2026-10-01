// One unit of the census, end to end: reconstruct, measure, optionally
// render with Codex (K4), then delete the reconstruction. Check K1 runs
// fixtures through exactly this function; the census runs sampled
// repositories through it.

import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync } from "node:fs";
import path from "node:path";
import { codexCheck } from "./codex-check.mjs";
import { measure } from "./measure.mjs";
import { reconstruct } from "./recon.mjs";

/** Names that would make `map` or an agent read an instruction file from outside the repository. */
const ANCESTOR_NAMES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "AGENTS.override.md",
  ".claude/CLAUDE.md",
  ".claude/AGENTS.md",
];

/**
 * Instruction files in `dir` or any directory above it. The census refuses to
 * run when there is one: every reconstruction would inherit it, as Claude Code
 * walks to the filesystem root. Checked by name only (nothing is read).
 */
export function ancestorInstructionFiles(dir) {
  const found = [];
  let cursor = path.resolve(dir);
  for (;;) {
    for (const n of ANCESTOR_NAMES) {
      const p = path.join(cursor, ...n.split("/"));
      if (existsSync(p)) found.push(p);
    }
    const up = path.dirname(cursor);
    if (up === cursor) break;
    cursor = up;
  }
  return found;
}

/** Empty user homes for map (a fresh machine). Returns their paths; throws if they are not empty. */
export function freshHomes(workDir) {
  const codexHome = path.join(workDir, "home", ".codex");
  const claudeHome = path.join(workDir, "home", ".claude");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  checkHomes({ codexHome, claudeHome });
  return { codexHome, claudeHome };
}

export function checkHomes(homes) {
  for (const h of [homes.codexHome, homes.claudeHome]) {
    const left = readdirSync(h);
    if (left.length)
      throw new Error(`${h} is no longer empty (${left.join(", ")}): the fresh-machine condition is broken`);
  }
}

/** Free bytes on the volume holding `dir`. */
export function freeBytes(dir) {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * @param {object} args
 * @param {import("./lib/client.mjs").GetOnlyClient} args.client
 * @param {{ id: string, repo: string, commit: string, frame?: string, index?: number }} args.unit
 * @param {string} args.workDir
 * @param {Function} args.mapRunner
 * @param {{codexHome: string, claudeHome: string}} args.homes
 * @param {string} args.claudeVersion
 * @param {string} args.seed
 * @param {string} [args.codexBin] run K4 when given
 * @param {Function} [args.renderFn] K4 renderer (tests)
 * @param {object} [args.plants]
 * @param {boolean} [args.keep] keep the reconstruction (debugging only)
 */
export async function runUnit({
  client,
  unit,
  workDir,
  mapRunner,
  homes,
  claudeVersion,
  seed,
  codexBin,
  renderFn,
  plants,
  keep,
}) {
  const base = path.join(workDir, "u", unit.id.replace(/[^A-Za-z0-9._-]/g, "_"));
  rmSync(base, { recursive: true, force: true });
  const dir = path.join(base, "repo");
  const head = { id: unit.id, frame: unit.frame, index: unit.index };
  try {
    const recon = await reconstruct({ client, repo: unit.repo, commit: unit.commit, dir, seed, plants });
    if (recon.status !== "ok")
      return {
        ...head,
        repo: unit.repo,
        commit: unit.commit,
        owner: unit.repo.split("/")[0],
        status: "excluded",
        exclusion: recon.exclusion,
        meta: recon.meta,
        problems: recon.problems,
        requests: recon.requests,
      };
    const row = await measure({ recon, mapRunner, homes, claudeVersion, plants });
    checkHomes(homes);
    if (codexBin || renderFn) {
      const bytesOf = new Map(recon.files.filter((f) => f.bytes).map((f) => [f.path, f.bytes]));
      row.k4 = await codexCheck({
        codexBin,
        repoDir: recon.dir,
        pairs: row.pairs,
        readBytes: (rel) => bytesOf.get(rel) ?? Buffer.alloc(0),
        workDir: base,
        renderFn,
      });
    }
    return { ...head, ...row };
  } finally {
    if (!keep) rmSync(base, { recursive: true, force: true });
  }
}
