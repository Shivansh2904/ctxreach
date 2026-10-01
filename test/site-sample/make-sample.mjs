// Makes the SAMPLE data the results page is tested and previewed with. Every
// value in it is made up. It is never a result, and never goes in site/data/.
//
// - results.json: the study's own analyze() (study/census/analyze.mjs) run on
//   census rows this script invents (deterministic, label "sample", versions
//   "0.0.0-sample", repositories named sample-owner-N/sample-repo-N, sample
//   sizes that are not the registered ones);
// - cells-results.json: the study's own run-cells.mjs --dry-run, against its
//   fake instrument (dryRun: true);
// - conformance/latest/*.json: records in scripts/conformance.mjs's shape,
//   invented here, every version "0.0.0-sample";
// - provenance.json: scripts/site-data.mjs over invented check outputs and
//   run manifests, the dry run's trials, and the real docs/demo.cast.json.
//
// Usage: node test/site-sample/make-sample.mjs [--study <dir holding study/>] [--out <dir>]
// (default: this repository and test/site-sample/data). The study code
// arrives with the v1/study branch; before that, point --study at a copy.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), "..", "..");
export const SAMPLE_VERSION = "0.0.0-sample";
export const SIZES = { "S-main": 240, "S-imp": 90 };

/** mulberry32: a small seeded generator, so the sample is the same every time. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** Invented census rows for one frame, in the shape study/census/analyze.mjs reads. */
export function fakeRows(frame, n, seed) {
  const r = rng(seed);
  const p = (x) => r() < x;
  // A second stream for the fields the analysis came to read later (each pair's Codex chain, O7's broken links,
  // O8's bytes), so the values drawn from the first stream stay what they were.
  const q = rng(seed ^ 0x2545f491);
  const imp = frame === "S-imp";
  const codes = ["claude.agents-shadowed", "codex.cut", "claude.words-not-import", "codex.nested", "claude.too-large"];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const owner = i % 37 === 0 ? "sample-owner-many" : `sample-owner-${i}`;
    const repo = `${owner}/sample-repo-${frame.toLowerCase()}-${i}`;
    const base = { frame, index: i, repo, owner, label: "sample" };
    if (p(0.035)) {
      rows.push({
        ...base,
        status: "excluded",
        exclusion: ["fork", "commit-gone", "tree-truncated", "failed-3-times"][i % 4],
      });
      continue;
    }
    const eligible = p(0.97);
    const t2Total = p(imp ? 0.85 : 0.35) ? 1 + Math.floor(r() * (p(0.05) ? 40 : 6)) : 0;
    const t2Dirs = Math.min(t2Total, 20);
    const pairs = 1 + t2Dirs;
    const eventDirs = [];
    for (let d = 0; d < pairs; d++) if (p(0.025)) eventDirs.push(d === 0 ? "." : `packages/p${d}`);
    const pairsT3 = Math.floor(r() * 4);
    const t3EventDirs = [];
    for (let d = 0; d < pairsT3; d++) if (p(0.02)) t3EventDirs.push(`libs/l${d}`);
    const o1 = eligible && p(imp ? 0.08 : 0.24);
    const o1file = eligible && (o1 || p(0.06));
    const o2 = eligible && t2Dirs > 0 && p(imp ? 0.26 : 0.12);
    const linkAffected = p(0.03);
    const rootWarn = codes.filter((c, k) => p([0.27, 0.02, 0.05, 0.04, 0.01][k]));
    const k4pairs = Array.from({ length: pairs }, (_x, d) => {
      const off = p(0.012);
      const fault = !off && p(0.004);
      return {
        dir: d === 0 ? "." : `packages/p${d}`,
        verdict: fault ? "FAULT" : off ? "OFF BY" : "EXACT",
        ...(off ? { offBy: 3, firstDiff: 120 } : {}),
        ...(fault ? { faults: ["renders differ"] } : {}),
      };
    });
    const faults = p(0.012) ? ["map answered for another launch directory"] : [];
    // The root AGENTS.md's bytes, and what Codex keeps of it at the root launch: at most its budget, and
    // nothing when an AGENTS.override.md beside it is read instead.
    const rootBytes = 200 + Math.floor(q() * (q() < 0.05 ? 90000 : 12000));
    const overridden = q() < 0.02;
    const rootChain = overridden
      ? [{ path: "AGENTS.override.md", bytes: 400, kept: 400, status: "full" }]
      : [
          {
            path: "AGENTS.md",
            bytes: rootBytes,
            kept: Math.min(rootBytes, 32768),
            status: rootBytes > 32768 ? "cut" : "full",
          },
        ];
    const broken = linkAffected && q() < 0.3 ? 1 : 0;
    const samplePairs = Array.from({ length: pairs }, (_x, d) => ({
      dir: d === 0 ? "." : `packages/p${d}`,
      type: d === 0 ? 1 : 2,
      warn: d === 0 ? rootWarn : [],
      findings: [],
      codex: { chain: d === 0 ? rootChain : [], notPreloaded: [], codes: [] },
      claude: { agentsRead: !o1file, codes: [], files: [], shadowers: [] },
    }));
    rows.push({
      ...base,
      status: "measured",
      faults,
      commit: sha256(`${repo}@sample`).slice(0, 40),
      claudeVersion: SAMPLE_VERSION,
      mapVersion: SAMPLE_VERSION,
      blobs: { rootAgents: p(0.05) ? "sample-template-blob" : sha256(`${repo}:AGENTS.md`).slice(0, 40) },
      launch: { t2Total, t2: Array.from({ length: t2Dirs }, (_x, d) => `packages/p${d + 1}`), t3: [] },
      files: [],
      pairs: samplePairs,
      k4: { pairs: k4pairs, exact: k4pairs.filter((x) => x.verdict === "EXACT").length, n: k4pairs.length },
      outcomes: {
        o1content: { eligible, event: o1 },
        o1contentShingle: { eligible, event: o1 && p(0.9) },
        o1file: { eligible, event: o1file },
        o2: { eligible, t2Dirs, event: o2, eventT123: o2 || (eligible && p(0.03)) },
        p1: {
          pairs,
          eventDirs,
          repoEvent: eventDirs.length > 0,
          pairsT3,
          t3EventDirs,
          repoEventT123: eventDirs.length + t3EventDirs.length > 0,
        },
        o4: { eligible, event: eligible && p(0.11) },
        o5: { rootWarn, rootWarnMap: rootWarn, anyWarn: rootWarn, linkAffected },
        o6: { eligible, event: eligible && p(0.05) },
        o7: { event: linkAffected, broken, rootLinkToAgents: linkAffected && p(0.5) },
        o8: {
          eligible,
          event: eligible && p(0.03),
          bytes: rootBytes,
          ...(rootBytes > 32768 ? { effectiveChars: 20000 + Math.floor(q() * 12768) } : {}),
        },
        k3: { eligible, event: o1file || (eligible && p(0.02)) },
      },
    });
  }
  return rows;
}

