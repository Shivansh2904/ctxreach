// Check K5's draw: 25 real repositories from the measured census, by a seeded
// draw within three strata (study/PREREG.md, K5): 12 where map predicts the
// root AGENTS.md is shadowed at root launch, 8 importers where it predicts a
// headless session in a type-2 directory gets none of it, and 5 with no root
// CLAUDE.md-family file where it predicts delivery. Each repository is drawn
// once: a repository in two samples (S-imp and a redrawn S-main) is one
// repository, and its row is the first that qualifies by sample name. The
// draws are numbered K5-01 to K5-25 in the order drawn. The main session then
// runs `ctxreach verify` (2 capture trials) on each (repository, launch
// directory), and k5-score.mjs turns those runs into k5-results.json.
//
// Usage: node study/census/k5-select.mjs --rows rows-S-main.jsonl --rows rows-S-imp.jsonl --seed <hex8> [--out k5.tsv]
// The TSV's columns: id, stratum, repo, commit, launch directory.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rowsInUse } from "./lib/draws.mjs";
import { draw } from "./lib/prng.mjs";

export const K5_STRATA = [
  { name: "shadowed", n: 12, pick: (r) => r.outcomes.o1file?.event === true, launch: () => "." },
  {
    name: "importer-subdir",
    n: 8,
    pick: (r) => r.outcomes.o2?.event === true,
    launch: (r) => r.outcomes.o2.eventDirs[0],
  },
  {
    name: "no-claude-md",
    n: 5,
    pick: (r) =>
      r.outcomes.o1file?.eligible === true &&
      r.outcomes.o1file.event === false &&
      !r.files.some((f) => ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"].includes(f.path)),
    launch: () => ".",
  },
];

/** Census rows from JSONL files: the rows in use (a redrawn sample's first draw is left out, study/PREREG.md section 4). */
export function readRowFiles(files) {
  return rowsInUse(
    files.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    ),
  );
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function selectK5(rows, seed) {
  // Canonical order: repository, then sample (frame) name, then commit.
  const usable = rows
    .filter((r) => r.status === "measured" && !(r.faults ?? []).length)
    .sort((a, b) => cmp(a.repo, b.repo) || cmp(String(a.frame), String(b.frame)) || cmp(a.commit, b.commit));
  const taken = new Set();
  const out = [];
  for (const s of K5_STRATA) {
    // Each repository once in a stratum's pool, and never one an earlier stratum drew.
    const inPool = new Set();
    const pool = usable.filter((r) => {
      if (taken.has(r.repo) || inPool.has(r.repo) || !s.pick(r)) return false;
      inPool.add(r.repo);
      return true;
    });
    for (const r of draw(pool, s.n, seed, `K5|${s.name}`)) {
      taken.add(r.repo);
      out.push({ stratum: s.name, repo: r.repo, commit: r.commit, launchDir: s.launch(r) });
    }
  }
  return out.map((p, i) => ({ id: `K5-${String(i + 1).padStart(2, "0")}`, ...p }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.flatMap((a, i) => (a === "--rows" ? [args[i + 1]] : []));
  const seedAt = args.indexOf("--seed");
  const outAt = args.indexOf("--out");
  if (!files.length || seedAt < 0) {
    console.error("usage: node study/census/k5-select.mjs --rows rows.jsonl [...] --seed HEX8 [--out k5.tsv]");
    process.exit(2);
  }
  const picked = selectK5(readRowFiles(files), args[seedAt + 1]);
  const tsv = picked.map((p) => [p.id, p.stratum, p.repo, p.commit, p.launchDir].join("\t")).join("\n") + "\n";
  if (outAt >= 0) writeFileSync(args[outAt + 1], tsv);
  process.stdout.write(tsv);
  for (const s of K5_STRATA) console.error(`${s.name}: ${picked.filter((p) => p.stratum === s.name).length}/${s.n}`);
}
