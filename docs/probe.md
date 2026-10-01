# Checking a prediction: `ctxreach probe`

<!-- Moved from README.md (the section of the same name), unchanged but for its
heading levels and links, so the README can stay short. Lane L3 owns the
content; lane L6 owned the move. -->

`map` predicts from documentation. `probe` checks the prediction against the
agent itself:

1. It copies the repository to a new temporary directory. The copy loses
   everything that could make the agent run a command: project settings
   (hooks, helper commands), `.mcp.json`, skills, subagents, `.codex/`, and
   the repository's own `.git`. It gets a fresh `git init` with no hooks.
   The copy holds no links: a link to a file or directory inside the
   repository is copied as that file or directory, and a link that leads
   outside the repository, to nothing, or into a loop is left out and
   listed in the report.
2. It plants a random token (`CTXR-` and 8 hex digits) on the first and last
   line of every instruction file `map` knows about in the copy, and in a
   decoy file that no documented rule loads.
3. It asks `map` what the agent should receive, launched from the same
   directory in the copy, for the version of the agent that is installed.
4. It runs the agent headless in the copy, once per trial, and saves each
   transcript. It then deletes the copy.
5. It works out, for each token, how it reached the agent, and compares that
   with the prediction.

It only ever runs the agent inside its own temporary copy (a
`ctxreach-probe-` directory inside the system temp directory, whose marker
file says this run finished stripping it), checks the copy again right before
each trial (nothing it strips, no link, and git using the copy's own `.git`),
and refuses otherwise. It never runs with `--bare`, which skips
`CLAUDE.md`. The exact flags, and why each is there, are in
[docs/rules.md](rules.md#probe).

Two modes:

- `--mode recall` (default): the agent has no tools at all, and is asked to
  list every token in its instructions. This measures what is **preloaded**.
- `--mode task`: the agent has only Read, Glob and Grep, and a read-only
  request (`--task`), then lists the tokens it has seen. This measures what
  arrives **while it works**: Claude Code loads a subdirectory's files when
  it reads a file there.

For each token in each trial, the probe records one of:

| Observation | Meaning |
|---|---|
| preloaded | Repeated, and no tool call touched its file (or, for a file below the launch directory, its directory) first. |
| on read | Repeated after a tool call touched a path in its directory, but not the file itself. Claude Code leaves no trace of this delivery in its output, so it is inferred from the order of events. |
| self-discovered | Repeated after a tool call named the file, or after the token appeared in a tool's output: the model went and read it. |
| not seen | Never repeated. |
| contaminated | The trial used a tool it was not allowed (any tool, in recall mode) or searched for the tokens. The whole trial is left out, and reported. |

Each token then gets a verdict against `map`: **CONFIRMED**, **MISSED**
(predicted to arrive, and did not in every usable trial), **EXTRA** (arrived
by the agent's own loading where `map` said it would not), **DISCOVERED** (not
loaded, but the model opened the file itself), **UNTESTED** (for example,
predicted on read, but no trial read a file there), or **NOT MODELLED** (`map`
says it does not model the file, such as an ancestor directory's rules, so it
made no prediction; what was observed is still shown). UNTESTED and NOT
MODELLED cells are not counted as agreeing or disagreeing.

The probe also checks itself:

- The decoy must be repeated in 0 of the usable trials, unless the agent
  read it first. Any other echo of it, and any trial whose session was not
  the one asked for (other tools, another directory, another version), marks
  the run as an **instrument fault**, which voids its results, prints no
  agreement figure (in `--json`, `agreement` is `null`), and exits with
  status 3. A trial that stops before its session starts (for example, when
  the agent is not logged in) is counted as failed, not as a fault.
- It warns when nothing is predicted to load at launch, since then a broken
  instrument that saw nothing would look like agreement.
- It counts stream events it does not recognise, instead of failing on them
  or hiding them.

Every result is a fraction of usable trials, stamped with the agent's version,
the OS and the date.

## A real run

On 2026-09-28, with Claude Code 2.1.280 on Windows 11 (model
`claude-fable-5-1`, Node 22.19.0), from the root of this repository after
`npm run build`:

```sh
node dist/cli.js probe --agent claude --repo examples/demo-monorepo --from examples/demo-monorepo/packages/api --mode recall --trials 3 --save test/recorded/demo-api-recall --no-color
```

That run's transcripts are in `test/recorded/demo-api-recall`. The report
below was printed from them with
`node dist/cli.js probe --replay test/recorded/demo-api-recall --no-color`,
which runs no agent and prints the same report as the run itself, except that
the last line shows the recording's path relative to the current directory:

```text
ctxreach probe  Claude Code 2.1.280, recall mode, launch dir packages/api  (demo-monorepo)
  run     2026-09-28T19:25:50.258Z on win32 10.0.26200 (x64), model claude-fable-5-1
  trials  3 of 3 recorded: 3 usable, 0 contaminated, 0 failed, 0 faulty

  file                                    token  map predicts                         observed (of 3 usable)  verdict
  AGENTS.md                               head   no: switched off by CLAUDE.local.md  not seen 3/3            CONFIRMED
  AGENTS.md                               tail   no: switched off by CLAUDE.local.md  not seen 3/3            CONFIRMED
  CLAUDE.local.md                         head   launch                               preloaded 3/3           CONFIRMED
  CLAUDE.local.md                         tail   launch                               preloaded 3/3           CONFIRMED
  packages/api/AGENTS.md                  head   no: switched off by CLAUDE.local.md  not seen 3/3            CONFIRMED
  packages/api/AGENTS.md                  tail   no: switched off by CLAUDE.local.md  not seen 3/3            CONFIRMED
  packages/web/AGENTS.md                  head   no: outside the launch dir's tree    not seen 3/3            CONFIRMED
  packages/web/AGENTS.md                  tail   no: outside the launch dir's tree    not seen 3/3            CONFIRMED
  packages/api/ctxreach-decoy.md (decoy)  head   decoy: no rule loads it              not seen 3/3            control: ok
  packages/api/ctxreach-decoy.md (decoy)  tail   decoy: no rule loads it              not seen 3/3            control: ok

Instrument
  decoy repeated without being read: 0/3 usable trials (must be 0)
  stream events not understood: 0 of 12 (tolerated, counted)

Agreement with map: 8 of 8 decided cells agree (CONFIRMED 8); 8 cells in all.

Notes
  Removed from the agent's environment (set by the Claude Code session that ran ctxreach): 26 variables.

An echo proves the text was delivered to the model. It does not prove the model follows it.
These results hold only for Claude Code 2.1.280 on win32 10.0.26200, on 2026-09-28, with this repository and prompt.
Each fraction counts usable trials only; contaminated, failed and faulty trials are listed separately.
Recording: test/recorded/demo-api-recall  (re-score with: ctxreach probe --replay <dir>)
```

In this run every cell agreed with `map`: 3 of 3 trials repeated the
`CLAUDE.local.md` tokens, and none repeated any `AGENTS.md` token. That is the
documented rule, observed: a personal `CLAUDE.local.md` switches `AGENTS.md`
off, so the payments rule in `packages/api/AGENTS.md` reached Claude Code in
0 of these 3 trials, and in 0 of 3 task-mode trials launched at the root that
read `packages/api/src/payments.ts` (`demo-root-task`).

## Where the agent disagreed with `map`

Eight recorded runs, 20 trials in all, are listed in
[test/recorded/README.md](../test/recorded/README.md). Six agreed with `map` in
every decided cell. Two did not, both launched in `packages/api`, and for the
same reason:

- **An ancestor's import from outside the launch directory did not load
  under `claude -p`.**
  Launched in `packages/api`, the root `CLAUDE.md`'s import of a file outside
  `packages/api` was loaded in 0/2 trials in each run (`nested-api-recall`,
  `ancestor-imports-recall`). In `ancestor-imports-recall` the same
  `CLAUDE.md`'s import of a file inside `packages/api` was loaded in 2/2.
  `map` says such an import "needs approval"; the documentation describes
  the approval dialog, but not what a headless run, which shows no dialog,
  does. Verdict: MISSED (2 of the 10 decided cells in `nested-api-recall`, 2
  of the 6 in `ancestor-imports-recall`).

One more thing was seen that `map` does not model, so it is not counted
either way:

- **The copy's root rules, launched from a subdirectory.** Launched in
  `packages/api`, Claude Code preloaded `.claude/rules/style.md` (no `paths`)
  from the copy's root in 2/2 trials; the rule with `paths` beside it was not
  preloaded (0/2). That root is both the copy's project root and its git
  root, and it is the only directory above the launch directory that had
  rules, so this says nothing about rules in other ancestors. The
  documentation does not say whether an ancestor's rules load; `map` labels
  them "not modelled", and the probe gives those cells the verdict NOT
  MODELLED.

These are small samples from one agent version on one machine. They are
reported, not folded into `map`: `map` follows the documentation, and the
probe is how a gap like this gets noticed.

## What `probe` does not do

- **An echo proves delivery, not compliance.** A repeated token shows the
  file's text reached the model. It says nothing about whether the model
  follows the instructions in it.
- Results hold only for the stamped version, OS, repository and prompt.
  Agents change their loading rules often; run it again after an upgrade.
- It supports Claude Code only. Codex needs its own adapter, which does not
  exist yet (`--agent codex` says so and exits).
- It runs your installed agent with your login, and each trial is a real,
  billed request. By Claude Code's own estimate, the 20 recorded trials cost
  US$1.03 in all, from US$0.002 to US$0.13 each.
- It has no second instrument yet: it does not install an
  `InstructionsLoaded` hook, so the hook's blind spot for `AGENTS.md`
  (rule `claude.hook-blind`) is not measured.
- A rule with `paths` is CONFIRMED when it arrives after a read and is never
  preloaded. When it does not arrive in task mode, the cell is UNTESTED, not
  MISSED: `map` does not work out which files match its `paths`, so the probe
  cannot tell whether any file read matched.
- In task mode, a file below the launch directory whose token is repeated
  after a read in its directory counts as "on read" even if it had been
  preloaded: the order of events cannot tell the two apart. Whether such a
  file is preloaded comes from a recall run from the same directory; the
  recorded task runs with on-read cells (`nested-task`, `agents-task`) are
  paired with one (`nested-recall`, `agents-recall`).
- Your own Claude Code configuration still applies. The copy loses the
  repository's hooks, skills and plugins, but the hooks, plugins and skills
  in your `~/.claude` (and any managed settings) run in every trial, as in
  any session, and your own instruction files there reach the agent too
  (the report lists those `map` finds).
- Links are copied as what they point to, so a `CLAUDE.md` that is a link
  to `AGENTS.md` reaches the agent as two separate files, and rule
  `claude.symlink` (the content delivered once) is not measured.
- The copy lives in the system temp directory, so instruction files in that
  directory's ancestors would reach the agent too. The report lists any that
  `map` finds.
- Saved transcripts have the temporary path, your home directory, your
  command, skill, agent and plugin lists and rate-limit details removed.
  Read them before sharing: they still contain the agent's messages and the
  files it read.

| Option | Meaning |
|---|---|
| `--agent <agent>` | `claude` (default). `codex` is not supported yet. |
| `--from <dir>` | Directory the agent is launched in (default: current directory). |
| `--repo <dir>` | Repository to copy (default: nearest ancestor with `.git`). |
| `--mode <mode>` | `recall` (default) or `task`. |
| `--task <text>` | The read-only request in task mode. |
| `--trials <n>` | Runs, 1 to 10 (default 3). |
| `--save <dir>` | Where to record the run (default: a new directory under the system temp directory). Must not be inside the repository. |
| `--replay <dir>` | Score a saved run instead of running the agent. |
| `--json` | JSON output, schema `ctxreach.probe/v1`. |
| `--timeout <s>` | Time limit per run (default 300). |
| `--claude-bin <path>` | The `claude` executable (default: found in a fully qualified `PATH` directory: absolute, and on Windows with its drive). A relative path is taken from the current directory; one inside the temporary copy is refused. |
| `--claude-home <dir>` | Claude Code user directory `map` reads for the prediction. |

Exit status: 0 when at least one trial was usable and the instrument checks
passed, 1 when no trial was usable, 2 for a usage or safety error, 3 for an
instrument fault.

