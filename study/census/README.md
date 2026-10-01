# Census scripts

The census of `study/PREREG.md` (sections 3 to 8): freeze a frame, draw a
sample, rebuild each sampled repository's instruction files at its pinned
commit, run `ctxreach map --json` from every launch directory as a fresh
machine would, and turn the rows into `results.json`. Every network request
goes through one GET-only client (`lib/client.mjs`), and every script
prints its count of non-GET attempts at the end (check K7).

| Script | What it does |
|---|---|
| `frame.mjs` | Freezes a Sourcegraph frame (S, S-imp, S-ci) or K3's two census lists: the query twice, both answers checked, the TSV and its SHA-256 in a manifest |
| `sample.mjs` | Draws a sample from a frozen frame with the seeded Fisher-Yates shuffle of `lib/prng.mjs`; a study sample must use the registered stream, size and exclusion (S-main's first draw, for S-imp) and the seed from the `prereg-v1` tag, with `--seed-offset` 0 (draw 1) or 1 (the one redraw, draw 2), from the frame TSV whose SHA-256 the tagged PREREG.md stamps, while PREREG.md is unchanged above its Deviations heading; the header records the draw and n |
| `seed.mjs` | Prints the seed: the first 8 hex digits of the commit `prereg-v1` points to (refuses before the tag exists, or when the tagged PREREG.md still holds a `{{stamp:...}}` placeholder); study runs read the registration and its stamps from that tagged copy |
| `recon.mjs` | Rebuilds one repository's instruction files at a commit (tree, blob-checked files, links recorded, import targets, launch directories) |
| `measure.mjs`, `detectors.mjs` | Runs `map --json` from each launch directory (in this process, `lib/maprun.mjs`) and computes every outcome; output-side checks turn a leak into a fault |
| `codex-check.mjs` | Check K4: `codex debug prompt-input` against `map`'s predicted bytes, twice per pair, throwaway `CODEX_HOME` |
| `pipeline.mjs` | One unit end to end, then deletes the reconstruction; K1 uses the same function |
| `run-census.mjs` | Runs a sample, serial and resumable, with the seed from the `prereg-v1` tag; `map` in process from the built library, checked against the spawned CLI on every 25th unit of the sample, by position, so a resumed run checks the same units (a difference is a fault on the row); api.github.com through `gh api`; refuses under an instruction file, on low disk, with another build than `--expect-dist`, when `gh api rate_limit` does not answer, on a sample whose header's n is not its number of units, and for a study run on a sample of another stream or seed, without `--expect-dist` or with another digest than the tag stamps, with another `--claude-version` than the registered one, without `--codex-bin`, with a Codex other than the registered version, while PREREG.md differs from the tagged copy above its Deviations heading, or into a rows file holding another sample's rows; every row records its draw, sample and its n (`sampleN`), build, Codex version and platform |
| `analyze.mjs` | Rows to `results.json`: Wilson intervals per frame, raw, blob-deduplicated and owner-capped, each outcome's left-out repositories by reason, the figures that are not proportions (`summaries`), and the registered verdicts; a draw's lost share is over its n, a redrawn sample replaces its first draw, which is reported as `<frame>-draw1`, and `lib/draws.mjs` refuses rows that would pool draws, samples, builds, versions or platforms, and a study draw with rows for fewer units than its n; rows with a fault are left out of every figure, K3 and K4; K4 is one figure over both frames in use, with each frame's own beside it (`checks.K4.byFrame`), so frames in use that differ in build, Codex version, platform or label are refused |
| `known-answer.mjs` | Check K1: every fixture with a hand-derived answer (`known-answers.json`) through the pipeline, network replaced by local files, `map` in process as in the census (`--spawn` for the CLI) |
| `plant-census-faults.mjs` | Check K2: each detector and pipeline step switched off in turn; K1 must fail each time |
| `consistency.mjs` | Check K3: the regex version of O1-file in the sample against the frame's own proportion |
| `k5-select.mjs` | Draws K5's 25 repositories (K5-01 to K5-25) from the measured rows in use without faults (a redrawn sample's first draw is left out; a repository in two samples is drawn once), with the seed from the `prereg-v1` tag; a typed `--seed` is refused unless `--label pilot` |
| `k5-score.mjs` | Check K5's figure: one `ctxreach verify --agent claude --trials 2 --json` output per drawn repository (`<dir>/K5-xx.json`) to `k5-results.json`, agreement k/n over decided cells with its Wilson interval, per stratum, disagreements by id and void runs; refuses a missing run, another agent, instrument, Claude Code version or number of trials |
| `dist-digest.mjs` | The build's fingerprint for the `study-v1` freeze |
| `time-map.mjs` | Times `map` per launch directory, spawned CLI against in process, over the pilot fixtures (`--k1`, `--synthetic N` for more) and compares every pair of answers |

