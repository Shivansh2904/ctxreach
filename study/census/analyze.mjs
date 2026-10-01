// Turn census rows into results.json (study/PREREG.md, "Analysis"). Every
// outcome is a proportion k/n with a Wilson 95% interval, per frame, in three
// variants: raw; deduplicated by the root AGENTS.md's blob (one row per blob,
// the first drawn); and at most 5 repositories per owner (the first 5 drawn).
// Frames are never pooled. Hypotheses get the pre-registered verdicts. Each
// repository-level outcome counts the repositories it leaves out by reason
// (`ineligibleWhy`); the figures that are not proportions are in `summaries`.
//
// Usage: node study/census/analyze.mjs --rows rows-S-main.jsonl [--rows rows-S-imp.jsonl] \
//          [--k3 K3.manifest.json] [--frame-manifest S.manifest.json] --out results.json [--label study|pilot]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { k3Check } from "./consistency.mjs";
import { CODEX_BUDGET, O1_EVENT_SHARE } from "./detectors.mjs";
import { sha256 } from "./lib/paths.mjs";
import { decideBound, decideRange, wilson } from "./lib/stats.mjs";
import { MAX_TYPE2_DIRS } from "./recon.mjs";

/**
 * Every finding code docs/rules.md's Findings table gives the severity
 * `warn` (a test keeps the two equal). O5 prints a row for each of them,
 * 0/n included, so a code that never fires is reported as 0 and not left
 * out; a code outside this list that does fire is reported too.
 */
export const WARN_CODES = [
  "claude.agents-shadowed",
  "claude.external-import-headless",
  "claude.home-ancestor",
  "claude.import-too-deep",
  "claude.link-as-text",
  "claude.mode-in-project-settings",
  "claude.too-large",
  "claude.version-no-agents",
  "claude.words-not-import",
  "codex.cut",
  "codex.empty-override",
  "codex.home-is-root",
  "codex.mid-codepoint",
  "codex.nested",
  "codex.no-budget",
  "codex.project-config-ignored",
  "codex.untrusted",
  "codex.zero-budget",
];

/**
 * Codex's share of the root AGENTS.md at root launch, in bytes, over
 * O1-content's repositories: the bytes of the root AGENTS.md that Codex keeps
 * (`kept` of its entry on the root launch's chain; 0 when it is not on the
 * chain, as behind a root AGENTS.override.md) over the file's bytes.
 */
function codexRootShare(r) {
  const o1 = r.outcomes.o1content;
  if (!o1) return undefined;
  if (!o1.eligible) return { eligible: false, why: o1.why };
  const root = r.pairs.find((p) => p.dir === "." && !p.error);
  if (!root) return { eligible: false, why: "root launch not measured" };
  const entry = root.codex.chain.find((c) => c.path === "AGENTS.md");
  if (!entry) return { eligible: true, kept: 0, share: 0 };
  return { eligible: true, kept: entry.kept, bytes: entry.bytes, share: entry.kept / entry.bytes };
}

/** O6 as map printed it: claude.words-not-import among map's own root warnings, before the symlink rule. */
function o6AsMapPrinted(r) {
  const o6 = r.outcomes.o6;
  if (!o6) return undefined;
  if (!o6.eligible) return { eligible: false, why: o6.why };
  return { eligible: true, event: r.outcomes.o5.rootWarnMap.includes("claude.words-not-import") };
}

/**
 * Repository-level outcomes: [id, source, eligible(o), event(o), unless].
 * The source is a detector key (the row's `outcomes[key]`) or a function of
 * the row. A repository the outcome leaves out is counted by reason
 * (`ineligibleWhy`): the source's own `why` when it is not eligible, else
 * `unless`, the outcome's own condition.
 */
