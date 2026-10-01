// Check K5's figure (study/PREREG.md section 8): `map` against Claude Code,
// live and at $0. k5-select.mjs draws 25 repositories (K5-01 to K5-25); each
// is run once through `ctxreach verify --agent claude --trials 2 --json` on a
// copy holding only its instruction files, and that JSON is saved as
// <verify>/<id>.json. This script sums agreement over decided cells, as
// ctxreach verify scores them, over the runs an instrument fault did not
// void, and writes k5-results.json: k/n with its Wilson 95% interval, the
// same per stratum, every disagreement (by id and launch directory, never by
// repository name) and every void run. It refuses a missing run, an output
// for an id that was not drawn, another agent or instrument, another Claude
// Code version than the registered one and another number of trials, so no
// run is dropped, swapped or added after the fact.
//
// Usage: node study/census/k5-score.mjs --selection k5.tsv --verify <dir> --out k5-results.json

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { K5_STRATA } from "./k5-select.mjs";
import { loadRegistry } from "./lib/registry.mjs";
import { formatFraction, wilson } from "./lib/stats.mjs";

/** Capture trials in each repository's one `ctxreach verify` run. */
export const K5_TRIALS = 2;
export const K5_SCHEMA = "ctxreach.k5-results/v1";

/** Verdicts that are evidence either way, and those that agree, as ctxreach verify counts them. */
const DECIDED = ["confirmed", "discovered", "missed", "extra"];
const AGREEING = ["confirmed", "discovered"];

/** k5-select.mjs's TSV: id, stratum, repo, commit, launch directory. */
export function readSelection(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [id, stratum, repo, commit, launchDir] = l.split("\t");
      return { id, stratum, repo, commit, launchDir };
    });
}

const round = (x) => (x === undefined ? null : Math.round(x * 1e6) / 1e6);

function fraction(k, n) {
  const w = wilson(k, n);
  return { k, n, p: round(w.p), lo: round(w.lo), hi: round(w.hi), printed: formatFraction(w) };
}

/** Why these runs cannot be scored as K5 (a list of problems, empty when fine). */
export function k5Problems(selection, runs, { claudeVersion, trials = K5_TRIALS }) {
  const problems = [];
  const ids = selection.map((p) => p.id);
  if (new Set(ids).size !== ids.length) problems.push("the selection gives an id twice");
  for (const p of selection) {
    const v = runs[p.id];
    if (v === undefined) {
      problems.push(`${p.id}: no ctxreach verify output (every drawn repository is run; none is skipped)`);
      continue;
    }
    if (v?.schema !== "ctxreach.verify/v1") {
      problems.push(`${p.id}: not a ctxreach verify --json output`);
      continue;
    }
    if (v.agent !== "claude" || v.instrument !== "capture")
      problems.push(`${p.id}: ${v.agent} by ${v.instrument}, not Claude Code by capture`);
    if (v.cliVersion !== claudeVersion)
      problems.push(`${p.id}: Claude Code ${v.cliVersion}, not the registered ${claudeVersion}`);
    if ((v.trials ?? []).length !== trials) problems.push(`${p.id}: ${(v.trials ?? []).length} trials, not ${trials}`);
    if (v.agreement) {
      const real = (v.cells ?? []).filter((c) => !c.decoy);
      const agree = real.filter((c) => AGREEING.includes(c.verdict)).length;
      const decided = real.filter((c) => DECIDED.includes(c.verdict)).length;
      if (agree !== v.agreement.agree || decided !== v.agreement.decided)
        problems.push(
          `${p.id}: its cells give ${agree}/${decided}, its agreement ${v.agreement.agree}/${v.agreement.decided}`,
        );
    }
  }
  const extra = Object.keys(runs).filter((id) => !ids.includes(id));
  if (extra.length) problems.push(`outputs for ids that were not drawn: ${extra.sort().join(", ")}`);
  return problems;
}

/**
 * K5 from the selection and one verify output per id (`runs`: id -> parsed
 * JSON). A run whose `agreement` is null was voided by an instrument fault:
 * it is listed and counted apart, never in n. Throws on k5Problems.
 */
export function scoreK5(selection, runs, { claudeVersion, trials = K5_TRIALS, selectionSha256 } = {}) {
  const problems = k5Problems(selection, runs, { claudeVersion, trials });
  if (problems.length) throw new Error(problems.join("; "));
  const voided = [];
  const disagreements = [];
  const sum = new Map([["all", { k: 0, n: 0 }], ...K5_STRATA.map((s) => [s.name, { k: 0, n: 0 }])]);
  for (const p of selection) {
    const v = runs[p.id];
    if (!v.agreement) {
      voided.push({ id: p.id, stratum: p.stratum, reasons: v.instrument_checks?.reasons ?? [] });
      continue;
    }
    for (const key of ["all", p.stratum]) {
      if (!sum.has(key)) sum.set(key, { k: 0, n: 0 });
      sum.get(key).k += v.agreement.agree;
      sum.get(key).n += v.agreement.decided;
    }
    for (const c of v.cells.filter((c) => !c.decoy && DECIDED.includes(c.verdict) && !AGREEING.includes(c.verdict)))
      disagreements.push({
        id: p.id,
        stratum: p.stratum,
        launchDir: p.launchDir,
        file: c.file,
        verdict: c.verdict,
        predicted: c.predicted.delivery,
        rule: c.predicted.rule,
        seen: c.fraction,
      });
  }
  const { k, n } = sum.get("all");
  return {
    schema: K5_SCHEMA,
    generatedAt: new Date().toISOString(),
    claudeVersion,
    trials,
    ...(selectionSha256 ? { selectionSha256 } : {}),
    repositories: selection.length,
    runsScored: selection.length - voided.length,
    agreement: fraction(k, n),
    byStratum: Object.fromEntries(
      [...sum].filter(([key]) => key !== "all").map(([key, s]) => [key, fraction(s.k, s.n)]),
    ),
    voided,
    disagreements,
    unit: "decided cell (file x token position) of a ctxreach verify run, as it scores them",
  };
}

function main(args) {
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const selectionFile = opt("--selection");
  const dir = opt("--verify");
  const out = opt("--out");
  if (!selectionFile || !dir || !out) {
    console.error("usage: node study/census/k5-score.mjs --selection k5.tsv --verify <dir> --out k5-results.json");
    return 2;
  }
  const text = readFileSync(selectionFile, "utf8");
  const selection = readSelection(text);
  const runs = {};
  for (const p of selection) {
    const f = path.join(dir, `${p.id}.json`);
    if (!existsSync(f)) continue;
    try {
      runs[p.id] = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      runs[p.id] = { schema: "unparseable" };
    }
  }
  let result;
  try {
    result = scoreK5(selection, runs, {
      claudeVersion: loadRegistry().claudeVersion,
      selectionSha256: createHash("sha256").update(text).digest("hex"),
    });
  } catch (err) {
    console.error(`refusing: ${err.message} (study/PREREG.md section 8, K5)`);
    return 2;
  }
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(
    `K5: ${result.agreement.printed} decided cells agree, over ${result.runsScored} of ${result.repositories} runs (${result.voided.length} void); ${result.disagreements.length} to adjudicate`,
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
