export type AgentId = "codex" | "claude";

export type Severity = "warn" | "info";

/**
 * Something `map` wants a person to look at. `rule` is the id of the loading
 * rule in docs/rules.md that produced it, so every finding can be traced
 * back to its source.
 */
export interface Finding {
  code: string;
  severity: Severity;
  agent: AgentId;
  rule: string;
  /** Absolute path of the file the finding is about, when there is one. */
  path?: string;
  message: string;
}

/** Where a byte budget cut a file (rule `codex.cut`). */
export interface Cut {
  /** Bytes kept; the first byte the agent never sees is at this offset. */
  at: number;
  /** 1-based line and byte column of the first byte lost. */
  line: number;
  column: number;
  /** The cut splits a multi-byte UTF-8 character, so the agent sees U+FFFD in its place. */
  midCodepoint: boolean;
  /** The section the cut falls in, if the file has headings before it. */
  cutSection?: string;
  /** Sections that start at or after the cut and never reach the agent. */
  lostSections: string[];
}

/**
 * How an agent is predicted to receive one file.
 *
 * - `launch`: loaded in full when the session starts.
 * - `launch-cut`: loaded when the session starts, but cut short.
 * - `import`: loaded at launch through an `@path` import in another file.
 * - `on-read`: loaded later, when the agent reads a file in that directory.
 * - `maybe`: not loaded by the agent itself; the model may choose to open it.
 * - `not-loaded`: never loaded (shadowed, out of budget, not a file this agent reads, ...).
 */
export type Delivery = "launch" | "launch-cut" | "import" | "on-read" | "maybe" | "not-loaded";

export interface Reach {
  path: string;
  delivery: Delivery;
  /** Short reason, e.g. "shadowed by AGENTS.override.md". */
  why: string;
  rule: string;
  cut?: Cut;
}
