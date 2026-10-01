# ctxreach study v1: pre-registration

This file is the study's registration. It is committed and tagged
`prereg-v1` before any sampled repository is fetched, and nothing above the
**Deviations** heading changes after that tag. Deviations are appended at
the end, dated, and never edited in place.

The machine-checkable part is the `prereg-registry` block in section 12:
`node study/prereg.mjs check` compares it with the code that runs the
study, and a test (`test/study-census.test.ts`) fails when they differ.
Values that exist only at tag time are written `{{stamp:<key>}}` until
`node study/prereg.mjs stamp --write` fills them; `study/census/seed.mjs`
refuses to give a seed from a tagged file that still holds one.

## 0. The question and the headline sentence

Coding agents read instruction files (`AGENTS.md`, `CLAUDE.md` and
friends) by rules that differ between agents. The study asks how often, in
public repositories that ship an `AGENTS.md`, Claude Code and Codex start a
session with different instructions from the same repository, and why.

The headline sentence is fixed now. A script fills its numbers from
`results.json` and `cells-results.json`; nobody types them. The script is
written after the tag (section 13, step 9) and only reads those two files:

> Same repo, different instructions. In k/n (x%, [lo, hi]) of public
> repositories with an AGENTS.md, Claude Code starts with under half of that
> file's text; in j/m launch directories Codex cuts or drops a chain file, as
> rendered by Codex's own `debug prompt-input`. And a personal
> `~/.claude/CLAUDE.md` switched AGENTS.md off in a/u vs b/v runs depending
> only on where the repository lives.

- k/n is outcome `O1-content` in frame S-main (raw), with its Wilson 95%
  interval.
- j/m is outcome `P1-pairs` in S-main (raw).
- u and v are the usable trials of cell B2 arms A1 and A2 (section 9: void
  trials are not counted); a and b are those of them in which the root
  `AGENTS.md` did not reach the model endpoint.
- If B2 is not **confirmed** by its rule (section 9), the third sentence
  is printed with its fractions and verdict and without the words
  "depending only on where the repository lives".

## 1. Tool freeze, timestamp and seed

1. **Tool freeze.** The tag `study-v1` marks the commit whose `map`
   produces every census measurement: `{{stamp:study-v1.commit}}`, ctxreach
   `{{stamp:ctxreach.version}}`, built with Node `{{stamp:node.version}}` from
   the dependencies locked in that commit's `package-lock.json`.
   The build's fingerprint (SHA-256 of every file in `dist/`, then SHA-256
   of that listing; `node study/census/dist-digest.mjs`) is
   `{{stamp:dist.digest}}`. `run-census.mjs --expect-dist <digest>` refuses
   any other build, and every census row records its build's digest. A
   `map` defect found after the freeze (by K4, K5 or K6, section 8, or in
   any other way) is appended to Deviations and fixed in a new build. The
   new build is run over the same samples; each build's rows are analysed by
   their own `analyze.mjs` run (it refuses rows of two builds in one frame),
   and both results are reported. The frozen build's results stay the
   registered ones and decide the verdicts; the fixed build's are reported
   beside them as that deviation's result.
2. **Agent versions.** Claude Code **2.1.285** is modelled by `map`
   (`--claude-version`) and pinned for the lab cells (a scratch install run
   with `--claude-bin` and `DISABLE_AUTOUPDATER=1`). Codex **0.159.2** is the
   renderer for check K4 and the Codex cells: a study census run refuses a
   renderer whose `codex --version` reports another version, every row
   records what it reported (`codexVersion`), and `results.json` lists it per
   frame (`codexVersions`) and for K4. Lab cells run on Windows 11; Codex
   renders also run on Linux in CI. Nothing is pooled across versions or
   operating systems: every census row records its platform, and
   `analyze.mjs` refuses rows of one frame that differ in build, Claude Code
   version, `map` version, Codex version or platform.
3. **Frames first.** The frames (section 3) are frozen with the study-v1
   build and stamped here **before** this file is committed. The seed then
   comes from a commit that already fixes the frames, so neither the frame
   nor the seed can be chosen after seeing the other.
4. **Timestamp.** This file is committed and the commit tagged
   `prereg-v1`. Shiv pushes the tag and opens an issue titled
   "Pre-registration v1" in the public repository, holding this file's
   SHA-256. The server timestamps of the push and the issue are the proof
   of time; local commit dates are not.
5. **Seed.** The seed is the first 8 hex digits of the commit that
   `prereg-v1` points to, printed by `node study/census/seed.mjs`. It is not
   written here, because this file is part of that commit. The one
   pre-registered redraw (section 4) uses seed + 1.

## 2. Pilot declaration

Everything observed before this registration is **pilot** data. The
hypotheses below were set from it, so it is never evidence for them, never
pooled with registered rows or trials, and always cited as "pilot, n = ...".
It is kept, redacted, in `study/pilot/` (see its README):

| Id | Pilot observation, 2026-09-30 | n |
|---|---|---|
| P-a | An ancestor `.claude/CLAUDE.md` above the git root switched `AGENTS.md` off (billed canary, Claude Code 2.1.280); `map` agreed on 6/6 cells | 1 trap + 1 control |
| P-b | The same through the $0 capture endpoint on 2.1.285, 6/6 and 5/5 predicted cells | 1 + 1 |
| P-c | `codex debug prompt-input` 0.159.2 renders the AGENTS.md block byte-exactly with no login; 22/22 fixture launches agreed with `map`; a planted 30,000-byte budget disagreed 1/1 | 22 launches |
| P-d | The dotted `-c` trust key of openai/codex#41499 never addressed the project (its trusted control failed); the inline-table form applied, and untrusted then delivered nothing | 1 render per case |
| P-e | `CODEX_HOME` at the project root delivered the root `AGENTS.md` twice (openai/codex#34193) | 1 render |
| P-f | The `InstructionsLoaded` hook fired under `-p` and was silent for an `AGENTS.md` loaded through the setting; `--setting-sources project,local` changed the model | 2 billed runs |
| P-g | OpenCode 1.18.33 stacked every `AGENTS.md` nearest first and read no `CLAUDE.md`; Gemini CLI core 0.62.0 ordered `Api/GEMINI.md` before the root file | 1 capture, 1 library run |
| P-h | Code-search counts behind the hypotheses: 31.3% of root `AGENTS.md` repositories have a root `CLAUDE.md` without `@AGENTS.md` (case-insensitive); 729 of 3,197 importers have a nested instruction file; 1.95% of single files exceed 32 KiB | census counts |
| P-i | Two 20-repository census dry runs from a **pilot seed** (`cf72741e`, not the study seed), through the study's own scripts, to test the pipeline and the rate budget; their rows are not kept | 20 + 20 |

Side findings P-f and P-g appear only as labelled side findings and
upstream drafts; OpenCode and Gemini are not measured by this study.

## 3. Frames

All frames come from Sourcegraph's streaming search API, unauthenticated,
one query at a time, through the study's GET-only client
(`study/census/frame.mjs`). The file matches give each repository and the
commit Sourcegraph indexed; that commit is the unit's pinned commit. Rows
are sorted by repository name and written as a TSV; its SHA-256 is the
frame's record. Only `github.com` repositories are kept (others are
counted).

