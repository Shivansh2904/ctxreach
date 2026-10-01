// Check K6, the blind second reader (study/PREREG.md, section 8;
// study/handcheck/PROTOCOL.md). A fresh reader works out by hand, from
// docs/rules.md alone, which files reach each agent for 30 (repository,
// launch directory) pairs of the census. This module draws the pairs, writes
// the reader's sheets (the files, never map's answers), derives map's answers
// from the census rows as the key, checks that no sheet leaks the key, and
// scores the reader's answers against it.

import { createHash } from "node:crypto";
import { received } from "../census/detectors.mjs";
import { checkSeed, draw } from "../census/lib/prng.mjs";
import { formatFraction, wilson } from "../census/lib/stats.mjs";

export const K6_PAIRS = 30;
/** Launch-directory types K6 draws from (the census's primary and secondary types). */
export const K6_LAUNCH_TYPES = [1, 2];
export const ANSWER_SCHEMA = "ctxreach.k6-answer/v1";
export const KEY_SCHEMA = "ctxreach.k6-key/v1";

const byRepo = (a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0);
const byDir = (a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0);
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Launch directories K6 may use: types 1 and 2, measured without an error. */
function candidateDirs(row) {
  return (row.pairs ?? []).filter((p) => K6_LAUNCH_TYPES.includes(p.type) && !p.error).sort(byDir);
}

/**
 * Draw K6's pairs in two stages, so one repository with 171 launch
 * directories cannot fill the sheet: `n` repositories uniformly from the
 * measured rows without faults (canonical order, stream "K6|repos"), then one
 * type-1 or type-2 launch directory uniformly within each (stream
 * "K6|dir|<repo>"). Ids are K6-01, K6-02, ... in the order drawn.
 */
export function drawPairs(rows, seed, n = K6_PAIRS) {
  checkSeed(seed);
  const seen = new Set();
  const usable = rows
    .filter((r) => r.status === "measured" && !(r.faults ?? []).length && candidateDirs(r).length > 0)
    .filter((r) => (seen.has(r.repo) ? false : (seen.add(r.repo), true)))
    .sort(byRepo);
  return draw(usable, n, seed, "K6|repos").map((row, i) => {
    const [pair] = draw(candidateDirs(row), 1, seed, `K6|dir|${row.repo}`);
    return {
      id: `K6-${String(i + 1).padStart(2, "0")}`,
      repo: row.repo,
      commit: row.commit,
      frame: row.frame,
      dir: pair.dir,
      type: pair.type,
    };
  });
}

/** Resolved targets of a row's working symlinks: link path -> target path. */
function rowLinks(row) {
  const out = new Map();
  for (const f of row.files ?? []) if (f.link && !f.link.broken && f.link.resolved) out.set(f.path, f.link.resolved);
  return out;
}

/**
 * map's answer for one pair, from its census row, in the shape the reader
 * fills in. Claude: the repository files whose text is in the model's context
 * when a headless session starts there, a symlink written as the file it
 * points to (the reconstruction measured links as copies; rule
 * claude.symlink), plus the files map says it does not model. Codex: the files
 * in the AGENTS.md block, root first, with the bytes kept of each.
 *
 * `linkCorrection: false` is the planted fault of the K6 tests.
 */
export function keyFor(row, dir, { linkCorrection = true } = {}) {
  const pair = (row.pairs ?? []).find((p) => p.dir === dir && !p.error);
  if (!pair) throw new Error(`${row.repo}: no measured pair at ${dir}`);
  const links = rowLinks(row);
  const target = (p) => (linkCorrection ? (links.get(p) ?? p) : p);
  const uniqueSorted = (xs) => [...new Set(xs)].sort();
  return {
    claude: {
      receives: uniqueSorted(pair.claude.files.filter(received).map((f) => target(f.path))),
      notModelled: uniqueSorted(pair.claude.files.filter((f) => f.notModelled).map((f) => f.path)),
    },
    codex: {
      chain: pair.codex.chain.filter((c) => c.kept > 0).map((c) => ({ path: c.path, keptBytes: c.kept })),
    },
  };
}

