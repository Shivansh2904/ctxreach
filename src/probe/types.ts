/**
 * Types shared by `ctxreach probe` and the agent adapters.
 *
 * `map` predicts from documented rules. `probe` checks those predictions
 * against a real agent: it copies the repository to a temporary directory,
 * plants a random token at the head and tail of each instruction file (and in
 * a decoy file that no rule loads), runs the agent headless and read-only,
 * and records which tokens the agent repeats and how it got them.
 *
 * Nothing here depends on a particular agent. An adapter turns one agent's
 * CLI and transcript format into the `Transcript` shape below, and the
 * classifier and the comparison work only on that shape.
 */
import type { AgentId, Delivery } from "../agents/types.js";

/**
 * - `recall`: every tool is turned off and the agent is asked to list the
 *   tokens in its instructions. Measures what is preloaded.
 * - `task`: only read tools are allowed, and the agent is given a read-only
 *   request. Measures what it receives, or finds, while working.
 */
export type ProbeMode = "recall" | "task";

/** A token planted in one place in one file. */
export interface Canary {
  /** Random, `CTXR-` and 8 hex digits, matched exactly. */
  token: string;
  /** Path of the file relative to the repository root, with forward slashes. */
  file: string;
  position: "head" | "tail";
  /** Byte offset of the token in the planted file. */
  offset: number;
  /** True for the control file that no documented rule loads. */
  decoy?: boolean;
  /**
   * True for a Claude Code rule file (under `.claude/rules/`) whose front
   * matter declares `paths`: it loads when a matching file is read, so a read
   * anywhere in the tree it covers can deliver it. Read from the file when it
   * is planted, not from map's prediction.
   */
  scoped?: boolean;
}

/**
 * How one canary reached the agent in one trial.
 *
 * - `preloaded`: repeated, and no tool call touched its file or (for a file
 *   below the launch directory) its directory before the repeat.
 * - `on-read`: repeated after a tool call touched a path in the file's
 *   directory, below the launch directory, but not the file itself. This is
 *   how Claude Code delivers a subdirectory's instruction files, and its
 *   stream shows no trace of the delivery, so the probe can only infer it.
 * - `self-discovered`: repeated after a tool call named the file itself, or
 *   after the token appeared in a tool's output.
 * - `not-seen`: never repeated.
 * - `contaminated`: the trial used a tool it was not allowed to use, so it
 *   says nothing about this canary.
 */
export type Observation = "preloaded" | "on-read" | "self-discovered" | "not-seen" | "contaminated";

/** Observations that come from a usable trial. */
export type UsableObservation = Exclude<Observation, "contaminated">;

/**
 * What `map` predicts for one canary, reduced to what a probe can observe.
 *
 * - `launch`: in the agent's context from the start.
 * - `on-read`: loaded by the agent when it reads a file in that directory.
 * - `on-match`: loaded when the agent reads a file that matches the file's
 *   own `paths` (Claude Code rules). ctxreach does not model which files
 *   match, so this is only ever checked one way: it must not be preloaded.
 * - `not-preloaded`: not loaded by the agent; the model may open it.
 * - `never`: not loaded at all (switched off, out of budget, past the cut,
 *   not a file this agent reads, or the decoy).
 */
export type Expectation = "launch" | "on-read" | "on-match" | "not-preloaded" | "never";

/**
 * - `confirmed`: the observation agrees with the prediction.
 * - `missed`: predicted to arrive (at launch, or on a read that happened),
 *   but not seen in every usable trial.
 * - `extra`: arrived by the agent's own loading where `map` predicted it
 *   would not.
 * - `discovered`: not predicted to arrive, but the model opened the file
 *   itself (task mode). Consistent with the prediction, which is about what
 *   the agent loads, not what the model reads.
 * - `untested`: predicted on read, but no trial read a file in its directory
 *   (or, for `on-match`, it did not arrive, which a non-matching read explains).
 * - `no-data`: no usable trial.
 */
export type Verdict = "confirmed" | "missed" | "extra" | "discovered" | "untested" | "no-data";

/** A step in an agent's transcript, in stream order, in a form every adapter can produce. */
export type TranscriptItem =
  | { kind: "text"; text: string }
  | { kind: "tool-use"; id: string; name: string; input: unknown }
  | { kind: "tool-result"; toolUseId: string; text: string; isError: boolean };

export type ToolUse = Extract<TranscriptItem, { kind: "tool-use" }>;

export interface Transcript {
  items: TranscriptItem[];
  /** The agent's own version string, from the transcript. */
  cliVersion?: string;
  model?: string;
  /** Tools the agent says it has in this session. */
  toolsOffered?: string[];
  /** Working directory the agent reports. */
  cwd?: string;
  /** A final result event arrived. */
  finished: boolean;
  isError: boolean;
  /** The final answer, when the agent reports one separately from its messages. */
  finalText?: string;
  events: {
    total: number;
    byType: Record<string, number>;
    /** Event types (and content block types) the parser does not know. Tolerated, but counted. */
    unknown: Record<string, number>;
  };
}

/** A string to replace in a saved transcript, so it can be shared and replayed elsewhere. */
export interface Redaction {
  from: string;
  to: string;
}

/** How the agent process ended. */
export interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  /** First part of stderr, if any. */
  stderr: string;
  durationMs: number;
  /** Things the run left outside the sandbox that ctxreach could not remove. */
  leftovers: string[];
}

export interface RunRequest {
  /** Directory to launch the agent in; must be inside a probe sandbox. */
  workdir: string;
  prompt: string;
  mode: ProbeMode;
  timeoutMs: number;
  /** Where to save the transcript (redacted). */
  transcriptPath: string;
  redactions: Redaction[];
}

/** Settings in the environment that change what the agent loads, as far as ctxreach can tell. */
export interface AgentEnvironment {
  /** A setting that skips instruction files entirely (Claude Code's bare mode) is in effect. */
  bare: boolean;
  /** Variables removed from the agent's environment, by name (values are never recorded). */
  removedEnv: string[];
  notes: string[];
}

/** One agent CLI, driven headless and read-only. */
export interface AgentAdapter {
  id: AgentId;
  title: string;
  /** Tools allowed in task mode. Any other tool use marks the trial contaminated. */
  readTools: readonly string[];
  /** The CLI's version, e.g. `2.1.280`. */
  version(): Promise<string>;
  /** Arguments passed to the CLI for a mode. The prompt goes to stdin, not here. */
  args(mode: ProbeMode): string[];
  environment(): AgentEnvironment;
  /** Run one session and save its transcript. */
  run(request: RunRequest): Promise<RunOutcome>;
  /** Read a saved transcript. Throws `TranscriptError` when it does not match the expected format. */
  parse(text: string): Transcript;
  /** Paths a tool call read as whole files (what triggers on-read loading). */
  fileReads(call: ToolUse): string[];
}

/** A transcript line does not match the format the adapter expects. */
export class TranscriptError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
  }
}

/** The probe refused to do something unsafe (for example, run an agent outside its temporary copy). */
export class SafetyError extends Error {}

/** What map predicts for one file, kept with the run so replays do not need the copy. */
export interface PredictedFile {
  /** Relative to the repository root, forward slashes. */
  file: string;
  delivery: Delivery | "decoy";
  why: string;
  rule: string;
  /** For a file cut short: bytes kept. */
  cutAt?: number;
  /** An import from outside the launch directory, which loads only once external imports are approved. */
  needsApproval?: boolean;
}
