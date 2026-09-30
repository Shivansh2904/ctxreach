# Loading rules ctxreach models

Every prediction `ctxreach map` makes comes from one of the rules below. Each
rule has an id (the same id appears in the code and in `--json` output), the
source it was taken from, and the date it was last checked against that source.

Agents change their loading behaviour often. When a rule here disagrees with
what an agent does today, the rule is wrong: please open an issue with the
agent version and a minimal repository.

Sources are either vendor documentation or, where the documentation is silent
or ambiguous, the agent's own source code at a pinned commit. Where the two
disagree, the table says so and says which one ctxreach follows.

## Codex

Checked on 2026-09-28 against:

- Docs: <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
  ("Custom instructions with AGENTS.md", previously at
  <https://developers.openai.com/codex/guides/agents-md>, which now redirects
  there).
- Docs: <https://learn.chatgpt.com/docs/config-file/config-advanced>
  (sections "Project root detection" and "Project instructions discovery",
  previously at <https://developers.openai.com/codex/config-advanced>, which
  now redirects there).
- Source: `openai/codex` at commit
  [`c0d2694`](https://github.com/openai/codex/tree/c0d26949be4144c751894ae96e28d3db2208b764),
  mainly `codex-rs/core/src/agents_md.rs` and its tests.

`SRC` below is short for
`https://github.com/openai/codex/blob/c0d26949be4144c751894ae96e28d3db2208b764/codex-rs`.

| Id | Rule | Source |
|---|---|---|
| `codex.root` | The project root is the nearest directory, starting at the launch directory and walking up, that contains one of `project_root_markers` (default `[".git"]`; a `.git` file counts as well as a directory). With no marker found, or with `project_root_markers = []`, only the launch directory is searched. The markers come from user-level config only: a project's own `.codex/config.toml` cannot change them. | Docs: config-advanced, "Project root detection". `SRC/core/src/agents_md.rs#L10-L18`, `#L199-L240`; test `project_layers_do_not_override_project_root_markers`. |
| `codex.walk` | Codex reads instruction files from the project root down to the launch directory, inclusive. Nothing above the root and nothing below the launch directory is preloaded. | Docs: agents-md, "How Codex discovers guidance". `SRC/core/src/agents_md.rs#L223-L240`. |
| `codex.one-per-dir` | In each directory, the first of `AGENTS.override.md`, `AGENTS.md`, then each `project_doc_fallback_filenames` entry that exists as a file is that directory's file. At most one file per directory; the others in that directory are not read. A directory with a candidate's name is skipped. | Docs: agents-md. `SRC/core/src/agents_md.rs#L242-L296`; tests `agents_local_md_preferred`, `override_directory_falls_back_to_agents_md_file`. |
| `codex.empty-skip` | A file whose text is empty after trimming whitespace contributes nothing and uses no budget. The directory slot is chosen before the content is read, so a whitespace-only `AGENTS.override.md` still takes its directory's slot and that directory's `AGENTS.md` is not read. | Docs say only "Codex skips empty files". The slot behaviour comes from the source: discovery picks the file by existence (`SRC/core/src/agents_md.rs#L254`), and the emptiness check happens later, at read time (`#L168-L179`). Not yet observed on a live run. |
| `codex.budget` | `project_doc_max_bytes` (default 32768) is one budget shared by the whole chain and spent root-first. Each file is cut to whatever budget is left; once the budget reaches 0, later files are not read at all. So a large root file can crowd out a package's own file. | Docs: agents-md ("stops adding files once the combined size reaches the limit"). `SRC/core/src/agents_md.rs#L142-L179`; test `total_byte_limit_truncates_later_project_docs`. **Conflict:** config-advanced describes the key as "how much to read from each AGENTS.md file". The source and its tests show a shared budget; ctxreach follows the source. |
| `codex.cut` | The cut is at a raw byte offset, not a character boundary. The kept bytes are then decoded leniently, so a cut inside a multi-byte UTF-8 character turns the partial character into U+FFFD. The budget is charged for the kept bytes. | `SRC/core/src/agents_md.rs#L155-L178` (`Vec::truncate`, then `String::from_utf8_lossy`); test `project_doc_invalid_utf8_uses_lossy_text`. |
| `codex.zero` | `project_doc_max_bytes = 0` turns project instruction files off. | `SRC/core/src/agents_md.rs#L133-L135`; test `zero_byte_limit_disables_docs`. |
| `codex.join` | Files are joined root-first with a blank line between them. When global instructions are present, a `--- project-doc ---` line separates them from the first project file. The separators are not charged to the budget. | Docs: agents-md, "Merge order". `SRC/core/src/agents_md.rs#L386-L419`. |
| `codex.global` | In `$CODEX_HOME` (default `~/.codex`) Codex reads `AGENTS.override.md`, else `AGENTS.md`, taking the first file that is not empty (unlike project directories). This file is not charged to `project_doc_max_bytes` and is not cut by it. Fallback names do not apply here. | Docs: agents-md, "Global scope". `SRC/codex-home/src/instructions/mod.rs#L40-L84`; comment in `SRC/core/src/agents_md_manager.rs#L165-L167`. |
| `codex.config` | `project_doc_max_bytes` and `project_doc_fallback_filenames` come from `$CODEX_HOME/config.toml`, overridden by each `.codex/config.toml` from the project root down to the launch directory (closer wins). Project `.codex/config.toml` layers only apply when the project is trusted. | Docs: config-advanced. `SRC/config/src/loader/mod.rs#L122-L136`, `#L1638-L1670`, `#L1086-L1101`. |
| `codex.fallback-names` | Fallback entries that are empty, `.` or `..`, or contain `/` (on Windows also `\` or `:`) are ignored. Duplicates are dropped. | `SRC/core/src/agents_md.rs#L272-L296`. |
| `codex.untrusted` | If the project is explicitly marked untrusted (`[projects."<path>"] trust_level = "untrusted"` in user config), no project instruction files load at all, only the global file. ctxreach looks the trust level up by the launch directory, then by the project root. | `SRC/core/src/agents_md.rs#L64-L66`; `SRC/config/src/config_toml.rs#L877-L891`. |
| `codex.nested` | Instruction files below the launch directory are not preloaded. Codex's base prompt tells the model to "check for any AGENTS.md files that may be applicable" when working in a subdirectory, so whether a nested file is read depends on what the model decides to do. `map` can only report "not preloaded"; measuring whether the model found it needs a live run. | Docs: agents-md ("Codex stops searching once it reaches your current directory"). `SRC/protocol/src/prompts/base_instructions/default.md#L27`. |

### What ctxreach does not model for Codex

- Config profiles (`--profile`), `-c key=value` overrides, and system or managed
  config layers. Only `$CODEX_HOME/config.toml` and project `.codex/config.toml`
  files are read.
- Sessions with more than one environment, which share one budget across
  environments.
- Case-insensitive file systems. ctxreach matches file names exactly; on Windows
  and on default macOS volumes, Codex may also pick up `agents.md`.
- The exact trust-key normalisation Codex uses. ctxreach compares paths
  case-insensitively on Windows and exactly elsewhere.

## Claude Code

Checked on 2026-09-28 against:

- Docs: <https://code.claude.com/docs/en/memory> ("How Claude remembers your
  project"), referred to below as *memory*.
- Docs: <https://code.claude.com/docs/en/hooks> (section "InstructionsLoaded").
- Docs: <https://code.claude.com/docs/en/headless> (section "Start faster with
  bare mode").

The Claude Code docs do not publish the loader's source, so where they are
silent ctxreach makes an assumption and marks it **assumed** below.

| Id | Rule | Source |
|---|---|---|
| `claude.ancestors` | At launch Claude Code loads `CLAUDE.md` and `CLAUDE.local.md` from the launch directory and every directory above it, up to the filesystem root (it does not stop at the repository root). Files are ordered root-first; within a directory `CLAUDE.local.md` comes after `CLAUDE.md`. `.claude/CLAUDE.md` is a project file in the same way as `./CLAUDE.md`. **Assumed:** `.claude/CLAUDE.md` loads from ancestors too, and comes after `CLAUDE.md` and before `CLAUDE.local.md` in its directory; the docs list it as a project location and count it in the AGENTS.md check "in your working directory or any directory above it", but do not give its order. | memory, "Choose where to put CLAUDE.md files", "How CLAUDE.md files load", "When Claude Code reads AGENTS.md". |
| `claude.user` | `~/.claude/CLAUDE.md` is the user file. It loads before project files and does not count towards the AGENTS.md check. | memory, "Choose where to put CLAUDE.md files", "When Claude Code reads AGENTS.md". |
| `claude.subdirs` | `CLAUDE.md` and `CLAUDE.local.md` files in subdirectories below the launch directory are not loaded at launch; each loads when Claude reads a file in its directory. **Assumed:** a subdirectory's `.claude/CLAUDE.md` behaves the same way (the AGENTS.md rule refers to a subdirectory's "three `CLAUDE.md` files"). Directories beside or above the launch directory's subtree are not loaded this way. | memory, "How CLAUDE.md files load". |
| `claude.agents-default` | By default (`claude-md-or-agents-md`), Claude reads `AGENTS.md` only when there is no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in the launch directory or above it. `~/.claude/CLAUDE.md`, the managed `CLAUDE.md` and `.claude/rules/` files do not count. When none count, every `AGENTS.md` and `.claude/AGENTS.md` in the launch directory and above loads at launch, and a subdirectory's `AGENTS.md` loads when Claude reads a file there, if that subdirectory has none of the three `CLAUDE.md` files. So adding a personal `CLAUDE.local.md` switches `AGENTS.md` off. | memory, "When Claude Code reads AGENTS.md". |
| `claude.agents-never` | Claude Code never reads `AGENTS.local.md`, `AGENTS.override.md`, or anything under a `.agents/` directory. | memory, "When Claude Code reads AGENTS.md". |
| `claude.modes` | The **Project instructions** setting has four values: `claude-md-or-agents-md` (default), `claude-md-and-agents-md` (each directory's `CLAUDE.md` files, then its `AGENTS.md`, skipping an `AGENTS.md` already loaded through an import or symlink), `claude-md` (never `AGENTS.md`), and `managed-only` (at launch only the managed file and auto memory; a subdirectory's `CLAUDE.md` and rules still load on read). It is read from `pluginConfigs["agents-md@builtin"].options.instructionFiles` in `~/.claude/settings.json`, a `--settings` file or managed settings, and ignored in project and local settings files. | memory, "Choose which instruction files load". |
| `claude.version` | Reading `AGENTS.md` needs Claude Code 2.1.277 or later. Before 2.1.281, some sessions (Amazon Bedrock, telemetry disabled) read `CLAUDE.md` only. The first session after upgrading from 2.1.276 or earlier may not read it either. | memory, "When AGENTS.md support is unavailable". |
| `claude.imports` | `@path` in a loaded file imports that file at launch, after the file that imports it. Relative paths resolve against the importing file's directory; absolute and `~/` paths are allowed. Imports nest up to four hops. Text in code spans and fenced code blocks is not parsed for imports. An import in a project file that resolves outside the launch directory is *external*: Claude Code asks once to approve external imports for the project, and if you decline they stay off. User-level files import without asking. An `AGENTS.md` read through the setting loads external imports only if they were already approved. (A `claude -p` run shows no approval dialog; probe runs saw external imports not load there. See [Evidence from probe runs](#evidence-from-probe-runs).) **Assumed:** an import is `@` at the start of a line or after whitespace, followed by non-space characters; if that path does not exist and ends in `.,;:!?)`, those characters are dropped and it is tried again. | memory, "Import additional files", "Where AGENTS.md differs from CLAUDE.md". |
| `claude.words` | A `CLAUDE.md` that tells Claude *in words* to read `AGENTS.md`, instead of importing it, means Claude sees `AGENTS.md` only if it decides to open the file. | memory, "Remove an earlier AGENTS.md workaround". |
| `claude.symlink` | A `CLAUDE.md` that is a symlink to `AGENTS.md` delivers that content once, as a `CLAUDE.md`. | memory, "Remove an earlier AGENTS.md workaround", "Share one file with other coding tools". |
| `claude.size` | A file over 4 MiB is skipped. | memory, "My CLAUDE.md is too large". |
| `claude.rules` | `.claude/rules/**/*.md` without a `paths` field load at launch, like `.claude/CLAUDE.md`; with `paths` they load when Claude reads a matching file. Rules in `.claude/rules/` directories below the launch directory load on demand. ctxreach models the launch directory's and subdirectories' rules only; it does not say whether an ancestor's rules load, because the docs do not, and marks them not modelled. (Launched in `packages/api`, a probe run saw the rule without `paths` in the project and git root preloaded, 2/2 trials; no other ancestor had rules to test. See [Evidence from probe runs](#evidence-from-probe-runs).) | memory, "Organize rules with .claude/rules/". |
| `claude.hook-blind` | The `InstructionsLoaded` hook does not fire for an `AGENTS.md` read through the setting. It does fire for one that a `CLAUDE.md` imports or symlinks to. (Not used by `map`. `probe` does not install a hook yet, so this blind spot is not measured.) | hooks, "InstructionsLoaded"; memory, "Where AGENTS.md differs from CLAUDE.md". |
| `claude.bare` | `claude --bare` skips CLAUDE.md discovery, and the docs say it "will become the default for `-p` in a future release". Without `--bare`, `claude -p` runs the project's hooks and connects its MCP servers even in an untrusted folder. (Not used by `map`. `probe` never passes `--bare`, reports `CLAUDE_CODE_SIMPLE` as a warning, and strips hooks and MCP config from its copy of the repository; see [Probe](#probe).) | headless, "Start faster with bare mode". |

### What ctxreach does not model for Claude Code

- The managed-policy `CLAUDE.md` and the managed `claudeMd` setting.
- `claudeMdExcludes`.
- `--add-dir` and `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD`.
- Whether an ancestor directory's `.claude/rules/` load.
- Glob matching of a rule's `paths` field: rules with `paths` are reported as
  "on read of a matching file" without saying which files match.
- Auto memory, skills, and output styles.
- Stripping of HTML comments, which changes a file's content but not whether
  it arrives.

## Findings

Each finding `map` reports has a code, a severity and the rule behind it.
`warn` means an instruction file, or part of one, does not reach an agent in
a way its author probably did not intend. `info` is worth knowing but often
intended.

| Code | Severity | Rule | Meaning |
|---|---|---|---|
| `codex.cut` | warn | `codex.budget` | A file is cut short by the shared byte budget; the finding names the sections lost. |
| `codex.mid-codepoint` | warn | `codex.cut` | The cut splits a multi-byte character, so Codex sees U+FFFD. |
| `codex.no-budget` | warn | `codex.budget` | Files earlier in the chain used the whole budget, so this file is not read at all. |
| `codex.empty-override` | warn | `codex.empty-skip` | An empty `AGENTS.override.md` takes its directory's slot, so that directory's `AGENTS.md` is not read. |
| `codex.nested` | warn | `codex.nested` | A file below the launch directory is not preloaded. |
| `codex.project-config-ignored` | warn | `codex.config` | A project `.codex/config.toml` sets an instruction setting, but the project is not trusted, so Codex ignores it. |
| `codex.untrusted` | warn | `codex.untrusted` | The project is marked untrusted, so no project files load. |
| `codex.zero-budget` | warn | `codex.zero` | `project_doc_max_bytes` is 0. |
| `codex.shadowed` | info | `codex.one-per-dir` | Another file in the same directory takes precedence. |
| `codex.empty` | info | `codex.empty-skip` | A file is empty after trimming, so Codex skips it. |
| `codex.no-root` | info | `codex.root` | No project root marker was found, so only the launch directory is searched. |
| `claude.agents-shadowed` | warn | `claude.agents-default` | An `AGENTS.md` does not reach Claude Code because of a `CLAUDE.md`-family file at or above the launch directory, or one in its own directory. |
| `claude.words-not-import` | warn | `claude.words` | A `CLAUDE.md` names `AGENTS.md` without importing it. |
| `claude.import-too-deep` | warn | `claude.imports` | An import is more than four hops from a memory file. |
| `claude.mode-in-project-settings` | warn | `claude.modes` | The Project instructions setting is in a project or local settings file, where it is ignored. |
| `claude.too-large` | warn | `claude.size` | A file is over 4 MiB. |
| `claude.version-no-agents` | warn | `claude.version` | The given Claude Code version cannot read `AGENTS.md`. |
| `claude.external-import` | info | `claude.imports` | An import resolves outside the launch directory and needs a one-time approval. |
| `claude.nested` | info | `claude.subdirs`, `claude.agents-default` | A file below the launch directory loads only when Claude reads a file in its directory. |
| `claude.version-some-sessions` | info | `claude.version` | On the given version, some sessions (Bedrock, telemetry off) read `CLAUDE.md` only. |

## Probe

`ctxreach probe` runs Claude Code itself. What follows is how it runs it, and
what the runs have shown so far. Codex has no probe adapter yet.

### How Claude Code is run

Checked on 2026-09-28 against `claude --help` of Claude Code 2.1.280 and:

- Docs: <https://code.claude.com/docs/en/cli-reference> (CLI flags).
- Docs: <https://code.claude.com/docs/en/headless> ("Start faster with bare
  mode", "Get structured output", "Stream responses", "Auto-approve tools").
- Docs: <https://code.claude.com/docs/en/permissions> ("Permission system",
  "Working directories", "What runs before you trust a folder").