| Frame | Query (verbatim) | Frozen | Repositories | TSV SHA-256 |
|---|---|---|---|---|
| **S** (census) | `file:^AGENTS\.md$ case:yes count:all` | {{stamp:frame.S.date}} | {{stamp:frame.S.repos}} | `{{stamp:frame.S.sha256}}` |
| **S-imp** (importers) | `file:^CLAUDE\.md$ case:yes patterntype:regexp ^@AGENTS\.md count:all` | {{stamp:frame.S-imp.date}} | {{stamp:frame.S-imp.repos}} | `{{stamp:frame.S-imp.sha256}}` |
| **S-ci** (any case) | `file:^AGENTS\.md$ count:all` | {{stamp:frame.S-ci.date}} | {{stamp:frame.S-ci.repos}} | `{{stamp:frame.S-ci.sha256}}` |

- **Validity.** Each query runs twice. A frame is valid only when both
  answers end with their `done` event, carry no alert, skip nothing but
  Sourcegraph's default fork and archive exclusions, report as many matches
  as they delivered, and list the same repositories apart from index churn
  (at most 5 repositories, or 0.1% of the list if larger). The first
  answer's commits are recorded; commits that moved between the answers are
  counted. A `select:repo` count is not used as a check: on the pilot day it
  returned 25,742 and then 24,726 for frame S, each with `done` and no
  alert, while the file-match list gave 26,022.
- **Case variants.** S-ci minus S (a root `agents.md` or other case
  variant, about 253 on the pilot day) is a reported stratum, as a count.
  It is never pooled with S and not sampled in v1.
- **K3's census counts** (section 8), frozen the same way on
  {{stamp:K3.date}}: {{stamp:K3.claude}} repositories in S with a root
  `CLAUDE.md` (`file:^CLAUDE\.md$ case:yes repo:has.file(path:^AGENTS\.md$)`),
  of which {{stamp:K3.claudeImport}} contain `@AGENTS.md`.
- Frame G (active GitHub repositories) is not part of v1.

## 4. Samples, seed and exclusions

- **S-main**: 1,100 repositories from S. **S-imp**: 385 from S-imp,
  excluding repositories drawn for S-main. Expected Wilson 95% half-widths:
  about ±2.7 points at p = 0.31 (n = 1,100) and ±4.2 points at p = 0.23
  (n = 385).
- **Draw** (`study/census/sample.mjs`, `lib/prng.mjs`). The frame's rows are
  put in canonical order (repository name, by UTF-16 code unit), the
  excluded sample's rows are removed, and the rows are shuffled by
  Fisher-Yates (for i from n-1 down to 1, swap i with j drawn uniformly
  from [0, i]). Random words come from SHA-256 in counter mode: word t is the
  first 4 bytes, big-endian, of `SHA-256("ctxreach-study|<seed>|<stream>|<t>")`,
  with t written in decimal and counted from 0, one counter per stream. A
  uniform integer in [0, m) takes the next word x and returns x mod m when
  x < m * floor(2^32 / m); otherwise it rejects x and takes the next word, so
  no value is favoured. The stream is the sample's name (`S-main`,
  `S-imp`). The first n rows of the shuffle, in draw order, are the sample.
  `sample.mjs` refuses a study sample whose stream or n is not registered
  here, whose seed does not come from the tag, whose seed offset is not 0 or
  1, or (S-imp) that does not exclude S-main's first draw.
- **Exclusions** (counted and reported per reason): fork, mirror or
  archived at fetch time; repository gone (404) or blocked (403, 451);
  commit gone (404, 422, or an empty repository); tree truncated by GitHub
  or over 100,000 entries; a request that failed 3 times (network errors
  or 5xx), or a rate-limit wait over 65 minutes; an instruction file whose
  bytes fail the blob check or cannot be written on the machine
  (reconstruction incomplete); a reconstruction over 50 MB. A template
  repository is recorded, not excluded.
- **Faults.** A measured row with an instrument fault (a `map` error, or an
  output-side check below) is not used, and counts with the exclusions.
- **Redraw.** A sample that loses more than 10% of its draws (excluded rows
  and rows with a fault, over the rows drawn; `redrawRequired` in
  `results.json`) is redrawn once, with the same stream and n and seed + 1
  (the seed as a 32-bit number plus 1, modulo 2^32, as 8 hex digits;
  `sample.mjs --seed-offset 1`): S-main from the whole frame S, and S-imp
  from S-imp less the S-main draw it was first drawn against (S-main's first
  draw, whether or not S-main is redrawn). The redrawn sample replaces the
  first for every figure and verdict: the outcomes, the hypotheses, K3, K4,
  and the K5 and K6 draws read only its rows. The first draw's rows are
  reported under a distinct frame name (`S-main-draw1`, `S-imp-draw1`), with
  their own figures, and are never pooled with the redraw or with any other
  rows. S-imp's overlap with a redrawn S-main is counted (`sharedRepos` in
  `results.json`), not excluded. A redrawn sample is not redrawn again,
  whatever it loses. Every sample records its draw (`draw=1`, or `draw=2`
  for the redraw) and every census row its draw and its sample's SHA-256;
  `sample.mjs` refuses a study seed offset other than 0 or 1 and an S-imp
  exclusion other than S-main's first draw; `run-census.mjs` refuses a study
  sample that is not of its stream or not drawn with the tag's seed (+ 1 for
  draw 2), and a rows file that already holds another sample's rows; and
  `analyze.mjs` refuses rows of one frame and draw from two samples, a unit
  given twice, a draw 2 without the draw 1 it replaces, and a draw 2 whose
  draw 1 lost 10% or less.

