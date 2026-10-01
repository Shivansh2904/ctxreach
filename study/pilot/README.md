# PILOT data (2026-09-30): not results

Everything in this folder was produced on 2026-09-30, before the study was
pre-registered, while the plan was being written. It is **pilot data**:
the hypotheses in `study/PREREG.md` were set from it, so it can never count
as evidence for them. It is never pooled with a registered cell or census
row, and anything that cites it says "pilot, n = 1" (or the n it had).

Every file was copied from the session's `tools-scratch` folder through
`redact.mjs`, which replaces the scratch and home paths with `<scratch>`
and `<home>` (and Claude Code's project-folder spelling of the scratch
folder with `<scratch-slug>`), replaces session, device, account and
installation ids and credential headers with `REDACTED` and every other
UUID (transcript file names, request and thread ids) with `<uuid>`,
turns lists of local skills, agents and commands into counts, and refuses
to write a file in which the local user name or a UUID survives.

No vendor's prompt text is kept, however short. In every recorded request
(`capture/claude-A.jsonl`, `claude-B.jsonl`, `opencode.jsonl`,
`codex-exec.jsonl`) and every `codex debug prompt-input` render
(`codex-renders/`), only what ctxreach scores stays: the instruction files
the agent delivered (as `{path, text}`, in the order sent, without the
agent's words around them), the AGENTS.md block of a Codex render or
request, ctxreach's own prompt, the working directory, and identifiers
such as model names and versions. Every other item (Claude Code's system
prompt and reminders, Codex's instructions and developer items, OpenCode's
system and title prompts, every tool) is `{kind, sha256, bytes}`: the
SHA-256 and UTF-8 size of the original text. A Codex render has the shape
the oracle saves (`reduceRender` in `src/oracle/codex-render.ts`); its
digests of items that held a local path differ from a verify recording's,
since these hash the original text. The oracle had not reduced its Claude
Code captures when this was done (2026-10-01), so a Claude request here
uses the same `{kind, sha256, bytes}` shape with the delivered files
attached (`kind: "claude.instructions"`). Elsewhere (a session's stream, a
hook payload) any string over 300 characters without a ctxreach token or
an instruction-file block becomes its size and SHA-256. Instruction text
from someone else's repository (the passlock render) is replaced by its
size and SHA-256 as well. `test/study-pilot.test.ts` fails on any text
left outside the kept items, on a kept file that is not the fixture's own
file, and on any phrase from the vendors' prompts in any file under
`study/` (the phrases are listed there as SHA-256 values only).

`SHA256SUMS-sources.txt` gives the SHA-256 of each original, so the
reduction can be checked by whoever holds the originals: `CTXR_SCRATCH=<scratch>
node study/pilot/redact.mjs --all` checks each original's SHA-256 and
rebuilds every file here from it, and `CTXR_SCRATCH=<scratch> npx vitest run
test/study-pilot.test.ts` also checks that every listed phrase is in the
originals and that every file here is its original reduced. The two
ctxreach probe recordings had only their paths and UUIDs changed
(`--paths-only`): ctxreach had already redacted them, and they replay
(`ctxreach probe --replay <dir>`) to the same 8 cells as the originals.

| Folder | What | Instrument, version | Pilot observation (n) | Plan ref |
|---|---|---|---|---|
| `probe-runs/r1-ancestor`, `r2-control` | two billed `ctxreach probe` recall runs of `test/recorded/sources/agents-only`, the copy moved by TEMP/TMP under a folder whose `.claude/CLAUDE.md` is `fixture-ancestor/` | canary echo, Claude Code 2.1.280 | with the ancestor file, AGENTS.md 0/1 and the ancestor token 1/1; without it, AGENTS.md 1/1; `map` 6/6 cells each; decoy 0/1 | P-a |
| `hook-runs/` | two billed runs with an `InstructionsLoaded` hook through `--settings` (`fixture/`: an ancestor rule above the git root, a repo rule, AGENTS.md, a decoy) | canary + hook, 2.1.280 | the hook fired under `-p` (3/3, 2/2) and was silent for an AGENTS.md read through the setting (1/1); the ancestor rule loaded (2/2); `--setting-sources project,local` changed the model | P-f |
| `capture/claude-A.jsonl`, `claude-B.jsonl` | Claude Code with `ANTHROPIC_BASE_URL` at a loopback recorder that answered 400, dummy key, empty config folder (`fixture/cfx/A` has an ancestor `.claude/CLAUDE.md`, `B` does not) | capture, 2.1.285, $0 | A: ancestor and rule tokens on the wire, AGENTS.md absent (6/6 predicted cells); B: AGENTS.md on the wire (5/5) | P-b |
| `capture/codex-exec*.jsonl` | `codex exec` with a custom provider pointed at the recorder | capture, Codex 0.159.2 | the request's AGENTS.md block equals `debug prompt-input`'s on one fixture | risk 3 |
| `capture/opencode.jsonl` | OpenCode with its provider pointed at the recorder (`fixture/ofx`) | capture, OpenCode 1.18.33 | `packages/api/AGENTS.md` then the root `AGENTS.md` (nearest first); neither `CLAUDE.md` | P-g |
| `codex-renders/codex-t1-*.json` | `codex debug prompt-input` in `packages/api` of a 40,064-byte root AGENTS.md repository | render, Codex 0.159.2, no login | the block holds the first 32,768 bytes of the root file; `map` predicted the same | P-c |
| `codex-renders/cx/` | renders of the `scripts/cx-gen.mjs` repository: launches, trust through `config.toml` and `-c` (dotted and inline-table), a project config, `CODEX_HOME` at the root | render, 0.159.2 | cut at 2,768 with U+FFFD; empty override takes the slot; the dotted `-c` trust key never addressed the project (its trusted control failed), the inline table did, and untrusted then delivered nothing; `CODEX_HOME` = root delivered the root file twice | P-c, P-d, P-e |
| `codex-renders/passlock-packages-server.json` | a public repository rebuilt from GitHub, rendered from `packages/server` | render, 0.159.2 | root file + blank line + package file = 6,292 bytes, as `map` predicted (the text itself is redacted) | P-c |
| `gemini/fixture/` | the fixture for Gemini CLI core's own memory functions | library, `@google/gemini-cli-core` 0.62.0 | `Api/GEMINI.md` is concatenated before the root `GEMINI.md` (a lexicographic sort); the run's output was printed, not saved: re-run `scripts/gemini-oracle.mjs` to see it | P-g |
| `scripts/` | the pilot's own scripts, as the record of the method | | | |

The conformance run of the 14 `codex-*` fixtures (22/22 launches
byte-exact; a planted 30,000-byte budget disagreed 1/1) printed its lines
and saved no file; `scripts/codex-conformance.mjs` re-runs it.

The census dry run of 2026-09-30 (20 repositories from a pilot seed) is
described in `study/census/README.md`; its rows are not kept.
