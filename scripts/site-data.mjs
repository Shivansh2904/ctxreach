// Assembles site/data/provenance.json: what the results page shows that is
// in neither results.json (study/census/analyze.mjs) nor cells-results.json
// (study/behavioural/run-cells.mjs). Every value is copied from a machine
// output named on the command line (each listed under "sources" with its
// SHA-256) or read from git; none is typed. The few counts it makes (trials
// and void reasons from trials.jsonl) are plain tallies of the rows it reads.
//
// Usage:
//   node scripts/site-data.mjs --label study|pilot|sample --out site/data/provenance.json
//     [--repo <owner/name>]            default Shivansh2904/ctxreach
//     [--git <dir>]                    repository to read tags from (default: this one)
//     [--prereg-tag prereg-v1]         commit, seed (its first 8 hex digits), SHA-256 of study/PREREG.md at the tag
//     [--issue <file>]                 the timestamp issue, saved from `gh api repos/<owner/name>/issues/<n>`
//     [--freeze-tag study-v1]          the tool freeze's commit
//     [--run <file>]...                run-census.mjs manifests (<rows>.run-<time>.json)
//     [--k1 <file>]                    `known-answer.mjs --json` output
//     [--k2 <file>]                    `plant-census-faults.mjs` output (its "K2: c/n planted faults caught" line)
//     [--k5 <file>]                    JSON with whole numbers k (agreeing) and n (decided)
//     [--k6 <file>]                    `handcheck.mjs score`'s k6-results.json
//     [--trials <file>]                run-cells.mjs's trials.jsonl
//     [--recordings <dir>]             one recording per subfolder, named <cell>-<arm> (for example B2-A1)
//     [--cast <file>]                  docs/demo.cast.json from scripts/make-cast.mjs
// Exit status: 0 when written, 2 for a usage problem or an input that does not have the expected shape.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), "..");
export const SCHEMA = "ctxreach.site-provenance/v1";
export const LABELS = ["study", "pilot", "sample"];

export class InputError extends Error {}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const whole = (x) => Number.isInteger(x) && x >= 0;

/** Arguments: repeatable --run, single values for the rest. */
export function parseArgs(argv) {
  const opts = { runs: [] };
  const single = {
    "--label": "label",
    "--out": "out",
    "--repo": "repo",
    "--git": "git",
    "--prereg-tag": "preregTag",
    "--issue": "issue",
    "--freeze-tag": "freezeTag",
    "--k1": "k1",
    "--k2": "k2",
    "--k5": "k5",
    "--k6": "k6",
    "--trials": "trials",
    "--recordings": "recordings",
    "--cast": "cast",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--run") {
      opts.runs.push(v);
      i++;
    } else if (single[a]) {
      if (v === undefined) throw new InputError(`${a} needs a value`);
      opts[single[a]] = v;
      i++;
    } else throw new InputError(`unknown argument ${a}`);
  }
  if (!LABELS.includes(opts.label)) throw new InputError(`--label must be one of ${LABELS.join(", ")}`);
  if (!opts.out) throw new InputError("--out is required");
  return opts;
}

function gitEnv() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
  const empty = process.platform === "win32" ? "NUL" : os.devNull;
  return { ...env, GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_SYSTEM: empty, GIT_CONFIG_NOSYSTEM: "1" };
}