## 5. Unit and reconstruction

- **Unit**: a repository at Sourcegraph's indexed commit, as a **fresh
  machine** would see it: empty `~/.codex` and `~/.claude`, default
  settings, nothing ever approved, Claude Code 2.1.285 semantics.
- **Reconstruction** (`study/census/recon.mjs`), through GitHub's REST API
  and raw file host, GET only: the repository's metadata, its recursive
  tree at the pinned commit, and only the files ctxreach reads: every
  `AGENTS.md`, `AGENTS.override.md`, `AGENTS.local.md`, `CLAUDE.md`,
  `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/AGENTS.md`,
  `.claude/settings.json`, `.claude/settings.local.json`, `.claude/rules/**/*.md`
  and `.codex/config.toml`, outside `node_modules`, `.git`, `.hg`, `.sl`
  and `.svn`; plus every file they might import (any `@token`, up to 6
  hops and 50 files). Every file is checked against its git blob id. An
  empty `.git` directory marks the root.
- **Symlinks** (tree mode `120000`) are written as a copy of their target
  with the link recorded, so the result is the same on every operating
  system. The measurement then applies the symlink rule: a link and its
  target are one file (a symlinked `CLAUDE.md` pointing at `AGENTS.md`
  delivers `AGENTS.md` once), and `map`'s warnings that exist only because
  the link was copied are dropped. Each row keeps `map`'s own codes beside
  the corrected ones (`pairs[].warn`, `o5.rootWarnMap`), and O5 and O6 are
  also reported as `map` printed them (`O5-any-root-warning-map`,
  `O5-root-map:<code>` and `O6-map` in `results.json`).
- Nothing from a repository is executed. The census refuses to run under a
  folder with an instruction file above it, checks that the empty homes stay
  empty, and deletes each reconstruction after measuring it. What is
  published: `owner/repo@commit`, measurements and blob ids; never
  contents.

## 6. Launch directories

1. **Type 1**: the repository root. Primary.
2. **Type 2**: every other directory holding an instruction file of its own
   (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, or
   `.claude/CLAUDE.md`, whose launch directory is the parent of `.claude`).
   At most **20 per repository**. When a repository has more, 20 are drawn
   by the seeded shuffle of section 4 from the directories in canonical
   order, with the study seed itself (the `prereg-v1` seed, also for a
   redrawn sample) and stream `t2|<owner/repo>`; `run-census.mjs` takes
   that seed from the tag (`--seed-from-tag prereg-v1`) and refuses a
   typed one for a study run. The count before the cap is kept in every
   row (`t2Total`). Secondary. The cap leaves the root launch, and so O1
   (content and file), untouched. O2 and P1 count a repository when at
   least one of its type-2 directories shows the event, so in a capped
   repository the cap can only miss an event in a directory not drawn,
   never add one: there, O2 and P1-repos are lower bounds, and P1-pairs
   counts drawn pairs only. The share of measured repositories whose
   type-2 directories were capped is reported per frame beside them
   (`type2Capped` in `results.json`).
3. **Type 3**: directories 1 to 3 levels deep holding a `package.json`,
   `pyproject.toml`, `Cargo.toml` or `go.mod`, not already type 1 or 2. At
   most 20 per repository, by seeded draw (stream `t3|<repo>`). Sensitivity
   only.

`map --json` runs from every launch directory (`study/census/measure.mjs`),
with `--codex-home` and `--claude-home` pointing at empty folders. It runs
in the census's own process: the frozen build's `map` and `toJson`
(`dist/index.js` re-exports them from the chunk `dist/cli.js` calls), used
as the CLI's map command uses them (`study/census/lib/maprun.mjs`). On
every 25th unit each launch directory is also run through the spawned CLI
and the two answers compared; a difference is a fault on the row, and the
run's manifest counts the checks. Each run
must report the reconstruction as its repository root and the requested
launch directory, and no file outside the repository may appear in either
agent's view; a breach is a fault on the row.

## 7. Outcomes and hypotheses

Every outcome is a proportion k/n with a Wilson 95% interval, per frame, in
three variants: **raw**; **deduplicated** by the root `AGENTS.md` blob (the
first drawn row per blob); and **owner-capped** (at most 5 repositories per
owner, the first drawn). Frames, draws, builds, versions and operating
systems are never pooled. Terms used below:

- **Root `AGENTS.md`**: the file at the repository root named exactly
  `AGENTS.md` (case-sensitive), or a symlink there to a file inside the
  repository; a broken symlink counts as none.
- **Received by Claude**: `map` gives the file delivery `launch` or
  `import` at session start, with no approval needed and inside the
  repository (imports are expanded at launch); a symlink and its target are
  one file (section 5). This is a file-level test: a copy of a file's text
  in another received file does not make the file received.
- **Left out**: every repository-level outcome counts the measured
  repositories outside its denominator by reason (`ineligibleWhy` in
  `results.json`), so each denominator below can be checked against the
  measured count.

