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
// A study sample is refused with a seed offset other than 0 (draw 1) or 1 (draw 2), and with an
// exclusion other than the registered one's first draw. The header records the draw and the offset.

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

/** A study sample is drawn once (seed offset 0, draw 1) and redrawn at most once (offset 1, draw 2). */
export const STUDY_SEED_OFFSETS = [0, 1];

/**
 * Why a study sample may not be drawn as asked, from the registry of
 * study/PREREG.md: the stream must be a registered sample, n its registered
 * size, the seed offset 0 (draw 1) or 1 (the one redraw, draw 2), and the
 * samples it excludes exactly the registered ones, each as the study sample's
 * first draw (S-imp, and its redraw, exclude the S-main draw S-imp was first
 * drawn against; a redrawn S-main is counted against it, not excluded).
 * Returns a list of problems (empty when fine).
 */
export function registeredProblems(registry, { stream, n, offset = 0, excludeHeaders = [] }) {
  const reg = registry?.samples?.[stream];
  if (!reg) return [`${stream} is not a registered sample (${Object.keys(registry?.samples ?? {}).join(", ")})`];
  const problems = [];
  if (n !== reg.n) problems.push(`${stream} is registered with n = ${reg.n}, not ${n}`);
  if (!STUDY_SEED_OFFSETS.includes(offset))
    problems.push(
      `a study sample is drawn with --seed-offset 0 (draw 1) or 1 (the one redraw, draw 2), not ${offset} (study/PREREG.md section 4)`,
    );
  const required = reg.exclude ?? [];
  for (const h of excludeHeaders) {
    if (h.label !== "study" || !required.includes(h.stream))
      problems.push(
        `${stream} excludes ${required.length ? `only the study sample${required.length > 1 ? "s" : ""} ${required.join(", ")}` : "nothing"}; --exclude ${h.stream ?? "(no stream)"} (label ${h.label ?? "none"}) is not registered`,
      );
    else if (h.draw !== "1")
      problems.push(
        `${stream} excludes ${h.stream}'s first draw (draw=1), the one it was first drawn against; ${h.stream}'s draw=${h.draw ?? "(none)"} is counted against it, not excluded`,
      );
  }
  for (const other of required)
    if (!excludeHeaders.some((h) => h.stream === other && h.label === "study" && h.draw === "1"))
      problems.push(`${stream} must exclude the study sample ${other}'s first draw (--exclude its draw=1 TSV)`);
  return problems;
}

/** The header line of a sample TSV: who drew it, which draw it is, from what. */
export function sampleHeaderText({ label, stream, seed, offset, n, frame, frameSha256, excluded }) {
  return `label=${label} stream=${stream} draw=${Number(offset) + 1} seed=${seed} seedOffset=${offset} n=${n} frame=${frame} frameSha256=${frameSha256} excluded=${excluded}`;
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
  const offset = Number(opt("--seed-offset") ?? 0);
  if (!Number.isInteger(offset) || offset < 0) {
    console.error(`--seed-offset must be a whole number of at least 0, not ${opt("--seed-offset")}`);
    return 2;
  }
  if (label === "study") {
    const problems = registeredProblems(loadRegistry(), {
      stream,
      n,
      offset,
      excludeHeaders: excludes.map((f) => sampleHeader(readFileSync(f, "utf8"))),
    });
    if (problems.length) {
      console.error(`refusing: ${problems.join("; ")} (study/PREREG.md, sections 4 and 12)`);
      return 2;
    }
  }
  if (tag) seed = seedFromTag(tag).seed;
  if (offset) seed = offsetSeed(seed, offset);
  const frameText = readFileSync(frameFile, "utf8");
  const exclude = new Set(excludes.flatMap((f) => readSample(readFileSync(f, "utf8")).map((r) => r.repo)));
  const rows = drawSample(readFrame(frameText), { n, seed, stream, exclude });
  const header = sampleHeaderText({
    label,
    stream,
    seed,
    offset,
    n: rows.length,
    frame: path.basename(frameFile),
    frameSha256: sha256(Buffer.from(frameText)),
    excluded: exclude.size,
  });
  const text = sampleTsv(rows, header);
  writeFileSync(out, text);
  console.log(header);
  console.log(`sample ${out}: ${rows.length} rows, SHA-256 ${sha256(Buffer.from(text))}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