function git(dir, args, encoding = "utf8") {
  try {
    return execFileSync("git", ["-C", dir, ...args], { env: gitEnv(), encoding, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new InputError(`git ${args.join(" ")} failed in ${dir}: ${String(e.stderr ?? e.message).trim()}`);
  }
}

/** The pre-registration tag: its commit, the seed rule's 8 hex digits, and PREREG.md's SHA-256 at the tag. */
export function readPrereg(dir, tag) {
  const commit = git(dir, ["rev-parse", "--verify", `${tag}^{commit}`]).trim();
  const prereg = git(dir, ["show", `${tag}:study/PREREG.md`], "buffer");
  return { tag, commit, seed: commit.slice(0, 8), preregSha256: sha256(prereg) };
}

/** The timestamp issue, from a saved `gh api` answer. */
export function readIssue(json) {
  if (typeof json?.html_url !== "string" || typeof json?.created_at !== "string")
    throw new InputError("the issue file has no html_url and created_at (save it with gh api repos/<repo>/issues/<n>)");
  return { issueUrl: json.html_url, issueCreatedAt: json.created_at, issueTitle: json.title ?? null };
}

/** One census run manifest (ctxreach.study-run/v1), the fields the page shows. */
export function readRun(json) {
  if (json?.schema !== "ctxreach.study-run/v1")
    throw new InputError("a --run file is not a ctxreach.study-run/v1 manifest");
  const c = json.client ?? {};
  return {
    frame: json.frame,
    label: json.label,
    seed: json.seed,
    seedFrom: json.seedFrom,
    sample: json.sample,
    sampleSha256: json.sampleSha256,
    startedAt: json.startedAt,
    endedAt: json.endedAt,
    units: json.units,
    exclusions: json.exclusions,
    unitsWithFaults: json.unitsWithFaults,
    dist: json.dist,
    claudeVersion: json.claudeVersion,
    codex: json.codex ?? null,
    node: json.node,
    platform: json.platform,
    requests: c.requests,
    retries: c.retries,
    nonGetAttempts: c.nonGetAttempts,
  };
}

/** K1 from `known-answer.mjs --json`: k/n and the names of fixtures listed as known defects. */
export function readK1(json) {
  if (!whole(json?.k) || !whole(json?.n) || !Array.isArray(json?.results))
    throw new InputError("the --k1 file is not known-answer.mjs --json output");
  return {
    k: json.k,
    n: json.n,
    knownDefects: json.results.filter((r) => r.knownDefect).map((r) => r.name),
    orphans: Array.isArray(json.orphans) ? json.orphans.length : 0,
  };
}

/** K2 from plant-census-faults.mjs's printed summary line. */
export function readK2(text) {
  const m = /^K2: (\d+)\/(\d+) planted faults caught by K1$/m.exec(text);
  if (!m) throw new InputError('the --k2 file has no "K2: c/n planted faults caught by K1" line');
  return { k: Number(m[1]), n: Number(m[2]) };
}

export function readK5(json) {
  if (!whole(json?.k) || !whole(json?.n) || json.k > json.n)
    throw new InputError("the --k5 file needs whole numbers k <= n");
  return { k: json.k, n: json.n };
}

/** K6 from handcheck.mjs's k6-results.json: agreement over all pairs and per agent. */
export function readK6(json) {
  if (!whole(json?.n) || !whole(json?.agree) || !whole(json?.claudeAgree) || !whole(json?.codexAgree))
    throw new InputError("the --k6 file is not handcheck.mjs's k6-results.json");
  return {
    pairs: { k: json.agree, n: json.n },
    claude: { k: json.claudeAgree, n: json.n },
    codex: { k: json.codexAgree, n: json.n },
    disagreements: Array.isArray(json.disagreements) ? json.disagreements.length : 0,
  };
}

/** A void reason with its variable part (a model name) removed, so equal reasons count together. */
export function reasonKey(reason) {
  return /^model .*, not the pinned /.test(reason) ? "model is not the pinned one" : reason;
}

/** The lab cells' trials (run-cells.mjs trials.jsonl): versions, OS, dates and the void reasons, warm-ups left out. */
export function readTrials(text) {
  const rows = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new InputError(`trials line ${i + 1} is not JSON`);
      }
    })
    .filter((t) => !t.warmup);
  if (!rows.length) throw new InputError("the --trials file has no trial");
  const uniq = (xs) => [...new Set(xs.filter((x) => typeof x === "string" && x))].sort();
  const voidReasons = {};
  for (const t of rows)
    if (t.status !== "usable")
      for (const r of t.reasons ?? []) voidReasons[reasonKey(r)] = (voidReasons[reasonKey(r)] ?? 0) + 1;
  const dates = rows
    .map((t) => t.date)
    .filter(Boolean)
    .sort();
  return {
    trials: rows.length,
    usable: rows.filter((t) => t.status === "usable").length,
    void: rows.filter((t) => t.status !== "usable").length,
    voidReasons,
    agentVersions: uniq(rows.map((t) => t.init?.version)),
    models: uniq(rows.map((t) => t.init?.model)),
    os: uniq(rows.map((t) => t.os)),
    firstTrial: dates[0] ?? null,
    lastTrial: dates.at(-1) ?? null,
    dryRun: rows.some((t) => t.dryRun === true),
  };
}

