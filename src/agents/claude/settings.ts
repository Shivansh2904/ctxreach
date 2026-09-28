import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ConfigError } from "../../util/errors.js";

export const CLAUDE_MODES = ["claude-md-or-agents-md", "claude-md-and-agents-md", "claude-md", "managed-only"] as const;
export type ClaudeMode = (typeof CLAUDE_MODES)[number];
export const CLAUDE_DEFAULT_MODE: ClaudeMode = "claude-md-or-agents-md";

/** The plugin id under which the Project instructions setting lives (rule `claude.modes`). */
export const AGENTS_MD_PLUGIN = "agents-md@builtin";

// Only the agents-md plugin's entry is checked. Other plugins' configs can
// have any shape, and must never stop map from running.
const Settings = z.looseObject({
  pluginConfigs: z
    .looseObject({
      [AGENTS_MD_PLUGIN]: z
        .looseObject({
          options: z.looseObject({ instructionFiles: z.enum(CLAUDE_MODES).optional() }).optional(),
        })
        .optional(),
    })
    .optional(),
});

export function defaultClaudeHome(): string {
  return path.join(os.homedir(), ".claude");
}

/** The Project instructions value set in a settings file, if any. Throws ConfigError on a malformed file. */
export function modeInSettings(file: string): ClaudeMode | undefined {
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  const parsed = Settings.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`${file}: ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data.pluginConfigs?.[AGENTS_MD_PLUGIN]?.options?.instructionFiles;
}

/** Compare dotted versions numerically: negative when a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
