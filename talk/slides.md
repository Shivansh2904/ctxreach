<!--
Slides for the five-minute talk (talk/run-of-show.md), as a template. Render
before presenting, from the published data:

  node scripts/writeup.mjs --template talk/slides.md --data site/data --out talk/build/slides.md

Slides are separated by lines holding only ---. No number is typed here:
each comes from site/data/ through a {{slot}} (test/site.test.ts). If the
rendered file starts with a SAMPLE or PILOT banner, do not present it.
-->

# Does your agent read your `AGENTS.md`?

ctxreach: which instruction files reach Codex and Claude Code, from which directory, up to which byte.

---

## The headline

{{headline}}

Pre-registered as {{preregTag}} at commit {{preregCommit}}, timestamped by a public issue opened {{preregIssue}}, before any repository was fetched.

---

## Same launch directory, two agents

![ctxreach map on examples/demo-monorepo, launched from packages/api](../docs/demo.svg)

{{demoLabel}}

---

## The home-folder cell, replayed

A personal `~/.claude/CLAUDE.md`; only where the repository lives changes.

- Repository under the home folder: `AGENTS.md` absent in {{b2a1}} runs.
- Repository outside it: `AGENTS.md` absent in {{b2a2}} runs.
- Cell B2: {{b2}}. Delivered to the model endpoint (custom base URL); Claude Code {{cellsVersion}}, {{cellsOs}}, {{cellsDate}}.

```sh
ctxreach verify --agent claude --replay site/runs/B2-A1/
ctxreach verify --agent claude --replay site/runs/B2-A2/
```

---

## Codex's own renderer, free

```sh
ctxreach verify --agent codex --from packages/api --save talk/build/codex-render
ctxreach verify --agent codex --replay talk/build/codex-render/
```

As rendered by `codex debug prompt-input`; the model is not run, no login is needed.

- `map` against that renderer over the whole sample: {{k4}} pairs byte-exact (check K4).
- Repositories whose `CLAUDE.md` imports `@AGENTS.md`: from at least one package directory, a headless session gets none of the root file in {{o2}} of them.

---

## Delivery is a precondition, not a benefit

Every study of whether these files help assumes they arrived.

```sh
{{selfcheck}}
```

{{site}}
