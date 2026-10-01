# Windows notes

## Import, do not symlink

A common tip is to make `CLAUDE.md` a symlink to `AGENTS.md`, so both agents
read one file. On Windows this often goes wrong without any message:

- Creating a symlink needs administrator rights or Developer Mode.
- Git checks symlinks out as **plain text files holding the target path**
  unless `core.symlinks` is true and the user may create links. The
  `CLAUDE.md` you get then contains only the text `AGENTS.md`, which Claude
  Code reads as a one-line instruction file. By the documented default, a
  `CLAUDE.md` switches `AGENTS.md` off, so you can end up with neither (lab
  cell B4 on the results site measures this).

Check with `type CLAUDE.md` (cmd) or `Get-Content CLAUDE.md` (PowerShell):
if all it says is `AGENTS.md`, that is what happened.

The fix that works everywhere is an **import**: a real `CLAUDE.md` file whose
content is the line

```text
@AGENTS.md
```

Claude Code expands the import at launch; Codex ignores `CLAUDE.md` and reads
`AGENTS.md` directly. Run `ctxreach map` again to confirm both agents get the
file.

## Commands

- Copy a folder: `Copy-Item -Recurse <from> <to>` (PowerShell) instead of
  `cp -r`.
- Run ctxreach from the clone: `node dist\cli.js ...`.
- Paths: both `\` and `/` work for `--from`.