The prompt goes to stdin. Every run gets these flags:

| Flag | Why | Source |
|---|---|---|
| `-p` | Headless: one prompt, then exit. | `claude --help`; headless. |
| `--output-format stream-json --verbose` | One JSON event per line: every message, tool call and tool result, so the classifier can see what the agent did before it repeated a token. | `claude --help`; headless, "Stream responses". |
| `--no-session-persistence` | No session file is written. | `claude --help`; cli-reference. |
| `--strict-mcp-config` (and no `--mcp-config`) | No MCP server from any configuration connects. | `claude --help`. |
| `--permission-mode dontAsk` | Anything that would ask for permission is denied. File reads inside the working directory need no approval, so they still work. | headless, "Auto-approve tools"; permissions, "Permission system". |
| `--tools ""` (recall mode) | No tools exist in the session. | `claude --help`: `""` disables all tools. |
| `--tools Read,Glob,Grep` (task mode) | Only the read tools exist. | `claude --help`. |

And never these:

| Flag | Why not | Source |
|---|---|---|
| `--bare` | Skips CLAUDE.md, so it would measure nothing (rule `claude.bare`). | headless. |
| `--allowedTools` | A bare `Read` rule would also allow reads outside the copy. Without it, `dontAsk` denies them. | permissions, "Working directories". |
| `--setting-sources`, `--settings`, `--safe-mode`, `--restricted` | Each changes which settings, and so possibly which instruction files, apply; excluding `project` from `--setting-sources` skips project rules. | `claude --help`; memory, "Organize rules with .claude/rules/". |

