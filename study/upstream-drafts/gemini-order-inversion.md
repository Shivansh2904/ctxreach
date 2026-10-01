# Draft issue for google-gemini/gemini-cli (not posted)

**Status:** draft. Shiv decides whether to file it.

**Before filing:**

1. Confirm end to end through the CLI binary. The pilot called
   `@google/gemini-cli-core` 0.62.0's own memory functions from Node
   (`study/pilot/scripts/gemini-oracle.mjs`); it did not run the `gemini`
   binary, and its output was printed, not saved. Re-run the script, save
   the output, and run the binary once on the same fixture (a capture of
   the first request, or its `/memory show`), then fill in the results
   below.
2. Pin the source: a permalink to the line in `memoryDiscovery.ts` (or the
   file it moved to) at the tested version.
3. Quote the docs' sentence on order as it reads on the day (the design
   notes paraphrase it as root to leaf) and link the page.
4. Search the tracker for an existing issue on memory file order.

Evidence: `study/pilot/gemini/fixture/` (pilot, one library run,
2026-09-30).

---

**Title:** Nested GEMINI.md can be concatenated before the root file (paths sorted as strings)

**What happens.** The docs describe context files as concatenated from the
root towards the current directory, so the more specific file comes last.
In `@google/gemini-cli-core` <<version>>, the startup paths from
`getEnvironmentMemoryPaths` come back sorted as plain strings. Launched in
`repo/Api` with `repo/GEMINI.md` and `repo/Api/GEMINI.md`, the order is:

```
<<paths as printed, e.g.
  .../repo/Api/GEMINI.md
  .../repo/GEMINI.md>>
```

so `Api/GEMINI.md` is concatenated **before** the root `GEMINI.md`, and the
general file ends up last. <<CLI BINARY RESULT: the same order in the
binary's first request / `/memory show`, gemini-cli <<version>>, OS, date.>>

**When it happens.** Whenever a directory on the path sorts before the
context file's name in a string comparison: here `Api/...` sorts before
`GEMINI.md` because `A` < `G`. Names that start with an upper-case letter
from A to F, a digit, `.` or `-` do this with the default file name; a
lower-case directory such as `packages/` does not, which may be why it has
not been noticed.

**Reproduce.**

```
repo/.git/            (empty; marks the project root)
repo/GEMINI.md        "ROOT <token-1>"
repo/Api/GEMINI.md    "API <token-2>"
cd repo/Api && gemini
```

Expected (per the docs): ROOT, then API. Observed: API, then ROOT.

**Why it matters.** When the two files disagree, the file that comes last
tends to carry more weight, and users write the nested file to refine the
root one.

**Suggested fix.** Order the discovered paths by depth from the project
root (or by the order of the upward walk) instead of sorting them as
strings. (A suggestion; not tested.)
