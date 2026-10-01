// Freeze a sampling frame from Sourcegraph (study/PREREG.md, "Frames").
//
// Unauthenticated GETs to Sourcegraph's streaming search API, through the
// GET-only client, one query at a time. The file matches give each
// repository and the commit Sourcegraph indexed, which becomes the unit's
// pinned commit. The list is sorted by repository and written as a TSV; its
// SHA-256 is the frame's record.
//
// The same query runs twice, and the two answers must list the same
// repositories, apart from index churn (at most 5, or 0.1% of the list).
// Each answer must end with its done event, carry no alert,
// report as many matches as it delivered, and skip nothing but Sourcegraph's
// default fork and archive exclusions.
//
// Why not a select:repo count as the cross-check: on 2026-09-30 the pilot
// freeze found `select:repo count:all` for frame S returning 25,742 and then
// 24,726 repositories within minutes, each after about 70 s and each with
// done:true and no alert, while the file-match list gave 26,022. A count that
// can be silently partial cannot check anything; a repeat of the list can.
//
// Usage: node study/census/frame.mjs --frame S|S-imp|S-ci|K3 --label study|pilot [--out dir]
// Exit: 0 valid; 1 a check failed; 3 a non-GET attempt was counted.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetOnlyClient, installFetchGuard } from "./lib/client.mjs";
import { sha256 } from "./lib/paths.mjs";
import { readStream } from "./lib/sse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SG = "https://sourcegraph.com/.api/search/stream";

/** The pre-registered frame queries, verbatim. */
export const FRAMES = {
  S: {
    query: String.raw`file:^AGENTS\.md$ case:yes count:all`,
    about: "every non-fork, non-archived repository with a root AGENTS.md, exact case",
  },
  "S-imp": {
    query: String.raw`file:^CLAUDE\.md$ case:yes patterntype:regexp ^@AGENTS\.md count:all`,
    about: "repositories whose root CLAUDE.md has a line starting @AGENTS.md",
  },
  "S-ci": {
    query: String.raw`file:^AGENTS\.md$ count:all`,
    about:
      "root AGENTS.md in any case (Sourcegraph matches file names without case by default); minus frame S, the case-variant stratum (counted and reported, never pooled)",
  },
};

/**
 * K3's census counts, as file-match lists: root CLAUDE.md files in
 * repositories with a root AGENTS.md, and those of them whose text contains
 * @AGENTS.md. The census proportion is (claude - claudeImport) / |S|.
 */
export const K3_LISTS = {
  claude: String.raw`file:^CLAUDE\.md$ case:yes repo:has.file(path:^AGENTS\.md$) count:all`,
  claudeImport: String.raw`file:^CLAUDE\.md$ case:yes repo:has.file(path:^AGENTS\.md$) patterntype:regexp @AGENTS\.md count:all`,
};

/** Largest share of repositories the two answers may disagree on (index churn), above an allowance of CHURN_ALLOWANCE. */
export const CHURN_TOLERANCE = 0.001;
export const CHURN_ALLOWANCE = 5;

/** Sourcegraph's default exclusions, by the reason names it reported on 2026-09-30. */
export const ALLOWED_SKIPS = new Set(["repository-fork", "excluded-fork", "excluded-archive"]);

export function searchUrl(query) {
  return `${SG}?v=V3&t=keyword&display=500000&q=${encodeURIComponent(query)}`;
}

/** Run one streaming query; returns matches and the stream's own completion signals. */
export async function streamSearch(client, query) {
  const res = await client.get(searchUrl(query), { accept: "text/event-stream", stream: true });
  if (res.status !== 200) return { status: res.status, matches: [], alerts: [], skipped: [], done: false };
  const out = { status: 200, matches: [], alerts: [], skipped: [], done: false, progress: undefined };
  await readStream(res.body, (event, json) => {
    if (event === "matches" && Array.isArray(json)) out.matches.push(...json);
    else if (event === "alert") out.alerts.push(json?.title ?? "alert");
    else if (event === "progress") {
      out.progress = json;
      if (json?.done) out.done = true;
      for (const s of json?.skipped ?? []) if (!out.skipped.includes(s.reason)) out.skipped.push(s.reason);
    } else if (event === "done") out.done = true;
  });
  return out;
}

/** Distinct repositories, sorted: [{ repo: "owner/name", host, commit, path, stars }]. */
export function frameRows(matches) {
  const byRepo = new Map();
  for (const m of matches) {
    const full = m.repository ?? m.name;
    if (!full || byRepo.has(full)) continue;
    const [host, ...rest] = full.split("/");
    byRepo.set(full, {
      repo: rest.join("/"),
      host,
      commit: m.commit ?? "",
      path: m.path ?? "",
      stars: m.repoStars ?? "",
    });
  }
  return [...byRepo.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v);
}

export function toTsv(rows) {
  return rows.map((r) => [r.repo, r.commit, r.path, r.stars].join("\t")).join("\n") + (rows.length ? "\n" : "");
}

