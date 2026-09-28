# Changelog

## Unreleased

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
  (stripped of hooks, MCP servers, skills and its `.git`), runs `claude -p`
  there with no tools (`--mode recall`) or only read tools (`--mode task`),
  and reports how each token arrived, against the prediction, as fractions
  of usable trials. A decoy file and per-trial session checks catch a broken
  instrument. Runs are recorded and can be re-scored with `--replay`; JSON
  output has schema `ctxreach.probe/v1`. Codex has no probe adapter yet.
- Recorded probe runs of Claude Code 2.1.280 in `test/recorded/`, replayed by
  the tests. Two disagreements with `map`, launched from a subdirectory: an
  ancestor directory's path-less rule was preloaded, and an import from
  outside the launch directory did not load under `claude -p`.
- `scripts/plant-probe-faults.mjs`: breaks one part of the probe at a time and
  checks that a test fails.
- `examples/demo-monorepo` has a source file in `packages/api`, so a task-mode
  probe has something to read.
