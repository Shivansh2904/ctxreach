// Files-only reconstruction of one repository at a pinned commit.
//
// Reads the repository's metadata and its recursive tree through the GET-only
// client, then writes, under `dir`, only the files ctxreach reads (instruction
// files, `.claude/settings*.json`, `.codex/config.toml`), the files they might
// import, and an empty `.git` directory as the root marker. Every fetched file
// is checked against the tree's blob id. Symlinks (tree mode 120000) are
// written as a copy of their target, with the link recorded, so the result is
// the same on every operating system; the measurement applies the symlink
// rule from the recorded modes (study/PREREG.md, "Reconstruction").
//
// Nothing from the repository is executed. The caller deletes `dir` after
// measuring.
//
// CLI (one repository, for inspection): node study/census/recon.mjs owner/repo <commit> <outDir>

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetOnlyClient } from "./lib/client.mjs";
import {
  dirOf,
  gitBlobSha,
  importCandidates,
  instructionDirs,
  isFetched,
  joinInside,
  manifestDirs,
  skipped,
  unsafePath,
} from "./lib/paths.mjs";
import { planted } from "./lib/plants.mjs";
import { draw } from "./lib/prng.mjs";

export const MAX_TREE_ENTRIES = 100_000;
export const MAX_TYPE2_DIRS = 20;
export const MAX_TYPE3_DIRS = 20;
export const MAX_IMPORT_DEPTH = 6;
export const MAX_IMPORT_FILES = 50;
export const MAX_REPO_BYTES = 50 * 1024 * 1024;

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

function encodePath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

/**
 * @param {object} args
 * @param {GetOnlyClient} args.client
 * @param {string} args.repo "owner/name"
 * @param {string} args.commit full commit SHA (Sourcegraph's indexed commit)
 * @param {string} args.dir directory to write the repository into (created)
 * @param {string} args.seed 8 hex digits, for the seeded draw of type-3 directories
 * @param {object} [args.plants]
 */
export async function reconstruct({ client, repo, commit, dir, seed, plants }) {
  const [owner, name] = repo.split("/");
  const out = {
    repo,
    commit,
    dir: path.resolve(dir),
    status: "ok",
    meta: undefined,
    tree: undefined,
    files: [],
    launch: { t1: ["."], t2: [], t3: [], t2Total: 0, t3Total: 0 },
    problems: [],
    requests: { api: 0, raw: 0 },
  };
  const before = { ...client.byHost };
  const exclude = (reason, detail) => {
    out.status = "excluded";
    out.exclusion = reason;
    if (detail) out.problems.push(detail);
    return finish();
  };
  const finish = () => {
    out.requests.api = (client.byHost["api.github.com"] ?? 0) - (before["api.github.com"] ?? 0);
    out.requests.raw = (client.byHost["raw.githubusercontent.com"] ?? 0) - (before["raw.githubusercontent.com"] ?? 0);
    return out;
  };

  if (!owner || !name || !/^[0-9a-f]{40}$/.test(commit)) return exclude("bad-unit", `bad unit ${repo}@${commit}`);

  // Repository metadata: exclusions at fetch time.
  let meta;
  try {
    meta = await client.getJson(`${API}/repos/${owner}/${name}`);
  } catch (err) {
    if (err?.fatal) throw err; // gh cannot run at all: stop, do not exclude
    return exclude("fetch-failed", err.message);
  }
  if (meta.status === 404) return exclude("repo-gone");
  if (meta.status === 451 || meta.status === 403) return exclude("repo-blocked", `HTTP ${meta.status}`);
  if (!meta.json) return exclude("fetch-failed", `repository metadata: HTTP ${meta.status}`);
  const m = meta.json;
  out.meta = {
    fullName: m.full_name,
    fork: m.fork === true,
    archived: m.archived === true,
    mirror: m.mirror_url != null,
    template: m.is_template === true,
    stars: m.stargazers_count,
    defaultBranch: m.default_branch,
  };
  if (out.meta.fork) return exclude("fork");
  if (out.meta.mirror) return exclude("mirror");
  if (out.meta.archived) return exclude("archived");

  // The tree at the pinned commit.
  let tree;
  try {
    tree = await client.getJson(`${API}/repos/${owner}/${name}/git/trees/${commit}?recursive=1`);
  } catch (err) {
    if (err?.fatal) throw err; // gh cannot run at all: stop, do not exclude
    return exclude("fetch-failed", err.message);
  }
  if (tree.status === 404 || tree.status === 422) return exclude("commit-gone");
  if (tree.status === 409) return exclude("commit-gone", "empty repository");
  if (!tree.json) return exclude("fetch-failed", `tree: HTTP ${tree.status}`);
  const entries = tree.json.tree ?? [];
  out.tree = { entries: entries.length, truncated: tree.json.truncated === true };
  if (out.tree.truncated) return exclude("tree-truncated");
  if (entries.length > MAX_TREE_ENTRIES) return exclude("tree-truncated");

  const blobs = new Map();
  for (const e of entries) if (e.type === "blob") blobs.set(e.path, e);

  mkdirSync(path.join(out.dir, ".git"), { recursive: true });
  const written = new Map(); // lower-cased path -> path, to catch case collisions
  let totalBytes = 0;
  const fetched = new Map(); // path -> record

  const writeFile = (rel, bytes) => {
    const why = unsafePath(rel);
    if (why) return why;
    const key = process.platform === "win32" || process.platform === "darwin" ? rel.toLowerCase() : rel;
    if (written.has(key) && written.get(key) !== rel) return "case-collision";
    try {
      const file = path.join(out.dir, ...rel.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    } catch (err) {
      return `write-failed: ${err.code ?? err.message}`;
    }
    written.set(key, rel);
    return undefined;
  };

  const rawBytes = async (entry) => {
    const res = await client.get(`${RAW}/${owner}/${name}/${commit}/${encodePath(entry.path)}`);
    if (res.status !== 200) return { error: `raw HTTP ${res.status}` };
    if (gitBlobSha(res.body) !== entry.sha) return { error: "blob id mismatch" };
    return { bytes: res.body };
  };

  const linkTarget = async (entry) => {
    const res = await client.getJson(`${API}/repos/${owner}/${name}/git/blobs/${entry.sha}`);
    if (!res.json || res.json.encoding !== "base64") return { error: `blob HTTP ${res.status}` };
    const bytes = Buffer.from(res.json.content, "base64");
    if (gitBlobSha(bytes) !== entry.sha) return { error: "blob id mismatch" };
    return { target: bytes.toString("utf8") };
  };

  /** Fetch one tree entry (following a symlink to its target) and write it at its own path. */
  const fetchEntry = async (entry, role) => {
    if (fetched.has(entry.path)) return fetched.get(entry.path);
    const rec = { path: entry.path, mode: entry.mode, size: entry.size ?? 0, sha: entry.sha, role, written: false };
    fetched.set(entry.path, rec);
    out.files.push(rec);
    let bytes;
    try {
      if (entry.mode === "120000") {
        const t = await linkTarget(entry);
        if (t.error) {
          rec.problem = t.error;
          return rec;
        }
        const resolved = joinInside(dirOf(entry.path), t.target.trim());
        rec.link = { target: t.target, resolved: resolved ?? null };
        const targetEntry = resolved !== undefined ? blobs.get(resolved) : undefined;
        if (!targetEntry || targetEntry.mode === "120000") {
          // Outside the repository, missing, or a link to a link: nothing a checkout would read.
          rec.link.broken = true;
          return rec;
        }
        if (planted(plants, "recon:links")) return rec;
        const got = await rawBytes(targetEntry);
        if (got.error) {
          rec.problem = `link target: ${got.error}`;
          return rec;
        }
        bytes = got.bytes;
        rec.link.targetSha = targetEntry.sha;
      } else {
        const got = await rawBytes(entry);
        if (got.error) {
          rec.problem = got.error;
          return rec;
        }
        bytes = got.bytes;
      }
    } catch (err) {
      if (err?.fatal) throw err;
      rec.problem = err.message;
      return rec;
    }
    totalBytes += bytes.length;
    const why = writeFile(entry.path, bytes);
    if (why) rec.problem = why;
    else rec.written = true;
    rec.bytes = bytes;
    return rec;
  };

  // 1. Instruction files and agent settings.
  const wanted = entries.filter(
    (e) => e.type === "blob" && (e.mode === "100644" || e.mode === "100755" || e.mode === "120000"),
  );
  for (const e of wanted) if (isFetched(e.path)) await fetchEntry(e, "instruction");

  // 2. Files they might import, breadth-first, a few hops deeper than Claude Code follows.
  if (!planted(plants, "recon:import-targets")) {
    let frontier = out.files.filter((f) => f.bytes && /\.md$/.test(f.path));
    let imports = 0;
    for (let depth = 1; depth <= MAX_IMPORT_DEPTH && frontier.length; depth++) {
      const next = [];
      for (const f of frontier) {
        for (const token of importCandidates(f.bytes.toString("utf8"))) {
          const rel = joinInside(dirOf(f.path), token);
          if (rel === undefined || fetched.has(rel) || skipped(rel)) continue;
          const e = blobs.get(rel);
          if (!e) continue;
          if (imports >= MAX_IMPORT_FILES) {
            out.problems.push(`import cap of ${MAX_IMPORT_FILES} files reached`);
            break;
          }
          imports++;
          const rec = await fetchEntry(e, "import");
          if (rec.bytes) next.push(rec);
        }
      }
      frontier = next;
    }
  }
  if (totalBytes > MAX_REPO_BYTES) return exclude("recon-too-large", `${totalBytes} bytes`);

  // Every instruction file must be in place; a missing import target is recorded, since map sees it as unresolved.
  const broken = out.files.filter((f) => f.role === "instruction" && f.problem);
  if (broken.length) return exclude("recon-incomplete", broken.map((f) => `${f.path}: ${f.problem}`).join("; "));
  for (const f of out.files) if (f.problem) out.problems.push(`${f.path}: ${f.problem}`);

  // Launch directories.
  const paths = entries.filter((e) => e.type === "blob").map((e) => e.path);
  let t2 = instructionDirs(out.files.filter((f) => f.role === "instruction").map((f) => f.path));
  out.launch.t2Total = t2.length;
  if (planted(plants, "launch:type2")) t2 = [];
  if (t2.length > MAX_TYPE2_DIRS) t2 = draw(t2, MAX_TYPE2_DIRS, seed, `t2|${repo}`).sort();
  let t3 = manifestDirs(paths, new Set(["." /* type 1 */, ...t2]));
  out.launch.t3Total = t3.length;
  if (planted(plants, "launch:type3")) t3 = [];
  if (t3.length > MAX_TYPE3_DIRS) t3 = draw(t3, MAX_TYPE3_DIRS, seed, `t3|${repo}`).sort();
  for (const d of [...t2, ...t3]) {
    const why = unsafePath(d);
    if (why) {
      out.problems.push(`launch dir ${d}: ${why}`);
      continue;
    }
    mkdirSync(path.join(out.dir, ...d.split("/")), { recursive: true });
    if (t2.includes(d)) out.launch.t2.push(d);
    else out.launch.t3.push(d);
  }
  return finish();
}

/** The record without file bytes, for writing to disk. */
export function reconSummary(recon) {
  return {
    ...recon,
    files: recon.files.map(({ bytes: _bytes, ...rest }) => ({ ...rest, bytes: _bytes ? _bytes.length : 0 })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, commit, outDir] = process.argv.slice(2);
  if (!repo || !commit || !outDir) {
    console.error("usage: node study/census/recon.mjs owner/repo <commit sha> <outDir>");
    process.exit(2);
  }
  // api.github.com through gh api (its own login); no token passes through ctxreach.
  const client = new GetOnlyClient({ log: (l) => console.error(l) });
  const r = await reconstruct({ client, repo, commit, dir: path.join(outDir, "repo"), seed: "00000000" });
  console.log(JSON.stringify(reconSummary(r), null, 1));
  console.error(client.summary());
  process.exitCode = client.nonGetAttempts ? 3 : r.status === "ok" ? 0 : 1;
}