/** Invented conformance records, in scripts/conformance.mjs's results.json shape. */
export function fakeConformance(agent, os, fixturesDir, seed) {
  const r = rng(seed);
  const fixtures = readdirSync(fixturesDir)
    .filter((n) => n.startsWith(`${agent}-`))
    .sort();
  const records = [];
  for (const fixture of fixtures)
    for (const launchDir of [".", "packages/api"]) {
      if (!existsSync(path.join(fixturesDir, fixture, "repo", ...launchDir.split("/")))) continue;
      const roll = r();
      const verdict = roll < 0.04 ? "disagree" : roll < 0.06 ? "fault" : "agree";
      const files = ["AGENTS.md", "packages/api/AGENTS.md"];
      const cells = files.flatMap((file) =>
        ["head", "tail"].map((position) => ({
          file,
          position,
          predicted: "launch",
          observed: "2/2",
          verdict: verdict === "disagree" && file === "AGENTS.md" ? "missed" : "confirmed",
        })),
      );
      records.push({
        fixture,
        launchDir,
        agent,
        version: SAMPLE_VERSION,
        os: `${os} sample`,
        date: "2026-01-01T00:00:00.000Z",
        instrument: agent === "codex" ? "render" : "capture",
        predicted: files,
        observed: verdict === "disagree" ? files.slice(1) : files,
        verdict,
        cells,
        keptBytes:
          agent === "codex"
            ? Object.fromEntries(
                files.map((f) => [
                  f,
                  {
                    predicted: 1000,
                    observed: verdict === "disagree" ? 990 : 1000,
                    verdict: verdict === "disagree" ? "OFF BY -10" : "EXACT",
                  },
                ]),
              )
            : null,
        controls: {
          control: { seen: 2, usable: 2 },
          decoy: { seen: 0, usable: 2 },
          deliveredKinds: ["launch", "launch-cut", "import"],
        },
        reasons: verdict === "fault" ? ["sample fault"] : [],
      });
    }
  return {
    schema: "ctxreach.conformance/v1",
    date: "2026-01-01T00:00:00.000Z",
    plantedPass: [
      {
        agent,
        fixture: agent === "codex" ? "codex-over-cap" : "claude-local-shadows-agents-twin",
        launchDir: ".",
        flags: agent === "codex" ? ["--codex-max-bytes", "30000"] : ["--claude-mode", "claude-md"],
        status: 1,
        disagreed: true,
      },
    ],
    records,
  };
}

