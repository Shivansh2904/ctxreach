# Workshop: does your agent get your instructions?

A 90-minute hands-on session for developers and founders who use Codex,
Claude Code or both, with an `AGENTS.md` or `CLAUDE.md` in their repository.

## The outcome, and how we know it happened

Designed backwards from one outcome:

> Each participant leaves knowing what reaches Codex and Claude Code from
> their own launch directory, and has fixed one trap.

The summative check is the **exit ticket** (last five minutes). Each person
writes, for their own repository and the directory they launch from:

- which instruction files reach Codex, and up to which byte;
- which reach Claude Code;
- one trap `ctxreach map` warned about, what they changed, and that the
  warning is gone when they ran `map` again.

A ticket with all three is the outcome met. Everything before it is there to
make that ticket possible, and every block ends with a quick check that shows
the room is on track.

## Who it is for (personas)

- **Priya**, backend lead, monorepo, Claude Code daily and Codex for
  reviews. Has a root `AGENTS.md` that grew to several screens. Wants: proof
  that the package rules arrive.
- **Tom**, founder, one repository, Claude Code only, keeps a
  `CLAUDE.local.md` with personal notes. Does not know it switches
  `AGENTS.md` off.
- **Ana**, on Windows, no admin rights, symlinked `CLAUDE.md` to `AGENTS.md`
  because a blog post said so. Git checked the link out as a text file.
- Anyone **without an agent login**: every exercise has a path with no login
  and no billed run.

## Schedule

| Minutes | Block | Format | Check at the end |
|---|---|---|---|
| 0-10 | Why instruction files fail silently: the three traps | Short talk, demo SVG | Sticky-note poll: AGENTS.md, CLAUDE.md, or both? |
| 10-25 | A manual canary: plant a word, ask the agent | Everyone types along | Green sticky: the word came back. Pink: it did not, or stuck |
| 25-40 | `ctxreach map` on the demo, then on your own repository | Code-along; helpers circulate | Each person reads one finding aloud to a neighbour |
| 40-55 | Fix one trap, then run `map` again | Pairs | The warning is gone on the second run (show a helper) |
| 55-70 | `ctxreach verify --agent codex`, free and with no login; or `--replay` | Demo, then hands-on | The output says EXACT for each chain file, or the replay prints its table |
| 70-85 | What the evidence says about the content of these files | Discussion | Each person writes down one line of their file to delete |
| 85-90 | Exit ticket and wrap-up | Individual | The exit ticket |

The checks come every 10 to 15 minutes, so nobody is lost for longer than
one block.

## Logistics

- **Helpers:** one per ten participants, not counting the instructor.
- **Sticky notes:** two colours per person (green: done; pink: stuck or need
  help). Stuck people put pink on the laptop lid; helpers go there first.
- **Setup check:** send [setup-check.md](setup-check.md) the day before.
  People who cannot run it still take part on the demo repository.
- **Windows:** read [windows.md](windows.md) before the session; the one
  rule to teach is "import, do not symlink".
- **No billed run is needed.** The canary in block two uses the
  participant's own agent and login if they choose; everyone else follows on
  a neighbour's screen or uses `ctxreach probe --replay` on a recording.
- **Numbers:** the study's figures are on the results site, rendered from
  its data. Quote them from there; do not copy them onto slides by hand.

## Files

- [facilitator-guide.md](facilitator-guide.md): what to say and do, block by block.
- [handout.md](handout.md): the participants' sheet, with every command.
- [setup-check.md](setup-check.md): the message for the day before.
- [windows.md](windows.md): the Windows notes.