Every trial is checked against its own `system/init` event: the working
directory must be the launch directory in the copy, the version must match
`claude --version`, and the tools must be none (recall) or only the read tools
(task). A trial that fails a check is excluded and the whole run is marked as
an instrument fault. A trial with no `system/init` event that also failed (a
non-zero exit, a timeout or no result event), such as a run that is not
logged in, stopped before its session started: it is counted as failed, not
as a fault.

When ctxreach itself runs inside a Claude Code session, the variables that
session sets for its children (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_ENTRYPOINT` and others, listed in
`src/agents/claude/adapter.ts`) are removed from the agent's environment, so
the agent starts as a top-level session. Variables a person sets, such as
`CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CONFIG_DIR`, are kept. `CLAUDE_CODE_SIMPLE`
(bare mode) and `CLAUDE_CODE_SAFE_MODE` are reported as warnings.

The `claude` executable is found in an absolute `PATH` directory, or given
with `--claude-bin`, which is resolved from the directory ctxreach runs in:
the agent's working directory is the copy, where a relative path would name
the repository's own file. An executable inside the copy is refused. When
ctxreach is interrupted (Ctrl+C or SIGTERM), it stops the agent first (on
Windows with `taskkill /T /F`, so whatever the agent started stops too), then
deletes the copy.

Observed on 2.1.280: even with `--no-session-persistence`, Claude Code creates
an empty folder `~/.claude/projects/<the copy's path>/memory`. The probe
removes it after each trial if it holds no file, and reports it otherwise.

### What the temporary copy loses

A `claude -p` session runs a project's hooks, its settings' `env` block and
helper commands, a project skill's hooks, and its `.mcp.json` servers, even
in a folder that was never trusted (permissions, "What runs before you trust
a folder"). So before any run the copy loses, wherever they appear:
`.claude/settings.json`, `.claude/settings.local.json`, `.claude/skills/`,
`.claude/agents/`, `.claude/hooks/`, `.claude-plugin/`, `.mcp.json` and
`.codex/`. The repository's `.git` is never copied (its config and hooks can
run commands), whether it is a directory or a `gitdir:` file, and neither is a
nested one; the copy gets `git init --template=`, which installs no hooks.
Then git, run from the copy's root and from the launch directory, must use
the copy's own `.git` and no other (a repository nested in the copy would
bring its own config). `node_modules` is not copied. All these names are
matched without case and without trailing dots or spaces, on every system:
on Windows and macOS `.GIT` opens as `.git`, and `.Claude/Settings.json` as
`.claude/settings.json`. git itself is run by its absolute path, found in an
absolute `PATH` directory: run by name, Windows looks for it in the copy
first. Removing the project settings also removes any setting in them that
changes loading (such as `claudeMdExcludes`, which `map` does not model
either).

