/**
 * Interfaces for the planned `ctxreach probe` command. Nothing in this file
 * runs an agent, and nothing imports it yet.
 *
 * `map` predicts from documented rules. `probe` will check those predictions
 * against the real agents: copy the repository to a temporary directory, plant
 * a random token at the head and tail of each instruction file (and in each
 * section), run each agent headless and read-only, and record which tokens
 * the agent can repeat and how it got them.
 *
 * Safety requirements the implementation must meet (see docs/rules.md,
 * rules `claude.bare` and `claude.hook-blind`):
 * - Work only on the temporary copy; never write to the user's repository.
 * - Remove project hooks, `.mcp.json` and project agent config from the copy
 *   before any run, because `claude -p` runs project hooks and MCP servers
 *   even in an untrusted folder.
 * - Run Codex with a read-only sandbox, and Claude Code with only read tools
 *   allowed. Do not use `--bare`, which skips CLAUDE.md.
 * - Never copy or move credentials; use whatever login the CLI already has.
 */
import type { AgentId, Delivery } from "../agents/types.js";

/** A token planted in one place in one instruction file. */
export interface Canary {
  /** Random, e.g. `CTXR-3f9a1c07`, matched exactly. */
  token: string;
  /** Path of the file relative to the repository root. */
  file: string;
  position: "head" | "tail" | "section";
  /** For `section` canaries, the heading of the section. */
  section?: string;
  /** Byte offset in the original file where the token was planted. */
  offset: number;
}

/**
 * How a canary reached the agent in one trial.
 *
 * - `preloaded`: echoed without the agent having opened the file itself.
 * - `self-discovered`: echoed only after a tool call touched the file.
 * - `not-seen`: never echoed.
 * - `contaminated`: the trial used tools where it was asked not to, so it
 *   cannot say anything about preloading.
 */
export type Observation = "preloaded" | "self-discovered" | "not-seen" | "contaminated";

/** How an observation compares with what `map` predicted for that file. */
export type Verdict = "confirmed" | "missed" | "extra" | "discovered";

export interface TrialResult {
  agent: AgentId;
  /** Launch directory relative to the repository root. */
  launchDir: string;
  trial: number;
  /** The agent CLI's own version string; every result is stamped with it. */
  cliVersion: string;
  observations: { canary: Canary; seen: Observation }[];
  /** Where the raw transcript was saved, so a result can be re-scored later. */
  transcriptPath: string;
}

export interface CellComparison {
  file: string;
  agent: AgentId;
  predicted: Delivery;
  /** Counts over trials, reported as fractions ("2/3"), never percentages. */
  seen: Record<Observation, number>;
  trials: number;
  verdict: Verdict;
}

/** One agent CLI, driven headless. */
export interface AgentAdapter {
  id: AgentId;
  /** The CLI's version string, e.g. from `codex --version`. */
  version(): Promise<string>;
  /** Run one read-only headless session in `workdir` and save its transcript. */
  run(options: { workdir: string; prompt: string; timeoutMs: number }): Promise<{ transcriptPath: string }>;
  /** Read a saved transcript: what the model wrote, and which files it opened itself. */
  parse(transcriptPath: string): Promise<{ output: string; filesRead: string[]; toolCalls: number }>;
}
