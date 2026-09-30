// The evidence registry: docs/evidence.json holds, for every rule id and
// finding code in docs/rules.md, how well it is supported, and this script
// turns it into docs/evidence.md and checks it.
//
// Status ladder (an entry may claim no more than its evidence):
//   documented    vendor documentation says so           confidence docs@<date> or assumed
//   source        a pinned source line says so           confidence source@<commit>
//   observed      recorded runs agree, k = n             confidence canary@<ver>, hook@<ver> or oracle@<ver>
//   contradicted  recorded runs disagree, k < n          the same, and a note on the gap
//
// k/n for a recorded entry is re-derived by replaying its recordings
// (test/evidence.test.ts passes the replayers: `probe --replay`'s scorer for
// canary recordings; render and capture recordings get theirs when the
// oracle lane's `verify --replay` is merged). The unit is cells: one planted
// token (head or tail of one file) in one recorded run, counted when its
// verdict is decided (CONFIRMED, DISCOVERED, MISSED or EXTRA) and agreeing
// when it is CONFIRMED or DISCOVERED. A cell's verdict already covers every
// usable trial of its run.
//
//   node scripts/evidence.mjs            write docs/evidence.md
//   node scripts/evidence.mjs --check [--against <file>]
//                                        exit 1 if docs/evidence.md (or <file>) is stale
//   node scripts/evidence.mjs flips --previous <old.json> --current <new.json> [--column <label>]
//                                        compare two conformance results.json files; exit 1 when
//                                        a cell's verdict changed, printing Markdown for an issue
//   node scripts/evidence.mjs plant [name ...]
//                                        break each evidence and Action check in turn; a test must fail

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SELF = fileURLToPath(import.meta.url);
export const ROOT = path.join(path.dirname(SELF), "..");
export const ID = /^(codex|claude)\.[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// docs/rules.md

/** Split a Markdown document into its `## ` sections: heading -> body. */
function sections(doc) {
  const out = new Map();
  for (const part of doc.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    out.set(part.slice(0, nl).trim(), part.slice(nl + 1));
  }
  return out;
}

/** Ids in the first column of the Markdown tables in `text`. */
function tableIds(text) {
  return [...text.matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]).filter((id) => ID.test(id));
}

/**
 * Rule ids (the Codex and Claude Code tables) and finding codes (the Findings
 * table) in docs/rules.md. An id can be both.
 */
export function rulesDocIds(doc) {
  const s = sections(doc);
  const rules = [...tableIds(s.get("Codex") ?? ""), ...tableIds(s.get("Claude Code") ?? "")];
  const findings = tableIds(s.get("Findings") ?? "");
  return { rules: [...new Set(rules)], findings: [...new Set(findings)] };
}

// ---------------------------------------------------------------------------
// docs/evidence.json

const Status = z.enum(["documented", "source", "observed", "contradicted"]);
const Instrument = z.enum(["canary", "hook", "render", "capture"]);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Entry = z
  .object({
    rule: z.string().regex(ID),
    status: Status,
    agent: z.enum(["codex", "claude"]),
    date: Day,
    confidence: z
      .string()
      .regex(/^(docs@\d{4}-\d{2}-\d{2}|source@[0-9a-f]{7,40}|(canary|hook|oracle)@[\w.-]+|assumed)$/),
    basis: z
      .string()
      .regex(/^(docs@\d{4}-\d{2}-\d{2}|source@[0-9a-f]{7,40}|assumed)$/)
      .optional(),
    version: z.string().optional(),
    os: z.string().optional(),
    instrument: Instrument.optional(),
    unit: z.literal("cells").optional(),
    k: z.number().int().nonnegative().optional(),
    n: z.number().int().positive().optional(),
    trials: z.number().int().positive().optional(),
    recording: z.array(z.string()).nonempty().optional(),
    select: z
      .object({
        rule: z.array(z.string()).nonempty().optional(),
        delivery: z.array(z.string()).nonempty().optional(),
        needsApproval: z.boolean().optional(),
      })
      .strict()
      .optional(),
    note: z.string().optional(),
  })
  .strict();

