# `ctxreach verify`: the oracles

`ctxreach map` predicts what an agent loads from its documented rules.
`ctxreach probe` asks Claude Code to repeat planted tokens, which costs a
model turn per trial. `ctxreach verify` asks each agent's own machinery
what it delivers, at no cost and with no login:

| Agent       | Instrument                                                                | What it shows                                                                                                                                             | Wording in every report                                                                                                     |
| ----------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Codex       | **render**: `codex debug prompt-input`                                    | The model-visible input as JSON. The `AGENTS.md` block in it is the exact bytes Codex would send.                                                         | "Codex's model input as rendered by `codex debug prompt-input` <version>. The model was not run."                           |
| Claude Code | **capture**: `claude -p` with `ANTHROPIC_BASE_URL` at a loopback recorder | The first request of the session, which carries the instruction files loaded at launch. The recorder answers 400, so nothing is billed and no model runs. | "Delivery to the model endpoint (custom base URL) by Claude Code <version>; the request was answered 400 and no model ran." |

Both plant the same tokens as `probe` (a head and a tail token per
instruction file in a temporary copy of the repository, plus a decoy file
no rule loads) and score them with the probe's vocabulary: CONFIRMED,
MISSED, EXTRA, NOT MODELLED. A `verify` cell reads like a `probe` cell.

Neither is a first-party model turn. A render shows what Codex sends, not
what the model does with it. A capture is the gateway path to the model
endpoint (AGENTS.md reaches it from Claude Code 2.1.281); whether a
first-party session delivers the same is measured separately, by paired
billed `probe` runs, not here.

## Running it

```sh
ctxreach verify --agent codex  --from packages/api                     # free, deterministic, no login
ctxreach verify --agent claude --from packages/api --model <pin>       # free, no login, needs 2.1.281+
ctxreach verify --agent codex  --replay <recording dir>                # score a saved run; no agent runs
```

Both agents: `--repo`, `--trials` (default 2; every render or capture of
the same copy must be identical, or the run is an instrument fault),
`--save <dir>`, `--replay <dir>`, `--timeout`, `--json`, `--no-color`.

Codex: `--codex-bin` (the executable or its `bin/codex.js`; default: PATH
or `$CTXREACH_CODEX_BIN`), `--codex-home <dir>` (the home to seed the
throwaway from; default `$CODEX_HOME`, then `~/.codex`), `--no-plant`
(compare bytes on the copy's files as they are; see "Planting moves
bytes"), `--clean` (seed
nothing), `--codex-trust <level>` (write this trust level for the copy
instead of mirroring the repository's), `--codex-max-bytes <n>` (given to
`map` only: the planted-fault pass).

Claude Code: `--claude-bin`, `--model <pin>` (required), `--home <dir>` (a
scratch home directory for the `~/.claude/CLAUDE.md` cells), `--settings
<file>` (passed through: a hook, or a Project instructions mode),
`--claude-mode <mode>` (given to `map` only: the planted-fault pass).

Exit status: 0 when every decided cell agrees with `map` and every chain
file is byte-exact; 1 when anything disagrees; 2 for a usage,
configuration or safety problem; 3 for an instrument fault, which voids
the run.

## The copy

The agent runs in the probe's sandbox, made and checked through
`src/probe/sandbox.ts`'s exported functions only: a copy of the repository
under the system temp directory, stripped of `.claude/settings*.json`,
skills, agents, hooks, `.claude-plugin/`, `.mcp.json`, `.codex/` and every
link, with a fresh `git init`, checked again right before the agent
starts (`assertReadyToRun`), and deleted afterwards. The report states
whether the copy is under the home directory and whether
`~/.claude/CLAUDE.md` exists on the machine, since both change what Claude
Code loads.

For Codex, after that check, the three instruction keys of each
`.codex/config.toml` on the root-to-launch path are written back into the
copy (`project_doc_max_bytes`, `project_doc_fallback_filenames`,
`project_root_markers`; nothing else), so `map` and Codex see the same
project budget.

## Codex: the render

```
codex debug prompt-input -c features.hooks=false "ctxreach verify CTXR-<token>: ..."
```