/** Recordings published with the site: one per subfolder, with its path relative to the site folder. */
export function readRecordings(dir, siteDir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, path: path.relative(siteDir, path.join(dir, name)).split(path.sep).join("/") + "/" }));
}

export function readCast(json) {
  if (json?.schema !== "ctxreach.demo-cast/v1") throw new InputError("the --cast file is not a demo-cast sidecar");
  return {
    label: json.label,
    command: json.command,
    version: json.ctxreach?.version,
    commit: json.ctxreach?.commit,
    date: json.date,
    platform: json.platform,
  };
}

/** Build the provenance document. `read(file)` returns a file's bytes (tests pass their own). */
export function assemble(opts, read = (f) => readFileSync(f)) {
  const sources = [];
  const load = (arg, file) => {
    const bytes = read(file);
    sources.push({ arg, file: path.basename(file), sha256: sha256(bytes) });
    return bytes.toString("utf8");
  };
  const json = (arg, file) => {
    const text = load(arg, file);
    try {
      return JSON.parse(text);
    } catch {
      throw new InputError(`${arg} ${file} is not JSON`);
    }
  };
  const gitDir = opts.git ?? ROOT;
  const doc = {
    schema: SCHEMA,
    label: opts.label,
    assembledAt: new Date().toISOString(),
    repo: opts.repo ?? "Shivansh2904/ctxreach",
    sources,
    prereg: null,
    freeze: null,
    runs: [],
    checks: {},
    cells: null,
    recordings: [],
    demo: null,
  };
  if (opts.preregTag) doc.prereg = readPrereg(gitDir, opts.preregTag);
  if (opts.issue) {
    const issue = readIssue(json("--issue", opts.issue));
    doc.prereg = { ...(doc.prereg ?? {}), ...issue };
  }
  doc.runs = opts.runs.map((f) => readRun(json("--run", f)));
  if (opts.freezeTag) {
    const commit = git(gitDir, ["rev-parse", "--verify", `${opts.freezeTag}^{commit}`]).trim();
    const digests = [...new Set(doc.runs.map((r) => r.dist).filter(Boolean))];
    if (digests.length > 1)
      throw new InputError(`the runs used ${digests.length} different builds: ${digests.join(", ")}`);
    doc.freeze = { tag: opts.freezeTag, commit, distDigest: digests[0] ?? null };
  }
  if (opts.k1) doc.checks.K1 = readK1(json("--k1", opts.k1));
  if (opts.k2) doc.checks.K2 = readK2(load("--k2", opts.k2));
  if (opts.k5) doc.checks.K5 = readK5(json("--k5", opts.k5));
  if (opts.k6) doc.checks.K6 = readK6(json("--k6", opts.k6));
  if (opts.trials) doc.cells = readTrials(load("--trials", opts.trials));
  if (opts.recordings)
    doc.recordings = readRecordings(opts.recordings, path.dirname(path.dirname(path.resolve(opts.out))));
  if (opts.cast) doc.demo = readCast(json("--cast", opts.cast));
  if (opts.label === "study") {
    const unlabelled = doc.runs.filter((r) => r.label !== "study");
    if (unlabelled.length)
      throw new InputError(`--label study, but ${unlabelled.length} run manifest(s) are labelled otherwise`);
    if (doc.cells?.dryRun)
      throw new InputError("--label study, but the trials are a dry run against the fake instrument");
  }
  return doc;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    for (const f of [opts.issue, opts.k1, opts.k2, opts.k5, opts.k6, opts.trials, opts.cast, ...opts.runs])
      if (f && !existsSync(f)) throw new InputError(`${f} does not exist`);
    if (opts.recordings && !(existsSync(opts.recordings) && statSync(opts.recordings).isDirectory()))
      throw new InputError(`${opts.recordings} is not a directory`);
    const doc = assemble(opts);
    mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(doc, null, 2) + "\n");
    console.log(
      `wrote ${opts.out}: label ${doc.label}, ${doc.sources.length} sources, ${doc.runs.length} runs, checks ${Object.keys(doc.checks).join(" ") || "none"}`,
    );
    return 0;
  } catch (e) {
    if (e instanceof InputError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = main(process.argv.slice(2));
}
