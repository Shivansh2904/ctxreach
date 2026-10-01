# Draft issue for anomalyco/opencode (not posted)

**Status:** draft. Shiv decides whether to file it.

**Before filing:**

1. Re-read <https://opencode.ai/docs/rules/> on the day and quote it as it
   then reads. If the docs already describe stacking every `AGENTS.md`
   from the launch directory up to the worktree root, drop this draft.
2. Re-run the capture on the current release (`opencode-ai` <<version>>)
   and update the version below.
3. Pin the source comment and the `findUp` call with permalinks at the
   tested version (`packages/opencode/src/session/instruction.ts`).
4. Search the tracker for an existing issue.

Evidence: `study/pilot/capture/opencode.jsonl` and
`study/pilot/capture/fixture/ofx/` (pilot, one capture, OpenCode 1.18.33,
Windows, 2026-09-30): the first model request was recorded by a local
server set as the provider's `baseURL`; nothing was sent to a model.

---

**Title:** Every ancestor AGENTS.md is loaded, but the docs and a code comment say the first match wins

**What the docs say.** The rules page says project files are found "by
traversing up from the current directory" and that "the first matching
file wins in each category". A comment in `instruction.ts` says the same:
"The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md
from every ancestor."

**What happens.** On OpenCode 1.18.33, launched in `packages/api` of

```
repo/.git/
repo/AGENTS.md                 "root AGENTS <token-a>"
repo/CLAUDE.md                 "root CLAUDE <token-c>"
repo/packages/api/AGENTS.md    "api AGENTS <token-b>"
repo/packages/api/CLAUDE.md    "api CLAUDE <token-d>"
```

the first model request carried **both** `AGENTS.md` files,
`packages/api/AGENTS.md` first and then the root file, and neither
`CLAUDE.md` (which matches the docs' fallback rule). As far as we can read
the source, `findUp` returns every match from the launch directory up to
the worktree root and the loader adds all of them.

**Question.** Which is intended? If stacking is intended, the docs and the
comment could say so (and give the order: nearest first, which is the
reverse of Codex's root-first order). If the first match should win, the
loader keeps more than it should.

We found this while checking our own notes on OpenCode against a capture:
our notes, written from the docs, said only the nearest file loads.
