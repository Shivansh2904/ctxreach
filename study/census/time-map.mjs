// Per-launch-directory time of `map --json`, before and after the census
// moved map into its own process (2026-10-01): the CLI spawned once per
// launch directory (before) against map called in this process from the
// same build (after). Run over the pilot's fixture repositories
// (study/pilot/**/repo) and, with --k1, over the K1 fixtures too. Each
// repository is copied to a fresh folder with a .git marker, as recon.mjs
// leaves one; its launch directories are the census's (types 1 to 3, capped
// and drawn as recon.mjs does). Every pair of answers is compared; a
// difference is printed and makes the exit status 1.
//
// --synthetic N adds one made-up repository shaped like the pilot's largest
// (N package folders, each with an AGENTS.md of about 1 KB, every third
// with a CLAUDE.md importing it), to show what a launch directory costs when
// map reads many instruction files each time.
//
// Usage: node study/census/time-map.mjs [--cli dist/cli.js] [--k1] [--synthetic 150] [--rounds 3] [--json out.json]

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allFixtures } from "./known-answer.mjs";
import { inProcessMapRunnerFromDist, spawnMapRunner } from "./lib/maprun.mjs";
import { instructionDirs, manifestDirs } from "./lib/paths.mjs";
import { draw } from "./lib/prng.mjs";
import { MAX_TYPE2_DIRS, MAX_TYPE3_DIRS } from "./recon.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

/** A made-up repository with `n` package folders holding instruction files (see the header). */
export function syntheticRepo(dir, n) {
  const repoDir = path.join(dir, "repo");
  const line = (i, j) => `- Rule ${j} for package ${i}: keep the public API stable and run the package tests first.\n`;
  const body = (i) => `# Package ${i}\n\n${Array.from({ length: 12 }, (_, j) => line(i, j)).join("")}`;
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(path.join(repoDir, "AGENTS.md"), body("root"));
  writeFileSync(path.join(repoDir, "CLAUDE.md"), "@AGENTS.md\n");
  for (let i = 0; i < n; i++) {
    const p = path.join(repoDir, "packages", `p${String(i).padStart(3, "0")}`);
    mkdirSync(p, { recursive: true });
    writeFileSync(path.join(p, "AGENTS.md"), body(i));
    if (i % 3 === 0) writeFileSync(path.join(p, "CLAUDE.md"), "@AGENTS.md\n");
  }
  return { name: `synthetic/${n}-packages`, repoDir };
}

/** The pilot's fixture repositories: every folder named `repo` under study/pilot. */
export function pilotRepos(dir = path.join(ROOT, "study", "pilot")) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory()) continue;
      const full = path.join(d, e.name);
      if (e.name === "repo") out.push({ name: `pilot/${rel}`.replace(/\/$/, ""), repoDir: full });
      else walk(full, `${rel}${e.name}/`);
    }
  };
  walk(dir, "");
  return out;
}

function filesUnder(root) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
      else out.push(`${rel}${e.name}`);
    }
  };
  walk(root, "");
  return out;
}

/** The census's launch directories for a repository's files (types 1-3, capped and drawn as recon.mjs does). */
export function launchDirs(files, name, seed = "00000000") {
  let t2 = instructionDirs(files);
  if (t2.length > MAX_TYPE2_DIRS) t2 = draw(t2, MAX_TYPE2_DIRS, seed, `t2|${name}`).sort();
  let t3 = manifestDirs(files, new Set([".", ...t2]));
  if (t3.length > MAX_TYPE3_DIRS) t3 = draw(t3, MAX_TYPE3_DIRS, seed, `t3|${name}`).sort();
  return [".", ...t2, ...t3];
}

function stats(ms) {
  const s = [...ms].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  const median = s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : 0;
  return {
    n: s.length,
    meanMs: round(mean),
    medianMs: round(median),
    minMs: round(s[0] ?? 0),
    maxMs: round(s.at(-1) ?? 0),
  };
}

const round = (x) => Math.round(x * 10) / 10;

/**
 * Time both runners over `repos`. `spawned` runs once per launch directory;
 * `inProcess` runs `rounds` times and its median per directory is kept.
 */
