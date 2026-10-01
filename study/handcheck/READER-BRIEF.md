# K6 reader brief

You are the second reader of a study of how coding agents load instruction
files. For each sheet in `sheets/`, work out **by hand, from `rules.md`
alone**, which files reach two agents when a session starts in the sheet's
launch directory, and write your answer in the matching file in `answers/`.

## What you may use

- `rules.md` (the loading rules, as written), the sheets, and this brief.
- Arithmetic: a calculator, or counting bytes from the sizes given.

## What you may not use

- Any program that works out delivery for you, including `ctxreach` and the
  agents themselves.
- Any other file of the ctxreach repository, the census rows, `key.json`, or
  anything you remember about what `ctxreach map` printed.
- Another person's or agent's answers.

If `rules.md` does not decide a case, give your best reading of it and say
so in `notes`. Do not look the case up elsewhere: an undecided case is a
result.

## Each sheet

A sheet gives the launch directory, the conditions (the same on every
sheet), and every file of the repository that the rules can read, with its
size in bytes and its text. A symlink is listed with the file it points to.

## Your answer

Fill in `answers/<id>.json`. Replace each `null`; an answer left `null`
counts as a disagreement.

```json
{
  "schema": "ctxreach.k6-answer/v1",
  "id": "K6-01",
  "claude": {
    "receives": ["CLAUDE.md", "docs/style.md"],
    "notModelled": []
  },
  "codex": {
    "chain": [
      { "path": "AGENTS.md", "keptBytes": 1204 },
      { "path": "packages/api/AGENTS.md", "keptBytes": 311 }
    ]
  },
  "notes": ""
}
```

- `claude.receives`: every repository file whose text is in Claude Code's
  context when the headless session starts (loaded at launch, or imported
  at launch by a file that is). Leave out files that load only when Claude
  reads something, files that would need an approval, and files outside the
  repository. For a symlink, write the path of the file it points to, once.
  Order does not matter.
- `claude.notModelled`: files about which `rules.md` says, in so many words,
  that ctxreach does not model whether they load. Usually empty.
- `codex.chain`: the files whose bytes appear in Codex's AGENTS.md
  instructions, in the order Codex joins them, each with the number of its
  bytes kept (a whole file keeps its size; a cut file keeps what the budget
  leaves; a file that contributes nothing is left out). Write the path Codex
  opens, even when it is a symlink.
- `notes`: anything you were unsure of, with the rule id you applied.

When every answer is filled in, say so; do not change an answer after that.