`study/prereg.mjs` checks PREREG.md's registry against these scripts and
fills its tag-time values (in the text and the `prereg-stamps` block); once
`prereg-v1` exists, `check` also fails when PREREG.md changed above its
Deviations heading or a deviation was edited in place (`check --tagged`
fails before the tag exists, too).

**K1 on 2026-10-01: 55/55, a pass**, over the 44 fixtures in
`test/fixtures/` and the 11 in `known-answer-fixtures/`. The 16 fixtures
the map-rules lane added were answered by hand from `docs/rules.md`
before K1 was run on them. `census-o2-external-import`, listed until then
as a known `map` defect, passes since the map-rules fix merged, and
`knownDefects` is empty. `census-o7-symlink-twin`'s answer follows the
rule that a `CLAUDE.md` holding only a path raises `claude.link-as-text`
instead of `claude.words-not-import` (its note says what changed). The 55
answers cover 49 distinct inputs: six pairs of fixtures are byte-identical
once only `repo/` is served (PREREG.md section 8, "What K1 covers", which
also lists the answer fields no answer pins).

## Order in the main session

```
# the tool commit is final: tag it, then build dist/ from exactly those sources
git tag study-v1        # prereg.mjs stamp refuses without it, or if src/, package*.json, tsup or tsconfig differ from it
npm run build           # prereg.mjs stamp refuses a dist/cli.js whose --version is not study-v1's package.json version
node study/census/known-answer.mjs                          # K1: n/n
node study/census/plant-census-faults.mjs                   # K2: all caught
node study/census/frame.mjs --frame S --label study         # and S-imp, S-ci, K3
node study/prereg.mjs stamp --study-tag study-v1 --frames study/census/data/frames --write
git commit study/PREREG.md && git tag prereg-v1   # Shiv pushes both tags and opens the issue (G1)
node study/census/seed.mjs
node study/census/sample.mjs --frame <S.tsv> --n 1100 --stream S-main --seed-from-tag prereg-v1 --out S-main.tsv
node study/census/sample.mjs --frame <S-imp.tsv> --n 385 --stream S-imp --seed-from-tag prereg-v1 --exclude S-main.tsv --out S-imp.tsv
gh auth status          # api.github.com is read through gh api; ctxreach reads no token
node study/census/run-census.mjs --sample S-main.tsv --frame-name S-main \
  --seed-from-tag prereg-v1 --out rows-S-main.jsonl --work C:/ctxr-census --expect-dist <digest> --codex-bin <codex.js>
# and the same for S-imp.tsv (--frame-name S-imp, --out rows-S-imp.jsonl); an interrupted run is run again
# with the same arguments until every unit has its row (analyze.mjs refuses an incomplete study draw)
node study/census/analyze.mjs --rows rows-S-main.jsonl --rows rows-S-imp.jsonl \
  --k3 <K3.manifest.json> --frame-manifest <S.manifest.json> --out results.json
# only if analyze marks a sample redrawRequired (over 10% lost), redraw it once (PREREG.md section 4),
# into its own sample and rows files; S-imp's redraw still excludes S-main.tsv (S-main's first draw):
node study/census/sample.mjs --frame <S.tsv> --n 1100 --stream S-main --seed-from-tag prereg-v1 --seed-offset 1 --out S-main-draw2.tsv
node study/census/run-census.mjs --sample S-main-draw2.tsv --frame-name S-main \
  --seed-from-tag prereg-v1 --out rows-S-main-draw2.jsonl --work C:/ctxr-census --expect-dist <digest> --codex-bin <codex.js>
node study/census/analyze.mjs --rows rows-S-main.jsonl --rows rows-S-main-draw2.jsonl --rows rows-S-imp.jsonl \
  --k3 <K3.manifest.json> --frame-manifest <S.manifest.json> --out results.json   # S-main = the redraw; S-main-draw1 reported apart
# K5 from the rows in use, then one ctxreach verify run per drawn repository, saved as C:/ctxr-k5/verify/K5-xx.json:
node study/census/k5-select.mjs --rows rows-S-main.jsonl --rows rows-S-imp.jsonl --seed-from-tag prereg-v1 --out C:/ctxr-k5/k5.tsv
node study/census/k5-score.mjs --selection C:/ctxr-k5/k5.tsv --verify C:/ctxr-k5/verify --out C:/ctxr-k5/k5-results.json
# K6 after the census (study/handcheck/PROTOCOL.md):
node study/handcheck/handcheck.mjs draw --rows rows-S-main.jsonl --rows rows-S-imp.jsonl --seed-from-tag prereg-v1 --out C:/ctxr-k6/pairs.json
node study/handcheck/handcheck.mjs sheets --rows rows-S-main.jsonl --rows rows-S-imp.jsonl --pairs C:/ctxr-k6/pairs.json --out C:/ctxr-k6
# a fresh reader fills C:/ctxr-k6/reader/answers/, then:
node study/handcheck/handcheck.mjs score --out C:/ctxr-k6
node study/prereg.mjs check --tagged   # PREREG.md unchanged above Deviations since prereg-v1
```