/** Problems with one answer, on its own. */
export function streamProblems(r, name = "answer") {
  const problems = [];
  if (r.status !== 200) problems.push(`${name}: HTTP ${r.status}`);
  if (!r.done) problems.push(`${name}: the stream never reported done`);
  if (r.alerts.length) problems.push(`${name}: alerts: ${r.alerts.join("; ")}`);
  const odd = r.skipped.filter((s) => !ALLOWED_SKIPS.has(s));
  if (odd.length) problems.push(`${name}: skipped for other reasons: ${odd.join(", ")}`);
  // Sourcegraph counts each matching line of a content match, and one per path match.
  const said = r.progress?.matchCount;
  const delivered = r.matches.reduce((n, m) => n + (m.lineMatches?.length || m.chunkMatches?.length || 1), 0);
  if (said !== undefined && said !== delivered)
    problems.push(`${name}: reported ${said} matches, delivered ${delivered}`);
  return problems;
}

/**
 * Validity checks for a frozen frame: both answers sound, the same
 * repositories in both, every repository with a commit. An indexed commit
 * that moved between the two answers (Sourcegraph re-indexing while we ask)
 * is counted, not a failure; the first answer's commit is the one recorded.
 */
export function frameChecks(first, second, rows) {
  const problems = [...streamProblems(first, "first answer"), ...streamProblems(second, "second answer")];
  const a = new Map(frameRows(first.matches).map((r) => [`${r.host}/${r.repo}`, r.commit]));
  const b = new Map(frameRows(second.matches).map((r) => [`${r.host}/${r.repo}`, r.commit]));
  const onlyFirst = [...a.keys()].filter((k) => !b.has(k)).length;
  const onlySecond = [...b.keys()].filter((k) => !a.has(k)).length;
  const commitMoved = [...a.entries()].filter(([k, c]) => b.has(k) && b.get(k) !== c).length;
  // Re-indexing while we ask moves a handful of repositories; a silently partial answer loses hundreds.
  if (onlyFirst + onlySecond > Math.max(CHURN_ALLOWANCE, CHURN_TOLERANCE * a.size))
    problems.push(
      `the two answers differ: ${onlyFirst} repositories only in the first, ${onlySecond} only in the second`,
    );
  const noCommit = rows.filter((r) => !/^[0-9a-f]{40}$/.test(r.commit)).length;
  if (noCommit) problems.push(`${noCommit} repositories have no indexed commit`);
  return { problems, onlyFirst, onlySecond, commitMoved };
}

async function freezeList(client, query) {
  const first = await streamSearch(client, query);
  const second = await streamSearch(client, query);
  const rows = frameRows(first.matches);
  return { first, second, rows, ...frameChecks(first, second, rows) };
}

async function main(args) {
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const frame = opt("--frame");
  const label = opt("--label");
  if (!frame || !label || !(frame in FRAMES || frame === "K3") || !["study", "pilot"].includes(label)) {
    console.error("usage: node study/census/frame.mjs --frame S|S-imp|S-ci|K3 --label study|pilot [--out dir]");
    return 2;
  }
  const out = path.resolve(opt("--out") ?? path.join(HERE, "data", label === "pilot" ? "pilot" : "frames"));
  mkdirSync(out, { recursive: true });
  const client = new GetOnlyClient({ minIntervalMs: 2000, log: (l) => console.error(l) });
  installFetchGuard(client);
  const date = new Date().toISOString().slice(0, 10);
  const started = Date.now();
  let manifest;
  if (frame === "K3") {
    const counts = {};
    const problems = [];
    for (const [key, query] of Object.entries(K3_LISTS)) {
      const f = await freezeList(client, query);
      counts[key] = f.rows.filter((r) => r.host === "github.com").length;
      counts[`${key}Churn`] = { onlyFirst: f.onlyFirst, onlySecond: f.onlySecond };
      problems.push(...f.problems.map((p) => `${key}: ${p}`));
    }
    manifest = { schema: "ctxreach.study-frame/v1", label, frame, queries: K3_LISTS, counts, problems };
  } else {
    const spec = FRAMES[frame];
    const f = await freezeList(client, spec.query);
    const github = f.rows.filter((r) => r.host === "github.com");
    const tsv = toTsv(github);
    const file = path.join(out, `${frame}-${date}.tsv`);
    writeFileSync(file, tsv);
    manifest = {
      schema: "ctxreach.study-frame/v1",
      label,
      frame,
      about: spec.about,
      query: spec.query,
      matches: [f.first.matches.length, f.second.matches.length],
      repos: github.length,
      nonGithub: f.rows.length - github.length,
      file: path.basename(file),
      sha256: sha256(Buffer.from(tsv, "utf8")),
      skipped: f.first.skipped,
      alerts: f.first.alerts,
      commitMovedBetweenAnswers: f.commitMoved,
      churnBetweenAnswers: { onlyFirst: f.onlyFirst, onlySecond: f.onlySecond },
      problems: f.problems,
    };
  }
  manifest.fetchedAt = new Date().toISOString();
  manifest.durationMs = Date.now() - started;
  manifest.valid = manifest.problems.length === 0;
  manifest.client = client.summary();
  writeFileSync(path.join(out, `${frame}-${date}.manifest.json`), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
  console.log(client.summary());
  if (client.nonGetAttempts) return 3;
  return manifest.valid ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
