# Setup check (send the day before)

Subject: Ten minutes of setup before tomorrow's workshop

Hi, please run these before the session. If any step fails, reply with the
last few lines it printed; you can still take part on the demo repository.

You need **Node 20 or later** (`node --version`) and **git**.

```sh
git clone https://github.com/Shivansh2904/ctxreach
cd ctxreach
npm ci
npm run build
node dist/cli.js --help
```

The last command prints `ctxreach`'s commands, `map` among them.

Then the demo (macOS, Linux or Git Bash):

```sh
cp -r examples/demo-monorepo ../demo
git -C ../demo init -q
node dist/cli.js map --from ../demo/packages/api --no-color
```

On Windows PowerShell:

```powershell
Copy-Item -Recurse examples\demo-monorepo ..\demo
git -C ..\demo init -q
node dist\cli.js map --from ..\demo\packages\api --no-color
```

You should see a table whose first line starts with `ctxreach map  launch dir:
packages/api`, and warnings under **Findings**.

Optional, for block five: install Codex if you use it (no login is needed for
the exercise). Optional, for block two: bring a repository with an
`AGENTS.md` or `CLAUDE.md` you are happy to copy into a scratch folder.

On Windows, please also read the two short notes in `workshop/windows.md`.
