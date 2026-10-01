// Check K2: switch off each outcome detector and pipeline step in turn
// (study/census/lib/plants.mjs) and show that check K1 then fails. A plant
// counts as caught only when K1 loses at least one fixture it passed without
// the plant, and the plant actually acted (its hit count is above 0);
// otherwise it is reported as not caught or not exercised.
//
// The script checks its own instrument first: K1 without a plant must give
// the same per-fixture result with map in process (the census's runner) as
// with the spawned CLI (so the faster runner, used for the census and the
// plants, measures the same thing), and the unplanted result is the baseline each plant is compared
// with. Fixtures listed as known defects in known-answers.json fail in the
// baseline too; a plant must break a fixture that passed.
//
// Usage: node study/census/plant-census-faults.mjs [--cli dist/cli.js] [plant ...]
// Exit: 0 all caught; 1 some not caught; 2 instrument failure.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { runKnownAnswers, ROOT } from "./known-answer.mjs";
import { inProcessMapRunnerFromDist, spawnMapRunner } from "./lib/maprun.mjs";
import { noPlants, PLANTS, withPlant } from "./lib/plants.mjs";

/**
 * Run every plant against `mapRunner`. `baseline` is K1 without a plant.
 * Returns { baseline, rows: [{ plant, hits, broke: [fixtures], verdict }] }.
 */
export async function runPlants({ mapRunner, plants = PLANTS, log = () => undefined, roots, answersFile, only }) {
  const baseline = await runKnownAnswers({ mapRunner, plants: noPlants(), roots, answersFile, only });
  const passed = new Set(baseline.results.filter((r) => r.pass).map((r) => r.name));
  const rows = [];
  for (const id of plants) {
    const p = withPlant(id);
    const res = await runKnownAnswers({ mapRunner, plants: p, roots, answersFile, only });
    const hits = p.hits.get(id) ?? 0;
    const broke = res.results.filter((r) => !r.pass && passed.has(r.name)).map((r) => r.name);
    let verdict;
    if (hits === 0) verdict = "NOT EXERCISED";
    else if (broke.length === 0) verdict = "NOT CAUGHT";
    else verdict = "caught";
    rows.push({ plant: id, hits, broke, verdict, k: res.k, n: res.n });
    log(
      `${id.padEnd(30)} hits ${String(hits).padStart(4)}  K1 ${res.k}/${res.n}  ${verdict}${broke.length ? ` (${broke.slice(0, 3).join(", ")}${broke.length > 3 ? ", ..." : ""})` : ""}`,
    );
  }
  return { baseline, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--cli");
  const cli = path.resolve(i >= 0 ? args[i + 1] : path.join(ROOT, "dist", "cli.js"));
  const requested = args.filter((a, j) => !a.startsWith("--") && args[j - 1] !== "--cli");
  const unknown = requested.filter((r) => !PLANTS.includes(r));
  if (unknown.length) {
    console.error(`unknown plant: ${unknown.join(", ")} (known: ${PLANTS.join(", ")})`);
    process.exit(2);
  }
  const library = await inProcessMapRunnerFromDist(path.dirname(cli));

  // Instrument check: map in process (the census's runner) must reproduce the spawned CLI's K1 row for row.
  const viaCli = await runKnownAnswers({ mapRunner: spawnMapRunner(cli) });
  const viaLib = await runKnownAnswers({ mapRunner: library });
  const strip = (r) =>
    JSON.stringify({ name: r.name, pass: r.pass, diffs: r.diffs, outcomes: r.row?.outcomes, pairs: r.row?.pairs });
  const differ = viaCli.results.filter((r, j) => strip(r) !== strip(viaLib.results[j] ?? {}));
  if (viaCli.n === 0 || differ.length) {
    console.error(
      `INSTRUMENT: map in process and the spawned CLI disagree on ${differ.length} of ${viaCli.n} fixtures: ${differ.map((r) => r.name).join(", ")}`,
    );
    process.exit(2);
  }
  console.log(
    `baseline: K1 ${viaCli.k}/${viaCli.n} with the spawned CLI, identical with map in process (${viaLib.k}/${viaLib.n})`,
  );
  for (const r of viaCli.results.filter((x) => !x.pass))
    console.log(`  baseline failure${r.knownDefect ? " (known defect)" : ""}: ${r.name}: ${r.diffs.join("; ")}`);

  const { rows } = await runPlants({
    mapRunner: library,
    plants: requested.length ? requested : PLANTS,
    log: (l) => console.log(l),
  });
  const caught = rows.filter((r) => r.verdict === "caught").length;
  console.log(`\nK2: ${caught}/${rows.length} planted faults caught by K1`);
  console.log(`non-GET attempts: ${viaCli.nonGet + viaLib.nonGet}`);
  process.exitCode = rows.some((r) => r.verdict === "NOT EXERCISED") ? 2 : caught === rows.length ? 0 : 1;
}
