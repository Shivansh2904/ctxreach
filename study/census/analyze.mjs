// Turn census rows into results.json (study/PREREG.md, "Analysis"). Every
// outcome is a proportion k/n with a Wilson 95% interval, per frame, in three
// variants: raw; deduplicated by the root AGENTS.md's blob (one row per blob,
// the first drawn); and at most 5 repositories per owner (the first 5 drawn).
// Frames are never pooled, and neither are two draws of one frame: a redrawn
// sample replaces its first draw for every figure, verdict and check, and the
// first draw is reported under `<frame>-draw1` (lib/draws.mjs, which refuses
// rows that would pool draws, samples, builds, versions or platforms, and a
// study draw with fewer rows than the n drawn). A row with a fault is not
// used: not for the outcomes, and not for K3 or K4.
// Hypotheses get the pre-registered verdicts, taken on the bounds as written
// here (rounded to 6 decimal places). Each repository-level outcome counts the
// repositories it leaves out by reason (`ineligibleWhy`); the figures that are
// not proportions are in `summaries`.
//
// Usage: node study/census/analyze.mjs --rows rows-S-main.jsonl [--rows rows-S-imp.jsonl] \
//          [--k3 K3.manifest.json] [--frame-manifest S.manifest.json] --out results.json [--label study|pilot]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { k3Check } from "./consistency.mjs";
import { CODEX_BUDGET, O1_EVENT_SHARE } from "./detectors.mjs";
import { lostShare, REDRAW_OVER, splitDraws } from "./lib/draws.mjs";
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
/** A sample that loses more than this share of its draws (exclusions and faulty rows) is redrawn once, with seed + 1. */
export { REDRAW_OVER };
/** K4's expected share of byte-exact pairs: registered, and reported as met or not; not a pass threshold. */
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

/** The verdict of a hypothesis on its outcome: its rule's words, or `no-data` when the outcome is missing or n is 0. */
export function decide(h, o) {
  if (!o) return "no-data";
  const w = { k: o.k, n: o.n, p: o.p, lo: o.lo, hi: o.hi };
  return h.rule === "bound" ? decideBound(w, h.bound) : decideRange(w, h.lo, h.hi);
}

/**
 * K4 over every rendered pair of the given rows: exact k/n with its Wilson
 * interval, whether k/n reached the registered expectation (a validity
 * estimate: falling short stops nothing), the Codex versions that rendered,
 * and every mismatch listed.
 */
