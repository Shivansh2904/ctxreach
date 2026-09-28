/**
 * A probe run on disk: `manifest.json` plus one transcript per trial. It
 * holds everything needed to score the run again later (`probe --replay`),
 * on any machine, without the temporary copy or the agent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const RECORDING_SCHEMA = "ctxreach.probe-recording/v1";
export const MANIFEST = "manifest.json";

const DeliveryJson = z.enum(["launch", "launch-cut", "import", "on-read", "maybe", "not-loaded", "decoy"]);

export const CanaryJson = z.object({
  token: z.string().regex(/^CTXR-[0-9a-f]{8}$/),
  file: z.string(),
  position: z.enum(["head", "tail"]),
  offset: z.number().int().nonnegative(),
  decoy: z.boolean().optional(),
  scoped: z.boolean().optional(),
});

export const TrialJson = z.object({
  trial: z.number().int().positive(),
  transcript: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stderr: z.string(),
  durationMs: z.number().int().nonnegative(),
  leftovers: z.array(z.string()),
});

export const ManifestJson = z.object({
  schema: z.literal(RECORDING_SCHEMA),
  ctxreach: z.string(),
  agent: z.enum(["claude", "codex"]),
  cliVersion: z.string(),
  os: z.object({ platform: z.string(), release: z.string(), arch: z.string() }),
  startedAt: z.string(),
  mode: z.enum(["recall", "task"]),
  trialsPlanned: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  /** Absolute path of the copy as it appears in the transcripts (a placeholder). */
  repo: z.string(),
  /** Launch directory relative to the copy, forward slashes. */
  launchDir: z.string(),
  /** Name of the directory that was copied (its path is not recorded). */
  sourceName: z.string(),
  args: z.array(z.string()),
  prompt: z.string(),
  canaries: z.array(CanaryJson),
  predicted: z.array(
    z.object({
      file: z.string(),
      delivery: DeliveryJson,
      why: z.string(),
      rule: z.string(),
      cutAt: z.number().int().optional(),
      needsApproval: z.boolean().optional(),
      notModelled: z.boolean().optional(),
    }),
  ),
  /** Instruction files outside the copy that map says also reach the agent (redacted paths). */
  outside: z.array(z.object({ file: z.string(), delivery: DeliveryJson, why: z.string() })),
  /** Files in the copy that map lists but that were not planted, and why. */
  unplanted: z.array(z.object({ file: z.string(), why: z.string() })),
  sandbox: z.object({
    stripped: z.array(z.string()),
    skipped: z.array(z.string()),
    /** How each link in the repository was copied (the copy holds none). Absent in older recordings. */
    links: z.array(z.string()).optional(),
  }),
  environment: z.object({ bare: z.boolean(), removedEnv: z.array(z.string()), notes: z.array(z.string()) }),
  claudeMode: z.string().optional(),
  trials: z.array(TrialJson),
});

export type Manifest = z.infer<typeof ManifestJson>;
export type TrialRecord = z.infer<typeof TrialJson>;

export class RecordingError extends Error {}

export function writeManifest(dir: string, manifest: Manifest): void {
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify(ManifestJson.parse(manifest), null, 2) + "\n");
}

export interface Recording {
  dir: string;
  manifest: Manifest;
  /** Transcript text per trial, in trial order; undefined when the file is missing. */
  transcripts: (string | undefined)[];
}

export function readRecording(dir: string): Recording {
  const file = path.join(dir, MANIFEST);
  if (!existsSync(file)) throw new RecordingError(`${dir} has no ${MANIFEST}; is it a probe recording?`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RecordingError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  const parsed = ManifestJson.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RecordingError(`${file}: ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"}`);
  }
  const manifest = parsed.data;
  const transcripts = manifest.trials.map((t) => {
    if (path.isAbsolute(t.transcript) || t.transcript.split(/[\\/]/).includes(".."))
      throw new RecordingError(`${file}: transcript path ${t.transcript} must be inside the recording`);
    const p = path.join(dir, t.transcript);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  });
  return { dir, manifest, transcripts };
}
