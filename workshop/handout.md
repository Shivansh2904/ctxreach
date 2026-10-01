# Handout: does your agent get your instructions?

Keep this open. Put a green sticky on your laptop when a step works, a pink
one when you are stuck; a helper will come to you.

## Before you start

You need Node 20 or later, and git. From the setup check:

```sh
git clone https://github.com/Shivansh2904/ctxreach
cd ctxreach
npm ci
npm run build
```

Below, `ctxreach` means `node dist/cli.js` run from that clone (on Windows,
`node dist\cli.js`).

## Block two: a manual canary

In a scratch copy of a repository (not one you will commit):

- Add `Canary word: PERIWINKLE` plus your initials as the last line of the
  root `AGENTS.md`, and a different word as its first line.
- Start your agent there and ask: "List every word in your instructions that
  starts with PERIWINKLE. Do not open any file."

No login, or no agent installed? Run the recorded version of this test:

```sh
ctxreach probe --replay test/recorded/demo-api-recall
```

Write down: did the word come back? Which agent? From which directory?

## Block three: `ctxreach map`

The demo first (macOS, Linux, Git Bash):

```sh
cp -r examples/demo-monorepo ../demo
git -C ../demo init -q
ctxreach map --from ../demo/packages/api
```

PowerShell:

```powershell
Copy-Item -Recurse examples\demo-monorepo ..\demo
git -C ..\demo init -q
node dist\cli.js map --from ..\demo\packages\api
```

Read the first table: one row per instruction file, one column per agent.
Then your own repository, from the directory you launch your agent in:

```sh
ctxreach map --from path/to/your/repo/the/launch/dir
```

To see what a fresh machine gets, without your personal config:

```sh
mkdir empty-codex empty-claude
ctxreach map --from path/to/launch/dir --codex-home empty-codex --claude-home empty-claude
```

Exit ticket, line one: which files reach Codex, and up to which byte.
Line two: which reach Claude Code.

## Block four: fix one trap

Pick the fix that answers your finding:

| `map` says | Fix |
|---|---|
| `AGENTS.md` does not reach Claude Code (a `CLAUDE.md` or `CLAUDE.local.md` switches it off) | Add the line `@AGENTS.md` to that `CLAUDE.md`, or set Project instructions to `claude-md-and-agents-md` |
| A file is cut, or never reaches Codex (budget used up) | Shorten the root file; move package rules into the package's own `AGENTS.md`; or raise `project_doc_max_bytes` on purpose |
| A file below the launch directory is not preloaded | Launch from that directory, or move the rule up |
| A `CLAUDE.md` whose whole text is a path (a symlink checked out as text) | Replace it with a `CLAUDE.md` holding `@AGENTS.md` |

Run `map` again. The warning should be gone. If a new one appeared, read it:
fixes for one agent can change what the other gets.

Exit ticket, line three: the trap, your change, and the warning gone.

## Block five: `ctxreach verify --agent codex`

With Codex installed (no login needed; no model runs):

```sh
ctxreach verify --agent codex --repo ../demo --from ../demo/packages/api
```

For each chain file it prints the bytes `map` predicted and the bytes Codex's
renderer kept, and EXACT or OFF BY. Without Codex, replay a recorded render:
any folder under `test/recorded/` whose name starts with `codex-`:

```sh
ctxreach verify --agent codex --replay test/recorded/<a codex- folder>
```

## Block six: one line to delete

Read your own instruction file. Write down one line that the agent could
work out from the code, or that it would not miss. Why is it there?

## Exit ticket

Repository and launch directory:

- Reaches Codex (files, and up to which byte):
- Reaches Claude Code (files):
- The trap I fixed, what I changed, and `map`'s warning before and after:

One thing to change about this session:
