// Measure one reconstructed repository: run `ctxreach map --json` from every
// launch directory (type 1 root, type 2 instruction-file directories, type 3
// package-manifest directories) as a fresh machine would, keep a compact
// summary of each run, and compute every outcome (detectors.mjs).
//
// Output-side checks: every map run must report the reconstruction as its
// repository root and the requested launch directory, and no file outside
// the repository may appear in either agent's view (an instruction file in an
// ancestor of the work directory, or a machine file reached by an absolute
// import). A breach is recorded as a fault on the row, never silently used.

import { readFileSync } from "node:fs";
import path from "node:path";
import { computeOutcomes, isOutside } from "./detectors.mjs";

function samePath(a, b) {
  const n = (p) => path.resolve(p).split(path.sep).join("/");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

/** The parts of one `map --json` result the census keeps. */
export function summarise(json, recon, dir) {
  const faults = [];
  if (json.schema !== "ctxreach.map/v1") faults.push(`unexpected schema ${json.schema}`);
  if (!samePath(json.repoRoot, recon.dir)) faults.push(`map used repository root ${json.repoRoot}`);
  if (json.launchDir !== dir) faults.push(`map launched in ${json.launchDir}, not ${dir}`);
  const codex = json.codex ?? { chain: [], notPreloaded: [] };
  const claude = json.claude ?? { files: [], shadowers: [], agentsMd: { read: false } };
  const outside = [
    ...codex.chain.map((c) => c.path),
    ...claude.files.map((f) => f.path),
    ...claude.shadowers,
    ...(codex.global ? [codex.global.path] : []),
  ].filter(isOutside);
  for (const p of new Set(outside)) faults.push(`outside the repository: ${p}`);
  const codes = (agent) => [...new Set(json.findings.filter((f) => f.agent === agent).map((f) => f.code))].sort();
  return {
    mapVersion: json.version,
    codex: {
      chain: codex.chain.map((c) => ({ path: c.path, bytes: c.bytes, kept: c.keptBytes, status: c.status })),
      notPreloaded: codex.notPreloaded,
      codes: codes("codex"),
    },
    claude: {
      agentsRead: claude.agentsMd.read,
      shadowers: claude.shadowers,
      files: claude.files.map((f) => ({
        path: f.path,
        kind: f.kind,
        delivery: f.delivery,
        rule: f.rule,
        ...(f.needsApproval ? { needsApproval: true } : {}),
        ...(f.notModelled ? { notModelled: true } : {}),
      })),
      codes: codes("claude"),
    },
    warn: [...new Set(json.findings.filter((f) => f.severity === "warn").map((f) => f.code))].sort(),
    findings: json.findings.map((f) => ({ code: f.code, severity: f.severity, path: f.path ?? null })),
    faults,
  };
}

/**
 * @param {object} args
 * @param {object} args.recon from recon.mjs (status "ok")
 * @param {(opts: object) => Promise<{json?: object, error?: string}>} args.mapRunner
 * @param {{codexHome: string, claudeHome: string}} args.homes empty directories
 * @param {string} args.claudeVersion Claude Code version map models
 * @param {object} [args.plants]
 */
export async function measure({ recon, mapRunner, homes, claudeVersion, plants }) {
  const pairs = [];
  const faults = [];
  const launch = [
    ...recon.launch.t1.map((d) => [1, d]),
    ...recon.launch.t2.map((d) => [2, d]),
    ...recon.launch.t3.map((d) => [3, d]),
  ];
  let mapVersion;
  for (const [type, dir] of launch) {
    const res = await mapRunner({
      launchDir: dir === "." ? recon.dir : path.join(recon.dir, ...dir.split("/")),
      repoRoot: recon.dir,
      codexHome: homes.codexHome,
      claudeHome: homes.claudeHome,
      claudeVersion,
    });
    if (res.error) {
      pairs.push({ dir, type, error: res.error });
      faults.push(`${dir}: ${res.error}`);
      continue;
    }
    const s = summarise(res.json, recon, dir);
    mapVersion = s.mapVersion;
    for (const f of s.faults) faults.push(`${dir}: ${f}`);
    pairs.push({ dir, type, codex: s.codex, claude: s.claude, warn: s.warn, findings: s.findings });
  }

  const bytesOf = new Map(recon.files.filter((f) => f.bytes).map((f) => [f.path, f.bytes]));
  const readBytes = (rel) => {
    if (isOutside(rel)) return Buffer.alloc(0);
    const b = bytesOf.get(rel);
    if (b) return Buffer.isBuffer(b) ? b : Buffer.from(b);
    try {
      return readFileSync(path.join(recon.dir, ...rel.split("/")));
    } catch {
      faults.push(`could not read ${rel}`);
      return Buffer.alloc(0);
    }
  };
  const ctx = { recon, pairs, plants, readBytes, read: (rel) => readBytes(rel).toString("utf8") };
  const outcomes = computeOutcomes(ctx);

  const agents = recon.files.find((f) => f.path === "AGENTS.md" && f.role === "instruction");
  const claude = recon.files.find((f) => f.path === "CLAUDE.md" && f.role === "instruction");
  return {
    repo: recon.repo,
    commit: recon.commit,
    owner: recon.repo.split("/")[0],
    status: "measured",
    mapVersion,
    claudeVersion,
    meta: recon.meta,
    tree: recon.tree,
    blobs: {
      rootAgents: agents ? (agents.link?.targetSha ?? agents.sha) : null,
      rootClaude: claude ? claude.sha : null,
    },
    files: recon.files.map((f) => ({
      path: f.path,
      mode: f.mode,
      size: f.size,
      sha: f.sha,
      role: f.role,
      ...(f.link ? { link: { resolved: f.link.resolved, broken: f.link.broken === true } } : {}),
    })),
    launch: {
      t2: recon.launch.t2,
      t2Total: recon.launch.t2Total,
      t3: recon.launch.t3,
      t3Total: recon.launch.t3Total,
    },
    pairs: pairs.map((p) =>
      p.error
        ? p
        : {
            dir: p.dir,
            type: p.type,
            warn: p.warn,
            findings: p.findings,
            codex: p.codex,
            claude: {
              agentsRead: p.claude.agentsRead,
              codes: p.claude.codes,
              files: p.claude.files,
              shadowers: p.claude.shadowers,
            },
          },
    ),
    outcomes,
    problems: recon.problems,
    faults,
    requests: recon.requests,
  };
}
