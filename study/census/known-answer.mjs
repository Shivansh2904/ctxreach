// Check K1: every fixture, with an answer derived by hand, goes through the
// census pipeline (GET-only client, reconstruction, `map --json`, detectors)
// with only the network replaced by local files. Pass rule: n/n, and every
// fixture has an answer.
//
// Fixtures: test/fixtures/* (the tool's own traps and twins) and
// study/census/known-answer-fixtures/* (census-only cases). Answers:
// study/census/known-answers.json.
//
// Usage: node study/census/known-answer.mjs [--cli dist/cli.js] [--spawn] [--only a,b] [--plant <id>] [--json]
// map runs in this process from the build beside --cli, as in the census; --spawn runs the CLI once per
// launch directory instead (K2 compares the two over every fixture).
// Exit: 0 when n/n; 1 when any fixture fails or lacks an answer; 3 when the client saw a non-GET attempt.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetOnlyClient } from "./lib/client.mjs";
import { fixtureCommit, fixtureDirs, localFetch, localRepo } from "./lib/local-source.mjs";
import { inProcessMapRunnerFromDist, spawnMapRunner } from "./lib/maprun.mjs";
import { noPlants, withPlant } from "./lib/plants.mjs";
import { freshHomes, runUnit } from "./pipeline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, "..", "..");
export const FIXTURE_ROOTS = [path.join(ROOT, "test", "fixtures"), path.join(HERE, "known-answer-fixtures")];
export const DETECTOR_KEYS = [
  "o1content",
  "o1contentShingle",
  "o1file",
  "o2",
  "p1",
  "o4",
  "o5",
  "o6",
  "o7",
  "o8",
  "k3",
];