/** The blank answer the reader fills in (null means "not answered"). */
export function blankAnswer(id) {
  return {
    schema: ANSWER_SCHEMA,
    id,
    claude: { receives: null, notModelled: null },
    codex: { chain: null },
    notes: "",
  };
}

/** A fence of tildes longer than any run of tildes in the text, at least four. */
function fenceFor(text) {
  const longest = Math.max(3, ...[...text.matchAll(/~+/g)].map((m) => m[0].length));
  return "~".repeat(longest + 1);
}

function describeFile(f) {
  if (f.link) {
    if (f.link.broken)
      return `symlink to \`${f.link.target.trim()}\`, which is outside the repository, missing, or another link: a checkout holds a dangling link`;
    return `symlink to \`${f.link.target.trim()}\` (that is, \`${f.link.resolved}\`); a checkout that keeps links reads the target's text through it`;
  }
  if (!f.bytes) return "listed in the tree, but its text could not be fetched: treat it as absent";
  return `${f.bytes.length.toLocaleString("en-GB")} bytes`;
}

/**
 * The reader's sheet for one pair: the launch directory, the fixed
 * conditions, and every file the reconstruction holds with its text. Nothing
 * here comes from map.
 * @param {{id: string, dir: string}} pair
 * @param {{files: {path: string, bytes?: Buffer, link?: {target: string, resolved?: string, broken?: boolean}}[]}} recon
 */
export function renderSheet(pair, recon) {
  const out = [
    `# ${pair.id}`,
    "",
    `Launch directory: \`${pair.dir}\` (\`.\` is the repository root).`,
    "",
    "Conditions (the same for every sheet): a fresh machine with empty",
    "`~/.claude` and `~/.codex` and default settings; the repository root is",
    "the top folder (it holds `.git`); nothing above the root holds an",
    "instruction file. Claude Code 2.1.285 runs headless (`claude -p`) in the",
    "launch directory, and no approval has ever been given in this project.",
    "Codex 0.159.2 starts in the launch directory with its default",
    "configuration and no trust entry for this project.",
    "",
    "The files below are every file of the repository that these rules can",
    "read at this commit (instruction files, `.claude/` settings and rules,",
    "`.codex/config.toml`, and the files they import); other files are left",
    "out. Sizes are in bytes of the file as stored.",
    "",
  ];
  for (const f of [...recon.files].sort(byPath)) {
    out.push(`## \`${f.path}\``, "", describeFile(f), "");
    if (!f.link && f.bytes) {
      const text = f.bytes.toString("utf8");
      const fence = fenceFor(text);
      out.push(fence + "text", text.endsWith("\n") ? text.slice(0, -1) : text, fence, "");
    }
  }
  out.push("## Your answer", "", `Fill in \`answers/${pair.id}.json\` as READER-BRIEF.md says.`, "");
  return out.join("\n");
}

/** Words and values that would tell the reader map's answer. */
const LEAKS = [
  /\b(?:claude|codex)\.[a-z][a-z-]+\b/, // rule ids and finding codes
  /\bkeptBytes\b/,
  /\bnotModelled\b/,
  /"receives"\s*:\s*\[/,
  /"delivery"\s*:/,
  /ctxreach\.map\/v1/,
];

/** The sheet without the repository's own text (the fenced blocks), which may mention anything. */
function sheetFrame(sheet) {
  return sheet.replace(/^(~{4,})text\n[\s\S]*?\n\1$/gm, "");
}

/**
 * Problems that would un-blind the reader, or [] for a clean sheet. The
 * vocabulary is looked for outside the repository's own text; the pair's key
 * anywhere.
 */
export function checkBlind(sheet, key) {
  const problems = [];
  const frame = sheetFrame(sheet);
  for (const re of LEAKS) if (re.test(frame)) problems.push(`sheet matches ${re}`);
  if (key) {
    if (sheet.includes(JSON.stringify(key))) problems.push("sheet holds the pair's key");
    if (key.codex.chain.length && sheet.includes(JSON.stringify(key.codex.chain)))
      problems.push("sheet holds the Codex answer");
  }
  return problems;
}

/** A sorted list of paths; null when unanswered, undefined when malformed. */
function pathList(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v) || v.some((p) => typeof p !== "string")) return undefined;
  return [...new Set(v.map((p) => p.trim()).filter(Boolean))].sort();
}