The copy holds no links (symlinks or junctions), checked with `lstat` before
anything is removed from it and again before any run: otherwise removing
`.claude/settings.json` through a linked `.claude` would delete the file the
link points to, outside the copy. A link to a file or directory inside the
repository is copied as that file or directory, so a `CLAUDE.md` that links
to `AGENTS.md` becomes two separate files and rule `claude.symlink` is not
measured. A link that leads outside the repository, to nothing, into a
directory that is not copied, or to a directory that contains it is left out,
and so is a link to a directory another link already copied (links to links
could otherwise copy a directory once for every path to it). Files,
directories and links all count towards the copy's limit of 20,000 entries.
The report lists every link and what was done with it.

The copy's marker file says that it was stripped, with a random nonce, only
once all of this is done. Right before each trial, the adapter checks that
marker and nonce, that no path above is in the copy (in any case), that it
holds no link, and where git finds its `.git`, and refuses to start the agent
otherwise.

The user's own configuration is not touched: the hooks, plugins and skills in
`~/.claude` and in managed settings run in every trial.

### Stream events

The parser (`src/agents/claude/events.ts`) validates, with zod, the events it
reads: `system/init` (working directory, tools, model, version), `assistant`
(text and `tool_use` blocks), `user` (`tool_result` blocks) and `result`. A
change in their shape fails the parse with the line number. Other event
types, `system` subtypes and content blocks are tolerated and counted, and the
report says how many there were. On 2.1.280 the only kind seen that the
parser does not know is `system/thinking_tokens`.

