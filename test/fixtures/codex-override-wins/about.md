Trap: packages/api has both AGENTS.override.md and AGENTS.md. Codex takes one file per directory and the override wins, so packages/api/AGENTS.md is never read (rule codex.one-per-dir).
