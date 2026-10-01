// Run the census over a drawn sample: for each unit, reconstruct, measure
// (and render with Codex for K4 when --codex-bin is given), append one JSON
// row, delete the reconstruction. Serial, resumable (units already in the
// output are skipped), and it prints the GET-only client's counts at the end.
//
// Preconditions, each a refusal: no instruction file in any directory above
// the work directory (Claude Code walks to the filesystem root, so every
// reconstruction would inherit it); empty homes; at least --min-free-gb free
// on the work volume; with --expect-dist, the built dist/ must be that build
// (a study run must give it, as the tagged PREREG.md stamps it).
//
// Usage:
//   node study/census/run-census.mjs --sample S-main.tsv --frame-name S-main --seed-from-tag prereg-v1 \
//     --out rows-S-main.jsonl --work C:\ctxr-census [--label study|pilot] [--cli dist/cli.js] \
//     [--codex-bin <path to codex.js>] [--claude-version 2.1.285] [--limit N] [--min-interval-ms 250] \
//     [--min-free-gb 2] [--expect-dist <digest>]
// A study run takes its seed from the prereg tag (--seed-from-tag prereg-v1): the
// same seed draws a repository's type-2 and type-3 directories when it has more
// than the caps. A typed --seed <hex8> is for --label pilot only. A study run
// also needs a study sample whose stream is --frame-name and whose draw (1, or
// the redraw 2) was drawn with the tag's seed (+ 1 for the redraw), and Codex
// for K4 (--codex-bin) at the registered version, --expect-dist with the
// stamped build and --claude-version at the registered version; it reads the
// registration from the tagged PREREG.md and refuses while the working copy
// differs from it above the Deviations heading. Every row records its draw,
// its sample's SHA-256 and n, the build's digest, the Codex version and the
// platform, so analyze.mjs can refuse rows that would pool them, or a draw
// with fewer rows than its n; a rows file holds one sample's rows only (a
// redraw goes to its own file).
// Exit: 0 done; 1 some units had instrument faults; 2 a precondition failed; 3 a non-GET attempt was counted.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexVersion, codexVersionProblem } from "./codex-check.mjs";
import { distDigest } from "./dist-digest.mjs";
import { GetOnlyClient, installFetchGuard } from "./lib/client.mjs";
import { crossCheckedRunner, inProcessMapRunnerFromDist, spawnMapRunner } from "./lib/maprun.mjs";
import { sha256 } from "./lib/paths.mjs";
import { checkSeed, offsetSeed } from "./lib/prng.mjs";
import { appendOnlyProblems, loadRegistry, PREREG_FILE, readRegistry, readStamps } from "./lib/registry.mjs";
import { ancestorInstructionFiles, freeBytes, freshHomes, runUnit } from "./pipeline.mjs";
import { readSample, sampleHeader } from "./sample.mjs";
import { seedFromTag } from "./seed.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The Claude Code version map models for the census (a fresh machine on the pinned release). */
export const CLAUDE_VERSION = "2.1.285";
/**
 * Every Nth unit of the sample (by its position in the sample, so a resumed
 * run checks the same units), each launch directory is also run through the
 * spawned CLI and the answers compared (PREREG.md section 6).
 */
export const CLI_CHECK_EVERY = 25;

export function readRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Check that api.github.com answers through the client's gh transport:
 * `GET /rate_limit` (which costs no request of the limit). Returns the core
 * limit and what is left, or `{ problem }`.
 */
export async function ghPreflight(client) {
  try {
    const r = await client.getJson("https://api.github.com/rate_limit");
    const core = r.json?.resources?.core;
    if (r.status !== 200 || !core) return { problem: `gh api rate_limit answered HTTP ${r.status}` };
    return { limit: core.limit, remaining: core.remaining };
  } catch (err) {
    return { problem: `gh api could not be used (${err.message}); install the GitHub CLI and run gh auth login` };
  }
}

/**
 * Why a study run may not use this sample (study/PREREG.md section 4): it
 * must be a study sample of the stream the rows will be labelled with, draw 1
 * or its one redraw (draw 2), drawn with the tag's seed (+ 1 for the redraw).
 * Returns a list of problems (empty when fine).
 */
export function studySampleProblems(header, { frameName, seed }) {
  const problems = [];
  if (header.label !== "study") problems.push(`the sample is not a study sample (label=${header.label ?? "none"})`);
  if (header.stream !== frameName)
    problems.push(`--frame-name ${frameName} is not the sample's stream ${header.stream ?? "(none)"}`);
  const draw = Number(header.draw);
  if (draw !== 1 && draw !== 2)
    problems.push(`the sample's draw ${header.draw ?? "(none)"} is not draw 1 or its one redraw, draw 2`);
  else if (header.seed !== offsetSeed(seed, draw - 1))
    problems.push(
      `draw ${draw} is drawn with seed ${offsetSeed(seed, draw - 1)} (the tag's seed${draw === 2 ? " + 1" : ""}), but the sample says ${header.seed ?? "(none)"}`,
    );
  if (header.n === undefined) problems.push("the sample's header gives no n");
  return problems;
}

