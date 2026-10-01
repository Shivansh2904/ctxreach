# Changelog

## Unreleased (0.1.0)

### Added on 2026-10-01

- Version 0.1.0 in `package.json`, so `dist/cli.js --version` tells a build
  of these sources from one of the earlier 0.0.0 ones (`study/prereg.mjs`
  compares it with the tag's `package.json`).
- `probe`, recording format v2, JSON schema `ctxreach.probe/v2`:
  - A positive control: `.claude/rules/ctxreach-control.md`, a rule without
    `paths` at the launch directory of the copy, whose two tokens every
    usable trial must repeat; a missed control is an instrument fault
    (exit 3). Its cells are shown and never counted in the agreement.
  - An `InstructionsLoaded` hook, passed with `--settings` from the
    sandbox's own directory, crossed with the tokens file by file; its log
    is saved per trial. `--no-hook` turns it off.
  - `--model` pins the model (else `ANTHROPIC_MODEL`, else `model` in the
    `settings.json` of `--claude-home`), and each session must report it,
    the recorded arguments and, from 2.1.277, the built-in `agents-md`
    plugin.
  - Refused: `CLAUDE_CODE_SIMPLE`, `CLAUDE_CODE_SAFE_MODE`,
    `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and `CLAUDE_CODE_DISABLE_ATTACHMENTS`
    set, and `--bare`, `--safe-mode` or `--restricted` in the arguments
    (exit 2).
  - Where the copy was is reported (inside the home directory or not,
    `~/.claude/CLAUDE.md`, instruction files above the copy), and partial
    echoes are counted.
  - `--isolation clean`, EXPERIMENTAL: drops the user's settings and the
    instruction files above the copy; four of its parts are unverified.
  - v1 recordings still replay: the eight in `test/recorded/` print two
    more lines than before and nothing else changes
    (`test/recorded/before-f5/`). `scripts/plant-probe-faults.mjs` has 117
    plants.
- `docs/probe.md`: the probe section of the README, moved there and brought
  up to format v2; the README keeps a summary.
- A results site, `site/index.html`, rendered from `site/data/` once the
  study has run (`scripts/site-data.mjs`); the write-up generator
  `scripts/writeup.mjs`; `scripts/plant-site-faults.mjs`. SAMPLE data for
  its tests and previews is in `test/site-sample/`, made by the study's own
  analysis from invented rows, and never in `site/data/`.
- The README demo as an asciicast and an SVG recorded from real `map`
  output (`scripts/make-cast.mjs`, `docs/demo.cast`, `docs/demo.svg`).
- Talk and workshop material in `talk/` and `workshop/`.

### Added since 2026-09-30

- `ctxreach verify --agent codex|claude`: checks `map` against each agent's
  own machinery, at no cost and with no login, in the probe's temporary
  copy. Codex: `codex debug prompt-input` with a throwaway `CODEX_HOME`,
  two renders that must be identical, and the `AGENTS.md` block compared
  with `map` byte for byte per chain file (EXACT or OFF BY n); the model is
  not run. Claude Code (2.1.281 or later): `claude -p` against a loopback
  recorder that answers 400, a dummy key, an empty config directory (or a
  scratch home with `--home`), `--model` pinned and asserted from
  `system/init`; nothing is billed. A must-appear token, a decoy and the
  session asserts void a run (exit 3). Recordings keep only what ctxreach
  scores, never the agents' own prompt text, and `--replay` scores them
  again; JSON output has schema `ctxreach.verify/v1`. Details in
  `docs/oracle.md`. The oracle API is exported from the package entry.
- Recorded `verify` runs of 2026-09-30 in `test/recorded/verify/`: Codex
  0.159.2, 22 of 22 fixture launches byte-exact with `map`; three Claude
  Code 2.1.285 captures agreeing in every cell (4/4, 2/2, 4/4); and the
  pilot renders and captures.
- `scripts/conformance.mjs` (the planted-fault pass first, then every
  fixture named after an agent, into `results.json`) and
  `scripts/plant-oracle-faults.mjs`.
- `test/oracle-vendor-text.test.ts`: fails if any recording, source, test,
  script or document holds a phrase of Codex's or Claude Code's own prompt.
- `map` for Claude Code:
  - `claude.home-ancestor` (warn): a `CLAUDE.md`, `.claude/CLAUDE.md` or
    `CLAUDE.local.md` above the repository switches `AGENTS.md` off,
    `~/.claude/CLAUDE.md` included for a repository under the home
    directory; the exemption for that file is gone, and rule `claude.user`
    is corrected. The message carries the rule's evidence status from
    `docs/evidence.json`.
  - `claude.external-import-headless` (warn): an import from outside the
    launch directory is predicted not loaded unless `~/.claude.json`
    records an approval for the project (`map` reads that one key);
    `claude.external-import` (info) now means an approved one. This is the
    disagreement the two recorded probe runs from `packages/api` showed.
  - `claude.link-as-text` (warn): a `CLAUDE.md`-family file whose whole
    text is one relative path, a symlink git checked out as a plain file.
  - An `AGENTS.md` whose text equals an instruction file already loaded is
    loaded once (`claude.modes`).
  - An `AGENTS.md` that a `CLAUDE.md` imports is no longer reported as
    shadowed, and a `CLAUDE.md` that imports one no longer raises
    `claude.words-not-import`.
  - The resolver can model an ancestor directory's `.claude/rules/`
    (`ancestorRules`), off by default: `map` and `probe` still list those
    rules as not modelled.
- `map` for Codex: `codex.home-is-root` (warn) when `$CODEX_HOME` is a
  directory on the chain, so the file there arrives twice.
- `scripts/plant-faults.mjs` also plants 15 faults in rules that raise no
  finding of their own, and in the evidence label.
- A GitHub Action (`action.yml`, a committed single-file bundle in
  `action/dist/`, `scripts/bundle-action.mjs --check`): annotations at the
  line where instructions stop arriving, a job summary per launch
  directory, `fail-on`. Workflows for its selftest, bundle freshness, a
  nightly conformance run and Pages. Not released; `docs/action.md`.
- `npm` builds `dist/` on install from git (`prepare`).
- An evidence registry, `docs/evidence.json`, with `docs/evidence.md`
  generated from it and `test/evidence.test.ts`: every rule id and finding
  code has an entry, every observed or contradicted entry replays to its
  fraction, and the README names no rule whose status is not `observed`.
- The study: `study/PREREG.md` (the pre-registration, not yet tagged), the
  census pipeline with checks K1 to K7, the behavioural lab cells, the
  pilot artefacts reduced to what ctxreach scores, and drafts of four
  upstream reports. K1's known answers cover every fixture.

### Before 2026-09-30

- `ctxreach map` for Codex: the root-to-launch-directory chain, one file per
  directory, the shared root-first byte budget with the cut point and the
  sections lost, project config and trust, and files below the launch
  directory.
- `ctxreach map` for Claude Code: the `CLAUDE.md` family up to the filesystem
  root, subdirectory files loaded on read, the `AGENTS.md` shadow rule and the
  Project instructions setting, `@` imports, and the version gates.
- A files-by-agents matrix in the terminal output and `--json` (schema
  `ctxreach.map/v1`).
- `map` exits with status 2 and says why when `--from` or `--repo` is not an
  existing directory, or when `--from` is outside `--repo`.
- `ctxreach probe --agent claude`: checks `map`'s prediction against Claude
  Code itself. It plants random tokens in a temporary copy of the repository
  (stripped of hooks, MCP servers, skills and its `.git`, and holding no
  links), runs `claude -p` there with no tools (`--mode recall`) or only read
  tools (`--mode task`), and reports how each token arrived, against the
  prediction, as fractions of usable trials. A decoy file and per-trial
  session checks catch a broken instrument. Files `map` does not model get
  no verdict (NOT MODELLED) and are not counted. Runs are recorded and can be
  re-scored with `--replay`; JSON output has schema `ctxreach.probe/v1`.
  Codex has no probe adapter yet.
- `map` marks the rows it does not model (an ancestor directory's rules) with
  `notModelled` in its JSON.
- Recorded probe runs of Claude Code 2.1.280 in `test/recorded/`, replayed by
  the tests. One disagreement with `map`, in both runs launched from a
  subdirectory: an import from outside the launch directory did not load
  under `claude -p` (0/2 trials in each). Also seen, and not counted because
  `map` does not model it: launched in `packages/api`, the copy's root rule
  without `paths` was preloaded (2/2).
- `scripts/plant-probe-faults.mjs`: breaks one part of the probe at a time and
  checks that a test fails.
- `examples/demo-monorepo` has a source file in `packages/api`, so a task-mode
  probe has something to read.