const REPO_OUTCOMES = [
  ["O1-content", "o1content", (o) => o.eligible, (o) => o.event],
  ["O1-content-shingle", "o1contentShingle", (o) => o.eligible, (o) => o.event],
  ["O1-codex-under-half", codexRootShare, (o) => o.eligible, (o) => o.share < O1_EVENT_SHARE],
  ["O1-codex-under-all", codexRootShare, (o) => o.eligible, (o) => o.share < 1],
  ["O1-file", "o1file", (o) => o.eligible, (o) => o.event],
  ["O2", "o2", (o) => o.eligible, (o) => o.event],
  ["O2-types123", "o2", (o) => o.eligible, (o) => o.eventT123],
  ["O2-given-type2", "o2", (o) => o.eligible && o.t2Dirs > 0, (o) => o.event, "no type-2 launch directory"],
  ["P1-repos", "p1", (o) => o.pairs > 0, (o) => o.repoEvent, "no type-1 or type-2 launch directory measured"],
  ["P1-repos-types123", "p1", (o) => o.pairs + o.pairsT3 > 0, (o) => o.repoEventT123, "no launch directory measured"],
  ["O4", "o4", (o) => o.eligible, (o) => o.event],
  ["O5-any-root-warning", "o5", () => true, (o) => o.rootWarn.length > 0],
  ["O5-any-root-warning-map", "o5", () => true, (o) => o.rootWarnMap.length > 0],
  [
    "O5-any-root-warning-no-links",
    "o5",
    (o) => !o.linkAffected,
    (o) => o.rootWarn.length > 0,
    "an instruction file is a symlink",
  ],
  ["O6", "o6", (o) => o.eligible, (o) => o.event],
  ["O6-map", o6AsMapPrinted, (o) => o.eligible, (o) => o.event],
  ["O7", "o7", () => true, (o) => o.event],
  ["O7-broken", "o7", () => true, (o) => o.broken > 0],
  ["O7-root-link-to-agents", "o7", () => true, (o) => o.rootLinkToAgents],
  ["O8", "o8", (o) => o.eligible, (o) => o.event],
  ["O8-over-budget", "o8", (o) => o.eligible, (o) => o.bytes > CODEX_BUDGET],
  ["K3-regex-O1-file", "k3", (o) => o.eligible, (o) => o.event],
];

/** Pair-level outcomes: [id, pairs(o), events(o)]. Intervals on pairs ignore clustering within repositories. */
const PAIR_OUTCOMES = [
  ["P1-pairs", (o) => o.pairs, (o) => o.eventDirs.length],
  ["P1-pairs-types123", (o) => o.pairs + o.pairsT3, (o) => o.eventDirs.length + o.t3EventDirs.length],
];

/** Pre-registered hypotheses: frame, outcome, rule. */
export const HYPOTHESES = [
  { id: "H1", frame: "S-main", outcome: "O1-content", rule: "bound", bound: 0.2, primary: true },
  { id: "H1b", frame: "S-main", outcome: "O1-file", rule: "range", lo: 0.25, hi: 0.4 },
  { id: "H2", frame: "S-imp", outcome: "O2", rule: "bound", bound: 0.15, primary: true },
  { id: "H3-pairs", frame: "S-main", outcome: "P1-pairs", rule: "range", lo: 0.01, hi: 0.05 },
  { id: "H3-repos", frame: "S-main", outcome: "P1-repos", rule: "range", lo: 0.01, hi: 0.08, primary: true },
];

export const OWNER_CAP = 5;
/** A frame that loses more than this share of its draws (exclusions and faulty rows) is redrawn once, with seed + 1. */
export const REDRAW_OVER = 0.1;
/** K4's expected share of byte-exact pairs. */
export const K4_EXPECTED = 0.98;

/** The three variants of a frame's usable rows. */
export function variants(rows) {
  const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const seenBlob = new Set();
  const dedup = ordered.filter((r) => {
    const key = r.blobs?.rootAgents ?? `repo:${r.repo}`;
    if (seenBlob.has(key)) return false;
    seenBlob.add(key);
    return true;
  });
  const perOwner = new Map();
  const ownercap = ordered.filter((r) => {
    const n = perOwner.get(r.owner) ?? 0;
    perOwner.set(r.owner, n + 1);
    return n < OWNER_CAP;
  });
  return { raw: ordered, dedup, ownercap };
}

function round(x) {
  return x === undefined ? null : Math.round(x * 1e6) / 1e6;
}

function fraction(k, n) {
  const w = wilson(k, n);
  return { k, n, p: round(w.p), lo: round(w.lo), hi: round(w.hi) };
}

