# Upstream drafts (not posted)

Drafts of comments and issues for other projects, written from the pilot
evidence of 2026-09-30 (`study/pilot/`). **Nothing here has been posted.**
Shiv decides whether each one is posted, and posts it under his own name;
no agent posts, comments or files anything.

Each draft lists what must be true before it is posted. Every one of them
rests on pilot data (n = 1 per case, Windows only) and says so; a draft
whose precondition is not met stays a draft.

| Draft | Where it would go | Kind | Before posting |
|---|---|---|---|
| [`codex-41499.md`](codex-41499.md) | openai/codex#41499 | comment | the Linux column of the same renders (a POSIX path, as in the report); the renders re-run with their command lines recorded |
| [`codex-34193.md`](codex-34193.md) | openai/codex#34193 | comment | one render on the current Codex release; the issue still open |
| [`gemini-order-inversion.md`](gemini-order-inversion.md) | google-gemini/gemini-cli | new issue | one end-to-end run through the CLI binary (the pilot called the library functions only); a search for an existing issue; the source permalink pinned |
| [`opencode-stacking.md`](opencode-stacking.md) | anomalyco/opencode | new issue | the docs page and the source comment re-read on the day; the capture re-run on the current release; the source permalink pinned; a search for an existing issue |

Wording rules (the same as the study's, `study/PREREG.md` section 10):

- Codex results read "as rendered by `codex debug prompt-input` <version>;
  the model was not run".
- #41499 reads "not reproduced on Windows 0.159.2 with a key form shown to
  apply", never "cannot reproduce" or "not a bug".
- Every claim carries its version, operating system and date, and its n.
- Placeholders are written `<<LIKE THIS>>` and must all be filled or the
  sentence removed before posting.
