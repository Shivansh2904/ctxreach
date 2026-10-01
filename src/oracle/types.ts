/**
 * Types shared by `ctxreach verify` and its two oracles.
 *
 * An oracle shows what an agent's own machinery delivers to its model, at no
 * cost and with no login:
 *
 * - `render`: Codex's `codex debug prompt-input` prints the model-visible
 *   input as JSON. The `AGENTS.md` block in it is byte-exact. The model is
 *   never run.
 * - `capture`: Claude Code is pointed, through `ANTHROPIC_BASE_URL`, at a
 *   loopback server that records the request and answers 400. The
 *   instruction files arrive in the request body. This is the gateway path
 *   to the model endpoint, not a first-party session.
 *
 * Both plant the same tokens as `ctxreach probe` (see `probe/canary.ts`) and
 * score them with the probe's vocabulary (see `probe/compare.ts`), so a
 * `verify` cell and a `probe` cell read the same way.
 */
import type { AgentId } from "../agents/types.js";

export type OracleAgent = AgentId;
export type Instrument = "render" | "capture";

/** The verify command was asked for something it cannot do (a usage or configuration problem; exit 2). */
export class OracleError extends Error {}

/** An agent's output does not have the shape the oracle expects. The message names the JSON path. */
export class RenderShapeError extends Error {
  constructor(
    readonly jsonPath: string,
    message: string,
  ) {
    super(`${jsonPath}: ${message}`);
  }
}

/** One file of a predicted Codex chain, with the text the render should hold for it. */
export interface ChainPiece {
  /** Relative to the copy, forward slashes; the global file is `$CODEX_HOME/<name>`. */
  file: string;
  /** Whole file, in bytes. */
  bytes: number;
  /** Bytes `map` says Codex keeps (0 when not read, or empty). */
  keptBytes: number;
  status: "loaded" | "cut" | "no-budget" | "empty" | "global";
  /** The kept bytes decoded as Codex decodes them (lossy UTF-8), or "" when nothing is kept. */
  text: string;
  /** The first bytes of the whole file, decoded, so an unexpected delivery can be spotted. */
  head: string;
}

export type SegmentVerdict = "EXACT" | "OFF BY" | "MISSING" | "EXTRA";

/** What the render held for one predicted chain file. */
export interface Segment {
  file: string;
  status: ChainPiece["status"];
  bytes: number;
  /** Bytes `map` predicted Codex keeps. */
  predictedBytes: number;
  /** Decoded bytes the render held for this file. */
  observedBytes: number;
  verdict: SegmentVerdict;
  /** For OFF BY: observed minus predicted, in decoded bytes. */
  offBy?: number;
  note?: string;
}

/** One file that a Claude capture body carried, as the `<system-reminder>` labels it. */
export interface DeliveredFile {
  /** The absolute path as sent (already redacted in a recording). */
  path: string;
  /** The label in parentheses, e.g. `project instructions, checked into the codebase`. */
  label: string;
  text: string;
}

/** The lines every verify report carries, so nobody reads a render or a capture as a model turn. */
export function honestWording(instrument: Instrument, version: string): string[] {
  if (instrument === "render")
    return [
      `Codex's model input as rendered by \`codex debug prompt-input\` ${version}. The model was not run.`,
      "This shows what Codex sends, not what the model does with it.",
    ];
  return [
    `Delivery to the model endpoint (custom base URL) by Claude Code ${version}; the request was answered 400 and no model ran.`,
    "This is the gateway path. First-party equivalence is measured separately (paired billed runs), not here.",
  ];
}
