export { map, findRepoRoot, type MapOptions, type MapResult } from "./map/map.js";
export { buildMatrix, type MatrixCell, type MatrixRow } from "./map/matrix.js";
export { resolveCodex, codexReach, type CodexResult, type CodexChainEntry } from "./agents/codex/resolve.js";
export { resolveCodexSettings, type CodexSettings, type TrustLevel } from "./agents/codex/config.js";
export { resolveClaude, type ClaudeResult, type ClaudeFile } from "./agents/claude/resolve.js";
export { CLAUDE_MODES, type ClaudeMode } from "./agents/claude/settings.js";
export { discoverSurfaces, type Surface, type SurfaceKind } from "./discover/surfaces.js";
export { toJson, MapJson } from "./report/json.js";
export { renderTerminal } from "./report/terminal.js";
export { ConfigError } from "./util/errors.js";
export type { AgentId, Cut, Delivery, Finding, Reach, Severity } from "./agents/types.js";
export type * from "./probe/types.js";
export { TranscriptError, SafetyError } from "./probe/types.js";
export { runProbe, type ProbeOptions } from "./probe/probe.js";
export { readRecording, type Recording, type Manifest } from "./probe/recording.js";
export { scoreRecording, type ProbeResult, type CellScore, type TrialScore } from "./probe/score.js";
export { claudeAdapter, type ClaudeAdapterOptions } from "./agents/claude/adapter.js";
export { probeJson, renderProbe, ProbeJson } from "./report/probe.js";
export { runVerify, scoreVerify, agrees, DEFAULT_TRIALS, type VerifyOptions } from "./oracle/verify.js";
export {
  readVerifyRecording,
  VERIFY_SCHEMA,
  type VerifyRecording,
  type VerifyManifest,
  type VerifyTrial,
} from "./oracle/recording.js";
export type { VerifyResult, OracleScore, OracleCell, OracleTrialScore } from "./oracle/score.js";
export { renderVerify, verifyJson, VerifyJson } from "./report/verify.js";
export { startCapture, type CaptureServer, type CaptureRecord, type CaptureOptions } from "./oracle/capture.js";
export {
  renderCodex,
  parseRender,
  promptInputRenderer,
  type Renderer,
  type RenderRequest,
  type RenderOutcome,
  type ParsedRender,
} from "./oracle/codex-render.js";
export { reduceCaptureBody, parseCaptureBody, type CaptureBody } from "./oracle/claude-capture.js";
export {
  OracleError,
  RenderShapeError,
  type OracleAgent,
  type Instrument,
  type Segment,
  type SegmentVerdict,
} from "./oracle/types.js";
export { registerVerify, type VerifyCommandOptions } from "./cli/commands/verify.js";