/** The chain in the reader's order; null when unanswered, undefined when malformed. */
function chainList(v) {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) return undefined;
  const out = v.map((c) => ({ path: typeof c?.path === "string" ? c.path.trim() : "", keptBytes: c?.keptBytes }));
  if (out.some((c) => !c.path || !Number.isInteger(c.keptBytes) || c.keptBytes < 0)) return undefined;
  return out;
}

/**
 * Score one answer against its key. The Claude sets compare as sets; the
 * Codex chain compares in order, bytes included. An unanswered or malformed
 * field is a disagreement, never skipped.
 */
export function scorePair(key, answer) {
  const diffs = [];
  const cmp = (field, want, got) => {
    if (got === null) diffs.push({ field, reason: "unanswered", map: want, reader: null });
    else if (got === undefined) diffs.push({ field, reason: "malformed", map: want, reader: null });
    else if (JSON.stringify(want) !== JSON.stringify(got))
      diffs.push({ field, reason: "differs", map: want, reader: got });
  };
  if (!answer || answer.schema !== ANSWER_SCHEMA || answer.id !== key.id) {
    diffs.push({ field: "answer", reason: "missing, wrong schema or wrong id", map: null, reader: null });
    return { claude: false, codex: false, agree: false, diffs };
  }
  cmp("claude.receives", key.claude.receives, pathList(answer.claude?.receives));
  cmp("claude.notModelled", key.claude.notModelled, pathList(answer.claude?.notModelled));
  cmp("codex.chain", key.codex.chain, chainList(answer.codex?.chain));
  const claude = !diffs.some((d) => d.field.startsWith("claude."));
  const codex = !diffs.some((d) => d.field.startsWith("codex."));
  return { claude, codex, agree: claude && codex, diffs };
}

/**
 * Score every pair of the key. `answers` maps id -> parsed answer (a missing
 * id counts as unanswered). Returns the fractions, printed with their Wilson
 * intervals, and the disagreements to adjudicate.
 */
export function scoreAll(key, answers) {
  const per = key.pairs.map((p) => ({ id: p.id, ...scorePair(p, answers[p.id]) }));
  const n = per.length;
  const count = (f) => per.filter(f).length;
  const agree = count((p) => p.agree);
  const claudeAgree = count((p) => p.claude);
  const codexAgree = count((p) => p.codex);
  return {
    n,
    agree,
    claudeAgree,
    codexAgree,
    printed: {
      pairs: formatFraction(wilson(agree, n)),
      claude: formatFraction(wilson(claudeAgree, n)),
      codex: formatFraction(wilson(codexAgree, n)),
    },
    disagreements: per.filter((p) => !p.agree).map((p) => ({ id: p.id, diffs: p.diffs })),
  };
}

/** The adjudication sheet: one row per disagreeing field, verdict and reason left blank. No repository is named. */
export function adjudicationSheet(result) {
  const cell = (v) => (v === null ? "(none)" : "`" + JSON.stringify(v).replace(/\|/g, "\\|") + "`");
  const lines = [
    "# K6 adjudication",
    "",
    `Agreement: ${result.printed.pairs} pairs; Claude ${result.printed.claude}; Codex ${result.printed.codex}.`,
    "",
    "Verdicts: **reader** (the reader misapplied a rule; cite it), **map** (map",
    "disagrees with the rule as written: a map defect, appended to PREREG.md's",
    "deviations), **rules** (docs/rules.md is silent or ambiguous here: the",
    "rule text is fixed after the study, and the case is listed).",
    "",
    "| Pair | Field | Why | map | Reader | Verdict | Reason |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const d of result.disagreements)
    for (const x of d.diffs)
      lines.push(`| ${d.id} | ${x.field} | ${x.reason} | ${cell(x.map)} | ${cell(x.reader)} |  |  |`);
  if (!result.disagreements.length) lines.push("| (none) | | | | | | |");
  return lines.join("\n") + "\n";
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