/** Outcomes for one frame's usable rows. */
export function frameOutcomes(frame, rows) {
  const out = [];
  for (const [variant, vrows] of Object.entries(variants(rows))) {
    for (const [id, source, eligible, event, unless] of REPO_OUTCOMES) {
      const of = typeof source === "function" ? source : (r) => r.outcomes[source];
      let k = 0;
      let n = 0;
      const ineligibleWhy = {};
      for (const r of vrows) {
        const o = of(r);
        if (o && eligible(o)) {
          n++;
          if (event(o)) k++;
          continue;
        }
        const why = !o ? "no detector output" : o.eligible !== false && unless ? unless : (o.why ?? "not eligible");
        ineligibleWhy[why] = (ineligibleWhy[why] ?? 0) + 1;
      }
      out.push({
        id,
        frame,
        variant,
        unit: "repository",
        ...fraction(k, n),
        ineligible: vrows.length - n,
        ineligibleWhy,
      });
    }
    for (const [id, pairs, events] of PAIR_OUTCOMES) {
      let n = 0;
      let k = 0;
      for (const r of vrows) {
        n += pairs(r.outcomes.p1);
        k += events(r.outcomes.p1);
      }
      out.push({ id, frame, variant, unit: "(repository, launch directory) pair", ...fraction(k, n), ineligible: 0 });
    }
    // O5 by code, at the root: after the symlink rule (O5-root) and as map printed them (O5-root-map).
    for (const [prefix, field] of [
      ["O5-root", "rootWarn"],
      ["O5-root-map", "rootWarnMap"],
    ]) {
      const codes = new Set([...WARN_CODES, ...vrows.flatMap((r) => r.outcomes.o5[field])]);
      for (const code of [...codes].sort()) {
        const k = vrows.filter((r) => r.outcomes.o5[field].includes(code)).length;
        out.push({
          id: `${prefix}:${code}`,
          frame,
          variant,
          unit: "repository",
          ...fraction(k, vrows.length),
          ineligible: 0,
          ineligibleWhy: {},
        });
      }
    }
  }
  return out;
}

/** Minimum, median (the mean of the middle two for an even count) and maximum, or nulls for none. */
function spread(values) {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n, min: null, median: null, max: null };
  const median = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  return { n, min: v[0], median, max: v[n - 1] };
}

/**
 * Figures that are not proportions, per frame and variant. O8-held-chars:
 * over the repositories whose root AGENTS.md is longer than Codex's budget
 * (O8-over-budget), the characters (code points; a character the cut splits
 * counts as one U+FFFD) that the budget's 32,768 bytes hold of that file
 * (`o8.effectiveChars`), apart for O8 events (CJK share 0.1 or more) and the
 * rest.
 */
export function frameSummaries(frame, rows) {
  const out = [];
  for (const [variant, vrows] of Object.entries(variants(rows))) {
    const over = vrows.map((r) => r.outcomes.o8).filter((o) => o?.eligible && o.bytes > CODEX_BUDGET);
    out.push({
      id: "O8-held-chars",
      frame,
      variant,
      unit: "characters in the first 32,768 bytes of a root AGENTS.md over the budget",
      budget: CODEX_BUDGET,
      cjk: spread(over.filter((o) => o.event).map((o) => o.effectiveChars)),
      other: spread(over.filter((o) => !o.event).map((o) => o.effectiveChars)),
    });
  }
  return out;
}

export function decide(h, o) {
  if (!o) return "no-data";
  const w = { k: o.k, n: o.n, p: o.p, lo: o.lo, hi: o.hi };
  return h.rule === "bound" ? decideBound(w, h.bound) : decideRange(w, h.lo, h.hi);
}

/** K4 over every rendered pair: exact k/n, every mismatch listed. */
export function k4Summary(rows) {
  const pairs = rows.flatMap((r) => (r.k4?.pairs ?? []).map((p) => ({ repo: r.repo, commit: r.commit, ...p })));
  if (!pairs.length) return null;
  const exact = pairs.filter((p) => p.verdict === "EXACT").length;
  return {
    ...fraction(exact, pairs.length),
    expectedAtLeast: K4_EXPECTED,
    faults: pairs.filter((p) => p.verdict === "FAULT").length,
    mismatches: pairs
      .filter((p) => p.verdict !== "EXACT")
      .map(({ repo, commit, dir, verdict, offBy, firstDiff, faults }) => ({
        repo,
        commit,
        dir,
        verdict,
        offBy,
        firstDiff,
        faults,
      })),
  };
}

