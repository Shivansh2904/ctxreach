// Check K6, the blind second reader: draw the pairs, write the reader's
// folder, score the answers. The protocol is study/handcheck/PROTOCOL.md.
//
//   node study/handcheck/handcheck.mjs draw   --rows rows-S-main.jsonl --rows rows-S-imp.jsonl --seed <hex8> --out <k6>/pairs.json
//   node study/handcheck/handcheck.mjs sheets --rows ... --pairs <k6>/pairs.json --out <k6>
//   node study/handcheck/handcheck.mjs score  --out <k6>
//   node study/handcheck/handcheck.mjs clean  --out <k6>
//
// `sheets` rebuilds each drawn repository at its census commit through the
// GET-only client (api.github.com through gh api, as for the census), checks every file
// against the census row's blob ids, and writes:
//   <k6>/reader/            the only folder the reader gets
//     rules.md              docs/rules.md of this build
//     READER-BRIEF.md       the reader's instructions
//     sheets/K6-xx.md       the files of each pair (repository text: never committed or published)
//     answers/K6-xx.json    blank answers
//   <k6>/key.json           map's answers from the census rows (not for the reader)
//   <k6>/manifest.json      SHA-256 of the key, rules.md and each sheet, recorded before the reader starts
// `score` writes <k6>/k6-results.json and <k6>/adjudication.md and prints x/n.
// `clean` deletes the sheets (the repositories' text) once adjudication is done.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetOnlyClient } from "../census/lib/client.mjs";
import { rowsInUse } from "../census/lib/draws.mjs";
import { reconstruct } from "../census/recon.mjs";
import {
  adjudicationSheet,
  blankAnswer,
  checkBlind,
  drawPairs,
  keyFor,
  KEY_SCHEMA,
  renderSheet,
  scoreAll,
  sha256,
} from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
export const RULES = path.join(ROOT, "docs", "rules.md");
export const BRIEF = path.join(HERE, "READER-BRIEF.md");

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

/** The census row's files against the rebuilt ones, by path, mode and blob id. */
function sameFiles(row, recon) {
  const sig = (fs) =>
    fs
      .map((f) => `${f.path}\t${f.mode}\t${f.sha}`)
      .sort()
      .join("\n");
  return sig(row.files) === sig(recon.files);
}

/**
 * Write the reader's folder, the key and the manifest.
 * @param {object} o
 * @param {GetOnlyClient} o.client
 * @param {object[]} o.rows census rows
 * @param {object[]} o.pairs from drawPairs
 * @param {string} o.out
 * @param {string} [o.rulesFile]
 * @param {string} [o.briefFile]
 * @param {(line: string) => void} [o.log]
 * @param {typeof renderSheet} [o.render] the sheet writer (tests plant a leak through it)
 */