run with the launch directory in the copy as its working directory and
`CODEX_HOME` set to a throwaway directory inside the sandbox. The command
writes into whatever home it is given (`installation_id`,
`.sandbox_migration`, `skills/`), so it never gets the user's own. The
throwaway is seeded from the user's home with a whitelist: the global
`AGENTS.override.md`/`AGENTS.md`, the three instruction keys of
`config.toml`, and the trust level the user's config gives the repository
that was copied, written for the copy's path (a trusted repository's own
`.codex/config.toml` then applies in the copy as it does at home). Never
`auth.json`, providers, MCP servers, hooks, profiles or history. `--clean`
seeds nothing. The render's environment has no `OPENAI_API_KEY` or
`CODEX_API_KEY`, and every proxy variable points at a closed port.

`-c features.hooks=false` is passed first; if Codex rejects the override
the render is repeated without it and the recording says `hooksFlag:
"rejected"`. The warning `Refusing to create helper binaries under
temporary dir` (Codex home under the temp directory) is harmless and is
recorded.

The output is validated with zod: an array of messages, each with
`content_item_kinds` in its metadata. The AGENTS block is the message
tagged `agents_md.instructions`:

```
# AGENTS.md instructions for <cwd>

<INSTRUCTIONS>
<global file>\n--- project-doc ---\n\n<root file>\n\n<next file>...
</INSTRUCTIONS>
```

(joins measured on 0.159.2 renders, rules `codex.join` in docs/rules.md; a
global file with no project files is assumed to arrive alone, not
observed). The next content item, `<environment_context>`, gives the
session's `<cwd>`, which must be the launch directory. The last message
is the prompt, whose fresh token must appear: that proves the JSON is this
run's. An output of another shape fails with its JSON path, and is kept
as evidence as far as its shape can be told (see Recordings: Codex's own
prompt text is never saved).

