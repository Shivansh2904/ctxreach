# Demo monorepo

A small repository with three instruction-file traps, used in the ctxreach
README:

- `AGENTS.md` at the root is 40 KiB, over Codex's default 32 KiB budget.
- `packages/api/AGENTS.md` holds the payments rule. Codex spends its whole
  budget on the root file before it gets there.
- `CLAUDE.local.md` is a personal notes file. Its presence stops Claude Code
  from reading any `AGENTS.md`.

To try it, build ctxreach and copy this directory out of the repository, so
that it has its own root. ctxreach is not published on npm, so it runs from a
clone. From the root of a clone of ctxreach, with no `/tmp/demo` yet:

```sh
npm ci
npm run build
cp -r examples/demo-monorepo /tmp/demo
git -C /tmp/demo init -q
node dist/cli.js map --from /tmp/demo/packages/api
```