export function loadAnswers(file = path.join(HERE, "known-answers.json")) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Every fixture directory, as { name, repoDir }. */
export function allFixtures(roots = FIXTURE_ROOTS) {
  const out = [];
  for (const root of roots)
    for (const name of fixtureDirs(root)) out.push({ name, repoDir: path.join(root, name, "repo") });
  return out;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Differences between an expected (partial) value and the actual one: each expected key must match. */
export function compare(expected, actual, where = "") {
  if (Array.isArray(expected)) {
    const a = Array.isArray(actual) ? [...actual].sort() : actual;
    return deepEqual([...expected].sort(), a)
      ? []
      : [`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object")
      return [`${where}: expected an object, got ${JSON.stringify(actual)}`];
    return Object.entries(expected).flatMap(([k, v]) => compare(v, actual[k], where ? `${where}.${k}` : k));
  }
  return expected === actual ? [] : [`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

/** Compare one measured row with its answer. */
export function checkRow(answer, row) {
  const diffs = [];
  const missing = DETECTOR_KEYS.filter((k) => !(k in answer));
  if (missing.length) diffs.push(`answer lacks ${missing.join(", ")}`);
  if (row.status !== "measured") return [...diffs, `status: ${row.status} (${row.exclusion ?? ""})`];
  if (row.faults.length) diffs.push(`faults: ${row.faults.join("; ")}`);
  diffs.push(...compare(answer.launch, { t2: row.launch.t2, t3: row.launch.t3 }, "launch"));
  for (const k of DETECTOR_KEYS) if (k in answer) diffs.push(...compare(answer[k], row.outcomes[k], k));
  return diffs;
}

/**
 * K1's verdict and its one-line summary. K1 passes only at n/n with every
 * answer matched to a fixture. A fixture listed in `knownDefects` still
 * fails: the line names it as a known map defect awaiting its fix (the
 * entry's `awaiting`), apart from any unexplained failure, and never as a pass.
 */
export function k1Verdict(res, answers = loadAnswers()) {
  const failed = res.results.filter((r) => !r.pass).map((r) => r.name);
  const known = failed.filter((n) => answers.knownDefects?.[n]);
  const unexplained = failed.filter((n) => !answers.knownDefects?.[n]);
  const pass = res.k === res.n && failed.length === 0 && (res.orphans ?? []).length === 0;
  const head = `K1: ${res.k}/${res.n} fixtures match their known answers`;
  if (pass) return { pass, line: `${head}; pass` };
  const why = [];
  if (known.length) {
    const fixes = [...new Set(known.map((n) => answers.knownDefects[n].awaiting ?? "a fix"))];
    why.push(
      `${known.length} known map defect${known.length === 1 ? "" : "s"} awaiting ${fixes.join(" and ")}: ${known.join(", ")}`,
    );
  }
  if (unexplained.length) why.push(`${unexplained.length} unexplained: ${unexplained.join(", ")}`);
  if ((res.orphans ?? []).length) why.push(`${res.orphans.length} answer(s) without a fixture`);
  return { pass, line: `${head}; FAIL, ${why.join("; ")}` };
}

/**
 * Run K1. `mapRunner` defaults to spawning the built CLI; tests pass one that
 * runs the CLI in-process.
 */
export async function runKnownAnswers({
  mapRunner,
  plants = noPlants(),
  only,
  answersFile,
  roots,
  log = () => undefined,
} = {}) {
  const answers = loadAnswers(answersFile);
  const fixtures = allFixtures(roots).filter((f) => !only || only.includes(f.name));
  const seen = [];
  // The local repositories stand in for both transports: gh api (api.github.com) and fetch (raw files).
  const local = localFetch(
    fixtures.map((f) => localRepo(f.name, f.repoDir)),
    { seen },
  );
  const client = new GetOnlyClient({
    fetchImpl: local,
    ghApi: local,
    minIntervalMs: 0,
    sleep: async () => undefined,
  });
  const work = mkdtempSync(path.join(os.tmpdir(), "ctxr-k1-"));
  const results = [];
  try {
    const homes = freshHomes(work);
    for (const f of fixtures) {
      const answer = answers.fixtures[f.name];
      if (!answer) {
        results.push({ name: f.name, pass: false, diffs: ["no answer in known-answers.json"], unanswered: true });
        continue;
      }
      const row = await runUnit({
        client,
        unit: { id: f.name, repo: `fixture/${f.name}`, commit: fixtureCommit(f.name) },
        workDir: work,
        mapRunner,
        homes,
        claudeVersion: answers.claudeVersion,
        seed: "00000000",
        plants,
      });
      const diffs = checkRow(answer, row);
      const defect = answers.knownDefects?.[f.name];
      results.push({ name: f.name, pass: diffs.length === 0, diffs, ...(defect ? { knownDefect: defect } : {}), row });
      log(`${diffs.length ? "FAIL" : "pass"}  ${f.name}${diffs.length ? `\n      ${diffs.join("\n      ")}` : ""}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const names = new Set(fixtures.map((f) => f.name));
  const orphans = only ? [] : Object.keys(answers.fixtures).filter((n) => !names.has(n));
  return {
    k: results.filter((r) => r.pass).length,
    n: results.length,
    results,
    orphans,
    nonGet: client.nonGetAttempts + seen.filter((s) => s.method !== "GET").length,
    client: client.summary(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const cli = path.resolve(opt("--cli") ?? path.join(ROOT, "dist", "cli.js"));
  const plant = opt("--plant");
  const res = await runKnownAnswers({
    mapRunner: args.includes("--spawn") ? spawnMapRunner(cli) : await inProcessMapRunnerFromDist(path.dirname(cli)),
    plants: plant ? withPlant(plant) : noPlants(),
    only: opt("--only")?.split(","),
    log: args.includes("--json") ? undefined : (l) => console.log(l),
  });
  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        { k: res.k, n: res.n, results: res.results.map(({ row: _row, ...r }) => r), orphans: res.orphans },
        null,
        2,
      ),
    );
  }
  for (const o of res.orphans) console.log(`answer without a fixture: ${o}`);
  const verdict = k1Verdict(res);
  console.log(`${verdict.line}${plant ? ` (plant ${plant})` : ""}`);
  console.log(res.client);
  process.exitCode = res.nonGet ? 3 : verdict.pass ? 0 : 1;
}