export async function makeSheets({
  client,
  rows,
  pairs,
  out,
  rulesFile = RULES,
  briefFile = BRIEF,
  log = () => {},
  render = renderSheet,
}) {
  const reader = path.join(out, "reader");
  if (existsSync(reader)) throw new Error(`${reader} exists: K6 sheets are written once`);
  mkdirSync(path.join(reader, "sheets"), { recursive: true });
  mkdirSync(path.join(reader, "answers"), { recursive: true });
  copyFileSync(rulesFile, path.join(reader, "rules.md"));
  copyFileSync(briefFile, path.join(reader, "READER-BRIEF.md"));
  const rowOf = new Map(rows.map((r) => [`${r.repo}@${r.commit}`, r]));
  const keys = [];
  const sheets = {};
  for (const p of pairs) {
    const row = rowOf.get(`${p.repo}@${p.commit}`);
    if (!row) throw new Error(`${p.id}: no census row for ${p.repo}@${p.commit}`);
    const key = { id: p.id, ...keyFor(row, p.dir) };
    const work = path.join(out, "tmp", p.id);
    rmSync(work, { recursive: true, force: true });
    try {
      const recon = await reconstruct({
        client,
        repo: p.repo,
        commit: p.commit,
        dir: path.join(work, "repo"),
        seed: "00000000",
      });
      if (recon.status !== "ok") throw new Error(`${p.id}: the rebuild was excluded (${recon.exclusion})`);
      if (!sameFiles(row, recon)) throw new Error(`${p.id}: the rebuilt files differ from the census row's`);
      const sheet = render(p, recon);
      const leaks = checkBlind(sheet, key);
      if (leaks.length) throw new Error(`${p.id}: the sheet is not blind: ${leaks.join("; ")}`);
      writeFileSync(path.join(reader, "sheets", `${p.id}.md`), sheet);
      writeFileSync(path.join(reader, "answers", `${p.id}.json`), JSON.stringify(blankAnswer(p.id), null, 2) + "\n");
      sheets[p.id] = sha256(sheet);
      keys.push(key);
      log(`${p.id}: sheet written (${recon.files.length} files)`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  rmSync(path.join(out, "tmp"), { recursive: true, force: true });
  const keyText = JSON.stringify({ schema: KEY_SCHEMA, pairs: keys }, null, 2) + "\n";
  writeFileSync(path.join(out, "key.json"), keyText);
  const manifest = {
    schema: "ctxreach.k6-manifest/v1",
    created: new Date().toISOString(),
    pairs: pairs.length,
    keySha256: sha256(keyText),
    rulesSha256: sha256(readFileSync(rulesFile)),
    briefSha256: sha256(readFileSync(briefFile)),
    sheets,
    nonGetAttempts: client.nonGetAttempts,
  };
  writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/** Score the reader's answers; refuses a key whose SHA-256 moved since the sheets were written. */
export function score(out) {
  const keyText = readFileSync(path.join(out, "key.json"), "utf8");
  const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
  if (sha256(keyText) !== manifest.keySha256) throw new Error("key.json changed after the sheets were written");
  const key = JSON.parse(keyText);
  const answers = {};
  const dir = path.join(out, "reader", "answers");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      answers[f.replace(/\.json$/, "")] = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
    } catch {
      answers[f.replace(/\.json$/, "")] = { schema: "unparseable" };
    }
  }
  const result = scoreAll(key, answers);
  writeFileSync(path.join(out, "k6-results.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(path.join(out, "adjudication.md"), adjudicationSheet(result));
  return result;
}

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const rowFiles = args.flatMap((a, i) => (a === "--rows" ? [args[i + 1]] : []));
  const out = arg(args, "--out");
  try {
    if (cmd === "draw") {
      const seed = arg(args, "--seed");
      if (!rowFiles.length || !seed || !out)
        throw new Error("usage: draw --rows rows.jsonl [...] --seed HEX8 --out pairs.json");
      const pairs = drawPairs(readRowFiles(rowFiles), seed, Number(arg(args, "--n") ?? 30));
      writeFileSync(out, JSON.stringify(pairs, null, 2) + "\n");
      console.log(`drew ${pairs.length} pairs (types ${[...new Set(pairs.map((p) => p.type))].sort().join(", ")})`);
    } else if (cmd === "sheets") {
      const pairsFile = arg(args, "--pairs");
      if (!rowFiles.length || !pairsFile || !out)
        throw new Error("usage: sheets --rows rows.jsonl [...] --pairs pairs.json --out DIR");
      const client = new GetOnlyClient({ log: (l) => console.error(l) });
      try {
        const m = await makeSheets({
          client,
          rows: readRowFiles(rowFiles),
          pairs: JSON.parse(readFileSync(pairsFile, "utf8")),
          out,
          log: (l) => console.log(l),
        });
        console.log(`key SHA-256 ${m.keySha256}; give ${path.join(out, "reader")} and nothing else to the reader`);
      } finally {
        console.log(`non-GET attempts: ${client.nonGetAttempts}`);
      }
      if (client.nonGetAttempts) process.exitCode = 3;
    } else if (cmd === "score") {
      if (!out) throw new Error("usage: score --out DIR");
      const r = score(out);
      console.log(`K6: ${r.printed.pairs} pairs agree; Claude ${r.printed.claude}; Codex ${r.printed.codex}`);
      console.log(`${r.disagreements.length} to adjudicate in ${path.join(out, "adjudication.md")}`);
    } else if (cmd === "clean") {
      if (!out) throw new Error("usage: clean --out DIR");
      rmSync(path.join(out, "reader", "sheets"), { recursive: true, force: true });
      console.log(`removed ${path.join(out, "reader", "sheets")}`);
    } else {
      throw new Error("usage: handcheck.mjs draw|sheets|score|clean ...");
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = process.exitCode || 1;
  }
}
