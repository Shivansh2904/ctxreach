// Check K3: the sample must agree with the census it was drawn from. The
// regex version of O1-file (a root CLAUDE.md whose text lacks "@AGENTS.md",
// the same test Sourcegraph's counts apply) is measured on every sampled
// repository; the whole frame's proportion comes from two Sourcegraph counts
// (frame.mjs --frame K3) over the frame's size. Pass rule: the census
// proportion lies inside the sample's Wilson 95% interval. A failure means
// sampling or reconstruction bias, and stops the study.
//
// Usage: node study/census/consistency.mjs --rows rows-S-main.jsonl --k3 K3.manifest.json --frame-manifest S.manifest.json

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wilson } from "./lib/stats.mjs";

/**
 * @param {object[]} rows measured S-main rows
 * @param {{ counts: { claude: number, claudeImport: number }, frameRepos: number }} manifest
 */
export function k3Check(rows, manifest) {
  const { claude, claudeImport } = manifest.counts ?? {};
  const N = manifest.frameRepos;
  if (!(N > 0) || !(claude >= 0) || !(claudeImport >= 0)) return { pass: false, explain: "census counts missing" };
  const census = (claude - claudeImport) / N;
  const el = rows.filter((r) => r.outcomes?.k3?.eligible);
  const k = el.filter((r) => r.outcomes.k3.event).length;
  const w = wilson(k, el.length);
  const pass = el.length > 0 && census >= w.lo && census <= w.hi;
  return {
    pass,
    census: { claude, claudeImport, frameRepos: N, p: census },
    sample: { k, n: el.length, p: w.p, lo: w.lo, hi: w.hi },
    explain: `census ${(census * 100).toFixed(2)}% vs sample ${k}/${el.length} [${((w.lo ?? 0) * 100).toFixed(2)}%, ${((w.hi ?? 0) * 100).toFixed(2)}%]`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (!opt("--rows") || !opt("--k3") || !opt("--frame-manifest")) {
    console.error(
      "usage: node study/census/consistency.mjs --rows rows.jsonl --k3 K3.manifest.json --frame-manifest S.manifest.json",
    );
    process.exit(2);
  }
  const rows = readFileSync(opt("--rows"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.status === "measured" && !(r.faults ?? []).length);
  const k3 = JSON.parse(readFileSync(opt("--k3"), "utf8"));
  const frame = JSON.parse(readFileSync(opt("--frame-manifest"), "utf8"));
  const res = k3Check(rows, { counts: k3.counts, frameRepos: frame.repos });
  console.log(`K3: ${res.pass ? "pass" : "FAIL"}: ${res.explain}`);
  process.exitCode = res.pass ? 0 : 1;
}
