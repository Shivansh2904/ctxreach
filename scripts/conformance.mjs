// The conformance battery: `ctxreach verify` over every fixture, for every
// agent that has an oracle, from the root and from packages/api, at no cost
// and with no login. It writes one results.json record per launch, and
// exits non-zero on any disagreement. This is what the nightly workflow calls.
//
// Before the battery, a planted-fault pass runs: `map` is given a wrong
// budget (Codex: --codex-max-bytes 30000 on codex-over-cap) or a wrong
// Project instructions mode (Claude Code: --claude-mode claude-md on
// claude-local-shadows-agents-twin). That pass MUST disagree. A battery
// whose planted pass agrees is an instrument fault: the check cannot fail,
// so nothing it says afterwards means anything, and the script stops with
// status 2.
//
// Usage:
//   node scripts/conformance.mjs [--agents codex,claude] [--codex-bin <path>] [--codex-home <dir>]
//     [--claude-bin <path>] [--model <pin>] [--trials <n>] [--out results.json]
//     [--cli dist/cli.js] [--fixtures test/fixtures] [--only <fixture>] [--keep-runs <dir>]
// Exit status: 0 when every launch agrees, 1 when any disagrees, 2 when the
// instrument fails (a planted pass that agrees, a run that faults or fails).

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), "..");

export const SCHEMA = "ctxreach.conformance/v1";
export const LAUNCH_DIRS = [".", "packages/api"];

/** The planted-fault pass per agent: a fixture and flags that make map wrong on purpose. */
export const PLANTED = {
  codex: { fixture: "codex-over-cap", launchDir: ".", flags: ["--codex-max-bytes", "30000"] },
  claude: { fixture: "claude-local-shadows-agents-twin", launchDir: ".", flags: ["--claude-mode", "claude-md"] },
};

export function parseArgs(argv) {
  const opts = {
    agents: ["codex"],
    trials: 2,
    out: "results.json",
    cli: path.join(ROOT, "dist", "cli.js"),
    fixtures: path.join(ROOT, "test", "fixtures"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--agents")
      opts.agents = next()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--codex-bin") opts.codexBin = next();
    else if (a === "--codex-home") opts.codexHome = next();
    else if (a === "--claude-bin") opts.claudeBin = next();
    else if (a === "--model") opts.model = next();
    else if (a === "--trials") opts.trials = Number(next());
    else if (a === "--out") opts.out = next();
    else if (a === "--cli") opts.cli = next();
    else if (a === "--fixtures") opts.fixtures = next();
    else if (a === "--only") opts.only = next();
    else if (a === "--keep-runs") opts.keepRuns = next();
    else if (a === "--no-plant") opts.noPlant = true;
    else throw new Error(`unknown argument ${a}`);
  }
  for (const agent of opts.agents) if (!PLANTED[agent]) throw new Error(`no oracle for agent ${agent}`);
  return opts;
}

/** Every (fixture, agent, launch dir) the battery runs: the fixtures named after the agent, from each launch dir that exists. */
export function launchesFor(fixturesDir, agents, only) {
  const out = [];
  for (const agent of agents)
    for (const fixture of readdirSync(fixturesDir)
      .filter((n) => n.startsWith(`${agent}-`))
      .sort()) {
      if (only && fixture !== only) continue;
      for (const launchDir of LAUNCH_DIRS)
        if (existsSync(path.join(fixturesDir, fixture, "repo", ...launchDir.split("/"))))
          out.push({ fixture, agent, launchDir });
    }
  return out;
}

/** One results.json record from a `verify --json` output. */
export function recordFrom(json, launch) {
  const real = json.cells.filter((c) => !c.decoy);
  const deliveredKinds = new Set(["launch", "launch-cut", "import"]);
  const predicted = [...new Set(real.filter((c) => c.expected === "launch").map((c) => c.file))];
  const observed = [...new Set(real.filter((c) => c.usable > 0 && c.seen === c.usable).map((c) => c.file))];
  const disagreeing = real.filter((c) => c.verdict === "missed" || c.verdict === "extra");
  const bytesOff = json.segments.filter((s) => s.verdict !== "EXACT");
  const verdict = json.instrument_checks.fault
    ? "fault"
    : json.trials.every((t) => t.status !== "usable")
      ? "failed"
      : disagreeing.length || bytesOff.length
        ? "disagree"
        : "agree";
  return {
    fixture: launch.fixture,
    launchDir: launch.launchDir,
    agent: json.agent,
    version: json.cliVersion,
    os: `${json.os.platform} ${json.os.release} ${json.os.arch}`,
    date: json.startedAt,
    instrument: json.instrument,
    predicted,
    observed,
    verdict,
    cells: real.map((c) => ({
      file: c.file,
      position: c.position,
      predicted: c.predicted.delivery,
      observed: c.fraction,
      verdict: c.verdict,
    })),
    keptBytes:
      json.instrument === "render"
        ? Object.fromEntries(
            json.segments.map((s) => [
              s.file,
              {
                predicted: s.predictedBytes,
                observed: s.observedBytes,
                verdict: s.verdict === "OFF BY" ? `OFF BY ${s.offBy}` : s.verdict,
              },
            ]),
          )
        : null,
    controls: {
      control: json.instrument_checks.control,
      decoy: json.instrument_checks.decoy,
      deliveredKinds: [...deliveredKinds],
    },
    reasons: json.instrument_checks.reasons,
  };
}

export function summarise(records) {
  const count = (v) => records.filter((r) => r.verdict === v).length;
  return {
    total: records.length,
    agree: count("agree"),
    disagree: count("disagree"),
    fault: count("fault"),
    failed: count("failed"),
  };
}

/** Copy a fixture's repo into a fresh directory with a `.git`, so the copy is a repository root. */
function materialise(fixturesDir, fixture, base) {
  const src = path.join(fixturesDir, fixture);
  const repo = path.join(base, "repo");
  cpSync(path.join(src, "repo"), repo, { recursive: true });
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const home = path.join(base, "home");
  if (existsSync(path.join(src, "home"))) cpSync(path.join(src, "home"), home, { recursive: true });
  else mkdirSync(home);
  return { repo, home };
}

/** The flags one verify run needs, per agent: the fixture's own home for Codex; a settings file carrying the fixture's mode for Claude. */
function agentFlags(opts, agent, home, base) {
  if (agent === "codex")
    return [
      ...(opts.codexBin ? ["--codex-bin", opts.codexBin] : []),
      "--codex-home",
      opts.codexHome ?? path.join(home, ".codex"),
    ];
  const flags = [...(opts.claudeBin ? ["--claude-bin", opts.claudeBin] : []), "--model", opts.model ?? ""];
  const userSettings = path.join(home, ".claude", "settings.json");
  if (existsSync(userSettings)) {
    const mode = JSON.parse(readFileSync(userSettings, "utf8")).pluginConfigs?.["agents-md@builtin"]?.options
      ?.instructionFiles;
    if (mode) {
      const file = path.join(base, "settings.json");
      writeFileSync(
        file,
        JSON.stringify({ pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: mode } } } }),
      );
      flags.push("--settings", file);
    }
  }
  return flags;
}

