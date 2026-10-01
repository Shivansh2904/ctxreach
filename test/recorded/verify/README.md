# Recorded verify runs

Real output of the two oracles `ctxreach verify` drives, kept so the tests
(`test/oracle-*.test.ts`) can replay them without Codex or Claude Code
installed. CI runs no agent. Everything here is redacted: the temporary copy
is `C:\ctxreach-probe`, the home directory `C:\Users\user`, the pilot's
scratch directory `C:\ctxreach-pilot`; credential headers are `<redacted>`;
session ids read `(removed by ctxreach)`, and the account metadata and
the git user's name were removed before the parts holding them were
digested.

The Codex renders (`*.render.json`) are also reduced to what ctxreach
scores, since most of what `codex debug prompt-input` prints is OpenAI's own
prompt text: the `agents_md.instructions` item and ctxreach's prompt
(`user.text`) are whole, every other content item is `{kind, sha256,
bytes}` (the hash and UTF-8 length of the text it replaced), the
environment context also keeps its `cwd`, and ids and timestamps are gone
(docs/oracle.md, Recordings). The renders recorded on 2026-09-30 were
reduced on 2026-10-01 with the same `reduceRender` the recorder now uses;
every digest was checked against the text it replaced, and replaying every
recording here gave byte-identical scores, byte counts and reports before
and after.

The Claude Code captures (`*.capture.jsonl`) are reduced the same way,
since most of each request is Anthropic's own prompt text (the system
prompt, the Environment and git status blocks, the preamble of each
reminder): `model`, each message's `role` and ctxreach's prompt are
whole; every other block and field is `{kind, sha256, bytes}`, and a block
that had text keeps beside its digest what the scorer reads from it (the
Environment block's `cwd`, the reminders' instruction `files` as path,
label and text, and any canary-form `tokens` outside those files);
headers are kept as they were (credentials `<redacted>`). The five
captures recorded on 2026-09-30 were reduced on 2026-10-01 with the same
`reduceCaptureBody` the recorder now uses (each with its manifest's
prompt; 70 digests, each checked against the text or JSON it replaced),
shrinking from about 9.6 KB to about 3.7 KB each; replaying all 30
recordings here gave byte-identical scores, reports and JSON before and
after, and each capture parses to the same model, working directory,
files and token presence.

These directories sit one level below `test/recorded/` because
`test/probe-recorded.test.ts` reads every `*.jsonl` directly under
`test/recorded/*/` as a probe transcript of Claude Code 2.1.280.

## Pilots (2026-09-30, one run each, never pooled with results)

| Directory | What | Made with |
|---|---|---|
| `codex-pilot/api.render.json` | Codex 0.159.2 `debug prompt-input` from `packages/api` of the breadth lane's fixture (`cx/gen.mjs`: a 30,000-byte root `AGENTS.md`, a 4,019-byte package file with a three-byte character straddling byte 2,768). The block holds the root file, a blank line, and 2,768 bytes of the package file ending in U+FFFD. | empty `CODEX_HOME`, proxies pointed at a closed port, no login |
| `codex-pilot/home-is-root.render.json` | The same, with `CODEX_HOME` set to the project root (openai/codex#34193): the root file arrives twice, joined by `\n--- project-doc ---\n\n`. | as above |
| `codex-pilot/untrusted-toml.render.json` | The same, with the project marked `trust_level = "untrusted"` in `config.toml`: no `AGENTS.md` block at all. | as above |
| `capture-pilot-A/` | Claude Code 2.1.285 `-p` pointed at a loopback recorder (`ANTHROPIC_BASE_URL`, dummy key, empty `CLAUDE_CONFIG_DIR`), launched in a repository whose parent holds `.claude/CLAUDE.md`. The request carries that ancestor file and the launch directory's rule; `AGENTS.md` and the nested `AGENTS.md` are absent. | breadth lane V8/V9 |
| `capture-pilot-B/` | The same repository without the ancestor file: `AGENTS.md` head and tail arrive; the nested file does not. | breadth lane V8/V9 |

The pilot captures were planted by hand (tokens like `CTXR-A0000a01`), had
no `--model` pin, and their session stream was not saved, so a replay scores
them from the request alone and says so in a warning. Their `manifest.json`
was written by `scratchpad/lanes/oracle/convert-pilot.mjs` from the pilot
artefacts and the breadth lane's recorded predictions.

## Recordings made by `ctxreach verify` (2026-09-30)

Directories named `<fixture>-<launch dir>` (`root` or `packages-api`) are
runs of `ctxreach verify` on the fixtures under `test/fixtures/`, made by
`test/oracle-record.test.ts` with `CTXREACH_RECORD` set, through the same
`runVerify` the command uses. Each `manifest.json` holds the arguments, the
prompt, the version, the OS and the time.

- `codex-*`: Codex 0.159.2 (`@openai/codex@0.159.2`, a pinned scratch
  install), `codex debug prompt-input` with a throwaway `CODEX_HOME` seeded
  from the fixture's own `home/.codex` (never `~/.codex`), proxies pointed
  at a closed port, no login, two renders each. 22 launches (the 14 codex
  fixtures from the root, 8 of them also from `packages/api`).
  `codex-planted-over-cap-root` is the planted-fault pass (`map` given
  `--codex-max-bytes 30000`), which disagrees.
  `codex-empty-override-packages-api-unplanted` and
  `codex-utf8-cut-root-unplanted` were made with `--no-plant`, one render
  each: planting adds two token lines to every file, which makes a
  whitespace-only override non-empty and moves a cut off the byte it was
  built for, so these two traps are recorded on the files as they are.
- `claude-*`: Claude Code 2.1.285 (`@anthropic-ai/claude-code@2.1.285`, a
  pinned scratch install, `DISABLE_AUTOUPDATER=1`), `claude -p` with a
  fresh, empty `CLAUDE_CONFIG_DIR` inside the sandbox, a dummy
  `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` at the loopback recorder (which
  answered 400), the parent session's variables removed, `--model
  claude-opus-5-5` pinned and asserted, one capture each. Nothing was
  billed; the real `~/.claude` was never read or written.

Re-score any of them with:

```sh
node dist/cli.js verify --agent codex --replay test/recorded/verify/<name>
node dist/cli.js verify --agent claude --replay test/recorded/verify/<name>
```