### Evidence from probe runs

Claude Code 2.1.280 on Windows 11, 2026-09-28. Each fraction is trials in
which the planted token arrived that way, over usable trials. Recordings are
in `test/recorded/`. An echo shows the text reached the model, not that the
model follows it.

| Rule | Observed | Recording |
|---|---|---|
| `claude.ancestors` | A `CLAUDE.local.md` or `CLAUDE.md` at the repository root was preloaded when launched in `packages/api`: 3/3, 2/2, 2/2. | `demo-api-recall`, `nested-api-recall`, `ancestor-imports-recall` |
| `claude.agents-default` | With a `CLAUDE.local.md` at the root, no `AGENTS.md` arrived: 0/3 launched in `packages/api`; 0/3 launched at the root while reading `packages/api/src/payments.ts`. With no `CLAUDE.md`-family file, the root `AGENTS.md` was preloaded (2/2, 3/3) and `packages/api/AGENTS.md` arrived after a read in `packages/api` (3/3), not before (0/2). | `demo-*`, `agents-*` |
| `claude.subdirs` | `packages/api/CLAUDE.md` was not preloaded from the root (0/2) and arrived after a read in `packages/api` (3/3). | `nested-recall`, `nested-task` |
| `claude.imports` | An import inside the launch directory was preloaded (2/2, 3/3, and 2/2 from an ancestor's `CLAUDE.md`). An import from outside the launch directory, in an ancestor's `CLAUDE.md`, was **not loaded** in `claude -p` (0/2, 0/2). `map` marks it "needs approval"; the docs describe the approval dialog but not what `-p`, which shows none, does. | `nested-*`, `ancestor-imports-recall` |
| `claude.rules` | A rule without `paths` was preloaded (2/2, 3/3). A rule with `paths` was not preloaded (0/2) and arrived after a read of a matching file (3/3; that task run cannot tell on-read from preloaded, which the 0/2 recall run settles). Launched in `packages/api`, the rules in the copy's root (its project and git root) behaved the same way: the one without `paths` was preloaded (2/2), the one with `paths` was not (0/2). No other directory above `packages/api` had rules to test. `map` marks ancestors' rules not modelled, so these cells get the verdict NOT MODELLED. | `nested-*` |