export function analyze({ rowSets, k3Manifest, label = "study" }) {
  const byFrame = new Map();
  for (const r of rowSets.flatMap((s) => s.rows)) {
    if (!byFrame.has(r.frame)) byFrame.set(r.frame, []);
    byFrame.get(r.frame).push(r);
  }
  const frames = {};
  const outcomes = [];
  const summaries = [];
  for (const [frame, rows] of byFrame) {
    const measured = rows.filter((r) => r.status === "measured" && !(r.faults ?? []).length);
    const faulted = rows.filter((r) => r.status === "measured" && (r.faults ?? []).length);
    const excluded = rows.filter((r) => r.status === "excluded");
    const reasons = {};
    for (const r of excluded) reasons[r.exclusion] = (reasons[r.exclusion] ?? 0) + 1;
    const share = rows.length ? (excluded.length + faulted.length) / rows.length : 0;
    frames[frame] = {
      drawn: rows.length,
      measured: measured.length,
      excluded: excluded.length,
      exclusions: reasons,
      withFaults: faulted.length,
      faultExamples: faulted.slice(0, 10).map((r) => ({ repo: r.repo, faults: r.faults.slice(0, 3) })),
      excludedShare: round(share),
      // Repositories with more type-2 directories than the cap: there O2 and P1 are lower bounds (PREREG.md section 6).
      type2Capped: {
        ...fraction(measured.filter((r) => (r.launch?.t2Total ?? 0) > MAX_TYPE2_DIRS).length, measured.length),
        cap: MAX_TYPE2_DIRS,
      },
      redrawRequired: share > REDRAW_OVER,
      claudeVersions: [...new Set(measured.map((r) => r.claudeVersion))],
      mapVersions: [...new Set(measured.map((r) => r.mapVersion))],
      labels: [...new Set(rows.map((r) => r.label ?? label))],
    };
    outcomes.push(...frameOutcomes(frame, measured));
    summaries.push(...frameSummaries(frame, measured));
  }
  const find = (frame, id, variant = "raw") =>
    outcomes.find((o) => o.frame === frame && o.id === id && o.variant === variant);
  const hypotheses = HYPOTHESES.map((h) => {
    const o = find(h.frame, h.outcome);
    return { ...h, estimate: o ? { k: o.k, n: o.n, p: o.p, lo: o.lo, hi: o.hi } : null, verdict: decide(h, o) };
  });
  const checks = { K4: k4Summary(rowSets.flatMap((s) => s.rows)) };
  if (k3Manifest && byFrame.has("S-main")) {
    const rows = byFrame.get("S-main").filter((r) => r.status === "measured" && !(r.faults ?? []).length);
    checks.K3 = k3Check(rows, k3Manifest);
  }
  return {
    schema: "ctxreach.study-results/v1",
    label,
    generatedAt: new Date().toISOString(),
    inputs: rowSets.map((s) => ({ file: s.file, sha256: s.sha256, rows: s.rows.length })),
    frames,
    hypotheses,
    outcomes,
    summaries,
    checks,
    wording: {
      codex: "as rendered by `codex debug prompt-input` <version>; the model was not run",
      claude: "predicted by ctxreach map for Claude Code <version>, default settings, a fresh machine; not a live run",
      pairs:
        "intervals on (repository, launch directory) pairs ignore clustering within a repository; the repository-level figure is the one with a valid interval",
    },
  };
}

function main(args) {
  const rowFiles = args.flatMap((a, i) => (a === "--rows" ? [args[i + 1]] : []));
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = opt("--out");
  if (!rowFiles.length || !out) {
    console.error(
      "usage: node study/census/analyze.mjs --rows rows.jsonl [--rows ...] [--k3 K3.manifest.json] --out results.json [--label pilot]",
    );
    return 2;
  }
  const rowSets = rowFiles.map((file) => {
    const text = readFileSync(file, "utf8");
    return {
      file: path.basename(file),
      sha256: sha256(Buffer.from(text)),
      rows: text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    };
  });
  const k3 = opt("--k3") ? JSON.parse(readFileSync(opt("--k3"), "utf8")) : undefined;
  const frameManifest = opt("--frame-manifest") ? JSON.parse(readFileSync(opt("--frame-manifest"), "utf8")) : undefined;
  const k3Manifest = k3 && frameManifest ? { ...k3, frameRepos: frameManifest.repos } : k3;
  const results = analyze({ rowSets, k3Manifest, label: opt("--label") ?? "study" });
  writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
  for (const h of results.hypotheses)
    console.log(
      `${h.id} ${h.frame} ${h.outcome}: ${h.estimate ? `${h.estimate.k}/${h.estimate.n} [${h.estimate.lo}, ${h.estimate.hi}]` : "no data"} -> ${h.verdict}`,
    );
  for (const [f, s] of Object.entries(results.frames))
    console.log(
      `${f}: ${s.measured} measured, ${s.excluded} excluded ${JSON.stringify(s.exclusions)}, ${s.withFaults} with faults, type-2 capped ${s.type2Capped.k}/${s.type2Capped.n}${s.redrawRequired ? " -- over 10% lost: the pre-registered redraw applies" : ""}`,
    );
  if (results.checks.K4) console.log(`K4: ${results.checks.K4.k}/${results.checks.K4.n} pairs byte-exact`);
  if (results.checks.K3) console.log(`K3: ${results.checks.K3.pass ? "pass" : "FAIL"} (${results.checks.K3.explain})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
