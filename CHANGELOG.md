# Changelog

## Unreleased

- `ctxreach map` for Codex: the root-to-launch-directory chain, one file per
  directory, the shared root-first byte budget with the cut point and the
  sections lost, project config and trust, and files below the launch
  directory.
- `ctxreach map` for Claude Code: the `CLAUDE.md` family up to the filesystem
  root, subdirectory files loaded on read, the `AGENTS.md` shadow rule and the
  Project instructions setting, `@` imports, and the version gates.
- A files-by-agents matrix in the terminal output and `--json` (schema
  `ctxreach.map/v1`).
- `map` exits with status 2 and says why when `--from` or `--repo` is not an
  existing directory, or when `--from` is outside `--repo`.
- Interfaces for the planned `probe` command.
