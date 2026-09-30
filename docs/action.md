# The ctxreach GitHub Action

The Action runs `ctxreach map` in a workflow and turns its warnings into
annotations on the lines where instructions stop reaching Codex or Claude
Code, plus a job summary with one matrix per launch directory. It runs no
agent and calls no API: like `map`, it predicts from each agent's documented
loading rules ([rules.md](rules.md)), and [evidence.md](evidence.md) says how
well each rule is supported.

```yaml
name: Instructions
on: [push, pull_request]
jobs:
  ctxreach:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Shivansh2904/ctxreach@<commit-sha>
        with:
          fail-on: codex.cut,claude.agents-shadowed
```

There is no release tag yet, so pin a commit. The Action is a composite
action that runs `node` on a committed single-file bundle
(`action/dist/ctxreach.cjs`), so it needs no `npm install`, only Node 20 or
later on the runner's `PATH`, which GitHub-hosted runners have. Its own
selftest runs it on Ubuntu and Windows.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `path` | `.` | Directory to scan, relative to the workspace: usually the repository root. Nothing above it is read. |
| `launch-dirs` | `auto` | Directories an agent is launched in, relative to `path`, one per line or separated by commas. `auto` is `path` itself and every directory that holds an instruction file (for a file under `.claude/`, the directory that holds `.claude`). |
| `agents` | `all` | `codex`, `claude`, or both separated by a comma. |
| `fail-on` | `none` | `none` never fails the step. `warn` fails it on any warning. A list of finding codes (the Findings table in [rules.md](rules.md)), such as `codex.cut,claude.agents-shadowed`, fails it only on those. |

An input that makes no sense (an unknown agent, a launch directory outside
`path` or missing, a `fail-on` code that is not in that Findings table, such
as the typo `codex.cuts`, which would otherwise never match) fails the step
with exit status 2 and an `::error` line saying which.

## Outputs

| Output | Meaning |
|---|---|
| `annotations` | Warning annotations written, after merging launch directories. |
| `warnings` | Warnings summed over launch directories (one warning seen from three launch directories counts three times). |
| `launch-dirs` | Launch directories modelled. |
| `json` | Path of a JSON file, schema `ctxreach.action/v1`: `{ "schema", "runs" }`, where each run is what `ctxreach map --json` prints (schema `ctxreach.map/v1`) for one launch directory. |

## What it annotates

Each warning becomes one `::warning` annotation. The same warning seen from
several launch directories is one annotation that names them all. On the
[demo monorepo](../examples/demo-monorepo), scanned as `demo/` with `auto`
launch directories, the Action prints six annotations, among them:

```text
::warning file=demo/AGENTS.md,line=547,title=ctxreach%3A Codex stops reading here (codex.cut)::Codex stops reading here (byte 32768 of the chain): project_doc_max_bytes is 32768, and this file is cut at its byte 32768 of 40960. Sections after it never reach Codex: "General 62", "General 63", "General 64", "General 65", "General 66" and 10 more. Launched from: the root, packages/api, packages/web.
::warning file=demo/CLAUDE.local.md,title=ctxreach%3A Switches AGENTS.md off for Claude Code (claude.agents-shadowed)::This file switches AGENTS.md off for Claude Code: AGENTS.md, packages/api/AGENTS.md, packages/web/AGENTS.md do not reach it. Import them with @AGENTS.md, or set Project instructions to claude-md-and-agents-md. Launched from: the root, packages/api, packages/web.
```

- A Codex cut (`codex.cut`) is annotated on the line where Codex stops
  reading, and the message gives the byte of the whole chain. When the cut
  splits a multi-byte character (`codex.mid-codepoint`), the same annotation
  says so.
- A file the budget never reaches (`codex.no-budget`) is annotated on its
  first line.
- An `AGENTS.md` that Claude Code does not read because of a `CLAUDE.md`,
  `.claude/CLAUDE.md` or `CLAUDE.local.md` (`claude.agents-shadowed`) is
  annotated on the file that switches it off, since that is the file to
  change.
- Any other warning is annotated on the file it is about, or on no file if it
  is about none.

GitHub shows at most 10 warning annotations per step on the run's page; the
log has every one, and the job summary lists every finding.

## What it models

The Action models a machine with no personal configuration: an empty
`~/.codex` and `~/.claude`, whatever the runner's home holds, and nothing
above `path`. So it answers "what does a fresh clone deliver", the same on
every runner. It does not see a developer's own `~/.claude/CLAUDE.md`,
`~/.codex/config.toml` or `CLAUDE.local.md` files that are not committed. Run
`ctxreach map` on your own machine for those.

## Without the Action

`ctxreach` is not on npm. npm builds it when it installs it from git (the
`prepare` script runs `tsup`), so this works without a clone:

```sh
npx github:Shivansh2904/ctxreach map --from packages/api
```

On 2026-09-30 the same install was checked end to end on Windows (Node
22.19.0, npm 10.9.3) from a local bare clone, `npx git+file:///<clone>#<branch>
map`, with an empty npm cache; the same clone with the `prepare` script
removed failed with no `ctxreach` command. The `github:` form itself goes
through GitHub and was not run before the branch was pushed.

## For maintainers

Four workflows look after the Action and the evidence behind it.

| Workflow | When | What fails it |
|---|---|---|
| `action-selftest.yml` | push or pull request touching the Action, `src/` or the two fixtures | The Action (this repository's `action.yml` with `uses: ./`) must give at least one annotation on `test/fixtures/codex-over-cap`, exactly none on its twin, and `fail-on: warn` must fail the step on the trap. Ubuntu and Windows. |
| `bundle-freshness.yml` | every push and pull request | `action/dist/ctxreach.cjs` or `docs/evidence.md` differs from a fresh build. Ubuntu and Windows. |
| `conformance.yml` | nightly, and weekly with macOS; scheduled runs only once the repository variable `CTXREACH_CONFORMANCE` is `on` | `scripts/conformance.mjs` finds a disagreement (Codex 0.159.2 and `@latest`, as rendered by `codex debug prompt-input`; Claude Code `@latest`, captured at a loopback endpoint with a dummy key), or a cell changed verdict since the previous run of its column (then it also opens an issue). Results go to `data/conformance/` on the `gh-pages` branch. |
| `pages.yml` | push to `site/` on `main`, after a conformance run, or by hand; automatic runs only once `CTXREACH_PAGES` is `on` | Deploys `site/` with the conformance results copied in. |

After changing anything under `src/` that the Action uses, rebuild the bundle
and commit it:

```sh
node scripts/bundle-action.mjs          # write action/dist/ctxreach.cjs
node scripts/bundle-action.mjs --check  # exit 1 if the committed bundle is stale
node scripts/evidence.mjs               # write docs/evidence.md from docs/evidence.json
node scripts/evidence.mjs plant         # break each evidence and Action check in turn; a test must fail
```

`action/dist/` is under the `dist/` ignore rule, so add a new bundle with
`git add -f action/dist/ctxreach.cjs`.