export const Registry = z.object({ schema: z.literal("ctxreach.evidence/v1"), entries: z.array(Entry) }).strict();

const RUN_FIELDS = ["version", "os", "instrument", "unit", "k", "n", "trials", "recording"];

/** The confidence prefix a recorded entry's instrument gives. */
const CONFIDENCE_OF = { canary: "canary", hook: "hook", render: "oracle", capture: "oracle" };

/**
 * Parse the registry and check each entry claims no more than its kind of
 * evidence allows. Returns the registry and a list of problems.
 */
export function validateRegistry(raw) {
  const parsed = Registry.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { registry: undefined, problems: [`${issue.path.join(".")}: ${issue.message}`] };
  }
  const registry = parsed.data;
  const problems = [];
  const seen = new Set();
  for (const e of registry.entries) {
    const at = e.rule;
    if (seen.has(e.rule)) problems.push(`${at}: more than one entry`);
    seen.add(e.rule);
    if (e.rule.split(".")[0] !== e.agent)
      problems.push(`${at}: agent is ${e.agent}, but the id is ${e.rule.split(".")[0]}'s`);
    const run = e.status === "observed" || e.status === "contradicted";
    if (!run) {
      const extra = RUN_FIELDS.filter((f) => e[f] !== undefined);
      if (extra.length)
        problems.push(`${at}: ${e.status} with run fields (${extra.join(", ")}); only a recorded run can back them`);
      if (e.select) problems.push(`${at}: ${e.status} with select`);
      if (e.status === "documented" && !/^(docs@|assumed$)/.test(e.confidence))
        problems.push(`${at}: documented needs confidence docs@<date> or assumed, not ${e.confidence}`);
      if (e.status === "source" && !e.confidence.startsWith("source@"))
        problems.push(`${at}: source needs confidence source@<commit>, not ${e.confidence}`);
      continue;
    }
    const missing = RUN_FIELDS.filter((f) => e[f] === undefined);
    if (missing.length) {
      problems.push(`${at}: ${e.status} needs ${missing.join(", ")}`);
      continue;
    }
    if (e.confidence !== `${CONFIDENCE_OF[e.instrument]}@${e.version}`)
      problems.push(`${at}: confidence must be ${CONFIDENCE_OF[e.instrument]}@${e.version}, not ${e.confidence}`);
    if (e.k > e.n) problems.push(`${at}: k ${e.k} is more than n ${e.n}`);
    if (e.status === "observed" && e.k !== e.n)
      problems.push(`${at}: observed needs every decided cell to agree (${e.k}/${e.n}); that is contradicted`);
    if (e.status === "contradicted" && e.k === e.n) problems.push(`${at}: contradicted, but ${e.k}/${e.n} agree`);
    if (e.status === "contradicted" && !e.note) problems.push(`${at}: contradicted needs a note on the gap`);
  }
  return { registry, problems };
}

/** Ids in docs/rules.md with no registry entry. */
export function missingEntries(ids, registry) {
  const have = new Set(registry.entries.map((e) => e.rule));
  return ids.filter((id) => !have.has(id));
}

/** Registry entries for ids docs/rules.md does not list (a renamed or removed rule). */
export function orphanEntries(ids, registry) {
  const known = new Set(ids);
  return registry.entries.map((e) => e.rule).filter((id) => !known.has(id));
}

// ---------------------------------------------------------------------------
// Replaying the recordings behind observed and contradicted entries.

const DECIDED = ["confirmed", "discovered", "missed", "extra"];
const AGREEING = ["confirmed", "discovered"];

/** The cells of one replayed run that an entry counts. Default: cells whose prediction cites the entry's id. */
export function selectCells(cells, entry) {
  const sel = entry.select ?? {};
  const rules = sel.rule ?? [entry.rule];
  return cells.filter(
    (c) =>
      rules.includes(c.rule) &&
      (sel.delivery === undefined || sel.delivery.includes(c.delivery)) &&
      (sel.needsApproval === undefined || c.needsApproval === sel.needsApproval) &&
      DECIDED.includes(c.verdict),
  );
}