| Id | Metric (as `study/census/detectors.mjs` computes it) | In `results.json` |
|---|---|---|
| **O1-content** (Claude headline) | Root launch. A = the root `AGENTS.md`'s lines (split at CR LF, CR or LF), each trimmed with every run of Unicode whitespace (CR, tab and no-break space included) collapsed to one space, kept when at least 20 characters (code points) long, deduplicated; text inside code fences counts. R = the lines of A that are equal to a line, normalised and filtered the same way, of a file Claude receives at root launch. Event: R/\|A\| < 0.5. Denominator: repositories with a root `AGENTS.md` whose root launch was measured and whose \|A\| > 0. \|A\| = 0 is counted apart from the other reasons a repository is left out (no root `AGENTS.md`, root launch not measured), as "no line of 20 or more characters". A byte-copy `CLAUDE.md` gives R = \|A\|. | `O1-content` |
| O1-content-shingle (sensitivity) | As O1-content, but a line of A counts as received when at least 0.8 of its distinct 8-word shingles (words: runs of non-whitespace) are among the shingles of the received files (each file's own shingles; a file under 8 words is one shingle); a line under 8 words counts when, whitespace collapsed, it is a substring of one received file's text, whitespace collapsed. Same denominator. | `O1-content-shingle` |
| **O1-file** | Root launch: the root `AGENTS.md` is not received by Claude, for any reason, recorded in the row (`o1file.cause`: `shadowed` when rule `claude.agents-default` leaves it out, as a `CLAUDE.md`-family file that neither imports nor links it does; `external-import` when it arrives only through an import that needs approval; `absent` when `map` lists it nowhere; otherwise the code of the rule that placed it). Denominator: repositories with a root `AGENTS.md` whose root launch was measured. | `O1-file` |
| **O2** (headless import) | At least one type-2 launch directory from which Claude, headless, does not receive the root `AGENTS.md`, for any reason (for example an import that resolves outside the launch directory, with no approval recorded). File level, like O1-file. Denominator: every repository with a root `AGENTS.md`, with or without type-2 directories. Also reported: the same over type-2 and type-3 directories (`O2-types123`; despite its name, type 1, the root launch, is never part of O2), and among repositories with at least one measured type-2 directory (`O2-given-type2`). | `O2`, `O2-types123`, `O2-given-type2` |
| **P1** (Codex headline) | A (repository, launch directory) pair of types 1 and 2 where `map` reports `codex.cut`, `codex.no-budget` or `codex.empty-override` (Codex 0.159.2 rules, 32,768-byte budget). Per pair (`P1-pairs`; denominator: every measured type-1 and type-2 pair) and per repository with at least one such pair (`P1-repos`; denominator: every repository with at least one measured type-1 or type-2 pair); also over types 1 to 3 (`P1-pairs-types123`, `P1-repos-types123`, with type-3 pairs added to both numerator and denominator). Pair intervals ignore clustering within a repository; the repository-level figure is the one with a valid interval. | `P1-pairs`, `P1-repos`, `P1-pairs-types123`, `P1-repos-types123` |
| O4 | At root launch, at least one `AGENTS.md` below the root (a file named exactly `AGENTS.md` in any directory but the root, other than a `.claude/AGENTS.md` at any depth; a broken symlink counts) of which Codex keeps no byte (it is not on Codex's chain with kept bytes above 0) and which Claude does not receive. Denominator: every repository whose root launch was measured, with or without a nested `AGENTS.md`. | `O4` |
| O5 | At least one `map` warning at root launch, after the symlink rule (`O5-any-root-warning`); also as `map` printed them (`O5-any-root-warning-map`), and among repositories with no reconstructed file (section 5) that is a working symlink (`O5-any-root-warning-no-links`). By code: one row for every `warn` code in the Findings table of `docs/rules.md`, 0/n included, plus any other code that occurs, both after the symlink rule (`O5-root:<code>`) and as printed (`O5-root-map:<code>`). Denominator: every measured repository (a repository whose root launch was not measured counts as having no root warning). | `O5-any-root-warning`, `O5-any-root-warning-map`, `O5-any-root-warning-no-links`, `O5-root:<code>`, `O5-root-map:<code>` |
| O6 | At root launch, `map` raises `claude.words-not-import`, after the symlink rule: some `AGENTS.md` is switched off (`claude.agents-shadowed`), and a `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` that loads at launch or on read (nested ones included) contains the text `AGENTS.md` (case-sensitive, anywhere in the file, so also inside a longer name) and imports no file named `AGENTS.md` (an `@AGENTS.md` inside a code span or fenced block is not an import). A file whose whole trimmed text is one relative path to an existing file is not an O6 event: `map` raises `claude.link-as-text` for it instead (rule `claude.symlink`), and it is counted under O5 as `O5-root:claude.link-as-text`. Also as `map` printed it, before the symlink rule (`O6-map`). Denominator: every repository whose root launch was measured. | `O6`, `O6-map` |
| O7 | Repositories with at least one file of section 5's list (an instruction file, settings file, rule or `.codex/config.toml`; import targets aside) that is a symlink (tree mode `120000`; `O7`), with at least one such link that is broken (`O7-broken`), and with a root `CLAUDE.md`-family link to `AGENTS.md` (`O7-root-link-to-agents`: the risk that a Windows checkout writes it as a text file; the census writes links as copies, so `claude.link-as-text` never fires for these). Denominator: every measured repository. | `O7`, `O7-broken`, `O7-root-link-to-agents` |
| O8 | The root `AGENTS.md`'s CJK share: of its characters (code points) that are not Unicode whitespace, the share that are CJK; event at 0.1 or more. CJK characters are the code points in U+1100–11FF, U+2E80–2FDF, U+3040–30FF, U+3100–318F, U+31A0–31BF, U+31F0–31FF, U+3400–4DBF, U+4E00–9FFF, U+A960–A97F, U+AC00–D7FF, U+F900–FAFF, U+FF66–FF9F and U+20000–3134F; that is, Han with its radicals and compatibility ideographs, kana with halfwidth katakana, Hangul with its jamo, and Bopomofo (CJK punctuation and fullwidth Latin are not counted). Denominator: every repository with a non-empty root `AGENTS.md` (a file of whitespace only has share 0). Also, over the same repositories, those whose root `AGENTS.md` is longer than Codex's 32,768-byte budget (`O8-over-budget`); and, among those, the characters (code points; a character the cut splits counts as one) that the budget's 32,768 bytes hold of the file, as minimum, median and maximum, apart for O8 events and the rest (`O8-held-chars` in the `summaries` of `results.json`, a figure that is not a proportion). | `O8`, `O8-over-budget`, `O8-held-chars` |

Codex's share of the root `AGENTS.md` is reported beside O1-content, over
O1-content's repositories, in bytes: the bytes of the root `AGENTS.md` that
Codex keeps at root launch (the kept bytes of its entry on the root
launch's chain; 0 when it is not on the chain, as when an
`AGENTS.override.md` at the root takes its slot) over the file's bytes. The
unit is bytes, not O1-content's lines, because a row keeps Codex's byte
counts and never the text. Two proportions: Codex keeps under half of the
file (`O1-codex-under-half`, O1-content's threshold) and under all of it
(`O1-codex-under-all`). The share is 100% whenever the root `AGENTS.md` is
at most 32,768 bytes and no root `AGENTS.override.md` takes its slot.

**Hypotheses**, set from the pilot (so these are confirmatory estimates
with a different instrument, not blind tests, and are labelled that way):

| Id | Frame, outcome | Pre-stated | Decision rule |
|---|---|---|---|
| **H1** (primary) | S-main, O1-content | at least 20% | **confirmed** if the Wilson lower bound is at least 20%; **refuted** if the upper bound is below 20%; else **inconclusive**. Reported verbatim either way. |
| H1b | S-main, O1-file | 25% to 40% | **hit** if the whole interval is inside [25%, 40%]; **miss** if it is wholly outside; else **overlaps** |
| **H2** (primary) | S-imp, O2 | at least 15% (the pilot's 22.8% is an upper bound) | as H1, bound 15% |
| H3-pairs | S-main, P1-pairs | 1% to 5% | as H1b |
| **H3-repos** (primary) | S-main, P1-repos | 1% to 8% | as H1b |

Each rule compares the interval's bounds as `results.json` holds them,
rounded to 6 decimal places, with the pre-stated values. A bound equal to
a pre-stated value reaches it: H1 is confirmed at a lower bound of exactly
0.2, and a hit may touch either end of its range; refuted and miss need a
bound strictly beyond. With a redraw (section 4), the redrawn sample
decides; after a `map` fix (section 1 item 1), the frozen build decides.

Every other figure in `results.json` is secondary and has no decision
rule: O1-content-shingle, Codex's share of the root `AGENTS.md`,
O2-types123, O2-given-type2, the type-3 variants of P1, O4 to O8, and
K3's per-repository input (section 8).

## 8. Instrument checks

K1, K2, K3 and K7 have pass rules: a failure stops the study, and is
reported as found. K8, K9 and K10 act on one battery or one trial, as their
rules say (an instrument fault, a void trial). K4, K5 and K6 are validity
estimates with no pass threshold: each is reported as found, with its
Wilson 95% interval, and stops nothing. Each of their disagreements is
adjudicated in the open as `map` (a `map` defect), as the other side (the
renderer, the capture or the reader) or as the rules (`docs/rules.md` is
silent or ambiguous). A disagreement adjudicated `map` is appended to
Deviations with the outcomes it could move, and section 1 item 1 applies: a
fixed build is run over the same samples and both results are reported,
the frozen build's verdicts standing as registered.

| Check | What | Pass rule |
|---|---|---|
| K1 known answers | Every fixture (`test/fixtures/*` and `study/census/known-answer-fixtures/*`), with an answer derived by hand from `docs/rules.md` (`study/census/known-answers.json`), through the census pipeline with only the network replaced (`study/census/known-answer.mjs`) | n/n: every fixture has an answer and every answer a fixture, and every fixture matches its answer (`k1Verdict`). A fixture listed as a known `map` defect still fails, and `prereg.mjs stamp` refuses while any is listed |
| K2 planted faults | Each of the 16 plants of `study/census/lib/plants.mjs` switched off in turn (`study/census/plant-census-faults.mjs`): the 11 outcome detectors (O1-content, O1-content-shingle, O1-file, O2, P1, O4, O5, O6, O7, O8 and K3's input) and 5 pipeline steps (import targets, symlinks, type-2 launch directories, type-3 launch directories, the symlink correction). First, `map` in process (the census's runner) must reproduce the spawned CLI's K1 result fixture for fixture | every plant acts at least once and makes K1 lose a fixture it passed without plants (exit 0); a plant that never acts, or a difference between the two runners, is an instrument failure (exit 2); a plant K1 does not catch fails K2 (exit 1) |
| K3 census consistency | The regex version of O1-file (a root `CLAUDE.md` whose text, or link text for a symlink, lacks `@AGENTS.md`; every measured repository counts) in S-main's rows in use (`K3-regex-O1-file` in `results.json`), against the frame's own proportion (K3.claude - K3.claudeImport) / \|S\| (`study/census/consistency.mjs`; `checks.K3`) | the census proportion lies inside the sample's Wilson 95% interval |
| K4 map vs Codex's renderer | For every sampled (repository, launch directory) pair of types 1 and 2 in the rows in use, the `agents_md.instructions` block of `codex debug prompt-input` 0.159.2 against `map`'s predicted bytes, rendered twice each with a throwaway `CODEX_HOME`, no credentials, proxies at a closed port, and a fresh control token (`study/census/codex-check.mjs`) | A validity estimate, no pass threshold: k/n byte-exact with its Wilson interval (`checks.K4`), reported as found. The registered expectation is at least 98% (`k4.expectedAtLeast`); `results.json` says whether k/n reached it (`checks.K4.expectationMet`), and falling short stops nothing. Every mismatch is listed and adjudicated; renders that differ, lose the token, render for another directory or change shape are instrument faults, listed and counted in n but not in k |
| K5 map vs Claude (live, $0) | 25 measured repositories from the rows in use, by a draw with the study seed within strata, each stratum drawn in turn (stream `K5\|<stratum>`) from the repositories not drawn yet: 12 where O1-file fires (launched at the root), 8 where O2 fires (launched from the first type-2 directory where it fires), and 5 whose root `AGENTS.md` Claude receives at root launch and whose root holds no `CLAUDE.md`-family file (launched at the root) (`study/census/k5-select.mjs`); 2 capture runs each through `ctxreach verify` | A validity estimate, no pass threshold: agreement k/n over decided cells, as `ctxreach verify` scores them, with its Wilson interval, reported as found. Every disagreement is adjudicated (`map`, the capture, or the rules) |
| K6 blind second reader | A fresh reader derives delivery by hand for 30 (repository, launch directory) pairs from `docs/rules.md` alone: 30 measured repositories from the rows in use, by seeded draw, then one type-1 or type-2 launch directory in each; sheets carry the files and never `map`'s answers, and the key taken from the census rows is hashed before the reader starts (`study/handcheck/PROTOCOL.md`) | A validity estimate, no pass threshold: x/30 pairs, and per agent, each with its Wilson interval, reported as found. Every disagreement adjudicated in the open (reader, `map` or rules) |
| K7 GET only | Every network request goes through one client that refuses any other method before sending and counts the refusals (`study/census/lib/client.mjs`) | every script prints "non-GET attempts: 0" |
| K8 planted pass | Before every conformance battery, a wrong budget (`--codex-max-bytes 30000`), a wrong mode or a reversed order run | must DISAGREE; a battery whose planted pass agrees is an instrument fault |
| K9 positive control | A must-appear token in a `.claude/rules/` file at the launch directory of every Claude trial, and a decoy no rule loads | a missing control voids the trial; decoy 0/N |
| K10 session asserts | `system/init.plugins` contains `agents-md@builtin`; `system/init.model` equals the pin; the rendered `cwd` equals the launch directory; `CODEX_HOME` inside the sandbox | a failed assert voids the trial |

**What K1 covers.** K1's 55 answers cover 49 distinct inputs. K1 serves a
fixture's `repo/` folder (and its `tree.json`, if any) with empty homes,
as the census serves a repository, so two fixtures that differ only outside
`repo/` are one input. Six pairs are byte-identical under these
conditions: the trap/twin pairs `claude-home-ancestor`,
`claude-external-headless`, `codex-home-is-root` and
`claude-package-imports-root`, whose twins differ from their traps only in
`home/` and `about.md`; `codex-over-cap` and `codex-project-config-twin`; and
`codex-override-wins` and `codex-empty-override-twin`. K1 launches only
from the launch directories of section 6, so `claude-ancestor-rules`, its
twin and `claude-import-outside-launch` are measured at the root only: the
launch from `packages/api` that their `about.md` describes is never made,
because `packages/api` holds no instruction file and no package manifest
there. With empty homes no fixture exercises a rule that needs a file in a
home (`claude.home-ancestor`, `codex.home-is-root`, `codex.global`, or a
Project instructions mode other than the default in `claude.modes`), nor an
ancestor's rules (`claude.rules`, which `map` does not model); the census
runs the same way and cannot reach them either.

31 answer fields are pinned in 0 of the 55 answers, so a fault that changes
only one of them still passes K1. Of these, the ones that feed a figure in
`results.json`: `k3.eligible`, `o1content.why`, `o1contentShingle.why`,
`o1file.why`, `o2.t2Dirs`, `o2.why`, `o4.eligible`, `o5.linkAffected`,
`o6.eligible`, `o7.broken`, `o7.rootLinkToAgents`, `o8.bytes`,
`o8.effectiveChars`, `o8.why`, `p1.pairs`, `p1.pairsT3`,
`p1.repoEventT123` and `p1.t3EventDirs`. The ones that feed none:
`k3.importsText`, `o1contentShingle.a`, `o1contentShingle.r`,
`o1contentShingle.share`, `o1file.cause`, `o1file.shadowers`,
`o1file.via`, `o2.causes`, `o4.nested`, `o4.notPreloaded`, `o5.anyWarn`,
`o8.chars` and `o8.cjkShare`. Fields pinned in 1 to 4 answers:
`o2.eventT123` (2), `o2.t3EventDirs` (2) and `o5.rootWarnMap` (1), which
`O5-any-root-warning-map`, `O5-root-map:<code>` and `O6-map` read. Codex's
share of the root `AGENTS.md` (`O1-codex-under-half`,
`O1-codex-under-all`) reads the root launch's Codex chain from the row
(`pairs`), which K1 does not compare at all.

## 9. Behavioural cells

Instruments:

- **capture**: Claude Code 2.1.285 with `ANTHROPIC_BASE_URL` at a loopback
  recorder that answers 400, a dummy key, session variables stripped, the
  model pinned, and one discarded warm-up per fresh config folder. Wording:
  "delivered to the model endpoint (custom base URL, gateway path)";
  first-party equivalence is measured in M1.
- **echo**: ctxreach's billed `probe` on Shiv's login. Wording: "echoed by
  the model in a first-party session; an echo proves delivery, not
  compliance".

`study/behavioural/cells.json` in this commit is the registration of the
cells (fixtures, arms, tokens, observables and rules), and
`study/behavioural/run-cells.mjs` runs them. Every trial is one instrument
run on a fresh copy with the harness's own tokens at the head and tail of
each instruction file, a positive control and a decoy. A trial is **void**
when the control is missing, the decoy is echoed, or a session assert fails;
void trials are reported and never replaced. Thresholds are fractions of
usable trials; an arm with fewer than 80% of its planned trials usable is
**insufficient**. A cell without a refute rule whose confirm rule is not
met is reported **not confirmed** (`not-confirmed` in `cells-results.json`),
never **refuted**. Only B2 has a refute rule, so only B2 can be refuted; B1,
B3, B4 and B6 are confirmed or not confirmed (or insufficient).

| Cell | Arms x trials | Instrument | Rule (fractions of usable trials) |
|---|---|---|---|
| **B2** home folder (headline cell) | warm-up 1 (P0-a); A0 10 (no `~/.claude/CLAUDE.md`, copy under the scratch home); A1 10 (file present, copy under the scratch home); A2 10 (file present, copy outside it, via `TEMP`/`TMP`); A3 5 (A1 launched from `packages/api`); A4 5 (an ancestor above the git root inside the scratch home) | capture; `HOME`/`USERPROFILE` = `C:/ctxr-home`, made by `setup-b2-home.mjs`; the real home is never used | **confirmed** if A1 AGENTS.md <= 0.1 and A2 >= 0.9 and A0 >= 0.9; **refuted** if A1 >= 0.9; else inconclusive. Precondition P0-a: the warm-up shows the scratch home file's token on the wire; if not, B2 is not run as registered |
| B1 ancestor above the git root | trap 10, control 10 | capture | confirmed if trap AGENTS.md <= 0.1 and trap ancestor token >= 0.9 and control AGENTS.md >= 0.9 |
| B3 external import, headless | subdir 10, root 5 | capture | confirmed if subdir root AGENTS.md <= 0.1 and subdir package AGENTS.md >= 0.9 and root root AGENTS.md >= 0.8 |
| B4 link as text | trap 5 | capture | confirmed if AGENTS.md <= 0.2 |
| B6 ancestor rules | trap 5 | capture (+ hook, when recorded) | confirmed if the ancestor rule >= 0.8; the hook's events are reported beside it |
| B7 words, not an import (task mode) | trap 10 | echo (billed) | reported as self-discovered k/10; no rule |

Twins (`-twin` fixtures, B6's `paths` arm) have 0 trials unless a trap
result needs a control; reserve runs may be spent on them, and are then
reported as such.

Later cells, run through the same harness once their instruments exist:

- **M1** method equivalence: B1 trap and control, B3 subdir and root, B4
  trap and the recorded `agents-only` source, 3 echo and 3 capture trials
  each. Agreement per decided cell k/n. "Capture delivered, echo not seen"
  is an echo miss (listed); "capture absent, echo seen" is an instrument
  fault.
- **E0** hook non-perturbation: the 8 recorded fixtures with the hook on
  (16 billed runs); a changed decided cell means "the hook perturbs" and the
  hook moves to separate paired runs.
- **X-table** (canary x hook, on M1 and E0 only): hook-fired over
  canary-seen for hookable files; canary-seen over hook-fired; partial
  echoes; the AGENTS.md hook-blind rate.
- **C1-C6** Codex, rendered twice each, byte-exact: C1 = K4; C2 untrusted
  through `config.toml` against `-c` in the inline-table form, on Windows
  and Linux; C3 an empty override taking its directory's slot; C4 a CJK
  character split by the budget (U+FFFD); C5 a lowercase `agents.md` on
  Windows; C6 `CODEX_HOME` at the project root. Wording: "as rendered by
  `codex debug prompt-input` 0.159.2; the model was not run".
- **V-col** (if hours remain): B1 trap and B2 A1 on the installed 2.1.280,
  billed, 3 + 3; a version column, never pooled.

Budget: about 130 capture runs ($0); 50 billed runs (M1 18, B7 10, E0 16,
demo 6) with 100 in reserve for re-running **failed** trials only
(contaminated trials are reported, never replaced). Usage is checked
before every billed batch.

## 10. Analysis and reporting rules

- Proportions only, each with a Wilson 95% interval (z = 1.959963984540054);
  printed as "k/n (x%, [lo, hi])". No significance tests between frames.
  `results.json` holds p and both bounds rounded to 6 decimal places, and
  the verdicts are taken on those rounded bounds (section 7).
- Raw, blob-deduplicated and owner-capped variants for every outcome; the
  raw variant decides the hypotheses.
- Never pooled across frames, draws, builds, agent versions or operating
  systems (`analyze.mjs` refuses such rows, sections 1 and 4); every figure
  carries its agent versions, operating system and date (`frames` and
  `generatedAt` in `results.json`).
- Behavioural cells: per arm, both fractions, with Wilson bounds beside
  them (0/10 means at most 27.8%; 10/10 at least 72.2%; 0/5 at most 43.4%).
- Every number on the site and in the write-up is rendered from
  `results.json` (`study/census/analyze.mjs`, `cells-results.json`); none is
  typed by hand.
- Wording: Codex claims read "as rendered by `codex debug prompt-input`
  <version>; the model was not run". Capture claims read "delivered to the
  model endpoint (custom base URL, gateway path)", as in section 9. Census
  claims about Claude read "predicted by ctxreach map for Claude Code
  <version> on a fresh machine with default settings, not a live run;
  checked live in K5 as k/n". `results.json` carries the Codex and census
  wordings (`wording`), and `cells.json` the capture and echo wordings of
  section 9. openai/codex#41499 reads "not reproduced on Windows 0.159.2
  with a key form shown to apply".
- Pilot data is cited as pilot. No repository is named for a defect.
- **Opt-out.** Repository owners can opt out by opening an issue on
  github.com/Shivansh2904/ctxreach; there is no email address to write to.
  An opted-out repository's name and commit are removed from every
  published file (rows, K4 mismatch lists, K5 and K6 lists); its
  measurements stay in the aggregate fractions, which name no repository,
  and the number of opt-outs is reported.

## 11. Data handling

- Network: GitHub REST GETs and `raw.githubusercontent.com` reads, and
  unauthenticated Sourcegraph searches, all through the GET-only client:
  three hosts only, one request at a time, a User-Agent naming the
  project, conditional requests, and waits as long as `retry-after` or the
  rate-limit reset asks. No GitHub search API. About 3,600 core API GETs in
  all (about 2.45 per repository in the pilot dry runs, for 1,485
  repositories), plus raw file reads, which do not count against the core
  limit; a projection, not a result (`study/census/README.md`).
- Credentials: GitHub REST GETs run through the GitHub CLI,
  `gh api -X GET --include <endpoint>`, which authenticates itself from its
  own login. ctxreach never reads, copies or stores a token (the client
  refuses one, and a test fails if a study script reads one from the
  environment). Raw file reads and Sourcegraph searches carry no
  credentials. The run stops, rather than excluding units, when gh is
  missing or not logged in.
- Instruction-file contents exist only in a reconstruction folder while a
  repository is measured and are deleted with it. Rows hold paths, sizes,
  blob ids and measurements.
- Nothing from a fetched repository is executed. Live runs on real
  repositories (K5) use recall mode, with no tools, on a copy holding only
  the instruction files.

## 12. Registry

The block below is the machine-checkable registration. `node
study/prereg.mjs check` prints any difference from the code; the census
scripts read the sample sizes from it.

```json prereg-registry
{
  "schema": "ctxreach.study-prereg/v1",
  "frames": {
    "S": "file:^AGENTS\\.md$ case:yes count:all",
    "S-imp": "file:^CLAUDE\\.md$ case:yes patterntype:regexp ^@AGENTS\\.md count:all",
    "S-ci": "file:^AGENTS\\.md$ count:all",
    "K3.claude": "file:^CLAUDE\\.md$ case:yes repo:has.file(path:^AGENTS\\.md$) count:all",
    "K3.claudeImport": "file:^CLAUDE\\.md$ case:yes repo:has.file(path:^AGENTS\\.md$) patterntype:regexp @AGENTS\\.md count:all"
  },
  "frameChecks": {"answers": 2, "churnAllowance": 5, "churnTolerance": 0.001},
  "limits": {
    "maxTreeEntries": 100000,
    "maxType2Dirs": 20,
    "maxType3Dirs": 20,
    "maxImportDepth": 6,
    "maxImportFiles": 50,
    "maxRepoBytes": 52428800,
    "maxAttempts": 3
  },
  "redraw": {"lostShareOver": 0.1, "seedOffset": 1},
  "normalise": {"minLineChars": 20, "shingleWords": 8, "shingleThreshold": 0.8, "o1EventShare": 0.5},
  "p1Codes": ["codex.cut", "codex.no-budget", "codex.empty-override"],
  "cjkEvent": 0.1,
  "codexBudget": 32768,
  "claudeVersion": "2.1.285",
  "mapCheckEvery": 25,
  "knownAnswerClaudeVersion": "2.1.285",
  "k4": {"trials": 2, "expectedAtLeast": 0.98, "launchTypes": [1, 2]},
  "k6": {"pairs": 30, "launchTypes": [1, 2]},
  "analysis": {"z": 1.959963984540054, "ownerCap": 5},
  "hypotheses": [
    {"id": "H1", "frame": "S-main", "outcome": "O1-content", "rule": "bound", "bound": 0.2, "primary": true},
    {"id": "H1b", "frame": "S-main", "outcome": "O1-file", "rule": "range", "lo": 0.25, "hi": 0.4},
    {"id": "H2", "frame": "S-imp", "outcome": "O2", "rule": "bound", "bound": 0.15, "primary": true},
    {"id": "H3-pairs", "frame": "S-main", "outcome": "P1-pairs", "rule": "range", "lo": 0.01, "hi": 0.05},
    {"id": "H3-repos", "frame": "S-main", "outcome": "P1-repos", "rule": "range", "lo": 0.01, "hi": 0.08, "primary": true}
  ],
  "cells": {
    "B1": {
      "instrument": "capture",
      "arms": {"trap": 10, "control": 10},
      "confirm": [["trap", "agents", "<=", 0.1], ["trap", "ancestor", ">=", 0.9], ["control", "agents", ">=", 0.9]],
      "refute": []
    },
    "B2": {
      "instrument": "capture",
      "arms": {"A0": 10, "A1": 10, "A2": 10, "A3": 5, "A4": 5},
      "confirm": [["A1", "agents", "<=", 0.1], ["A2", "agents", ">=", 0.9], ["A0", "agents", ">=", 0.9]],
      "refute": [["A1", "agents", ">=", 0.9]]
    },
    "B3": {
      "instrument": "capture",
      "arms": {"subdir": 10, "root": 5},
      "confirm": [["subdir", "rootAgents", "<=", 0.1], ["subdir", "packageAgents", ">=", 0.9], ["root", "rootAgents", ">=", 0.8]],
      "refute": []
    },
    "B4": {
      "instrument": "capture",
      "arms": {"trap": 5},
      "confirm": [["trap", "agents", "<=", 0.2]],
      "refute": []
    },
    "B6": {
      "instrument": "capture",
      "arms": {"trap": 5},
      "confirm": [["trap", "ancestorRule", ">=", 0.8]],
      "refute": []
    },
    "B7": {
      "instrument": "echo",
      "arms": {"trap": 10},
      "confirm": [],
      "refute": []
    }
  },
  "samples": {
    "S-main": {"frame": "S", "n": 1100},
    "S-imp": {"frame": "S-imp", "n": 385, "exclude": ["S-main"]}
  },
  "seed": {"tag": "prereg-v1", "digits": 8},
  "codexVersion": "0.159.2"
}
```

## 13. Order of work after the tag

1. `node study/census/seed.mjs` prints the seed.
2. `sample.mjs --seed-from-tag prereg-v1` draws S-main, then S-imp with
   `--exclude` S-main (its first draw).
3. K1 and K2 on the frozen build; K7 printed by every script.
4. `run-census.mjs --expect-dist {{stamp:dist.digest}}` over S-main and
   S-imp, with `--codex-bin` (Codex 0.159.2) for K4, each sample into its
   own rows file.
5. `analyze.mjs` over the rows. A sample it marks `redrawRequired` is
   redrawn once (section 4: `sample.mjs --seed-offset 1`, S-imp again
   excluding S-main's first draw), run with `run-census.mjs` into a rows
   file of its own, and `analyze.mjs` is run again with both draws' rows.
   K3 from the rows in use and the frozen counts.
6. Lab cells at $0 (B1, B2, B3, B4, B6, K5, drawn from the rows in use),
   then billed (M1, E0, B7).
7. K6 by a fresh reader: `study/handcheck/handcheck.mjs draw` with the
   seed, `sheets`, the reader's answers, then `score` and the adjudication
   (`study/handcheck/PROTOCOL.md`). K4, K5 and K6 adjudications of `map`
   go to Deviations (section 8).
8. `analyze.mjs` writes the final `results.json`; deviations are appended
   below.
9. A script written after the tag fills the headline sentence of section 0
   from `results.json` and `cells-results.json`. It only reads those two
   files, is committed before it is run, and its output is not edited by
   hand.

## Deviations

Appended below this line, dated, never edited in place.
