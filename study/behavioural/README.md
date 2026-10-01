# Behavioural cells (arm C)

The pre-registered lab cells of `study/PREREG.md` ("Behavioural cells"), as
data (`cells.json`), fixtures (`fixtures/`), and one harness
(`run-cells.mjs`). Nothing here has run a real agent: the build lane ran
the harness against a fake instrument only.

| Cell | Fixture (twin) | Arms x trials | Instrument | Rule (fractions of usable trials) |
|---|---|---|---|---|
| B1 | `b1-ancestor` | trap 10 (ancestor `.claude/CLAUDE.md` above the git root), control 10 | capture | confirmed if trap AGENTS.md <= 0.1, trap ancestor token >= 0.9, control AGENTS.md >= 0.9 |
| B2 (headline) | `b2-home` | warm-up 1 (P0-a), A0 10, A1 10, A2 10, A3 5, A4 5 | capture, scratch home | confirmed if A1 <= 0.1 and A2 >= 0.9 and A0 >= 0.9; refuted if A1 >= 0.9; else inconclusive; P0-a failing means B2 is not run as registered |
| B3 | `b3-external-import` (`-twin`) | subdir 10, root 5 | capture | confirmed if subdir root AGENTS.md <= 0.1, subdir package AGENTS.md >= 0.9, root root AGENTS.md >= 0.8 |
| B4 | `b4-link-as-text` (`-twin`) | trap 5 | capture | confirmed if AGENTS.md <= 0.2 |
| B6 | `b6-ancestor-rules` (paths twin arm) | trap 5 | capture (+ hook when lane L3 records it) | confirmed if the ancestor rule >= 0.8 |
| B7 | `b7-words-task` (`-twin`) | trap 10 | echo, task mode | reported as k/10, no rule |

Twin arms have 0 trials by default: they are there so `map`'s prediction
for each trap and its twin can be checked (`test/study-census.test.ts`), and
so the main session can spend reserve runs on them if a trap result needs a
control.

An arm with fewer usable trials than 80% of those planned is
**insufficient**; voided trials are reported and never replaced.

## What one trial is

`run-cells.mjs` makes, under `<out>/work/<cell>/<arm>/trial-<n>/`:

- `stage/repo`: a copy of the fixture with the harness's own tokens at the
  head and tail of every instruction file (except files a cell lists in
  `noTokens`, such as B4's `CLAUDE.md`, which must stay the bare text
  `AGENTS.md`), an empty `.git`, a **positive control**
  (`.claude/rules/ctxreach-cell-control.md`, no `paths`, so it loads at
  launch) and a **decoy** (`ctxreach-cell-decoy.md`, which no rule loads) in
  the launch directory;
- the arm's layout files (an ancestor `.claude/CLAUDE.md`, the scratch
  home's `.claude/CLAUDE.md`, an ancestor rule), each with a fresh token;
- `TEMP`/`TMP`/`TMPDIR` pointed where the arm wants the instrument's copy
  (the probe sandbox and the capture oracle copy into `os.tmpdir()`, so
  this moves the copy without code changes);
- `HOME`/`USERPROFILE` for B2's arms, and `CLAUDE_CONFIG_DIR` removed.

It runs the instrument once (`--trials 1`), reads what the instrument
observed, and scores the trial: **void** if the control token is missing,
the decoy token is present, `system/init.plugins` lacks
`agents-md@builtin`, or `system/init.model` is not the pin; otherwise each
observable counts as seen when any of its tokens is. Files planted outside
the trial folder are removed after every trial, so no arm inherits another
arm's home file (the dry run caught exactly that: A0 read 0/10 until this
was added).

## Instruments

- **capture** (`ctxreach verify --agent claude`, lane L2): what reached the
  model endpoint. The harness reads every `*.jsonl` line under `--save` that
  has `method: "POST"` and a `url` containing `/v1/messages`, and takes the
  tokens in its `body`; a stream-json `system/init` line anywhere in those
  files gives the session asserts. **Needs confirming when L2 merges**: that
  `verify --save` writes request records in that shape, that it accepts
  `--claude-bin`, `--model` and `--home`, and how it handles the
  first-session warm-up.
- **echo** (`ctxreach probe --agent claude`, billed): the model's own words.
  The harness reads the assistant text and result in the recording's
  `trial-*.jsonl`. The probe reports the harness's tokens as "invented"
  (it did not plant them) and may exit 3 for that; the harness scores from
  the recording, not from the probe's verdict.

## Running

Dry run (no agent, no network, nothing written outside `--out`):

```
node study/behavioural/run-cells.mjs --dry-run --out <scratch>/cells-dry
FAKE_INSTRUMENT_MODE=no-home-shadow node study/behavioural/run-cells.mjs --dry-run --out <scratch>/cells-refuted --cells B2
```

The first confirms B1-B6 (the fake follows each hypothesis) and reports B7;
the second must refute B2. Both print `real agent runs: 0 (billed 0)`.

Live (main session only, after lanes L2 and L3 merge and the `study-v1`
freeze):

1. `node study/behavioural/setup-b2-home.mjs --yes` makes `C:/ctxr-home`
   and `C:/ctxr-out` with a marker file; it refuses the real home, anything
   inside it, and any existing folder it did not make. (`--remove --yes`
   takes them away afterwards.) Not run by the build lane.
2. `node study/behavioural/run-cells.mjs --live --out C:/ctxr-cells --ctxreach dist/cli.js --claude-bin <tools-scratch>/cc/node_modules/.bin/claude --model <pinned id> --cells B1,B3,B4,B6`
   (capture, $0), then `--cells B2` (it runs the warm-up first and stops the
   verdict at "precondition-failed" if the home token did not reach the
   endpoint), then B7 (billed: check usage first). The harness refuses when
   an instruction file it did not plant sits above any folder a copy will
   live in, so keep `--out` outside the home folder.
3. `cells-results.json` holds per-arm k/n with Wilson bounds and the
   verdicts; `trials.jsonl` holds every trial, void or not.

Later cells (`cells.json` "later"): M1 and E0 reuse these arms and the
recorded fixtures once L2 and L3 have merged; the X-table comes from L3's
`src/probe/instruments.ts`.
