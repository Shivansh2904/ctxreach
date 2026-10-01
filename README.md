# ctxreach

Does your coding agent actually see your `AGENTS.md`?

`ctxreach` tells you which of a repository's instruction files (`AGENTS.md`,
`AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/`, and
the files they import) reach which coding agent, when it is launched from a
given directory, and up to which byte.

It covers Codex and Claude Code. Both load instruction files by rules that are
easy to get wrong, and when a file does not arrive, the session usually gives
no sign of it.

## Status

- **Works now: `ctxreach map`.** It predicts what each agent receives, from
  each agent's documented loading rules. It reads files and config only; it
  runs no agent and calls no API.
- **Works now, for Claude Code only: `ctxreach probe`.** It checks `map`'s
  predictions against the real agent, by planting random tokens in a
  throwaway copy of the repository and running the agent there headless and
  read-only. See [Checking a prediction](#checking-a-prediction-ctxreach-probe).
  A Codex adapter does not exist yet.
- **Works now, at no cost and with no login: `ctxreach verify`.** It checks
  `map`'s predictions against each agent's own machinery: the prompt Codex
  renders, and the first request a headless Claude Code session sends to a
  local recorder. See [Verify against the agents themselves](#verify-against-the-agents-themselves).

`ctxreach` is not on npm yet. Run it from a clone (see [Running it](#running-it)).

## Three ways instructions silently fail to arrive

1. **Codex spends one byte budget on the whole chain, root first.** Codex reads
   one instruction file per directory from the project root down to the
   launch directory, and stops at `project_doc_max_bytes` (32 KiB by default)
   for the chain as a whole. A long root `AGENTS.md` can leave nothing for the
   package file you launched next to.
2. **A personal `CLAUDE.local.md` switches `AGENTS.md` off in Claude Code.**
   By default, Claude Code reads `AGENTS.md` only when there is no
   `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in the launch
   directory or above it.
3. **Files below the launch directory are not preloaded.** Codex does not
   read them at all unless the model decides to open them; Claude Code loads
   a subdirectory's files only when it reads a file there.

Each rule, with the documentation or source it comes from and the date it was
checked, is in [docs/rules.md](docs/rules.md).

## Example

`examples/demo-monorepo` has all three traps: a large root `AGENTS.md`, a
payments rule in `packages/api/AGENTS.md`, and a `CLAUDE.local.md`. Launched
from `packages/api`, neither agent receives the payments rule. From the root
of a clone of this repository, after `npm ci` and `npm run build`, with no
`/tmp/demo` yet:

```text
$ cp -r examples/demo-monorepo /tmp/demo
$ git -C /tmp/demo init -q
$ node dist/cli.js map --from /tmp/demo/packages/api --no-color
ctxreach map  launch dir: packages/api  repo: /tmp/demo

  file                    Codex                                                        Claude Code
  AGENTS.md               launch, cut at byte 32768                                    no: switched off by CLAUDE.local.md
  CLAUDE.local.md         no: not a Codex instruction file                             launch
  packages/api/AGENTS.md  no: budget used up by earlier files                          no: switched off by CLAUDE.local.md
  packages/web/AGENTS.md  no: not on the path from the project root to the launch dir  no: outside the launch dir's tree

Codex
  project root  .            (has .git)
  budget        32768 bytes  (default)
  trust         unknown      (not set)
  global file   none

  #  file                    bytes  reaches Codex
  1  AGENTS.md               40960  first 32768 bytes (cut at line 547)
  2  packages/api/AGENTS.md  1152   nothing: budget used up
     budget used: 32768 of 32768 bytes

Claude Code
  Project instructions  claude-md-or-agents-md  (default)
  AGENTS.md             not read                (switched off by CLAUDE.local.md)
  version               not given               (assumes 2.1.281 or later; pass --claude-version to check an older one)

  Loaded at launch, in order: CLAUDE.local.md

Findings
  warn  codex  AGENTS.md is cut at byte 32768 of 40960 (line 547). The cut falls inside "General 61". Sections that never reach Codex: "General 62", "General 63", "General 64", "General 65" and 11 more.
  warn  codex  packages/api/AGENTS.md (1152 bytes) never reaches Codex: files earlier in the chain used the whole 32768-byte budget.
  warn  claude AGENTS.md does not reach Claude Code: the personal CLAUDE.local.md switches AGENTS.md off. Import it with @AGENTS.md, or set Project instructions to claude-md-and-agents-md.
  warn  claude packages/api/AGENTS.md does not reach Claude Code: the personal CLAUDE.local.md switches AGENTS.md off. Import it with @AGENTS.md, or set Project instructions to claude-md-and-agents-md.
```

This output was produced on 2026-09-28 by the commands shown, run from the
root of a clone of this repository with Node 20.20.2 on Linux, with no Codex
or Claude Code user config present. The byte counts are the sizes of the
example's files; the example's large file is generated by
`scripts/gen-fixtures.mjs`.

## Verify against the agents themselves

`verify` asks each agent's own machinery what it delivers from a launch
directory, and compares that with `map`. It runs in a temporary copy of the
repository, plants tokens as `probe` does, and costs nothing:

```sh
# Codex: free and deterministic, no login (needs the codex CLI)
node dist/cli.js verify --agent codex --from path/to/your/repo/packages/api

# Claude Code 2.1.281 or later: free, no login; --model is required and asserted
node dist/cli.js verify --agent claude --from path/to/your/repo/packages/api --model <model>

# Score a saved run again; no agent runs
node dist/cli.js verify --agent codex --replay test/recorded/verify/codex-root-starves-nested-packages-api
```

- **Codex:** it runs `codex debug prompt-input` twice, with a throwaway
  `CODEX_HOME`, and compares the `AGENTS.md` block Codex renders with
  `map`'s prediction byte for byte, file by file. The model is not run, so
  this shows what Codex sends, not what the model does with it.
- **Claude Code:** it runs `claude -p` with `ANTHROPIC_BASE_URL` pointing at
  a recorder on the loopback interface that answers 400, a dummy key and an
  empty config directory, and reads which instruction files the first
  request carries. Nothing is billed and no model runs. This is delivery to
  the model endpoint through a custom base URL; whether a first-party
  session delivers the same is measured separately, by `probe`.

A must-appear token in the prompt, a decoy file no rule loads, and two
trials that must deliver the same text are controls: if one fails, the
run is an instrument fault, its verdicts are void, and it exits with
status 3. A recording keeps only what ctxreach scores, never the agents'
own prompt text, and `--replay` scores it again on any machine.

The recordings in `test/recorded/verify/`, made on 2026-09-30 on Windows,
replay as follows: Codex 0.159.2 rendered 22 of 22 fixture launches byte for
byte as `map` predicted, and three Claude Code 2.1.285 captures agreed with
`map` in every cell (4 of 4, 2 of 2, 4 of 4). Those are one run each per
launch. Flags, the controls, what a recording keeps, and the limits are in
[docs/oracle.md](docs/oracle.md).

## Checking a prediction: `ctxreach probe`

`map` predicts from documentation. `probe` checks the prediction against
Claude Code itself: it copies the repository to a temporary directory, plants
a random token on the first and last line of every instruction file `map`
knows about, runs `claude -p` there headless and read-only, and records which
tokens the agent repeats. Each trial is a real, billed request on your own
login.

```sh
# Run Claude Code three times from packages/api, with the model pinned
node dist/cli.js probe --agent claude --from path/to/your/repo/packages/api --model <model>

# Score a saved run again; no agent runs
node dist/cli.js probe --replay test/recorded/demo-api-recall
```

- **Controls.** A decoy file that no rule loads must never be repeated, and a
  positive control, a rule without `paths` that Claude Code loads at launch,
  must be repeated in every trial. If either fails, or a session is not the
  one asked for, the run is an instrument fault: its results are void and it
  exits with status 3.
- **A second instrument.** An `InstructionsLoaded` hook, passed with
  `--settings`, reports the `CLAUDE.md` and rule files Claude Code loads, and
  the report crosses each file's tokens with it. `--no-hook` turns it off.
- **The model is pinned.** `--model`, else `ANTHROPIC_MODEL`, else the model
  in your `settings.json`, is passed to Claude Code, and every trial's session
  must report it; with none of them, the report says the model was not
  pinned.
- **Refused.** `probe` will not start while `CLAUDE_CODE_SIMPLE`,
  `CLAUDE_CODE_SAFE_MODE`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS` or
  `CLAUDE_CODE_DISABLE_ATTACHMENTS` is set, and never runs the agent with
  `--bare`, `--safe-mode` or `--restricted`: each turns instruction files
  off, so a run would measure nothing.
- **Isolation.** By default your own settings, plugins and
  `~/.claude/CLAUDE.md` apply, as in your own sessions. `--isolation clean`
  drops your settings and the instruction files above the copy, to show what
  the repository alone delivers. It is **EXPERIMENTAL**: four of its parts
  are unverified, it needs a model pin, and every report of a clean run says
  so.
- `--json` prints schema `ctxreach.probe/v2`. Recordings are format v2, and
  v1 recordings, such as the eight in `test/recorded/`, still replay.

Of the eight recorded runs (Claude Code 2.1.280 on Windows, 20 trials in
all), six agreed with `map` in every decided cell; the other two are
explained in [docs/probe.md](docs/probe.md). Two things are not measured yet:

- None of the recorded runs had the hook, so the hook's blind spot for
  `AGENTS.md` (rule `claude.hook-blind`) is not measured.
- Links are copied as what they point to, so rule `claude.symlink` (the
  content delivered once) is not measured.

How each token's delivery is worked out, the verdicts, a real run, where the
agent disagreed with `map`, what `probe` does not do, and every option are in
[docs/probe.md](docs/probe.md). The exact flags and checks, with their
sources, are in [docs/rules.md](docs/rules.md#probe).

## Running it

From a clone of this repository:

```sh
npm ci
npm run build
node dist/cli.js map --from path/to/your/repo/packages/api
```

Node 20 or later.

`map` finds the repository by walking up from `--from` to the nearest `.git`.
It reads your Codex config (`$CODEX_HOME` or `~/.codex`) and your Claude Code
settings (`~/.claude`), because both change what the agents load. Point
`--codex-home` and `--claude-home` at empty directories to see what a machine
with no personal config would get.

| Option | Meaning |
|---|---|
| `--from <dir>` | Directory the agent is launched in (default: current directory). |
| `--repo <dir>` | Directory to scan for instruction files (default: nearest ancestor with `.git`). |
| `--agents <list>` | `codex`, `claude`, or both (default). |
| `--json` | JSON output, schema `ctxreach.map/v1`. |
| `--fail-on-warn` | Exit with status 1 if there is any warning, for CI. |
| `--codex-home <dir>` | Codex home (default: `$CODEX_HOME`, then `~/.codex`). |
| `--codex-max-bytes <n>` | Use this `project_doc_max_bytes`, overriding every config file. |
| `--codex-trust <level>` | Assume the project is `trusted`, `untrusted` or `unknown` to Codex. |
| `--claude-home <dir>` | Claude Code user directory (default: `~/.claude`). |
| `--claude-mode <mode>` | Assume this **Project instructions** value. |
| `--claude-version <x.y.z>` | Model this Claude Code version's `AGENTS.md` support. |

Exit status: 0 on success, 1 with `--fail-on-warn` and a warning, 2 when
`--from` or `--repo` is not an existing directory, when `--from` is outside
`--repo`, or when a Codex or Claude Code config file cannot be parsed.

## What `map` does not do

- It predicts from documented rules. It cannot tell you whether the agent
  follows an instruction, only whether the instruction should arrive.
- Where Codex's behaviour depends on the model choosing to open a file (files
  below the launch directory), `map` can only say "not preloaded". Measuring
  what actually happens is what `probe` is for.
- Agents change their loading rules often. The rules here were checked on
  the date given in [docs/rules.md](docs/rules.md), which also lists what is
  not modelled (config profiles, managed policy files, `claudeMdExcludes`,
  and others).

## Study

A pre-registered study will measure how often these traps occur in public
repositories that have an `AGENTS.md`, with `map` checked against Codex's
own renderer, and run lab cells through the capture oracle. Its frames,
outcomes, hypotheses, checks and decision rules are fixed in
[study/PREREG.md](study/PREREG.md) before any sampled repository is
fetched. There are no results yet. What the study publishes per repository
is `owner/repo@commit`, measurements and blob ids, never file contents, and
no repository is named for a defect.

Repository owners can opt out of the study by opening an issue on github.com/Shivansh2904/ctxreach; there is no email address.

## Development

```sh
npm test                       # vitest
npm run typecheck
npm run format:check
npm run build                  # tsup, into dist/
node scripts/plant-faults.mjs  # remove each finding in turn; a test must fail
node scripts/plant-probe-faults.mjs  # break each part of probe in turn; a test must fail
node scripts/plant-oracle-faults.mjs # break each part of verify in turn; a test must fail
node scripts/plant-site-faults.mjs   # break each check of the results site in turn; a test must fail
node scripts/evidence.mjs --check    # docs/evidence.md is current; `plant` breaks each registry check
node scripts/bundle-action.mjs --check  # the Action's committed bundle matches a fresh build
```

Each trap has a small fixture repository under `test/fixtures/` and a clean
twin that must produce no finding for that trap. `scripts/plant-faults.mjs`
checks that the tests would notice a detector going missing: for each finding
code, it runs the suite with that finding filtered out of the resolvers'
output (in memory; no file is changed), and it exits non-zero if any code
goes unnoticed.
Files that need exact byte sizes are generated by `scripts/gen-fixtures.mjs`,
and a test checks that the committed copies still match it.

`probe` is tested without an agent: a fake agent that writes Claude Code's
`stream-json` format drives the whole pipeline, a fake `claude` executable
drives the adapter, and the real runs in `test/recorded/` are replayed.
`scripts/plant-probe-faults.mjs` breaks one part of `probe` at a time (the
classifier ignoring tool calls, the decoy check switched off, recall mode left
with a tool, the copy keeping its hooks or copying links as links, and more)
and checks that a test fails for each. Each planted run gets a temporary
directory of its own, which is all it deletes afterwards.

When you change a rule, update [docs/rules.md](docs/rules.md) with its source
and the date you checked it; a test fails if `map` produces a rule id or
finding code that the doc does not list.

## Licence

MIT. See [LICENSE](LICENSE).