The block is split into one segment per file of `map`'s predicted chain,
in `map`'s order: `kept 2,768 of 4,019 B (map: 2,768)` with the verdict
EXACT or OFF BY n (decoded bytes; a cut inside a multi-byte character
delivers U+FFFD, three bytes for one), MISSING for a predicted file not
in the render, EXTRA for a file predicted absent that is. This is
stronger than token presence and needs no model. The renderer sits behind
one function (`Renderer` in `src/oracle/codex-render.ts`), so a better
oracle such as the proposed `codex debug agents-md` (openai/codex#30788)
can replace it.

`src/oracle/codex-exec.ts` holds a second Codex instrument, a real
`codex exec --ephemeral --sandbox read-only --json` turn whose model
provider is the loopback recorder (a custom provider in the throwaway
home's `config.toml`, dummy `env_key`, retries 0). On 0.159.2 the request
it sends equalled the render on one fixture (2026-09-30). `verify` does
not run it; the study can, where a render-versus-turn check is wanted.

## Claude Code: the capture

The session runs with the probe's recall flags (`-p`, `stream-json`,
`--tools ""`, `--permission-mode dontAsk`, `--strict-mcp-config`,
`--no-session-persistence`), plus `--model <pin>` and, when given,
`--settings <file>`. Its environment is the caller's minus the parent
session's variables (as the probe adapter removes them), every
`ANTHROPIC_*` and cloud-provider setting, OAuth tokens and proxies, with:

- `CLAUDE_CONFIG_DIR` = a fresh, empty directory inside the sandbox (so
  there is no login, no user `CLAUDE.md`, no user settings), or with
  `--home <dir>` a scratch home directory (`USERPROFILE`/`HOME` follow it,
  `CLAUDE_CONFIG_DIR` is unset), never the real home;
- `ANTHROPIC_API_KEY` = a dummy value; `ANTHROPIC_BASE_URL` = the recorder;
- `DISABLE_TELEMETRY=1`, `DISABLE_AUTOUPDATER=1`.

A variable that turns instruction files off (`CLAUDE_CODE_SIMPLE`,
`CLAUDE_CODE_SAFE_MODE`, `CLAUDE_CODE_DISABLE_CLAUDE_MDS`,
`CLAUDE_CODE_DISABLE_ATTACHMENTS`) is refused. `claude --version` runs
under the same environment; a version below 2.1.281 is refused, since it
sends `CLAUDE.md` only to a custom endpoint.

The recorder (`src/oracle/capture.ts`) binds `127.0.0.1` on a free port,
refuses any other host, records each request's method, URL, headers and
body, and answers 400 with an API-shaped error. Credential headers
(`Authorization`, `X-Api-Key`, cookies, anything named like a key or
token) are replaced by `<redacted>` before the record exists, in memory
and on disk. `verify` keeps each request only as saved (see Recordings):
the body Claude Code sent is never written whole.

The instruction files arrive in the first `POST /v1/messages` as
`<system-reminder>` text blocks of the user message:

```
Contents of C:\...\repo\AGENTS.md (project instructions, checked into the codebase):

<the file>
```

(shape from 2.1.285 captures, 2026-09-30). Block-level HTML comments are
stripped by Claude Code before injection (`stripHtmlComments` mirrors
that); tokens are plain text, so delivery is judged on them.

Every trial is asserted from its `system/init` event: the plugins list
the built-in AGENTS.md plugin (`agents-md@builtin` on 2.1.280,
`cc-plugin-agents-md@builtin` on 2.1.285, recorded 2026-09-30; else
AGENTS.md support is off in this session), the model equals the pin, the
version equals `claude --version`, the working directory is the launch
directory. The first live captures of 2.1.285 were voided by exactly this
assert, which knew only the 2.1.280 name: the instrument refused to score
rather than guess. A recording that carries no session
stream (the pilot bodies of 2026-09-30) cannot be asserted that way; it is
scored from the request alone, with the working directory from the
request's Environment block, and the report says so.

## Controls that can void a run

- **Must-appear token.** The prompt carries a fresh token that must be in
  the output of every trial (a render's last user message; a capture's
  request). In the breadth lane's pilot, a 9-character token pattern once
  scored every token absent, and only the must-appear token showed the
  fault.
- **Decoy.** `ctxreach-decoy.md` in the launch directory, which no rule
  loads, must never be delivered.
- **Identical trials.** Two renders, or two captures, of the same copy
  must deliver the same text.
- **Session asserts** (above), and the working directory for both agents.

A failed control is an instrument fault (exit 3): the verdicts are void
and no agreement figure is given. A trial that never produced an output
(a render that did not exit 0, a session that sent no request) is
`failed` and excluded, not a fault.

## Recordings

A run is saved as `manifest.json` (schema `ctxreach.verify-recording/v1`:
the planted tokens, `map`'s prediction per file, the predicted chain with
the text each file should contribute, the exact arguments and prompt, what
was seeded, the session's environment facts, how each trial ended) plus
per trial `trial-N.render.json` (Codex, reduced as below) or
`trial-N.capture.jsonl` (Claude Code's requests, reduced as below) and
`trial-N.stdout.jsonl` (its stream-json). Paths are
redacted to fixed placeholders, in path and slug form; session ids, account
metadata and the git user's name are removed. `--replay <dir>` scores a
recording again, on any machine, without the copy or the agent, and gives
exactly what the live run gave.

A saved render holds only what ctxreach scores. `codex debug
prompt-input` prints Codex's whole model input, and most of it is OpenAI's
own prompt text (the developer items: skills, permissions, collaboration
mode, multi-agent role), which is not ctxreach's to publish. The content
item tagged `agents_md.instructions` and ctxreach's own prompt
(`user.text`) are kept whole. Every other content item is replaced by
`{kind, sha256, bytes}`: its kind, and the SHA-256 and UTF-8 length of its
text after redaction, so a later render can be compared with it. The
environment context also keeps its `cwd`, the one field the scorer reads.
Each message keeps its `type`, `role` and `content_item_kinds`; ids and
timestamps are dropped. The scorer reads a reduced render exactly as it
read the whole one, so a live run and its replay agree. A message whose
kinds do not line up with its content is digested whole, since which item
is the AGENTS block cannot be told, and the run then fails instead of
guessing. Output that is not JSON is not saved: a line giving its length
and SHA-256 stands in for it. `test/oracle-render-saved.test.ts` fails if
any recorded render holds text of Codex's own items.

A saved capture holds only what ctxreach scores, for the same reason: the
request Claude Code sends carries its whole prompt (the system prompt, the
Environment and git status blocks, the preamble of each reminder), which
is Anthropic's text, not ctxreach's. The recorder is given a `save`
function, so a request is redacted and reduced before it is kept, in
memory or on disk. Kept: `model`, each message's `role`, and every block
whose text is exactly the prompt ctxreach passed. Every other block, and
every other field of the request (`tools`, `metadata`, `thinking` and the
rest), becomes `{kind, sha256, bytes}` (the hash and UTF-8 length of its
text after redaction, or of its JSON when it has none). A block that had
text also keeps what the scorer reads from it: `cwd`, the working
directory an Environment block names; `files`, the instruction files its
reminders carry, each as path, label and text; and `tokens`, any
canary-form token in it outside those files, so the must-appear check
sees what it saw before. Parts the scorer does not read keep nothing but
their digest. `parseCaptureBody` reads a saved body as it read the whole
one (the same model, working directory and files, and every token present
in one exactly when it is in the other), so a live run and its replay
agree; a body that is not JSON is replaced by a line giving its length
and SHA-256. `test/oracle-capture-saved.test.ts` checks every recorded
capture against that shape.

`test/oracle-vendor-text.test.ts` reads every recording, and every source,
test, script and document, for phrases taken from what Codex 0.159.2 and
Claude Code 2.1.285 sent; the phrases are held as hashes of their words
(`test/helpers/vendor-text.ts`), so the test does not contain them.

`test/recorded/verify/` holds the pilot renders and captures of
2026-09-30 and the recordings made from the fixtures; its README lists
them.

## Planting moves bytes

A planted file is 62 bytes longer than the file in the repository (a
31-byte head line and a 31-byte tail line), so in the copy a budget cut
lands 31 bytes later in the original text, and a whitespace-only file is
no longer empty. `map` predicts on the planted copy, so prediction and
render still compare like for like, but a fixture built around an exact
byte (a cut inside a character at 32,768) or around emptiness (a
whitespace-only `AGENTS.override.md`) no longer shows that behaviour when
planted. For Codex, `--no-plant` leaves the copy's files as they are: the
byte comparison is the evidence, and the decoy and the prompt token remain
the controls. A Claude Code run always plants, since a capture is scored
by its tokens.

## What is and is not verified (2026-09-30)

- Verified on real output, replayed by `test/oracle-recorded.test.ts`
  (recordings in `test/recorded/verify/`):
  - Codex 0.159.2 on Windows: 22 of 22 launches of the 14 codex fixtures
    (root and `packages/api`) byte-exact with `map`, two identical renders
    each, `-c features.hooks=false` accepted in every launch; the planted
    pass (`map` given 30,000 bytes) disagrees by 2,768 bytes; unplanted, a
    whitespace-only override takes its slot (0 of 6 bytes) and a cut inside
    a three-byte character delivers U+FFFD (32,770 decoded bytes for 32,768).
  - Claude Code 2.1.285 on Windows, one capture each: `CLAUDE.local.md`
    delivered and `AGENTS.md` not (4 of 4 cells); with no `CLAUDE.md`-family
    file, `AGENTS.md` delivered whole (2 of 2); from `packages/api`, the root
    `CLAUDE.md` delivered and the package's `AGENTS.md` not (4 of 4). The
    session's plugin is listed as `cc-plugin-agents-md@builtin`.
  - The pilot renders and captures (`codex-pilot`, `capture-pilot-A/B`).
- Assumed, not observed: a global file with an empty project chain arrives
  alone.
- Not run by the tests: any real agent. The tests drive stand-ins
  (`test/helpers/fake-codex.mjs`, `test/helpers/fake-capture-client.mjs`)
  that reproduce each agent's output shape from the rules, and replay the
  recordings. `test/oracle-record.test.ts` re-records them against the
  real tools, only when `CTXREACH_RECORD` is set.
- One run each is one run each: the fractions above are 1/1 or 2/2 per
  launch and say nothing about variability. The study's cells set their
  own trial counts.
