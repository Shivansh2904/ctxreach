<!--
The write-up, as a template. scripts/writeup.mjs fills each {{slot}} from
site/data/ with the results page's own render core, so no number is typed
here: test/site.test.ts fails on a digit outside a slot (identifiers such as
H1, B2 or openai/codex#41499 are allowed), on an unknown slot, and on a
rendered text of a thousand words or more.

Generate (the integrator, after the study's data is in site/data/):
  node scripts/writeup.mjs --format html --out site/writeup.html
  node scripts/writeup.mjs --format md --out <for the blog>

Before publishing: check that openai/codex#13386 and openai/codex#41499 are
still open, and post it as a results page, not the README.
-->

# {{title}}

{{headline}}

These are the pre-registered figures, filled in by a script from the study's data: the census was analysed on {{resultsDate}}, with Claude Code {{claudeVersion}} as modelled by `ctxreach map` on a fresh machine and Codex as rendered by `codex debug prompt-input` ({{codexVersion}}); the lab cells ran on Claude Code {{cellsVersion}} ({{cellsOs}}, {{cellsDate}}). To see what reaches each agent from the directory you launch it in, run this in your repository (it runs no agent and calls no API):

```sh
{{selfcheck}}
```

## Why one file reaches two agents differently

Codex reads one instruction file per directory, from the project root down to the launch directory, and stops at one byte budget for the whole chain. Claude Code, by default, reads `AGENTS.md` only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` sits on the way. A collaborator on its repository has explained (anthropics/claude-code#80580) that the home folder's `~/.claude/CLAUDE.md` loads as an ancestor project file when the repository lives under the home folder; whether it then switches `AGENTS.md` off is what cell B2 below tests. Neither agent preloads files below the launch directory. None of this shows in the session: a file that does not arrive leaves no trace.

## What the census measured

The census drew public repositories with a root `AGENTS.md` from a frozen Sourcegraph frame, rebuilt their instruction files at the indexed commit, and ran `ctxreach map` from every launch directory as a fresh machine would. In frame S-main ({{smainMeasured}} repositories measured):

- Claude Code starts with under half of the root `AGENTS.md`'s text in {{o1}} of repositories. Hypothesis H1: {{h1}}. The file does not arrive at all in {{o1file}} (H1b: {{h1b}}).
- Codex cuts or drops a chain file in {{p1pairs}} launch directories, and from at least one launch directory in {{p1repos}} of repositories (H3: {{h3repos}}).
- Among repositories whose `CLAUDE.md` imports `@AGENTS.md`, a headless session started in at least one package directory gets none of the root file in {{o2}} (H2: {{h2}}).

The instruments were checked before any of this was read. `map` against Codex's own renderer, byte for byte: {{k4}} pairs exact (K4). `map` against live Claude Code captures: {{k5}} decided cells agree (K5). A second reader, working by hand from the written rules alone: {{k6}} pairs agree (K6).

## The home-folder cell

A personal `~/.claude/CLAUDE.md` is meant for your own preferences, in every project. In cell B2 ({{b2}}), with that file in a scratch home folder, `AGENTS.md` did not reach the model endpoint in {{b2a1}} runs when the repository lived under the home folder, and in {{b2a2}} runs when it lived outside it. Without the file, it arrived in {{b2a0}} runs. The other cells: an ancestor `.claude/CLAUDE.md` above the git root (B1), {{b1}}; an `@AGENTS.md` import from a package, headless (B3), {{b3}}; a `CLAUDE.md` symlink checked out as text (B4), {{b4}}; ancestor rules (B6), {{b6}}.

## The moment our own control caught us

Our first attempt to reproduce openai/codex#41499, where an untrusted project's `AGENTS.md` is still delivered, seemed to succeed. A trusted control, run the same way, showed why: the dotted `-c` trust key never addressed the project at all, so neither run tested trust. With a key form shown to apply, the untrusted project delivered nothing. The study reports openai/codex#41499 as not reproduced on Windows with a key form shown to apply. Since then, every battery starts with a planted pass that must disagree, and every lab trial carries a token that must arrive and a decoy that must not.

## Limits

- An echo proves delivery, not compliance. Nothing here says whether a model follows a file once it arrives.
- Codex figures are renders: as rendered by `codex debug prompt-input`; the model was not run.
- The capture cells use the gateway path (a custom base URL); first-party equivalence was measured separately with paired billed runs.
- Census figures about Claude Code are `map`'s predictions on a fresh machine, checked live on a seeded subsample (K5).
- The lab cells ran on one Windows host. Every figure holds for its agent version, operating system and date, and nothing is pooled across them.

## For the vendors

Anthropic's `agents_md_load.yielded` telemetry could measure the Claude Code figure across all users directly. OpenAI's openai/codex#13386 (silent truncation) and openai/codex#41499 were open when this was written.

## Credits

The canary method comes from P. Szypowicz's post on Claude Code reading `AGENTS.md` only with telemetry on. Thanks to the reporters and commenters on openai/codex#13386 and anthropics/claude-code#80580, to M. Galster and colleagues for their studies of agent configuration in public repositories, and to T. Gloaguen and colleagues, whose evaluation asks the next question: whether the files help once they arrive.

Pre-registration: {{preregTag}} at commit {{preregCommit}}, timestamped by a public issue opened {{preregIssue}}. Every figure, its recording and the command that reproduces it: {{site}}
