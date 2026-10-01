# K6 protocol: the blind second reader

Check K6 of `study/PREREG.md` (section 8): a fresh reader derives delivery
by hand for 30 (repository, launch directory) pairs of the census from
`docs/rules.md` alone. It checks two things at once: that `map` computes
what the rules say, and that the rules, as written, are enough to say it. It
is reported as x/30 with every disagreement adjudicated in the open. It is
run once, after the census and on the frozen build (step 6 of PREREG.md
section 13); it never changes a census row.

## 1. Draw (`handcheck.mjs draw`)

- Pool: every measured S-main and S-imp row without a fault that has a
  type-1 or type-2 launch directory.
- Stage 1: 30 repositories by the seeded shuffle of `study/census/lib/prng.mjs`
  with the study seed and stream `K6|repos`, in canonical (sorted) order.
- Stage 2: one type-1 or type-2 launch directory in each, uniformly, stream
  `K6|dir|<repo>`. Two stages keep one repository with many launch
  directories from filling the sheet.
- Ids `K6-01` to `K6-30` in the order drawn. `pairs.json` maps ids to
  repositories and stays with the study data; nothing published names a
  repository.

## 2. Sheets and the sealed key (`handcheck.mjs sheets`)

- Each pair's repository is rebuilt at its census commit through the
  GET-only client (check K7 applies: the script prints its non-GET count,
  which must be 0), and its files must match the census row's paths, modes
  and blob ids; a mismatch stops the step.
- The sheet gives the launch directory, the fixed conditions of the census
  unit (a fresh machine, Claude Code 2.1.285 headless with no approval ever
  given, Codex 0.159.2 with default configuration and no trust entry), and
  every file the reconstruction holds with its size, its link target if it
  is a symlink, and its text. Nothing on it comes from `map`.
- **Blindness is checked, not assumed:** every sheet is scanned for rule
  ids, finding codes and answer vocabulary outside the repository's own
  text, and for the pair's key anywhere; a hit stops the step.
- The key is `map`'s answer taken from the census row (not re-run): the
  files Claude receives at launch headless (`received` in
  `study/census/detectors.mjs`, symlinks written as their targets per rule
  `claude.symlink`), the files `map` marks not modelled, and Codex's chain
  with the bytes kept of each. `key.json` sits outside the reader's folder.
- `manifest.json` records the SHA-256 of `key.json`, of the `rules.md` copy,
  of the brief and of every sheet **before the reader starts**; `score`
  refuses a key whose hash moved.

## 3. The reader

- A fresh subagent (or person) that has not worked on ctxreach, given only
  the folder `reader/` (`rules.md`, `READER-BRIEF.md`, `sheets/`,
  `answers/`) in an otherwise empty working directory.
- The brief is `READER-BRIEF.md`, verbatim. The reader answers every
  sheet; undecided cases are answered with a best reading and a note.
- The reader's transcript is kept, so anyone can see what it read.

## 4. Scoring (`handcheck.mjs score`)

- A pair **agrees** when all three fields match: `claude.receives` (as a
  set), `claude.notModelled` (as a set), and `codex.chain` (in order, with
  the bytes kept). An unanswered or malformed field is a disagreement.
- Reported: x/30 pairs, and per agent (Claude k/30, Codex k/30), each with
  its Wilson 95% interval, from `k6-results.json`.
- There is no pass threshold: K6 is reported as found.

## 5. Adjudication, in the open

`score` writes `adjudication.md` with one row per disagreeing field: the
pair id, the field, `map`'s answer and the reader's. Each row gets one
verdict and a reason:

| Verdict | Meaning | What follows |
|---|---|---|
| reader | the reader misapplied a rule | the rule id is cited; nothing changes |
| map | `map` disagrees with the rule as written | a map defect: appended to PREREG.md's deviations, with the census outcomes it could move |
| rules | `docs/rules.md` is silent or ambiguous | the rule text is fixed after the study; the case is listed |

Adjudication names pair ids and paths inside the repository, never the
repository. It is published beside `results.json`.

## 6. Data handling

The sheets hold instruction-file text from public repositories, so they
live only in the K6 work folder: never committed, never published, and
deleted by `handcheck.mjs clean` once adjudication is done. What is kept:
`pairs.json` (with the study data), `key.json`, `manifest.json`, the
answers, `k6-results.json` and `adjudication.md`.