What is published per repository is `owner/repo@commit`, measurements and
blob ids, never file contents, and no repository is named for a defect.
Repository owners can opt out by opening an issue on
github.com/Shivansh2904/ctxreach; there is no email address to write to.
PREREG.md section 10 says what an opt-out removes.

The work folder must have no instruction file in it or above it
(`C:/ctxr-census` qualifies on this machine; a folder under a home that
has `~/.claude/CLAUDE.md` would not).

## Pilot dry runs (2026-09-30): pilot data, not results

Two dry runs of 20 repositories each went through these scripts against
the live services, from a **pilot seed** (`cf72741e`), never the study
seed. Their rows are not kept and their outcome fractions are not
reported anywhere; the hypotheses in PREREG.md come from the plan, were
fixed before either run, and were not changed after them.

| | Run 1 (17:02-17:09 UTC) | Run 2 (20:20-20:34 UTC, final code) |
|---|---|---|
| Frame S | 26,014 repositories (two identical answers) | 26,030 (two identical answers, churn 0) |
| Other frames | K3: 11,320 with a root `CLAUDE.md`, 3,383 with `@AGENTS.md` | S-imp 3,181; K3: 11,328 and 3,386 |
| Sourcegraph GETs | 2 (S) + 4 (K3) | 2 + 2 + 4 |
| Units measured | 20/20, 0 excluded, 0 with faults | 20/20, 0 excluded, 0 with faults |
| GitHub GETs | 44 API + 44 raw | 49 API + 199 raw |
| Retries, waits | 0, 17 s pacing | 0, 8 s pacing |
| Largest reconstruction | 56,624 bytes | 873,391 bytes |
| Wall time | about 2 minutes | 11 minutes, 390 s of it one repository with 171 launch directories |
| K3 (pilot) | not run | pass: frame 30.51% inside the sample's [25.82%, 65.79%] |
| Non-GET attempts | 0 | 0 |

