// The pre-registration's machine-checkable part (study/PREREG.md).
//
// PREREG.md holds a fenced `json prereg-registry` block: the frame queries,
// sample sizes, thresholds, hypotheses and cells the study registers. This
// module checks that block against the code that will run the study (so the
// document and the scripts cannot drift apart), and fills the values that
// exist only at tag time: the study-v1 tool freeze, the build's digest, and
// the frozen frames' sizes and hashes. Each such value is a placeholder
// written {{stamp:<key>}} until then. The seed is never in PREREG.md: it is
// the first 8 hex digits of the commit that contains it (census/seed.mjs).
// The stamped values are also held as JSON (the `json prereg-stamps` block),
// which the census scripts read from the tagged copy.
//
// Usage:
//   node study/prereg.mjs check [--stamped] [--tagged] [--tag prereg-v1]
//       the registry against the code, and the stamps block against STAMP_KEYS;
//       with --stamped, also no placeholder left. Once the tag exists, also
//       PREREG.md against the tagged copy: nothing above the Deviations heading
//       may change, and deviations are only appended (--tagged: fail when the
//       tag does not exist yet)
//   node study/prereg.mjs stamp --study-tag study-v1 --frames <dir> [--dist dist] [--write]
//       compute every stamp (refusing a pilot frame, an invalid frame, a TSV
//       whose hash moved, sources that differ from the tag, a dist/cli.js
//       whose --version is not the tag's package.json version, or a known
//       map defect) and, with --write, put them into PREREG.md
// Exit: 0 fine; 1 a problem was found; 2 usage.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HYPOTHESES, K4_EXPECTED, OWNER_CAP, REDRAW_OVER } from "./census/analyze.mjs";
import { K4_TRIALS } from "./census/codex-check.mjs";
import { CJK_EVENT, CODEX_BUDGET, O1_EVENT_SHARE, P1_CODES } from "./census/detectors.mjs";
import { distDigest } from "./census/dist-digest.mjs";
import { CHURN_ALLOWANCE, CHURN_TOLERANCE, FRAMES, K3_LISTS } from "./census/frame.mjs";
import { K5_TRIALS } from "./census/k5-score.mjs";
import { K5_STRATA } from "./census/k5-select.mjs";
import { GetOnlyClient } from "./census/lib/client.mjs";
import { MIN_LINE_CHARS, SHINGLE_THRESHOLD, SHINGLE_WORDS } from "./census/lib/normalise.mjs";
import { Z95 } from "./census/lib/stats.mjs";
import { K6_LAUNCH_TYPES, K6_PAIRS } from "./handcheck/lib.mjs";
import {
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_FILES,
  MAX_REPO_BYTES,
  MAX_TREE_ENTRIES,
  MAX_TYPE2_DIRS,
  MAX_TYPE3_DIRS,
} from "./census/recon.mjs";
import { appendOnlyProblems, readRegistry, readStampsBlock } from "./census/lib/registry.mjs";
import { CLAUDE_VERSION, CLI_CHECK_EVERY } from "./census/run-census.mjs";
import { gitEnv } from "./census/seed.mjs";

export { readRegistry };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, "..");
export const PREREG = path.join(HERE, "PREREG.md");

/** Sources whose build is the frozen tool: the working tree must match the study-v1 tag on these. */
export const FROZEN_SOURCES = ["src", "package.json", "package-lock.json", "tsup.config.ts", "tsconfig.json"];

/** Every value filled at tag time. */
export const STAMP_KEYS = [
  "study-v1.commit",
  "ctxreach.version",
  "dist.digest",
  "node.version",
  ...["S", "S-imp", "S-ci"].flatMap((f) => [`frame.${f}.date`, `frame.${f}.repos`, `frame.${f}.sha256`]),
  "K3.date",
  "K3.claude",
  "K3.claudeImport",
];

const PLACEHOLDER = /\{\{stamp:([A-Za-z0-9.-]+)\}\}/g;

