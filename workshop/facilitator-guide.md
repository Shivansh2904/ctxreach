# Facilitator guide

Live-code slowly, with a large font and notifications off. Type every
command; do not paste. When you make a mistake, keep it on screen and fix it
out loud: that is part of the lesson. Keep the demo SVG (`docs/demo.svg`)
and a terminal open side by side.

## 0-10: Why instruction files fail silently

Goal: everyone can name the three traps.

1. Ask: "Who has an `AGENTS.md`? A `CLAUDE.md`? Both?" Sticky-note poll on
   the wall in three columns. Keep it: you will refer to it in block three.
2. Show the demo SVG. Walk the three traps, one sentence each:
   - Codex reads one file per directory from the project root down to where
     it was launched, and stops at one byte budget for the whole chain.
   - Claude Code, by default, reads `AGENTS.md` only when no `CLAUDE.md`,
     `.claude/CLAUDE.md` or `CLAUDE.local.md` sits on the way.
   - Neither preloads files below the launch directory.
3. Say why it matters: the session never tells you a file did not arrive.

**Check:** point at a trap on the slide and ask a volunteer which agent it
affects.

## 10-25: A manual canary

Goal: everyone sees, with their own agent or a neighbour's, that you can
test delivery instead of assuming it.

1. In a **scratch copy** of a repository (never one you will commit), add a
   line to the end of the root `AGENTS.md`: `Canary word: PERIWINKLE` plus
   your initials. Add a different word at the top.
2. Start the agent in the repository root and ask: "List every word in your
   instructions that starts with PERIWINKLE. Do not open any file."
3. Then do the same from a package directory, if the repository has one.

People without a login pair with someone who has one, or run
`ctxreach probe --replay test/recorded/demo-api-recall` from the ctxreach
clone, which prints a recorded run of exactly this test.

Say: this is the method from P. Szypowicz's post on Claude Code and
telemetry; `ctxreach probe` automates it with random tokens and a decoy.

**Check:** green sticky if the word came back from the root, pink if not or
if stuck. Ask a pink to say what they saw; it is usually a trap, not a bug.

## 25-40: `ctxreach map`, the demo and then your own repository

Goal: everyone has read `map`'s output for their own launch directory.

1. Code along on the demo (commands in the handout). Read the table aloud:
   one row per file, one column per agent.
2. Then each person runs it on their own repository, from the directory
   they actually launch the agent in. Helpers circulate.
3. Point out the two homes `map` reads (`~/.codex`, `~/.claude`): personal
   config changes the answer. `--codex-home` and `--claude-home` with empty
   folders show what a fresh machine gets.

**Check:** each person reads one finding aloud to a neighbour, and says which
agent it is about.

## 40-55: Fix one trap

Goal: everyone changes one thing and sees the warning go.

Offer four fixes, and say which trap each one answers:

- **Claude Code skips `AGENTS.md`:** put a line `@AGENTS.md` in the
  `CLAUDE.md` (an import), or set Project instructions to
  `claude-md-and-agents-md`.
- **Codex cuts the chain:** shorten the root file, move package rules into
  the package's own `AGENTS.md`, or raise `project_doc_max_bytes` if the
  length is deliberate.
- **Rules below the launch directory:** put them where the agent will be
  launched, or launch from the package.
- **A symlinked `CLAUDE.md` on Windows:** replace it with an import (see
  [windows.md](windows.md)).

Pairs: one person drives, one reads `map`'s finding aloud and checks the fix
against it. Swap after one fix.

**Check:** run `map` again; the warning is gone. Show a helper.

## 55-70: `ctxreach verify --agent codex`

Goal: everyone sees a prediction checked against the agent's own machinery,
for free.

1. Demo: `ctxreach verify --agent codex --from packages/api` on the demo
   copy. It runs Codex's own prompt renderer (`codex debug prompt-input`):
   no login, no model, no cost. Read the per-file line: kept bytes, and
   EXACT or OFF BY.
2. Those with Codex installed run it on their own repository.
3. Everyone else replays a recording (`--replay`; the handout names one).

Say the honest sentence: "as rendered by `codex debug prompt-input`; the
model was not run". A render is what Codex sends, not what the model does.

**Check:** the output shows EXACT for each chain file, or the replay prints
its table.

## 70-85: What the evidence says about content

Goal: delivery is settled; now, is the content worth delivering?

Discuss, with the sources on screen:

- L. Gloaguen and colleagues, "Evaluating AGENTS.md": instructions are
  followed, but overall task success did not improve and cost went up.
- Augment's post on writing good `AGENTS.md` files: the best files were
  short, and nested docs were often not found.
- The vendors' own advice: Anthropic's memory docs ask for a short
  `CLAUDE.md` with concrete, checkable lines; OpenAI's Codex guide says a
  short, accurate `AGENTS.md` beats a long one.

Say: "Delivery is a precondition, not a benefit."

**Check:** each person writes one line of their own file to delete, and why.

## 85-90: Exit ticket

Hand out the ticket (in the handout). Collect it. Give the results site
address and the self-check command. Ask for one thing to change about the
session on the back of the ticket.
