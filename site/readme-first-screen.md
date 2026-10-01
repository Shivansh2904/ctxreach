<!--
Draft of README.md's first screen, for the integrator (lane L6 drafts, the
integrator writes README.md last). It is a template: render it with

  node scripts/writeup.mjs --template site/readme-first-screen.md --data site/data --out <file>

and paste the result over README.md's opening, down to and including the
"Three ways instructions silently fail to arrive" list. Every number comes
from site/data/ through a {{slot}}; none is typed (test/site.test.ts).

Rules named here: only rules whose docs/evidence.json status is "observed"
(test/evidence.test.ts check 3 fails the README otherwise). Today that is
claude.agents-shadowed and claude.nested. The Codex trap is described but its
rule ids (codex.cut, codex.no-budget) are not named until the render battery
marks them observed; add them then. Add claude.home-ancestor only after cell
B2 is confirmed and the registry says observed.

docs/demo.svg comes from node scripts/make-cast.mjs --svg docs/demo.svg (one
SVG for both themes: svg-term-cli draws its own dark terminal window). Its
label (version, commit, date) is the first line of the recording and is
repeated under the image from provenance.json.
-->

# ctxreach

Does your coding agent actually see your `AGENTS.md`?

<picture>
  <img alt="ctxreach map on the demo monorepo, launched from packages/api: Codex cuts the root AGENTS.md and never reaches the package's file; Claude Code reads neither AGENTS.md, because a CLAUDE.local.md switches them off" src="docs/demo.svg">
</picture>

<sub>{{demoLabel}}. The demo repository is `examples/demo-monorepo`.</sub>

```sh
{{selfcheck}}
```

`ctxreach` shows which instruction files (`AGENTS.md`, `CLAUDE.md`, `CLAUDE.local.md`, `.claude/rules/` and the files they import) reach Codex and Claude Code when the agent is launched from a given directory, and up to which byte. `map` predicts from each agent's loading rules and runs no agent; `verify` checks the prediction against each agent's own machinery at no cost and with no login; `probe` checks it against a real, billed Claude Code session.

**The study.** {{headline}} [Results, method and recordings]({{site}}), pre-registered as {{preregTag}} before any repository was fetched.

## Three ways instructions silently fail to arrive

- **Codex spends one byte budget on the whole chain, root first.** It reads one instruction file per directory from the project root down to the launch directory, and stops at `project_doc_max_bytes` for the chain as a whole. A long root `AGENTS.md` can leave nothing for the package file next to where you launched. ([rules](docs/rules.md))
- **A personal `CLAUDE.local.md` switches `AGENTS.md` off in Claude Code** (`claude.agents-shadowed`, observed; [evidence](docs/evidence.md)). By default, Claude Code reads `AGENTS.md` only when there is no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` in the launch directory or above it.
- **Files below the launch directory are not preloaded** (`claude.nested`, observed; [evidence](docs/evidence.md)). Codex does not read them unless the model opens them; Claude Code loads a subdirectory's files only when it reads a file there.

## Status

- `map`: Codex and Claude Code, from documented rules and published source.
- `verify`: Codex as rendered by `codex debug prompt-input` (the model is not run); Claude Code through a loopback capture endpoint (the gateway path, no model runs). The versions checked every night are the columns of the conformance matrix on the [results site]({{site}}).
- `probe`: Claude Code only, on your own login; each trial is a billed request. See [docs/probe.md](docs/probe.md).