/**
 * Why a study run may not start under this registration (study/PREREG.md
 * sections 1 and 4): the working PREREG.md must be the tagged one with
 * deviations appended, --expect-dist must name the build the tag stamps, and
 * --claude-version must be the registered one. Returns { problems, registry }
 * with the tagged registry.
 */
export function studyRunProblems({ tagged, working, tag, expectDist, claudeVersion }) {
  if (typeof tagged !== "string") return { problems: [`${tag}: no study/PREREG.md to read the registration from`] };
  const problems = appendOnlyProblems(tagged, working, tag);
  const registry = readRegistry(tagged);
  const stamped = readStamps(tagged)["dist.digest"];
  if (!expectDist)
    problems.push(`a study run names the frozen build with --expect-dist (${tag} stamps ${stamped ?? "no digest"})`);
  else if (expectDist !== stamped)
    problems.push(`--expect-dist ${expectDist} is not the build ${tag} stamps (${stamped ?? "no digest"})`);
  if (claudeVersion !== registry.claudeVersion)
    problems.push(`--claude-version ${claudeVersion} is not the registered ${registry.claudeVersion}`);
  return { problems, registry };
}

/**
 * Run the census. `map` runs in this process from the built library
 * (dist/index.js, the chunk dist/cli.js calls), and every `cliCheckEvery`th
 * unit (default 25) each launch directory is also run through the spawned
 * CLI and the two answers compared; a difference is a fault on the row.
 * Tests pass local transports (`fetchImpl`, `ghApi`) and runners
 * (`mapRunner`, `referenceRunner`). Returns { code, manifest }.
 */
