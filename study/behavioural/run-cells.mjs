// Run the pre-registered lab cells (study/behavioural/cells.json) and decide
// each by its rule.
//
// Every trial is one instrument invocation with --trials 1, in a fresh
// layout: a staging copy of the fixture carrying the harness's tokens, the
// arm's ancestor or home files, a positive control rule and a decoy at the
// launch directory, and TEMP/TMP pointed where the arm wants the
// instrument's copy to live. Trials are appended to trials.jsonl as they
// finish (the run can be resumed), and cells-results.json holds k/n with
// Wilson intervals and the verdicts.
//
// --dry-run replaces the instrument with study/behavioural/fake/fake-instrument.mjs
// and the scratch home with a folder inside --out: no agent runs and nothing
// outside --out is written or listed. --live runs `node <ctxreach> verify|probe`
// with the pinned --claude-bin and --model; it refuses unless the scratch home
// was made by setup-b2-home.mjs (for B2), no instruction file sits above any
// folder a copy will live in, and HOME is never the real home.
//
// Usage:
//   node study/behavioural/run-cells.mjs --dry-run --out <dir> [--cells B1,B2]
//   node study/behavioural/run-cells.mjs --live --out <dir> --ctxreach dist/cli.js --claude-bin <pinned claude> --model <id> [--cells ...]

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideCell,
  instructionFilesAbove,
  instrumentArgs,
  layoutTrial,
  loadCells,
  readObservation,
  scoreTrial,
  summariseCell,
} from "./lib.mjs";
import { MARKER } from "./setup-b2-home.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake", "fake-instrument.mjs");

