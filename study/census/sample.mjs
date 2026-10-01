// Draw a sample from a frozen frame (study/PREREG.md, section 4).
//
// The frame's rows are put in canonical order (by repository name), the rows
// of any --exclude sample are removed (S-imp excludes S-main's draws), and
// the first n of a seeded Fisher-Yates shuffle are the sample, in draw order.
// The seed is the first 8 hex digits of the prereg-v1 commit
// (--seed-from-tag), or an explicit, labelled pilot seed.
//
// Usage:
//   node study/census/sample.mjs --frame S.tsv --n 1100 --stream S-main --seed-from-tag prereg-v1 --out S-main.tsv
//   node study/census/sample.mjs --frame S.tsv --n 20 --stream PILOT --seed <8 hex> --label pilot --out pilot.tsv
// Options: --exclude <sample.tsv> (repeatable), --seed-offset 1 (the one pre-registered redraw).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./lib/paths.mjs";
import { checkSeed, draw, offsetSeed } from "./lib/prng.mjs";
import { loadRegistry } from "./lib/registry.mjs";
import { seedFromTag } from "./seed.mjs";

/** Parse a frame TSV (repo, commit, path, stars) into rows. */
export function readFrame(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [repo, commit, p, stars] = l.split("\t");
      return { repo, commit, path: p, stars };
    });
}

/** Parse a sample TSV (index, id, repo, commit). */
export function readSample(text) {
  return text
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [index, id, repo, commit] = l.split("\t");
      return { index: Number(index), id, repo, commit };
    });
}

export function drawSample(frameRows, { n, seed, stream, exclude = new Set() }) {
  const canonical = frameRows
    .filter((r) => !exclude.has(r.repo))
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  return draw(canonical, n, checkSeed(seed), stream).map((r, i) => ({
    index: i,
    id: `${stream}-${String(i).padStart(4, "0")}`,
    repo: r.repo,
    commit: r.commit,
  }));
}

/** The `key=value` fields of a sample TSV's header line. */
export function sampleHeader(text) {
  const first = text.split("\n", 1)[0];
  if (!first.startsWith("# ")) return {};
  return Object.fromEntries(
    first
      .slice(2)
      .split(" ")
      .map((kv) => kv.split("="))
      .filter((p) => p.length === 2),
  );
}

/**
 * Why a study sample may not be drawn as asked, from the registry of
 * study/PREREG.md: the stream must be a registered sample, n its registered
 * size, and every sample it must exclude given as a study sample of that
 * stream. Returns a list of problems (empty when fine).
 */
export function registeredProblems(registry, { stream, n, excludeHeaders = [] }) {
  const reg = registry?.samples?.[stream];
  if (!reg) return [`${stream} is not a registered sample (${Object.keys(registry?.samples ?? {}).join(", ")})`];
  const problems = [];
  if (n !== reg.n) problems.push(`${stream} is registered with n = ${reg.n}, not ${n}`);
  for (const other of reg.exclude ?? [])
    if (!excludeHeaders.some((h) => h.stream === other && h.label === "study"))
      problems.push(`${stream} must exclude the study sample ${other} (--exclude its TSV)`);
  return problems;
}

export function sampleTsv(rows, header) {
  return [`# ${header}`, ...rows.map((r) => [r.index, r.id, r.repo, r.commit].join("\t"))].join("\n") + "\n";
}

function main(args) {
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const excludes = args.flatMap((a, i) => (a === "--exclude" ? [args[i + 1]] : []));
  const frameFile = opt("--frame");
  const n = Number(opt("--n"));
  const stream = opt("--stream");
  const out = opt("--out");
  const label = opt("--label") ?? "study";
  let seed = opt("--seed");
  const tag = opt("--seed-from-tag");
  if (!frameFile || !Number.isInteger(n) || n < 1 || !stream || !out || (!seed && !tag) || (seed && tag)) {
    console.error(
      "usage: node study/census/sample.mjs --frame F.tsv --n N --stream NAME (--seed HEX8 | --seed-from-tag TAG) --out S.tsv [--exclude S.tsv] [--seed-offset K] [--label pilot]",
    );
    return 2;
  }
  if (label === "study" && !tag) {
    console.error(
      "a study sample takes its seed from the prereg tag (--seed-from-tag); an explicit seed is for --label pilot only",
    );
    return 2;
  }
  if (label === "study") {
    const problems = registeredProblems(loadRegistry(), {
      stream,
      n,
      excludeHeaders: excludes.map((f) => sampleHeader(readFileSync(f, "utf8"))),
    });
    if (problems.length) {
      console.error(`refusing: ${problems.join("; ")} (study/PREREG.md, section 12)`);
      return 2;
    }
  }
  if (tag) seed = seedFromTag(tag).seed;
  const offset = Number(opt("--seed-offset") ?? 0);
  if (offset) seed = offsetSeed(seed, offset);
  const frameText = readFileSync(frameFile, "utf8");
  const exclude = new Set(excludes.flatMap((f) => readSample(readFileSync(f, "utf8")).map((r) => r.repo)));
  const rows = drawSample(readFrame(frameText), { n, seed, stream, exclude });
  const header = `label=${label} stream=${stream} seed=${seed}${offset ? ` (offset ${offset})` : ""} n=${rows.length} frame=${path.basename(frameFile)} frameSha256=${sha256(Buffer.from(frameText))} excluded=${exclude.size}`;
  const text = sampleTsv(rows, header);
  writeFileSync(out, text);
  console.log(header);
  console.log(`sample ${out}: ${rows.length} rows, SHA-256 ${sha256(Buffer.from(text))}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