/** The keys of every placeholder still in `text`, in order of appearance, once each. */
export function placeholders(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The registry as the code would write it. Anything that differs from PREREG.md's block is drift. */
export function codeRegistry({ cells = loadCells(), answers = loadAnswers() } = {}) {
  return {
    frames: {
      S: FRAMES.S.query,
      "S-imp": FRAMES["S-imp"].query,
      "S-ci": FRAMES["S-ci"].query,
      "K3.claude": K3_LISTS.claude,
      "K3.claudeImport": K3_LISTS.claudeImport,
    },
    frameChecks: { answers: 2, churnAllowance: CHURN_ALLOWANCE, churnTolerance: CHURN_TOLERANCE },
    limits: {
      maxTreeEntries: MAX_TREE_ENTRIES,
      maxType2Dirs: MAX_TYPE2_DIRS,
      maxType3Dirs: MAX_TYPE3_DIRS,
      maxImportDepth: MAX_IMPORT_DEPTH,
      maxImportFiles: MAX_IMPORT_FILES,
      maxRepoBytes: MAX_REPO_BYTES,
      maxAttempts: new GetOnlyClient({ fetchImpl: async () => undefined }).maxAttempts,
    },
    redraw: { lostShareOver: REDRAW_OVER, seedOffset: 1 },
    normalise: {
      minLineChars: MIN_LINE_CHARS,
      shingleWords: SHINGLE_WORDS,
      shingleThreshold: SHINGLE_THRESHOLD,
      o1EventShare: O1_EVENT_SHARE,
    },
    p1Codes: P1_CODES,
    cjkEvent: CJK_EVENT,
    codexBudget: CODEX_BUDGET,
    claudeVersion: CLAUDE_VERSION,
    mapCheckEvery: CLI_CHECK_EVERY,
    knownAnswerClaudeVersion: answers.claudeVersion,
    k4: { trials: K4_TRIALS, expectedAtLeast: K4_EXPECTED, launchTypes: [1, 2] },
    k5: { trials: K5_TRIALS, strata: Object.fromEntries(K5_STRATA.map((s) => [s.name, s.n])) },
    k6: { pairs: K6_PAIRS, launchTypes: K6_LAUNCH_TYPES },
    analysis: { z: Z95, ownerCap: OWNER_CAP },
    hypotheses: HYPOTHESES,
    cells: Object.fromEntries(
      cells.cells.map((c) => [
        c.id,
        {
          instrument: c.instrument,
          arms: Object.fromEntries(c.arms.filter((a) => a.trials > 0).map((a) => [a.id, a.trials])),
          confirm: c.confirm,
          refute: c.refute,
        },
      ]),
    ),
  };
}

export function loadCells() {
  return JSON.parse(readFileSync(path.join(HERE, "behavioural", "cells.json"), "utf8"));
}

export function loadAnswers() {
  return JSON.parse(readFileSync(path.join(HERE, "census", "known-answers.json"), "utf8"));
}

/**
 * Drift between PREREG.md's registry and the code: one line per differing
 * key. Keys the registry holds that the code does not derive (samples,
 * seed, versions pinned elsewhere) are checked for shape only.
 */
export function checkAgainstCode(registry, code = codeRegistry()) {
  const problems = [];
  const walk = (reg, got, where) => {
    for (const [k, v] of Object.entries(got)) {
      const at = where ? `${where}.${k}` : k;
      if (!(k in (reg ?? {}))) problems.push(`${at}: in the code (${JSON.stringify(v)}) but not registered`);
      else if (v && typeof v === "object" && !Array.isArray(v)) walk(reg[k], v, at);
      else if (!same(reg[k], v))
        problems.push(`${at}: registered ${JSON.stringify(reg[k])}, the code has ${JSON.stringify(v)}`);
    }
    for (const k of Object.keys(reg ?? {}))
      if (!(k in got) && where) problems.push(`${where}.${k}: registered but not in the code`);
  };
  const { samples, seed, codexVersion, ...rest } = registry;
  walk(rest, code, "");
  if (!samples?.["S-main"] || !samples?.["S-imp"]) problems.push("samples: S-main and S-imp must be registered");
  for (const [name, s] of Object.entries(samples ?? {})) {
    if (!(s.frame in FRAMES)) problems.push(`samples.${name}: unknown frame ${s.frame}`);
    if (!Number.isInteger(s.n) || s.n < 1) problems.push(`samples.${name}: n must be a positive integer`);
  }
  if (seed?.tag !== "prereg-v1" || seed?.digits !== 8)
    problems.push("seed: must be the first 8 hex digits of prereg-v1");
  if (typeof codexVersion !== "string") problems.push("codexVersion: missing");
  return problems;
}

/**
 * The stamps block against STAMP_KEYS: every key once, each holding its own
 * placeholder or, once stamped, a value. Returns a list of problems.
 */
export function stampsBlockProblems(text) {
  let block;
  try {
    block = readStampsBlock(text);
  } catch (err) {
    return [err.message];
  }
  const problems = [];
  const keys = Object.keys(block);
  for (const k of STAMP_KEYS) if (!keys.includes(k)) problems.push(`stamps block: no ${k}`);
  for (const k of keys) {
    if (!STAMP_KEYS.includes(k)) problems.push(`stamps block: ${k} is not a tag-time value`);
    const v = block[k];
    const own = `{{stamp:${k}}}`;
    if (typeof v !== "string" || v === "" || (v.includes("{{stamp:") && v !== own))
      problems.push(`stamps block: ${k} holds ${JSON.stringify(v)}, not ${own} or its value`);
  }
  return problems;
}

/** study/PREREG.md as the tag holds it, or undefined when the tag (or the file in it) does not exist. */
export function taggedPrereg(tag = "prereg-v1", cwd = ROOT) {
  try {
    return execFileSync("git", ["show", `${tag}:study/PREREG.md`], {
      cwd,
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return undefined;
  }
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** The one study-labelled manifest for `frame` in `dir`, or a problem. */
function frameManifest(dir, frame) {
  const re = new RegExp(`^${frame.replace(/[-]/g, "\\-")}-\\d{4}-\\d{2}-\\d{2}\\.manifest\\.json$`);
  const found = existsSync(dir) ? readdirSync(dir).filter((n) => re.test(n)) : [];
  if (found.length !== 1) return { problem: `frame ${frame}: expected one manifest in ${dir}, found ${found.length}` };
  const file = path.join(dir, found[0]);
  return { file, manifest: JSON.parse(readFileSync(file, "utf8")) };
}

/**
 * Compute every stamp. Returns { values, problems }; values are filled even
 * when there are problems, so the caller can print them, but a caller must
 * not write them unless problems is empty.
 */
export function stampValues({
  studyTag = "study-v1",
  framesDir,
  distDir,
  cwd = ROOT,
  registry,
  answers = loadAnswers(),
}) {
  const values = {};
  const problems = [];
  // The tool freeze.
  let commit;
  try {
    commit = git(cwd, "rev-parse", "--verify", `${studyTag}^{commit}`);
    values["study-v1.commit"] = commit;
    values["ctxreach.version"] = JSON.parse(git(cwd, "show", `${commit}:package.json`)).version;
  } catch {
    problems.push(`tag ${studyTag} does not exist here: the tool is not frozen yet`);
  }
  if (commit) {
    try {
      git(cwd, "diff", "--quiet", commit, "--", ...FROZEN_SOURCES);
    } catch {
      problems.push(
        `the working tree's ${FROZEN_SOURCES.join(", ")} differ from ${studyTag}: dist/ would not be the frozen build`,
      );
    }
  }
  const dist = distDir ?? path.join(cwd, "dist");
  try {
    values["dist.digest"] = distDigest(dist).digest;
  } catch (err) {
    problems.push(`dist: ${err.message}`);
  }
  // The build answers with the version it was built from: a dist/ built at another version than the tag's
  // package.json is not the frozen build. (It cannot tell two builds of one version apart: `npm run build`
  // right before the stamp, as study/census/README.md orders it, is what makes dist/ the tag's.)
  if (values["ctxreach.version"] !== undefined) {
    let printed;
    try {
      printed = execFileSync(process.execPath, [path.join(dist, "cli.js"), "--version"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: 60_000,
      }).trim();
    } catch (err) {
      problems.push(`dist/cli.js --version failed (${String(err.message).split("\n")[0]})`);
    }
    if (printed !== undefined && printed !== values["ctxreach.version"])
      problems.push(
        `dist/cli.js --version prints ${printed || "nothing"}, not ${values["ctxreach.version"]} (${studyTag}'s package.json): dist/ was not built from the frozen sources`,
      );
  }
  values["node.version"] = process.version;

  // The frames, frozen before this file is committed.
  for (const frame of ["S", "S-imp", "S-ci"]) {
    const got = frameManifest(framesDir, frame);
    if (got.problem) {
      problems.push(got.problem);
      continue;
    }
    const m = got.manifest;
    if (m.label !== "study") problems.push(`frame ${frame}: labelled ${m.label}, not study`);
    if (m.valid !== true || (m.problems ?? []).length)
      problems.push(`frame ${frame}: not valid (${(m.problems ?? []).join("; ")})`);
    if (!/non-GET attempts: 0$/.test(m.client ?? ""))
      problems.push(`frame ${frame}: the client did not report 0 non-GET attempts`);
    if (registry && m.query !== registry.frames?.[frame]) problems.push(`frame ${frame}: frozen with another query`);
    const tsv = path.join(path.dirname(got.file), m.file ?? "");
    if (!m.file || !existsSync(tsv)) problems.push(`frame ${frame}: ${m.file} is missing`);
    else if (sha256(readFileSync(tsv)) !== m.sha256)
      problems.push(`frame ${frame}: ${m.file} no longer has the SHA-256 it was frozen with`);
    values[`frame.${frame}.date`] = (m.fetchedAt ?? "").slice(0, 10);
    values[`frame.${frame}.repos`] = String(m.repos);
    values[`frame.${frame}.sha256`] = m.sha256;
  }
  const k3 = frameManifest(framesDir, "K3");
  if (k3.problem) problems.push(k3.problem);
  else {
    const m = k3.manifest;
    if (m.label !== "study") problems.push(`K3: labelled ${m.label}, not study`);
    if (m.valid !== true || (m.problems ?? []).length) problems.push("K3: not valid");
    if (!/non-GET attempts: 0$/.test(m.client ?? "")) problems.push("K3: the client did not report 0 non-GET attempts");
    values["K3.date"] = (m.fetchedAt ?? "").slice(0, 10);
    values["K3.claude"] = String(m.counts?.claude);
    values["K3.claudeImport"] = String(m.counts?.claudeImport);
  }

  // K1 must be able to pass: no map defect may be carried into the study.
  const defects = Object.keys(answers.knownDefects ?? {});
  if (defects.length) problems.push(`known map defects would fail K1: ${defects.join(", ")}`);
  return { values, problems };
}

/** Put the values into the text; returns { text, missing } (placeholders with no value). */
export function applyStamps(text, values) {
  const missing = [];
  const out = text.replace(PLACEHOLDER, (m, key) => {
    if (values[key] === undefined || values[key] === "") {
      missing.push(key);
      return m;
    }
    return values[key];
  });
  return { text: out, missing: [...new Set(missing)] };
}

function main(args) {
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const text = readFileSync(PREREG, "utf8");
  const registry = readRegistry(text);
  const drift = [...checkAgainstCode(registry), ...stampsBlockProblems(text)];
  for (const d of drift) console.log(`drift: ${d}`);
  if (args[0] === "check") {
    const left = placeholders(text);
    console.log(`registry vs code: ${drift.length ? `${drift.length} difference(s)` : "identical"}`);
    console.log(`placeholders left: ${left.length}${left.length ? ` (${left.join(", ")})` : ""}`);
    // Append-only after the tag: compared whenever the tag exists, and required with --tagged.
    const tag = opt("--tag") ?? "prereg-v1";
    const tagged = taggedPrereg(tag);
    let appendOnly = [];
    if (tagged === undefined) {
      console.log(`against ${tag}: the tag does not exist here (or holds no study/PREREG.md); nothing to compare`);
      if (args.includes("--tagged")) appendOnly = [`${tag} does not exist`];
    } else {
      appendOnly = appendOnlyProblems(tagged, text, tag);
      for (const p of appendOnly) console.log(`changed after the tag: ${p}`);
      console.log(
        `against ${tag}: ${appendOnly.length ? "CHANGED above the appended deviations" : "unchanged; deviations only appended"}`,
      );
    }
    return drift.length || appendOnly.length || (args.includes("--stamped") && left.length) ? 1 : 0;
  }
  if (args[0] === "stamp") {
    if (!opt("--frames")) {
      console.error("usage: node study/prereg.mjs stamp --study-tag study-v1 --frames <dir> [--dist dist] [--write]");
      return 2;
    }
    const { values, problems } = stampValues({
      studyTag: opt("--study-tag") ?? "study-v1",
      framesDir: path.resolve(opt("--frames")),
      distDir: opt("--dist") ? path.resolve(opt("--dist")) : undefined,
      registry,
    });
    for (const [k, v] of Object.entries(values)) console.log(`${k.padEnd(22)} ${v}`);
    const { text: out, missing } = applyStamps(text, values);
    for (const p of [...drift, ...problems]) console.log(`problem: ${p}`);
    if (missing.length) console.log(`problem: no value for ${missing.join(", ")}`);
    if (drift.length || problems.length || missing.length) return 1;
    if (args.includes("--write")) {
      writeFileSync(PREREG, out);
      console.log(`wrote ${path.relative(ROOT, PREREG)}; SHA-256 ${sha256(Buffer.from(out, "utf8"))}`);
    } else console.log("all stamps computed; run again with --write to fill PREREG.md");
    return 0;
  }
  console.error(
    "usage: node study/prereg.mjs check [--stamped] [--tagged] [--tag prereg-v1] | stamp --study-tag study-v1 --frames <dir> [--write]",
  );
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