function readTrials(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Run the requested cells. Returns { code, results, realRuns, billedRuns }.
 * @param {object} o
 */
export function runCells(o) {
  const log = o.log ?? ((l) => console.log(l));
  const cells = loadCells(o.cellsFile ?? path.join(HERE, "cells.json"));
  const out = path.resolve(o.out);
  mkdirSync(out, { recursive: true });
  const wanted = o.cells?.length ? cells.cells.filter((c) => o.cells.includes(c.id)) : cells.cells;
  const dry = !o.live;
  if (!dry && (!o.ctxreach || !o.claudeBin || !o.model)) {
    log("refusing: --live needs --ctxreach, --claude-bin and --model");
    return { code: 2 };
  }
  const realHome = os.homedir();
  const vars = {
    home: dry ? path.join(out, "fake-home") : path.resolve(o.home ?? cells.scratchHome.live),
    outside: dry ? path.join(out, "fake-outside") : path.resolve(o.outside ?? cells.scratchHome.outside),
    model: o.model ?? "fake-model",
    claudeBin: o.claudeBin ?? "fake",
  };
  if (path.resolve(vars.home).toLowerCase() === path.resolve(realHome).toLowerCase()) {
    log("refusing: the scratch home is the real home directory");
    return { code: 2 };
  }
  if (!dry && wanted.some((c) => c.homeArms) && !existsSync(path.join(vars.home, MARKER))) {
    log(`refusing: ${vars.home} was not made by study/behavioural/setup-b2-home.mjs`);
    return { code: 2 };
  }
  mkdirSync(vars.home, { recursive: true });
  mkdirSync(vars.outside, { recursive: true });

  const trialsFile = path.join(out, "trials.jsonl");
  const done = readTrials(trialsFile);
  let realRuns = 0;
  let billedRuns = 0;
  const results = [];
  for (const cell of wanted) {
    const spec = cells.instruments[cell.instrument];
    const plan = [];
    if (cell.warmup) plan.push({ arm: cell.arms.find((a) => a.id === cell.warmup.arm), n: 1, warmup: true });
    for (const arm of cell.arms) plan.push({ arm, n: arm.trials, warmup: false });
    for (const { arm, n, warmup } of plan) {
      for (let i = 1; i <= n; i++) {
        const key = `${cell.id}/${arm.id}/${warmup ? "warmup" : i}`;
        if (done.some((t) => t.key === key)) continue;
        const trialDir = path.join(out, "work", cell.id, arm.id, warmup ? "warmup" : `trial-${i}`);
        rmSync(trialDir, { recursive: true, force: true });
        // A leftover home file (an interrupted run) would silently turn A0 into A1.
        const homeFile = path.join(vars.home, ".claude", "CLAUDE.md");
        if (cell.homeArms && existsSync(homeFile)) {
          log(`removing a leftover ${homeFile} before ${key}`);
          rmSync(homeFile, { force: true });
        }
        const trial = layoutTrial({ cells, cell, arm, trialDir, fixturesDir: path.join(HERE, "fixtures"), vars });
        if (!dry) {
          // Only the files this arm planted may sit above the copy or the staging repository.
          const norm = (p) => path.resolve(p).toLowerCase();
          const planted = new Set(trial.files.flatMap((f) => [norm(f), norm(path.dirname(f))]));
          const above = [...instructionFilesAbove(trial.tmp), ...instructionFilesAbove(path.dirname(trial.repo))];
          const unplanned = [...new Set(above.map(norm))].filter((f) => !planted.has(f));
          if (unplanned.length) {
            log(`refusing: instruction files the cell did not plant sit above the copy: ${unplanned.join(", ")}`);
            return { code: 2 };
          }
        }
        const args = instrumentArgs({ cells, cell, arm, trial, vars });
        const env = { ...process.env, ...trial.env, ...cells.pinned.env };
        if (!dry) delete env.CLAUDE_CONFIG_DIR;
        const [cmd, argv] = dry
          ? [process.execPath, [FAKE, ...args]]
          : [process.execPath, [path.resolve(o.ctxreach), ...args]];
        if (dry) env.FAKE_INSTRUMENT_CEILING = out;
        const started = Date.now();
        const r = spawnSync(cmd, argv, { env, encoding: "utf8", timeout: 10 * 60 * 1000, windowsHide: true });
        if (!dry) {
          realRuns++;
          if (spec.billed) billedRuns++;
        }
        const obs = readObservation(cell.instrument, trial.save);
        const score = scoreTrial({ cell, trial, obs, pin: dry ? undefined : o.model });
        const row = {
          key,
          cell: cell.id,
          arm: arm.id,
          trial: warmup ? 0 : i,
          warmup,
          instrument: cell.instrument,
          dryRun: dry,
          exitCode: r.status,
          durationMs: Date.now() - started,
          init: obs.init ?? null,
          os: `${process.platform} ${os.release()}`,
          date: new Date().toISOString(),
          ...score,
          tokensOf: Object.fromEntries(Object.entries(trial.tokens).map(([k, v]) => [k, v])),
          control: trial.control,
          decoy: trial.decoy,
        };
        appendFileSync(trialsFile, JSON.stringify(row) + "\n");
        done.push(row);
        log(
          `${key} ${score.status}${score.reasons.length ? ` (${score.reasons.join("; ")})` : ""} seen ${JSON.stringify(score.seen)}`,
        );
        // Files planted outside the trial folder (the home file, ancestors under the scratch home) go now,
        // so no arm inherits another arm's layout.
        for (const f of trial.files)
          if (!f.toLowerCase().startsWith(trialDir.toLowerCase())) rmSync(f, { force: true });
        if (!o.keep) rmSync(trialDir, { recursive: true, force: true });
      }
    }
    const trials = done.filter((t) => t.cell === cell.id);
    const arms = summariseCell(cell, trials);
    const warm = trials.find((t) => t.warmup);
    // P0-a: the warm-up must show the home file's token on the wire, or B2 is not run as registered.
    const precondition = cell.warmup ? (warm ? warm.seen[cell.warmup.mustSee] === true : undefined) : undefined;
    const verdict = decideCell(cell, arms, { precondition });
    results.push({
      cell: cell.id,
      title: cell.title,
      instrument: cell.instrument,
      wording: spec.wording,
      arms,
      precondition: precondition ?? null,
      verdict,
    });
    log(
      `${cell.id}: ${verdict} ${Object.entries(arms)
        .map(
          ([a, s]) =>
            `${a} ${Object.entries(s.observe)
              .map(([k, v]) => `${k} ${v.k}/${v.n}`)
              .join(" ")}`,
        )
        .join("; ")}`,
    );
  }
  const doc = {
    schema: "ctxreach.study-cell-results/v1",
    dryRun: dry,
    generatedAt: new Date().toISOString(),
    realAgentRuns: realRuns,
    billedRuns,
    results,
  };
  writeFileSync(path.join(out, "cells-results.json"), JSON.stringify(doc, null, 2) + "\n");
  log(`real agent runs: ${realRuns} (billed ${billedRuns})${dry ? "; dry run against the fake instrument" : ""}`);
  return { code: 0, results, realRuns, billedRuns };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!opt("--out") || args.includes("--dry-run") === args.includes("--live")) {
    console.error(
      "usage: node study/behavioural/run-cells.mjs (--dry-run | --live --ctxreach dist/cli.js --claude-bin <path> --model <id>) --out <dir> [--cells B1,B2]",
    );
    process.exit(2);
  }
  const res = runCells({
    out: opt("--out"),
    live: args.includes("--live"),
    cells: opt("--cells")?.split(","),
    ctxreach: opt("--ctxreach"),
    claudeBin: opt("--claude-bin"),
    model: opt("--model"),
    home: opt("--home"),
    outside: opt("--outside"),
  });
  process.exitCode = res.code;
}
