# Recorded probe runs

Real runs of `ctxreach probe` against Claude Code, kept so that the tests
(`test/probe-recorded.test.ts`, `test/probe-events.test.ts`) can replay them
without calling an agent. CI never runs an agent.

All runs: Claude Code 2.1.280, model `claude-fable-5-1` (the account's
default), Windows 11 (`win32 10.0.26200`, x64), Node 22.19.0, on 2026-09-28,
from the root of this repository after `npm run build`. Every command also
had `--no-color`.

Each directory holds `manifest.json` (the planted tokens, `map`'s prediction
for each file, the exact arguments and prompt, and how each trial ended) and
one `trial-N.jsonl` per trial: the agent's `stream-json` output, with the
temporary copy's path replaced by `C:\ctxreach-probe`, the home directory by
`C:\Users\user`, and the account's command, skill, agent and plugin lists and
rate-limit details removed. Re-score any of them with:

```sh
node dist/cli.js probe --replay test/recorded/<name>
```

| Recording | Command (after `node dist/cli.js probe --agent claude`) | Result |
|---|---|---|
| `demo-api-recall` | `--repo examples/demo-monorepo --from examples/demo-monorepo/packages/api --mode recall --trials 3 --save test/recorded/demo-api-recall` | 8 of 8 decided cells agree with `map`; decoy 0/3 |
| `demo-root-task` | `--repo examples/demo-monorepo --from examples/demo-monorepo --mode task --task "Explain what packages/api/src/payments.ts does." --trials 3 --save test/recorded/demo-root-task` | 8 of 8 agree; decoy 0/3 |
| `nested-recall` | `--repo test/recorded/sources/nested-claude --from test/recorded/sources/nested-claude --mode recall --trials 2 --save test/recorded/nested-recall` | 14 of 14 agree; decoy 0/2 |
| `nested-task` | `--repo test/recorded/sources/nested-claude --from test/recorded/sources/nested-claude --mode task --task "Explain what packages/api/src/index.ts does." --trials 3 --save test/recorded/nested-task` | 14 of 14 agree; decoy 0/3 |
| `agents-recall` | `--repo test/recorded/sources/agents-only --from test/recorded/sources/agents-only --mode recall --trials 2 --save test/recorded/agents-recall` | 6 of 6 agree; decoy 0/2 |
| `agents-task` | `--repo test/recorded/sources/agents-only --from test/recorded/sources/agents-only --mode task --task "Explain what packages/api/src/index.ts does." --trials 3 --save test/recorded/agents-task` | 4 of 4 decided cells agree, 2 untested; decoy 0/3 |
| `nested-api-recall` | `--repo test/recorded/sources/nested-claude --from test/recorded/sources/nested-claude/packages/api --mode recall --trials 2 --save test/recorded/nested-api-recall` | **8 of 10 decided cells agree: 2 MISSED**; 4 NOT MODELLED; decoy 0/2 |
| `ancestor-imports-recall` | `--repo test/recorded/sources/ancestor-imports --from test/recorded/sources/ancestor-imports/packages/api --mode recall --trials 2 --save test/recorded/ancestor-imports-recall` | **4 of 6 agree: 2 MISSED**; decoy 0/2 |

The repositories the probe copied are `examples/demo-monorepo` and the three
under `sources/`.

## Where the agent and `map` differ

- **The copy's root rules, launched from a subdirectory (not modelled).**
  Launched in `packages/api`, Claude Code preloaded `.claude/rules/style.md`
  (no `paths`) from the copy's root, which is also its git root, in 2/2
  trials, and did not preload the rule with `paths` there (0/2). No other
  directory above `packages/api` had rules, so no other was tested. `map` does not model an ancestor's rules
  (docs/rules.md, rule `claude.rules`), so these cells are NOT MODELLED and
  are not counted either way. The documentation does not say whether they
  load, so the resolver is unchanged.
- **An external import does not load in `claude -p` (the one disagreement).**
  Launched in `packages/api`, the root `CLAUDE.md`'s `@docs/testing.md`
  import was loaded in 0/2 trials. `map` predicted "import, needs approval": the
  documentation says Claude Code asks once to approve imports from outside
  the launch directory, but not what a `-p` session, which shows no dialog,
  does. `ancestor-imports-recall` separates the two possible causes: the
  same root `CLAUDE.md` importing a file inside `packages/api` loaded (2/2),
  while its import from outside did not (0/2). The probe counts the cell
  against the unconditional part of the prediction (loaded at launch), so it
  shows as MISSED.

## A recording that was replaced

`nested-task` was recorded twice. The first recording (made just before the
current one, same command, same echoes) was scored by a classifier that
treated every `.claude/rules/` file as loadable on read, which labelled the
path-less `style.md` "on read" instead of "preloaded". Canaries now record
whether their rule file declares `paths` (the `scoped` field), and that
recording has no such field, so replayed today it would misreport the scoped
rule as preloaded. It was re-recorded rather than edited, and is not kept.

## Recorded before the positive control (`before-f5/`)

All eight recordings above are format v1: they were made before ctxreach
planted a positive control, ran the InstructionsLoaded hook, pinned the model
or recorded where the copy was. `before-f5/` holds what
`node dist/cli.js probe --replay test/recorded/<name> --no-color` (`.txt`) and
`... --json` (`.json`) printed for each of them at commit `47e60a0`, before
any of that existed. `test/probe-recorded.test.ts` replays every recording
today and checks that the report is the same, line for line, apart from two
added lines (the control marked "absent (recorded before F5)", and the count
of partial echoes), and that the JSON is the same apart from the schema name
and the fields v2 adds.
