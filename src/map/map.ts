import { existsSync } from "node:fs";
import path from "node:path";
import { resolveClaude, type ClaudeResult } from "../agents/claude/resolve.js";
import type { ClaudeMode } from "../agents/claude/settings.js";
import type { TrustLevel } from "../agents/codex/config.js";
import { resolveCodex, type CodexResult } from "../agents/codex/resolve.js";
import type { AgentId, Finding } from "../agents/types.js";
import { buildMatrix, type MatrixRow } from "./matrix.js";

export interface MapOptions {
  /** Directory the agent is launched in. */
  launchDir: string;
  /** Directory scanned for instruction files. Defaults to the nearest ancestor holding `.git`, else the launch directory. */
  repoRoot?: string;
  agents?: AgentId[];
  codex?: {
    home?: string;
    maxBytes?: number;
    trust?: TrustLevel;
  };
  claude?: {
    home?: string;
    homeDir?: string;
    mode?: ClaudeMode;
    version?: string;
    /** Stop the upward walk here (tests). */
    ceiling?: string;
  };
}

export interface MapResult {
  launchDir: string;
  repoRoot: string;
  codex?: CodexResult;
  claude?: ClaudeResult;
  matrix: MatrixRow[];
  findings: Finding[];
}

export function findRepoRoot(start: string): string | undefined {
  let cursor = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(cursor, ".git"))) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

/** Predict, for each requested agent, which instruction files reach it from `launchDir`. */
export function map(options: MapOptions): MapResult {
  const launchDir = path.resolve(options.launchDir);
  const repoRoot = path.resolve(options.repoRoot ?? findRepoRoot(launchDir) ?? launchDir);
  const agents = options.agents ?? ["codex", "claude"];
  const result: MapResult = { launchDir, repoRoot, matrix: [], findings: [] };

  if (agents.includes("codex")) {
    const c = options.codex ?? {};
    result.codex = resolveCodex({
      launchDir,
      scanRoot: repoRoot,
      ...(c.home !== undefined ? { codexHome: c.home } : {}),
      ...(c.maxBytes !== undefined ? { maxBytesOverride: c.maxBytes } : {}),
      ...(c.trust !== undefined ? { trustOverride: c.trust } : {}),
    });
    result.findings.push(...result.codex.findings);
  }
  if (agents.includes("claude")) {
    const c = options.claude ?? {};
    result.claude = resolveClaude({
      launchDir,
      scanRoot: repoRoot,
      ...(c.home !== undefined ? { claudeHome: c.home } : {}),
      ...(c.homeDir !== undefined ? { homeDir: c.homeDir } : {}),
      ...(c.mode !== undefined ? { mode: c.mode } : {}),
      ...(c.version !== undefined ? { version: c.version } : {}),
      ...(c.ceiling !== undefined ? { ceiling: c.ceiling } : {}),
    });
    result.findings.push(...result.claude.findings);
  }
  result.matrix = buildMatrix(result);
  return result;
}