function runVerify(opts, launch, extraFlags, scratch) {
  const base = mkdtempSync(path.join(scratch, `${launch.fixture}-`));
  const { repo, home } = materialise(opts.fixtures, launch.fixture, base);
  const save = path.join(base, "run");
  const args = [
    opts.cli,
    "verify",
    "--agent",
    launch.agent,
    "--repo",
    repo,
    "--from",
    path.join(repo, ...launch.launchDir.split("/")),
    "--trials",
    String(opts.trials),
    "--save",
    save,
    "--json",
    ...agentFlags(opts, launch.agent, home, base),
    ...extraFlags,
  ];
  const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, cwd: ROOT });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = undefined;
  }
  if (opts.keepRuns && existsSync(save))
    cpSync(
      save,
      path.join(opts.keepRuns, `${launch.agent}-${launch.fixture}-${launch.launchDir.replace(/\//g, "_")}`),
      { recursive: true },
    );
  return { status: r.status, stderr: r.stderr, json };
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.agents.includes("claude") && !opts.model) {
    console.error("verify --agent claude needs --model <pin>");
    return 2;
  }
  if (!existsSync(opts.cli)) {
    console.error(`${opts.cli} does not exist; run npm run build first`);
    return 2;
  }
  if (opts.keepRuns) mkdirSync(opts.keepRuns, { recursive: true });
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ctxreach-conformance-"));
  const results = { schema: SCHEMA, date: new Date().toISOString(), plantedPass: [], records: [] };
  let status = 0;
  try {
    // K8: the planted pass must disagree before anything is scored.
    for (const agent of opts.agents) {
      const p = PLANTED[agent];
      const launch = { fixture: p.fixture, agent, launchDir: p.launchDir };
      const r = runVerify(opts, launch, p.flags, scratch);
      const disagreed = r.status === 1;
      results.plantedPass.push({
        agent,
        fixture: p.fixture,
        launchDir: p.launchDir,
        flags: p.flags,
        status: r.status,
        disagreed,
      });
      console.log(
        `planted pass ${agent}: ${p.fixture} with ${p.flags.join(" ")} -> exit ${r.status} (${disagreed ? "DISAGREES, as it must" : "did not disagree: INSTRUMENT FAULT"})`,
      );
      if (!disagreed) {
        console.error(r.stderr);
        status = 2;
      }
    }
    if (status !== 0) return status;

    const launches = launchesFor(opts.fixtures, opts.agents, opts.only);
    for (const launch of launches) {
      const r = runVerify(opts, launch, [], scratch);
      if (!r.json) {
        console.error(
          `${launch.agent} ${launch.fixture} from ${launch.launchDir}: no JSON (exit ${r.status})\n${r.stderr}`,
        );
        results.records.push({
          ...launch,
          verdict: "failed",
          reasons: [r.stderr.trim()],
          version: null,
          os: null,
          date: null,
          instrument: null,
          predicted: [],
          observed: [],
          cells: [],
          keptBytes: null,
          controls: null,
        });
        status = 2;
        continue;
      }
      const record = recordFrom(r.json, launch);
      results.records.push(record);
      const bytes = record.keptBytes
        ? ` bytes ${Object.values(record.keptBytes).filter((b) => b.verdict === "EXACT").length}/${Object.keys(record.keptBytes).length} exact`
        : "";
      console.log(
        `${launch.agent.padEnd(6)} ${launch.fixture.padEnd(36)} from ${launch.launchDir.padEnd(12)} ${record.verdict.toUpperCase()}${bytes}`,
      );
      if (record.verdict === "disagree" && status === 0) status = 1;
      if (record.verdict === "fault" || record.verdict === "failed") status = 2;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    writeFileSync(opts.out, JSON.stringify(results, null, 2) + "\n");
  }
  const s = summarise(results.records);
  console.log(
    `\n${s.agree} of ${s.total} launches agree with map (${s.disagree} disagree, ${s.fault} faulty, ${s.failed} failed); written to ${opts.out}`,
  );
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = main(process.argv.slice(2));
}