What the dry runs say about the budget (for the main session):

- **GitHub API.** About 2.45 core API GETs per repository (the metadata,
  the tree, and a blob for each symlink); raw file reads do not count
  against the core limit. 1,485 repositories need about 3,600 core GETs, so
  the census reads api.github.com through the GitHub CLI's own login
  (`gh api -X GET --include`; ctxreach never sees a token): the
  unauthenticated limit of 60 an hour would take about 60 hours.
  `run-census.mjs` no longer reads a token variable (the dry runs' code
  did); it asks `gh api rate_limit` before the first unit and refuses to
  start without an answer.
- **Time** (as the dry runs ran, before the changes below). Each launch
  directory cost one spawned `map` process, about 2.3 s on the pilot day. Most repositories have 1 to 7 launch directories, but the
  type-2 cap is 200 and one pilot repository had 171 (6.5 minutes on its
  own). Over the two runs the mean was about 20 s per repository, which
  projects to about 8 hours for 1,485 repositories before K4, against the
  plan's 2.5 hours. K4 renders twice per type-1 and type-2 pair (about
  1.6 s each).
- **Pairs.** The same repository contributed 151 of the 179 type-1 and
  type-2 pairs in run 2, which is why P1-pairs is secondary to P1-repos and
  its interval is marked as ignoring clustering.
- **Disk.** Reconstructions are deleted per repository; the largest was
  under 1 MB.

## Time projection (2026-10-01)

Three changes since the dry runs: `map` runs in the census's own process,
type-2 launch directories are capped at 20 per repository (was 200), and
api.github.com is read through `gh api`.

**map per launch directory**, `node study/census/time-map.mjs --k1
--synthetic 150 --rounds 3` on this machine (Node 22.19.0, Windows 11), the
spawned CLI once per directory against the same build in process (median
of 3); every pair of answers identical (81/81):

| Repositories | Launch directories | Spawned CLI, mean (median) | In process, mean (median) |
|---|---|---|---|
| Pilot fixtures (`study/pilot/**/repo`, 5) | 8 | 264 ms (244) | 28 ms (28) |
| K1 fixtures (39) | 52 | 244 ms (240) | 25 ms (25) |
| Made-up repository with 150 packages (the pilot's largest had 171 launch directories) | 21 | 419 ms (392) | 172 ms (163) |

An earlier run a few minutes before gave 278 and 249 ms spawned, 32 and 26 ms
in process, for the first two rows. The one-off cost in process is about
0.3 s per run (the import and one `cli.js --version`). The spawned cost
measured today is well below the 2.3 s of the pilot day, so the saving
per directory is 0.2 to 0.25 s here, not 2 s; in process, map's own work
on many instruction files (the last row) is what remains.

**Projection for 1,485 repositories**, from these inputs: after the cap,
pilot run 2 had 49 type-1 and type-2 launch directories over 20
repositories (2.45 each; 179 before the cap), type-3 directories were not
counted then and are at most 20 per repository; K4 renders twice per
type-1 and type-2 pair at about 1.6 s a render; about 2.45 core API GETs
per repository, each now starting `gh` (about 0.13 s, `gh --version`
timed here) on top of the request, with 250 ms between requests.

| Part | Estimate |
|---|---|
| `map` | 2.45 type-1/2 directories plus the type-3 ones at about 0.03 s each: about 4 minutes in all with 3 type-3 directories a repository, about 17 with 20 (and at most 41 directories, about 7 s, for a repository that fills both caps at the 150-package cost) |
| K4 | 2.45 pairs x 2 renders x 1.6 s, about 8 s a repository: about 3.2 hours (about 11.8 hours at the uncapped pilot mean of 8.95 pairs) |
| GitHub and raw reads | about 4 requests a repository at 0.25 to 0.5 s: about 25 to 50 minutes |
| Total | about 4 hours serial with K4, under 1 hour without it |

These are projections from a 20-repository pilot with one outlier, not
measurements; the first study run's manifest records the real figures.