export async function timeRunners({ repos, spawned, inProcess, rounds = 3, work }) {
  const homes = { codexHome: path.join(work, "home", ".codex"), claudeHome: path.join(work, "home", ".claude") };
  mkdirSync(homes.codexHome, { recursive: true });
  mkdirSync(homes.claudeHome, { recursive: true });
  const rows = [];
  for (const r of repos) {
    const root = path.join(work, "r", r.name.replace(/[^A-Za-z0-9._-]/g, "_"), "repo");
    cpSync(r.repoDir, root, { recursive: true });
    mkdirSync(path.join(root, ".git"), { recursive: true });
    for (const d of launchDirs(filesUnder(root), r.name)) {
      const opts = {
        launchDir: d === "." ? root : path.join(root, ...d.split("/")),
        repoRoot: root,
        ...homes,
        claudeVersion: "2.1.285",
      };
      if (!existsSync(opts.launchDir) || !statSync(opts.launchDir).isDirectory()) continue;
      let t = performance.now();
      const before = await spawned(opts);
      const spawnMs = performance.now() - t;
      const inMs = [];
      let after;
      for (let i = 0; i < rounds; i++) {
        t = performance.now();
        after = await inProcess(opts);
        inMs.push(performance.now() - t);
      }
      rows.push({
        repo: r.name,
        dir: d,
        spawnMs: round(spawnMs),
        inProcessMs: stats(inMs).medianMs,
        same: JSON.stringify(before) === JSON.stringify(after),
      });
    }
  }
  return rows;
}

export function summarise(rows) {
  const spawn = stats(rows.map((r) => r.spawnMs));
  const inproc = stats(rows.map((r) => r.inProcessMs));
  return {
    launchDirs: rows.length,
    identical: rows.filter((r) => r.same).length,
    spawnedCli: spawn,
    inProcess: inproc,
    speedup: inproc.meanMs > 0 ? round(spawn.meanMs / inproc.meanMs) : null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const cli = path.resolve(opt("--cli") ?? path.join(ROOT, "dist", "cli.js"));
  const rounds = Number(opt("--rounds") ?? 3);
  const t0 = performance.now();
  const inProcess = await inProcessMapRunnerFromDist(path.dirname(cli));
  const setupMs = round(performance.now() - t0);
  const spawned = spawnMapRunner(cli);
  const work = mkdtempSync(path.join(os.tmpdir(), "ctxr-time-"));
  const groups = { pilot: pilotRepos() };
  if (args.includes("--k1")) groups.k1 = allFixtures();
  if (opt("--synthetic")) groups.synthetic = [syntheticRepo(path.join(work, "made"), Number(opt("--synthetic")))];
  const out = {
    schema: "ctxreach.study-map-timing/v1",
    at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: `${os.cpus().length} x ${os.cpus()[0]?.model ?? "?"}`,
    cli: path.relative(ROOT, cli),
    inProcessSetupMs: setupMs,
    rounds,
    groups: {},
  };
  let differ = 0;
  try {
    for (const [name, repos] of Object.entries(groups)) {
      const rows = await timeRunners({ repos, spawned, inProcess, rounds, work: path.join(work, name) });
      const s = summarise(rows);
      out.groups[name] = { repos: repos.length, ...s, rows };
      differ += s.launchDirs - s.identical;
      console.log(
        `${name}: ${repos.length} repositories, ${s.launchDirs} launch directories; ` +
          `spawned CLI mean ${s.spawnedCli.meanMs} ms (median ${s.spawnedCli.medianMs}), ` +
          `in process mean ${s.inProcess.meanMs} ms (median ${s.inProcess.medianMs}); ` +
          `${s.speedup}x; identical answers ${s.identical}/${s.launchDirs}`,
      );
      for (const r of rows.filter((x) => !x.same)) console.log(`  DIFFERENT: ${r.repo} ${r.dir}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`in-process setup (import + one cli.js --version): ${setupMs} ms, once per run`);
  if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(out, null, 2) + "\n");
  process.exitCode = differ ? 1 : 0;
}