const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};

export async function makeSample({ study = ROOT, out = path.join(ROOT, "test", "site-sample", "data") } = {}) {
  const analyzePath = path.join(study, "study", "census", "analyze.mjs");
  const cellsScript = path.join(study, "study", "behavioural", "run-cells.mjs");
  if (!existsSync(analyzePath) || !existsSync(cellsScript))
    throw new Error(`no study code under ${study} (study/census/analyze.mjs, study/behavioural/run-cells.mjs)`);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ctxreach-site-sample-"));
  try {
    // Census: invented rows through the study's own analysis.
    const { analyze } = await import(pathToFileURL(analyzePath).href);
    const rowSets = Object.entries(SIZES).map(([frame, n], k) => {
      const rows = fakeRows(frame, n, 0x5a3b1e + k);
      const text = rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
      return { file: `SAMPLE-rows-${frame}.jsonl`, sha256: sha256(text), rows };
    });
    const k3Manifest = { counts: { claude: 7300, claudeImport: 1300 }, frameRepos: 26000 };
    const results = analyze({ rowSets, k3Manifest, label: "sample" });
    write(path.join(out, "results.json"), results);

    // Lab cells: the study's harness, dry run against its fake instrument.
    const dry = path.join(tmp, "cells");
    const run = spawnSync(process.execPath, [cellsScript, "--dry-run", "--out", dry], {
      encoding: "utf8",
      cwd: study,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (run.status !== 0) throw new Error(`run-cells --dry-run failed (exit ${run.status}): ${run.stderr}`);
    const cells = JSON.parse(readFileSync(path.join(dry, "cells-results.json"), "utf8"));
    if (cells.dryRun !== true) throw new Error("the dry run's cells-results.json is not marked dryRun");
    write(path.join(out, "cells-results.json"), cells);

    // Conformance columns, invented.
    const fixtures = path.join(ROOT, "test", "fixtures");
    write(
      path.join(out, "conformance", "latest", "results-codex-pinned-Linux.json"),
      fakeConformance("codex", "linux", fixtures, 11),
    );
    write(
      path.join(out, "conformance", "latest", "results-codex-latest-Windows.json"),
      fakeConformance("codex", "win32", fixtures, 12),
    );
    write(
      path.join(out, "conformance", "latest", "results-claude-latest-Linux.json"),
      fakeConformance("claude", "linux", fixtures, 13),
    );

    // Provenance: scripts/site-data.mjs over invented check outputs and run manifests.
    const { assemble } = await import(pathToFileURL(path.join(ROOT, "scripts", "site-data.mjs")).href);
    const inputs = path.join(tmp, "inputs");
    mkdirSync(path.join(inputs, "site", "runs", "B2-A1"), { recursive: true });
    mkdirSync(path.join(inputs, "site", "runs", "B7-trap"), { recursive: true });
    const k1 = {
      k: 39,
      n: 40,
      results: [{ name: "sample-fixture", pass: false, knownDefect: "sample defect" }],
      orphans: [],
    };
    const k6 = { n: 30, agree: 28, claudeAgree: 29, codexAgree: 29, disagreements: [{ id: "p01" }, { id: "p02" }] };
    write(path.join(inputs, "k1.json"), k1);
    writeFileSync(
      path.join(inputs, "k2.txt"),
      "sample log\nK2: 15/16 planted faults caught by K1\nnon-GET attempts: 0\n",
    );
    write(path.join(inputs, "k5.json"), { k: 94, n: 96 });
    write(path.join(inputs, "k6.json"), k6);
    const runs = Object.entries(SIZES).map(([frame, n], k) => {
      const file = path.join(inputs, `SAMPLE-rows-${frame}.jsonl.run-sample.json`);
      write(file, {
        schema: "ctxreach.study-run/v1",
        label: "sample",
        frame,
        sample: `SAMPLE-${frame}.tsv`,
        sampleSha256: sha256(`sample ${frame}`),
        seed: "5a3b1e00",
        seedFrom: "typed (pilot)",
        startedAt: `2026-01-0${k + 1}T09:00:00.000Z`,
        endedAt: `2026-01-0${k + 1}T13:30:00.000Z`,
        units: n,
        exclusions: {},
        unitsWithFaults: 0,
        largestReconstructionBytes: 1,
        dist: "sample-dist-digest",
        claudeVersion: SAMPLE_VERSION,
        codex: `codex-cli ${SAMPLE_VERSION}`,
        node: "v0.0.0-sample",
        platform: "sample x64",
        client: { requests: 4 * n, nonGetAttempts: 0, retries: 0 },
      });
      return file;
    });
    const prov = assemble({
      label: "sample",
      out: path.join(inputs, "site", "data", "provenance.json"),
      runs,
      k1: path.join(inputs, "k1.json"),
      k2: path.join(inputs, "k2.txt"),
      k5: path.join(inputs, "k5.json"),
      k6: path.join(inputs, "k6.json"),
      trials: path.join(dry, "trials.jsonl"),
      recordings: path.join(inputs, "site", "runs"),
      cast: path.join(ROOT, "docs", "demo.cast.json"),
    });
    // No prereg-v1 tag exists for a sample: an invented one, marked as such.
    prov.prereg = {
      tag: "prereg-sample",
      commit: "sample00000000000000000000000000000000000",
      seed: "sample00",
      preregSha256: "sample".padEnd(64, "0"),
      issueUrl: "https://example.invalid/sample-issue",
      issueCreatedAt: "2026-01-01T08:00:00Z",
      issueTitle: "Sample issue (made up)",
    };
    prov.freeze = {
      tag: "study-sample",
      commit: "sample11111111111111111111111111111111111",
      distDigest: "sample-dist-digest",
    };
    write(path.join(out, "provenance.json"), prov);
    return { out, results, cells, prov };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? path.resolve(args[i + 1]) : undefined;
  };
  const { out } = await makeSample({ study: opt("--study"), out: opt("--out") });
  console.log(`wrote SAMPLE data (made up, never results) to ${out}`);
}