export function k4Summary(rows) {
  const rendered = rows.filter((r) => (r.k4?.pairs ?? []).length);
  const pairs = rendered.flatMap((r) => r.k4.pairs.map((p) => ({ repo: r.repo, commit: r.commit, ...p })));
  if (!pairs.length) return null;
  const exact = pairs.filter((p) => p.verdict === "EXACT").length;
  return {
    ...fraction(exact, pairs.length),
    expectedAtLeast: K4_EXPECTED,
    expectationMet: exact / pairs.length >= K4_EXPECTED,
    codexVersions: [...new Set(rendered.map((r) => r.codexVersion ?? null))],
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

const usable = (rows) => rows.filter((r) => r.status === "measured" && !(r.faults ?? []).length);

/**
 * Throws (from lib/draws.mjs) on rows that would pool two draws of a frame,
 * two samples, builds, agent versions or platforms, on a unit given twice, and
 * on a study draw with fewer rows than the n drawn; and on frames in use that
 * differ in build, Codex version, platform or label, which K4's one figure
 * over both frames would pool.
 */
export function analyze({ rowSets, k3Manifest, label = "study" }) {
  const sets = splitDraws(
    rowSets.flatMap((s) => s.rows),
    { label },
  );
  const inUse = sets.filter((s) => !s.supersededBy);
  const frames = {};
  const outcomes = [];
  const summaries = [];
  for (const { name: frame, frame: sampled, draw, n, complete, rows, replaces, supersededBy } of sets) {
    const measured = usable(rows);
    const faulted = rows.filter((r) => r.status === "measured" && (r.faults ?? []).length);
    const excluded = rows.filter((r) => r.status === "excluded");
    const reasons = {};
    for (const r of excluded) reasons[r.exclusion] = (reasons[r.exclusion] ?? 0) + 1;
    // Over the n units drawn, not the rows given: a study draw is complete (lib/draws.mjs refuses one that is not).
    const share = lostShare(rows, n);
    // Repositories this sample shares with the other samples in use (S-imp against a redrawn S-main): counted, not excluded.
    const repos = new Set(rows.map((r) => r.repo));
    const sharedRepos = supersededBy
      ? undefined
      : Object.fromEntries(
          inUse
            .filter((o) => o.name !== frame)
            .map((o) => [o.name, new Set(o.rows.map((r) => r.repo).filter((r) => repos.has(r))).size]),
        );
    frames[frame] = {
      frame: sampled,
      draw,
      ...(replaces ? { replaces } : {}),
      ...(supersededBy ? { supersededBy } : {}),
      drawn: n,
      rowsGiven: rows.length,
      complete,
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
      // Only a complete first draw can be redrawn, and only once.
      redrawRequired: draw === 1 && complete && share > REDRAW_OVER,
      claudeVersions: [...new Set(measured.map((r) => r.claudeVersion))],
      mapVersions: [...new Set(measured.map((r) => r.mapVersion))],
      codexVersions: [...new Set(rows.map((r) => r.codexVersion ?? null))],
      dists: [...new Set(rows.map((r) => r.dist ?? null))],
      platforms: [...new Set(rows.map((r) => r.platform ?? null))],
      labels: [...new Set(rows.map((r) => r.label ?? label))],
      ...(sharedRepos ? { sharedRepos } : {}),
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
  // The checks read the usable rows in use: a redrawn sample's first draw is left out of K3 and K4, as of every
  // verdict, and so is a row with a fault (K4's own render faults are on the row's k4 pairs, not row faults).
  // K4 is the one figure taken over both frames (a repository drawn into both samples is rendered, and counted,
  // once in each); each frame's own k/n is reported beside it (`byFrame`) and decides nothing. Since it pools the
  // frames in use, they must share one build, Codex version, platform and label (lib/draws.mjs holds each frame
  // to one of each); frames that differ are analysed apart.
  for (const key of ["dist", "codexVersion", "platform", "label"]) {
    const of = (r) => r[key] ?? (key === "label" ? label : null);
    const values = [...new Set(inUse.flatMap((s) => s.rows.map((r) => JSON.stringify(of(r)))))];
    if (values.length > 1)
      throw new Error(
        `the frames in use differ in ${key} (${values.join(", ")}): K4 is one figure over both frames, so frames of two of them are analysed apart`,
      );
  }
  const checks = { K4: k4Summary(inUse.flatMap((s) => usable(s.rows))) };
  if (checks.K4)
    checks.K4.byFrame = Object.fromEntries(
      inUse.flatMap((s) => {
        const own = k4Summary(usable(s.rows));
        return own ? [[s.name, { k: own.k, n: own.n, p: own.p, lo: own.lo, hi: own.hi, faults: own.faults }]] : [];
      }),
    );
  const sMain = inUse.find((s) => s.name === "S-main");
  if (k3Manifest && sMain) checks.K3 = k3Check(usable(sMain.rows), k3Manifest);
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
      codexCensus:
        "as predicted by map and checked byte-for-byte against Codex's own `debug prompt-input` renderer (K4: k/n)",
      claude:
        "predicted by ctxreach map for Claude Code <version> on a fresh machine with default settings, not a live run; checked live in K5 as k/n",
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
  let results;
  try {
    results = analyze({ rowSets, k3Manifest, label: opt("--label") ?? "study" });
  } catch (err) {
    console.error(`refusing: ${err.message} (study/PREREG.md, sections 1 and 4)`);
    return 2;
  }
  writeFileSync(out, JSON.stringify(results, null, 2) + "\n");
  for (const h of results.hypotheses)
    console.log(
      `${h.id} ${h.frame} ${h.outcome}: ${h.estimate ? `${h.estimate.k}/${h.estimate.n} [${h.estimate.lo}, ${h.estimate.hi}]` : "no data"} -> ${h.verdict}`,
    );
  for (const [f, s] of Object.entries(results.frames))
    console.log(
      `${f}: draw ${s.draw}${s.supersededBy ? ` (superseded by the redraw, ${s.supersededBy})` : ""}${s.complete ? "" : ` (incomplete: rows for ${s.rowsGiven} of ${s.drawn})`}, ${s.measured} measured, ${s.excluded} excluded ${JSON.stringify(s.exclusions)}, ${s.withFaults} with faults, type-2 capped ${s.type2Capped.k}/${s.type2Capped.n}${s.redrawRequired ? " -- over 10% lost: the pre-registered redraw applies" : ""}`,
    );
  if (results.checks.K4)
    console.log(
      `K4: ${results.checks.K4.k}/${results.checks.K4.n} pairs byte-exact over both frames (expected at least ${K4_EXPECTED * 100}%: ${results.checks.K4.expectationMet ? "met" : "not met"}; a validity estimate, not a pass threshold); per frame ${Object.entries(
        results.checks.K4.byFrame,
      )
        .map(([f, s]) => `${f} ${s.k}/${s.n}`)
        .join(", ")}`,
    );
  if (results.checks.K3) console.log(`K3: ${results.checks.K3.pass ? "pass" : "FAIL"} (${results.checks.K3.explain})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