/** k/n over some replayed runs. */
export function countCells(replays, entry) {
  let k = 0;
  let n = 0;
  let trials = 0;
  for (const r of replays) {
    const cells = selectCells(r.cells, entry);
    n += cells.length;
    k += cells.filter((c) => AGREEING.includes(c.verdict)).length;
    if (cells.length) trials += r.usable;
  }
  return { k, n, trials };
}

/**
 * Replay each recorded entry and compare. `replayers[instrument]` has
 * `replay(dir)` -> { cells: [{ rule, delivery, needsApproval, verdict }],
 * usable, agent, version, os, date, fault } and `all()` -> every recording
 * directory for that instrument. Every recording of the entry's agent,
 * version and OS that has a counted cell must be listed, so an entry cannot
 * leave a disagreeing run out.
 */
export function replayMismatches(registry, replayers, root = ROOT) {
  const problems = [];
  const cache = new Map();
  const replay = (instrument, dir) => {
    const key = `${instrument}:${dir}`;
    if (!cache.has(key)) cache.set(key, replayers[instrument].replay(path.join(root, dir)));
    return cache.get(key);
  };
  for (const e of registry.entries) {
    if (e.status !== "observed" && e.status !== "contradicted") continue;
    const at = e.rule;
    const replayer = replayers[e.instrument];
    if (!replayer) {
      problems.push(`${at}: no replayer for ${e.instrument} recordings on this branch`);
      continue;
    }
    const listed = [];
    let bad = false;
    for (const dir of e.recording) {
      if (!existsSync(path.join(root, dir))) {
        problems.push(`${at}: recording ${dir} does not exist`);
        bad = true;
        continue;
      }
      const r = replay(e.instrument, dir);
      if (r.fault) problems.push(`${at}: ${dir} is an instrument fault, so it is no evidence`);
      if (r.agent !== e.agent || r.version !== e.version || r.os !== e.os)
        problems.push(
          `${at}: ${dir} is ${r.agent} ${r.version} on ${r.os}, the entry says ${e.agent} ${e.version} on ${e.os}`,
        );
      if (r.date > e.date) problems.push(`${at}: ${dir} was recorded on ${r.date}, after the entry's date ${e.date}`);
      if (selectCells(r.cells, e).length === 0) problems.push(`${at}: ${dir} has no cell this entry counts`);
      listed.push(r);
    }
    if (bad) continue;
    const got = countCells(listed, e);
    if (got.k !== e.k || got.n !== e.n)
      problems.push(`${at}: the recordings replay to ${got.k}/${got.n}, the entry says ${e.k}/${e.n}`);
    if (got.trials !== e.trials)
      problems.push(`${at}: the recordings hold ${got.trials} usable trials, the entry says ${e.trials}`);
    for (const dir of replayer.all()) {
      if (e.recording.includes(dir)) continue;
      const r = replay(e.instrument, dir);
      if (r.agent === e.agent && r.version === e.version && r.os === e.os && selectCells(r.cells, e).length)
        problems.push(`${at}: ${dir} has cells this entry counts but is not listed`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// README.md: name only what was observed.

/** A sentence that says outright it reports no measurement. */
export const NOT_MEASURED = /\b(not measured|not yet measured|unmeasured)\b/i;

/** The sentence of `text` around `index`: from the previous `.`, `!` or `?` before a space, to the next. */
function sentenceAt(text, index, length) {
  const before = text.slice(0, index);
  const starts = [...before.matchAll(/[.!?](?=\s)|\n\s*\n|^\s*[-*|] /gm)];
  const last = starts[starts.length - 1];
  const start = last ? last.index + last[0].length : 0;
  const rest = text.slice(index + length);
  const end = rest.search(/[.!?](?=\s|$)|\n\s*\n/);
  return text
    .slice(start, end === -1 ? text.length : index + length + end + 1)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every place the README names a rule id or finding code whose status is not
 * `observed`, unless its sentence says it is not measured. Returns
 * { id, status, line, sentence } for each.
 */
export function readmeViolations(readme, ids, registry) {
  const status = new Map(registry.entries.map((e) => [e.rule, e.status]));
  const out = [];
  for (const id of new Set([...ids, ...registry.entries.map((e) => e.rule)])) {
    const pattern = new RegExp(`(?<![\\w.-])${id.replace(/[.]/g, "\\.")}(?![\\w-])`, "g");
    for (const m of readme.matchAll(pattern)) {
      const s = status.get(id) ?? "no entry";
      if (s === "observed") continue;
      const sentence = sentenceAt(readme, m.index, id.length);
      if (NOT_MEASURED.test(sentence)) continue;
      out.push({ id, status: s, at: m.index, line: readme.slice(0, m.index).split("\n").length, sentence });
    }
  }
  // In the order they appear.
  return out.sort((a, b) => a.at - b.at).map(({ id, status, line, sentence }) => ({ id, status, line, sentence }));
}

// ---------------------------------------------------------------------------
// docs/evidence.md

function runColumn(e) {
  return `${e.agent} ${e.version} ${e.os}`;
}

function kinds(id, doc) {
  const k = [];
  if (doc.rules.includes(id)) k.push("rule");
  if (doc.findings.includes(id)) k.push("finding");
  return k.length ? k.join(" + ") : "not in docs/rules.md yet";
}

const cellText = (s) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ");

/** docs/evidence.md: a matrix of ids by agent, version and OS, then every entry's detail. */
export function renderEvidenceMd(registry, doc) {
  const entries = registry.entries;
  const runs = entries.filter((e) => e.status === "observed" || e.status === "contradicted");
  const columns = [...new Set(runs.map(runColumn))].sort();
  const count = (s) => entries.filter((e) => e.status === s).length;
  const lines = [];
  lines.push("# Evidence for each rule and finding", "");
  lines.push(
    "Generated by `node scripts/evidence.mjs` from [`evidence.json`](evidence.json). Do not edit this file;",
    "edit the JSON and run the script. `test/evidence.test.ts` fails when this file is stale, when an id in",
    "[`rules.md`](rules.md) has no entry, when a recorded entry does not replay to its fraction, and when",
    "`README.md` names an id whose status is not `observed`.",
    "",
  );
  lines.push(
    `${entries.length} entries: ${count("observed")} observed, ${count("contradicted")} contradicted, ` +
      `${count("source")} from source code, ${count("documented")} from documentation only.`,
    "",
  );
  lines.push(
    "| Status | Means |",
    "|---|---|",
    "| documented | Vendor documentation says so (`docs@<date checked>`), or ctxreach assumes it (`assumed`). |",
    "| source | The agent's source code at a pinned commit says so (`source@<commit>`). |",
    "| observed | Recorded runs agree with `map` in every counted cell (`canary@<version>`: `probe` runs; `oracle@<version>`: renders or captured requests). |",
    "| contradicted | Recorded runs disagree with `map` in at least one counted cell; the note says where. |",
    "",
  );
  lines.push(
    "A run column's fraction is k/n cells: a cell is one planted token (the head or tail of one file) in one",
    "recorded run, counted when its verdict is decided and agreeing when it is CONFIRMED or DISCOVERED. A cell",
    "is CONFIRMED only if every usable trial of its run behaved as predicted. Cells in one run are not",
    "independent, so no interval is given. Pilot runs are named in notes and are never counted.",
    "",
  );
  lines.push(`| Id | Kind | Status | Basis |${columns.map((c) => ` ${c} |`).join("")}`);
  lines.push(`|---|---|---|---|${columns.map(() => "---|").join("")}`);
  for (const e of entries) {
    const basis = e.basis ?? e.confidence;
    const cells = columns.map((c) =>
      (e.status === "observed" || e.status === "contradicted") && runColumn(e) === c
        ? ` ${e.status} ${e.k}/${e.n} |`
        : " |",
    );
    lines.push(`| \`${e.rule}\` | ${kinds(e.rule, doc)} | ${e.status} | ${basis} |${cells.join("")}`);
  }
  lines.push("");
  lines.push("## Recorded entries", "");
  for (const e of runs) {
    lines.push(`### \`${e.rule}\`: ${e.status} ${e.k}/${e.n} cells`, "");
    lines.push(
      `${e.agent === "claude" ? "Claude Code" : "Codex"} ${e.version} on ${e.os}, ${e.date}, instrument ${e.instrument}, ` +
        `${e.trials} usable trials in ${e.recording.length} ${e.recording.length === 1 ? "run" : "runs"}.`,
      "",
    );
    if (e.select) {
      const parts = [];
      if (e.select.rule) parts.push(`predicted by ${e.select.rule.map((r) => `\`${r}\``).join(" or ")}`);
      if (e.select.delivery) parts.push(`predicted delivery ${e.select.delivery.map((d) => `\`${d}\``).join(" or ")}`);
      if (e.select.needsApproval !== undefined) parts.push(`needs approval: ${e.select.needsApproval}`);
      lines.push(`Counts the cells ${parts.join(", ")}.`, "");
    }
    for (const r of e.recording) lines.push(`- \`${r}\`, replay with \`ctxreach probe --replay ${r}\``);
    lines.push("");
    if (e.note) lines.push(e.note, "");
  }
  const noted = entries.filter((e) => e.note && e.status !== "observed" && e.status !== "contradicted");
  if (noted.length) {
    lines.push("## Notes on other entries", "");
    for (const e of noted) lines.push(`- \`${e.rule}\` (${e.status}): ${cellText(e.note)}`);
    lines.push("");
  }
  return lines.join("\n").replace(/\n*$/, "\n");
}

// ---------------------------------------------------------------------------
// Conformance flips (the nightly workflow).

const FlipRecord = z
  .object({
    fixture: z.string(),
    launchDir: z.string(),
    agent: z.string(),
    version: z.string(),
    os: z.string(),
    verdict: z.string(),
    instrument: z.string(),
  })
  .passthrough();

/** results.json holds an array of records, or { records: [...] }. */
export function readResults(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.records) ? raw.records : undefined;
  if (!list) throw new Error("expected an array of records or { records: [...] }");
  return list.map((r, i) => {
    const parsed = FlipRecord.safeParse(r);
    if (!parsed.success)
      throw new Error(`record ${i}: ${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`);
    return parsed.data;
  });
}

const cellKey = (r) => JSON.stringify([r.agent, r.instrument, r.os, r.fixture, r.launchDir]);

/**
 * Cells whose verdict changed between two runs of the same column (for
 * example "latest"), keyed by agent, instrument, OS, fixture and launch
 * directory, not by version: a new release is exactly when a flip matters.
 * Cells only in one run are listed as added or removed, not as flips.
 */
export function flips(previous, current) {
  const before = new Map(previous.map((r) => [cellKey(r), r]));
  const after = new Map(current.map((r) => [cellKey(r), r]));
  const changed = [];
  for (const [key, now] of after) {
    const then = before.get(key);
    if (then && then.verdict !== now.verdict) changed.push({ before: then, after: now });
  }
  const added = [...after.keys()].filter((k) => !before.has(k)).map((k) => after.get(k));
  const removed = [...before.keys()].filter((k) => !after.has(k)).map((k) => before.get(k));
  return { changed, added, removed };
}

export function flipsMarkdown(result, column) {
  const lines = [`Conformance cells that changed verdict in the \`${column}\` column:`, ""];
  lines.push("| agent | OS | fixture | launch dir | before | after |", "|---|---|---|---|---|---|");
  for (const { before, after } of result.changed)
    lines.push(
      `| ${after.agent} (${after.instrument}) | ${after.os} | ${after.fixture} | ${after.launchDir} | ${before.verdict} (${before.version}) | ${after.verdict} (${after.version}) |`,
    );
  lines.push("", `${result.added.length} cells added, ${result.removed.length} removed since the previous run.`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Plants: break one check at a time; a test must fail each time.

export const PLANTS = [
  {
    name: "coverage-check-off",
    file: "scripts/evidence.mjs",
    find: "return ids.filter((id) => !have.has(id));",
    replace: "return [];",
  },
  {
    name: "orphan-check-off",
    file: "scripts/evidence.mjs",
    find: "return registry.entries.map((e) => e.rule).filter((id) => !known.has(id));",
    replace: "return [];",
  },
  {
    name: "replay-count-ignored",
    file: "scripts/evidence.mjs",
    find: "if (got.k !== e.k || got.n !== e.n)",
    replace: "if (false)",
  },
  {
    name: "replay-unlisted-run-allowed",
    file: "scripts/evidence.mjs",
    find: "problems.push(`${at}: ${dir} has cells this entry counts but is not listed`);",
    replace: "void 0;",
  },
  {
    name: "observed-needs-no-agreement",
    file: "scripts/evidence.mjs",
    find: 'if (e.status === "observed" && e.k !== e.n)',
    replace: "if (false)",
  },
  {
    name: "readme-check-off",
    file: "scripts/evidence.mjs",
    find: 'if (s === "observed") continue;',
    replace: "continue;",
  },
  {
    name: "readme-disclaimer-anything",
    file: "scripts/evidence.mjs",
    find: "export const NOT_MEASURED = /\\b(not measured|not yet measured|unmeasured)\\b/i;",
    replace: "export const NOT_MEASURED = /./;",
  },
  {
    name: "evidence-md-drops-rows",
    file: "scripts/evidence.mjs",
    find: "for (const e of entries) {",
    replace: "for (const e of entries.slice(1)) {",
  },
  {
    name: "flips-never",
    file: "scripts/evidence.mjs",
    find: "if (then && then.verdict !== now.verdict)",
    replace: "if (false)",
  },
  { name: "annotation-no-line", file: "src/report/annotations.ts", find: "line: entry.cut.line,", replace: "" },
  {
    name: "annotation-no-switcher",
    file: "src/report/annotations.ts",
    find: "for (const s of switchers) shadowed.set(s, [...(shadowed.get(s) ?? []), f.path]);",
    replace: "",
  },
  {
    name: "annotation-no-escape",
    file: "src/report/annotations.ts",
    find: 'return text.replace(/%/g, "%25").replace(/\\r/g, "%0D").replace(/\\n/g, "%0A");',
    replace: "return text;",
  },
  {
    name: "fail-on-ignored",
    file: "src/report/annotations.ts",
    find: 'if (failOn === "none") return false;',
    replace: "return false;",
  },
  {
    name: "launch-dirs-root-only",
    file: "src/report/annotations.ts",
    find: "for (const s of discoverSurfaces(root)) dirs.set(relTo(root, s.dir), s.dir);",
    replace: "",
  },
  {
    name: "fail-on-unknown-code-accepted",
    file: "src/report/annotations.ts",
    find: "if (!knownCodes.includes(c))",
    replace: "if (false)",
  },
  {
    name: "summary-limit-in-characters",
    file: "src/report/markdown.ts",
    find: 'const bytes = (text: string) => Buffer.byteLength(text, "utf8");',
    replace: "const bytes = (text: string) => text.length;",
  },
  {
    name: "summary-says-nothing-above-path",
    file: "src/report/markdown.ts",
    find: "const above = [...aboveWords(agents, options.scanned), ...codexRootsAbove(runs, options.scanned)];",
    replace: "const above = [`And nothing above ${code(options.scanned)} is read.`];",
  },
  {
    name: "summary-claude-no-above-path",
    file: "src/report/markdown.ts",
    find: 'agent === "claude" && outside(row.path) && !json.claude?.files.some((f) => f.path === row.path)',
    replace: "false",
  },
  {
    name: "action-reads-runner-home",
    file: "src/report/annotations.ts",
    find: 'codex: { home: path.join(home, ".codex") },',
    replace: "codex: {},",
  },
  {
    name: "action-reads-runner-claude-home",
    file: "src/report/annotations.ts",
    find: 'claude: { home: path.join(home, ".claude"), homeDir: home, ceiling: inputs.root },',
    replace: "claude: { ceiling: inputs.root },",
  },
];

const PLANT_TESTS = ["test/evidence.test.ts", "test/action.test.ts"];
const MARK = "PLANT-RESULT ";
const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

// This file holds the plants' own text in PLANTS, so a plant in this file
// applies only to the code before that list.
const PLANTS_START = "\nexport const PLANTS = [";

/** The part of a file's source a plant may change, and the rest. */
function plantRegion(file, source) {
  if (file !== "scripts/evidence.mjs") return [source, ""];
  const at = source.indexOf(PLANTS_START);
  if (at === -1) throw new Error(`${file}: cannot find the PLANTS list`);
  return [source.slice(0, at), source.slice(at)];
}

/** How often each plant's text occurs where it may apply (each must be exactly once). */
export function plantOccurrences() {
  return PLANTS.map((p) => ({
    name: p.name,
    count: plantRegion(p.file, readFileSync(path.join(ROOT, p.file), "utf8"))[0].split(p.find).length - 1,
  }));
}

async function plantChild({ name, files }) {
  const { startVitest } = await import("vitest/node");
  const plant = PLANTS.find((p) => p.name === name);
  let applied = false;
  const plugin = {
    name: "ctxreach-plant-evidence-fault",
    enforce: "pre",
    transform(source, id) {
      if (!plant || rel(id.split("?")[0]) !== plant.file) return null;
      const [head, tail] = plantRegion(plant.file, source);
      if (head.split(plant.find).length !== 2) throw new Error(`${plant.file}: expected the plant's text once`);
      applied = true;
      return head.replace(plant.find, plant.replace) + tail;
    },
  };
  const failed = [];
  const broken = [];
  let total = 0;
  const reporter = {
    onTestRunEnd(modules, errors) {
      for (const mod of modules) {
        const file = rel(mod.moduleId);
        if (mod.errors().length) broken.push(`${file}: ${mod.errors()[0].message}`);
        for (const test of mod.children.allTests()) {
          total++;
          const result = test.result();
          if (result.state === "failed")
            failed.push({ file, name: test.fullName, why: (result.errors?.[0]?.message ?? "").split("\n")[0] });
        }
      }
      for (const e of errors) broken.push(`unhandled: ${e.message}`);
    },
  };
  // The plugin runs in this process, so `applied` is read after the run.
  await startVitest(
    "test",
    files ?? PLANT_TESTS,
    { root: ROOT, run: true, watch: false, reporters: [reporter] },
    plant ? { plugins: [plugin] } : {},
  );
  process.stdout.write(`\n${MARK}${JSON.stringify({ name, total, failed, broken, applied })}\n`);
  process.exit(0);
}

function plantRun(name, files) {
  const own = mkdtempSync(path.join(os.tmpdir(), "ctxreach-plant-run-"));
  let res;
  try {
    res = spawnSync(process.execPath, [SELF, "plant-child", JSON.stringify({ name, files })], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TMPDIR: own, TMP: own, TEMP: own },
    });
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
  const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith(MARK));
  if (!line) {
    process.stderr.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    throw new Error(`the run for ${name ?? "the baseline"} printed no result (exit ${res.status})`);
  }
  return JSON.parse(line.slice(MARK.length));
}

function plantMain(requested) {
  const unknown = requested.filter((n) => !PLANTS.some((p) => p.name === n));
  if (unknown.length) {
    console.error(`Unknown plant: ${unknown.join(", ")}`);
    return 2;
  }
  const wrong = plantOccurrences().filter((o) => o.count !== 1);
  if (wrong.length) {
    console.error("Each plant's text must occur exactly once in its file:");
    for (const w of wrong) console.error(`  ${w.name}: found ${w.count} times`);
    return 2;
  }
  const targets = requested.length ? PLANTS.filter((p) => requested.includes(p.name)) : PLANTS;
  const base = plantRun(null);
  if (base.total === 0 || base.failed.length || base.broken.length) {
    console.error(`The tests do not pass without a plant (${base.failed.length} of ${base.total} failed):`);
    for (const f of [...base.broken, ...base.failed.map((f) => `${f.file} > ${f.name} (${f.why})`)])
      console.error(`  ${f}`);
    return 2;
  }
  console.log(`baseline: 0 of ${base.total} tests fail with nothing planted (${PLANT_TESTS.join(", ")})`);
  let uncaught = 0;
  let instrument = 0;
  const width = Math.max(...targets.map((p) => p.name.length));
  for (const plant of targets) {
    const r = plantRun(plant.name);
    let verdict;
    if (!r.applied || r.broken.length) {
      instrument++;
      verdict = `INSTRUMENT: ${r.applied ? r.broken.join("; ") : "the plant was never applied (no test loads the file)"}`;
    } else if (r.failed.length === 0) {
      uncaught++;
      verdict = "NOT CAUGHT: no test failed";
    } else {
      // Run the failing files again with the same plant, so a timeout on a busy machine is not taken for a catch.
      const again = plantRun(plant.name, [...new Set(r.failed.map((f) => f.file))]);
      const label = (f) => `${f.file} > ${f.name}`;
      const repeated = new Set(again.failed.map(label));
      const caught = r.failed.filter((f) => repeated.has(label(f)));
      if (caught.length) verdict = `caught by ${caught.length} of ${r.total} tests, e.g. ${label(caught[0])}`;
      else {
        uncaught++;
        verdict = `NOT CAUGHT: ${r.failed.length} tests failed once but not on a second run`;
      }
    }
    console.log(`${plant.name.padEnd(width)}  ${verdict}`);
  }
  console.log(`\n${targets.length - uncaught - instrument} of ${targets.length} planted faults caught by a test`);
  return instrument ? 2 : uncaught ? 1 : 0;
}

// ---------------------------------------------------------------------------

export function loadAll(root = ROOT) {
  const doc = rulesDocIds(readFileSync(path.join(root, "docs", "rules.md"), "utf8"));
  const { registry, problems } = validateRegistry(
    JSON.parse(readFileSync(path.join(root, "docs", "evidence.json"), "utf8")),
  );
  return { doc, registry, problems };
}

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  if (argv[0] === "plant-child") return plantChild(JSON.parse(argv[1] ?? "{}"));
  if (argv[0] === "plant") return plantMain(argv.slice(1));
  if (argv[0] === "flips") {
    const previous = arg(argv, "--previous");
    const current = arg(argv, "--current");
    const column = arg(argv, "--column") ?? "latest";
    if (!current) {
      console.error(
        "usage: node scripts/evidence.mjs flips --previous <old.json> --current <new.json> [--column <label>]",
      );
      return 2;
    }
    const now = readResults(JSON.parse(readFileSync(current, "utf8")));
    if (!previous || !existsSync(previous)) {
      console.log(`No previous results for the ${column} column; ${now.length} cells recorded, nothing to compare.`);
      return 0;
    }
    const result = flips(readResults(JSON.parse(readFileSync(previous, "utf8"))), now);
    if (result.changed.length === 0) {
      console.log(`No cell changed verdict in the ${column} column (${now.length} cells).`);
      return 0;
    }
    process.stdout.write(flipsMarkdown(result, column));
    return 1;
  }
  const { doc, registry, problems } = loadAll();
  if (!registry) {
    console.error(`docs/evidence.json: ${problems.join("; ")}`);
    return 2;
  }
  const md = renderEvidenceMd(registry, doc);
  const file = path.join(ROOT, "docs", "evidence.md");
  if (argv.includes("--check")) {
    const against = arg(argv, "--against") ?? file;
    const same = existsSync(against) && readFileSync(against, "utf8") === md;
    const shown = path.relative(process.cwd(), against) || against;
    console.log(same ? `${shown} is up to date` : `${shown} is stale: run node scripts/evidence.mjs`);
    return same ? 0 : 1;
  }
  writeFileSync(file, md);
  console.log(`wrote docs/evidence.md (${registry.entries.length} entries)`);
  if (problems.length) {
    console.error(`docs/evidence.json has ${problems.length} problems:`);
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const code = await main(process.argv.slice(2));
  if (code !== undefined) process.exitCode = code;
}