export async function runCensus(o) {
  const log = o.log ?? ((l) => console.log(l));
  const cli = path.resolve(o.cli ?? path.join(ROOT, "dist", "cli.js"));
  const claudeVersion = o.claudeVersion ?? CLAUDE_VERSION;
  const label = o.label ?? "study";
  // The seed: from the prereg tag for a study run (it also draws the capped
  // type-2 and type-3 directories); a typed seed for a pilot run only.
  if (label === "study" && !o.seedFromTag) {
    log("refusing: a study run takes its seed from the prereg tag (--seed-from-tag prereg-v1), not a typed --seed");
    return { code: 2 };
  }
  let seed = o.seed;
  let tagged;
  if (o.seedFromTag) {
    try {
      tagged = (o.seedResolver ?? seedFromTag)(o.seedFromTag);
      seed = tagged.seed;
    } catch (err) {
      log(`refusing: ${err.message}`);
      return { code: 2 };
    }
  }
  checkSeed(seed);

  // The sample: one draw of one stream. A study run takes only a study sample
  // of its own stream, drawn with the tag's seed (draw 1) or seed + 1 (draw 2).
  const sampleText = readFileSync(o.sample, "utf8");
  const sampleSha = sha256(Buffer.from(sampleText));
  const header = sampleHeader(sampleText);
  const draw = header.draw === undefined ? 1 : Number(header.draw);
  const units = readSample(sampleText).map((u) => ({ ...u, frame: o.frameName }));
  // The sample's n, stamped on every row: analyze.mjs takes a draw's lost share over it and refuses a study draw with fewer rows.
  const sampleN = header.n === undefined ? units.length : Number(header.n);
  const sampleProblems = label === "study" ? studySampleProblems(header, { frameName: o.frameName, seed }) : [];
  if (sampleN !== units.length)
    sampleProblems.push(`the sample's header says n=${header.n}, but it holds ${units.length} units`);
  if (label !== "study" && draw !== 1 && draw !== 2)
    sampleProblems.push(`the sample's draw ${header.draw} is not draw 1 or its one redraw, draw 2`);
  if (label === "study" && !o.codexBin)
    sampleProblems.push("a study run renders every type-1 and type-2 pair with Codex for check K4 (--codex-bin)");
  // The registration a study run keeps to: the tagged PREREG.md's registry and stamps.
  let registry;
  if (label === "study") {
    const run = studyRunProblems({
      tagged: tagged?.prereg,
      working: o.workingPrereg ?? readFileSync(PREREG_FILE, "utf8"),
      tag: o.seedFromTag,
      expectDist: o.expectDist,
      claudeVersion,
    });
    sampleProblems.push(...run.problems);
    registry = run.registry;
  }
  if (sampleProblems.length) {
    log(`refusing: ${sampleProblems.join("; ")} (study/PREREG.md, sections 4 and 8)`);
    return { code: 2 };
  }
  // A rows file holds one sample's rows: a redraw repeats the first draw's unit ids, which would read as done.
  const others = readRows(o.out).filter((r) => r.sampleSha256 !== sampleSha);
  if (others.length) {
    log(
      `refusing: ${o.out} holds ${others.length} row(s) of another sample (or rows that name no sample); a redraw or another sample goes to its own rows file`,
    );
    return { code: 2 };
  }

  // Preconditions.
  const workDir = path.resolve(o.work);
  mkdirSync(workDir, { recursive: true });
  const above = ancestorInstructionFiles(workDir);
  if (above.length) {
    log(
      `refusing: instruction files above the work directory would reach every reconstruction:\n  ${above.join("\n  ")}`,
    );
    return { code: 2 };
  }
  const minFree = (o.minFreeGb ?? 2) * 1024 ** 3;
  if (freeBytes(workDir) < minFree) {
    log(`refusing: less than ${minFree / 1024 ** 3} GB free on the work volume`);
    return { code: 2 };
  }
  const dist = o.mapRunner ? { digest: "injected runner (tests)" } : distDigest(path.dirname(cli));
  if (o.expectDist && dist.digest !== o.expectDist) {
    log(`refusing: dist digest ${dist.digest} is not the frozen build ${o.expectDist}`);
    return { code: 2 };
  }
  // K4's renderer: a study run uses the registered Codex version only (study/PREREG.md section 1).
  const codex = o.codexBin ? await (o.codexVersionOf ?? codexVersion)(o.codexBin) : null;
  if (label === "study") {
    const problem = codexVersionProblem(codex, (registry ?? loadRegistry()).codexVersion);
    if (problem) {
      log(`refusing: ${problem} (study/PREREG.md section 1)`);
      return { code: 2 };
    }
  }
  const homes = freshHomes(workDir);

  const done = new Set(readRows(o.out).map((r) => r.id));
  const todo = units.filter((u) => !done.has(u.id)).slice(0, o.limit > 0 ? o.limit : undefined);
  // api.github.com goes through gh api (its own login); tests pass local transports instead.
  const client = new GetOnlyClient({
    minIntervalMs: o.minIntervalMs ?? 250,
    log: (l) => log(`  ${l}`),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl, ghApi: o.fetchImpl, sleep: async () => undefined } : {}),
    ...(o.ghApi ? { ghApi: o.ghApi } : {}),
  });
  // gh must answer before the first unit: a missing gh or login stops the run here,
  // instead of turning every unit into a fetch-failed exclusion.
  const gh = await ghPreflight(client);
  if (gh.problem) {
    log(`refusing: ${gh.problem}`);
    return { code: 2 };
  }
  log(
    `api.github.com ${client.ghApi.viaGh ? "through gh api" : "through a stand-in for gh api"}: core limit ${gh.limit}, ${gh.remaining} left`,
  );
  const restore = installFetchGuard(client);
  // map in process, checked against the spawned CLI on every Nth unit.
  const every = o.cliCheckEvery ?? CLI_CHECK_EVERY;
  const mapCheck = { every, units: 0, checked: 0, agreed: 0, differ: [] };
  let checkThisUnit = false;
  const primary = o.mapRunner ?? (await inProcessMapRunnerFromDist(path.dirname(cli)));
  const reference = o.mapRunner ? o.referenceRunner : spawnMapRunner(cli);
  const runner =
    reference && every > 0
      ? crossCheckedRunner(primary, reference, { pick: () => checkThisUnit, stats: mapCheck })
      : primary;
  const started = new Date();
  log(
    `${label} census of ${o.frameName} (draw ${draw}): ${todo.length} to do (${done.size} already done) of ${units.length}; ` +
      `map in process from ${o.mapRunner ? "an injected runner" : path.dirname(cli)} (dist ${dist.digest.slice(0, 12)})` +
      (reference && every > 0 ? `, checked against the CLI every ${every} units` : ", not checked against the CLI") +
      `, Claude Code ${claudeVersion} modelled` +
      (codex ? `, K4 with ${codex}` : ", no K4"),
  );

  let faults = 0;
  let maxBytes = 0;
  const exclusions = {};
  try {
    for (const [i, unit] of todo.entries()) {
      const t0 = Date.now();
      // By the unit's position in the sample, not in this run: a resumed run checks the same units.
      const position = Number.isInteger(unit.index) ? unit.index : i;
      checkThisUnit = Boolean(reference) && every > 0 && position % every === 0;
      if (checkThisUnit) mapCheck.units++;
      const row = await runUnit({
        client,
        unit,
        workDir,
        mapRunner: runner,
        homes,
        claudeVersion,
        seed,
        codexBin: o.codexBin,
      });
      // What analyze.mjs needs to keep draws, samples, builds, versions and platforms apart.
      row.label = label;
      row.draw = draw;
      row.sampleSha256 = sampleSha;
      row.sampleN = sampleN;
      row.dist = dist.digest;
      row.codexVersion = codex;
      row.platform = process.platform;
      appendFileSync(o.out, JSON.stringify(row) + "\n");
      const bytes = (row.files ?? []).reduce((n, f) => n + (f.size ?? 0), 0);
      maxBytes = Math.max(maxBytes, bytes);
      if (row.status === "excluded") exclusions[row.exclusion] = (exclusions[row.exclusion] ?? 0) + 1;
      if (row.faults?.length) faults++;
      const rate = client.rate ? ` core ${client.rate.remaining}/${client.rate.limit}` : "";
      log(
        `[${i + 1}/${todo.length}] ${unit.repo} ${row.status}${row.exclusion ? ` (${row.exclusion})` : ""}` +
          (row.status === "measured"
            ? ` t2 ${row.launch.t2.length} t3 ${row.launch.t3.length} files ${row.files.length}${row.k4 ? ` K4 ${row.k4.exact}/${row.k4.n}` : ""}${row.faults.length ? ` FAULTS ${row.faults.length}` : ""}`
            : "") +
          ` api ${row.requests?.api ?? 0} raw ${row.requests?.raw ?? 0}${rate} ${Date.now() - t0} ms`,
      );
    }
  } finally {
    restore();
  }
  const manifest = {
    schema: "ctxreach.study-run/v1",
    label,
    frame: o.frameName,
    draw,
    sample: path.basename(o.sample),
    sampleSha256: sampleSha,
    sampleN,
    seed,
    seedFrom: o.seedFromTag ?? "typed (pilot)",
    startedAt: started.toISOString(),
    endedAt: new Date().toISOString(),
    units: todo.length,
    exclusions,
    unitsWithFaults: faults,
    largestReconstructionBytes: maxBytes,
    dist: dist.digest,
    claudeVersion,
    codex,
    github: {
      via: client.ghApi.viaGh ? "gh api" : "a stand-in for gh api (tests)",
      coreLimit: gh.limit,
      coreRemainingAtStart: gh.remaining,
    },
    map: {
      runner: o.mapRunner ? "injected (tests)" : "in process, dist/index.js",
      check: { ...mapCheck, differ: mapCheck.differ.slice(0, 50), differCount: mapCheck.differ.length },
    },
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    client: {
      requests: client.requests,
      byHost: client.byHost,
      byStatus: client.byStatus,
      retries: client.retries,
      waitedMs: client.waitedMs,
      nonGetAttempts: client.nonGetAttempts,
      refusedHosts: client.refusedHosts,
    },
  };
  writeFileSync(
    `${o.out}.run-${started.toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  log(
    `done: ${todo.length} units, ${Object.values(exclusions).reduce((a, b) => a + b, 0)} excluded ${JSON.stringify(exclusions)}, ` +
      `${faults} with faults, largest reconstruction ${maxBytes} bytes`,
  );
  log(client.summary());
  return { code: client.nonGetAttempts ? 3 : faults ? 1 : 0, manifest };
}

async function main(args) {
  const opt = (name, dflt) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const need = ["--sample", "--frame-name", "--out", "--work"];
  const oneSeed = (opt("--seed") === undefined) !== (opt("--seed-from-tag") === undefined);
  if (need.some((n) => opt(n) === undefined) || !oneSeed) {
    console.error(
      "usage: node study/census/run-census.mjs --sample F --frame-name NAME (--seed-from-tag prereg-v1 | --seed HEX8 --label pilot) --out rows.jsonl --work DIR [options]",
    );
    return 2;
  }
  const { code } = await runCensus({
    sample: opt("--sample"),
    frameName: opt("--frame-name"),
    out: opt("--out"),
    work: opt("--work"),
    seed: opt("--seed"),
    seedFromTag: opt("--seed-from-tag"),
    label: opt("--label", "study"),
    cli: opt("--cli"),
    codexBin: opt("--codex-bin"),
    claudeVersion: opt("--claude-version", CLAUDE_VERSION),
    limit: Number(opt("--limit", "0")),
    minIntervalMs: Number(opt("--min-interval-ms", "250")),
    minFreeGb: Number(opt("--min-free-gb", "2")),
    expectDist: opt("--expect-dist"),
  });
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
