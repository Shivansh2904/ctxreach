# Same repo, different instructions: five-minute talk

One idea: the same repository gives two coding agents different instructions,
silently, and you can check which in a few seconds. Everything on stage is a
recording or a replay. **No billed agent run happens on stage, ever**: no
`ctxreach probe`, no live `claude` session.

The slides are `talk/slides.md`, a template. Every number on them is filled
from the study's data by the same code as the results site; render them the
day before (see Preparation) and never type a number onto a slide.

## Run of show

| Time | Beat | On screen | Say (in your own words) | If it fails |
|---|---|---|---|---|
| 0:00-0:20 | Hook | Slide "Does your agent read your AGENTS.md?" | Hands up if your repository has an `AGENTS.md`. Keep it up if you know your agent read it today. | Nothing to fail. |
| 0:20-1:00 | The headline | Slide "The headline", with the pre-registration tag and the issue timestamp | Read the sentence once, slowly. Point at the timestamp: the hypotheses were public before any repository was fetched. Say what the numbers are fractions of. | The slide is static: nothing to fail. |
| 1:00-2:30 | Demo 1: `map` | `docs/demo.svg` full screen (recorded; its first line says typing is simulated and gives the version and date) | Same launch directory, two agents. Codex: the root file uses the whole byte budget, so the payments rule in the package file never arrives. Claude Code: a personal `CLAUDE.local.md` switches both `AGENTS.md` files off. Neither session says so. | Open the SVG in a browser tab kept open beforehand. |
| 2:30-3:40 | Demo 2: the home-folder cell, replayed | Terminal: `ctxreach verify --agent claude --replay site/runs/B2-A1/`, then `B2-A2` | Same repository, same personal `~/.claude/CLAUDE.md`; only where the repository lives changes. Show the control token arriving and the decoy absent in both runs: the instrument works, so the difference is real. | Show the slide "The home-folder cell", which has the same fractions. |
| 3:40-4:30 | Demo 3: Codex's own renderer, replayed | Terminal: `ctxreach verify --agent codex --replay talk/build/codex-render/` (rendered at rehearsal from the demo copy) | This is Codex's own prompt renderer, run with no login and no model: the bytes Codex would send, compared file by file with `map`. Then the slide with check K4 (map against that renderer over the whole sample) and the headless-import trap. | Show the slide; it lists the command and K4. Only if the room asks, render live: `ctxreach verify --agent codex --from packages/api` is free and deterministic, but it is not needed. |
| 4:30-5:00 | Close | Slide "Delivery is a precondition, not a benefit", QR code to the site | Every study of whether these files help assumes they arrived. Check yours: one command, no agent run. | Read the site address aloud. |

Talking points that stay true whatever the data says:

- "An echo proves delivery, not compliance." Nothing here says a model obeys a file.
- Codex figures are renders, "as rendered by `codex debug prompt-input`; the model was not run".
- Capture is the gateway path to the model endpoint, not a first-party session.
- If cell B2 is not confirmed, say so and read its verdict from the slide; the slide drops the words "depending only on where the repository lives" on its own.

## Preparation

The day before:

- Render the slides from the published data, and read the banner line: it must not say SAMPLE or PILOT.

  ```sh
  mkdir -p talk/build
  node scripts/writeup.mjs --template talk/slides.md --data site/data --out talk/build/slides.md
  ```

- Check the two recordings replay, offline (network off):
  `ctxreach verify --agent claude --replay site/runs/B2-A1/` and `.../B2-A2/`.
- Make the demo copy and save a Codex render to fall back on:

  ```sh
  cp -r examples/demo-monorepo ~/demo && git -C ~/demo init -q
  ctxreach verify --agent codex --repo ~/demo --from ~/demo/packages/api --save talk/build/codex-render
  ```

- Make the QR code for the site address on the last slide and save it as `talk/build/qr.png`.

One hour before:

- Terminal at 120 columns, font large enough for the back row, notifications off, a dark theme that matches the SVG.
- Run Demo 3's replay once. If you keep the live render as a fallback, check Codex is installed at the version on the slides (`codex --version`).
- Close every agent session on the presenting machine.

## Never on stage

- `ctxreach probe` or any `claude -p` run: billed, slow, and not the same twice.
- A number that is not on a rendered slide. If asked for one, point to the site, where each figure links to its recording.
- Naming a repository for a defect. The study never does.
