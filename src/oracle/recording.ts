/**
 * A verify run on disk: `manifest.json` plus, per trial, the agent's own
 * output (a Codex render as JSON, or a Claude capture as JSONL beside the
 * stream-json the CLI printed). It holds everything `verify --replay` needs
 * to score the run again, on any machine, without the copy or the agent.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RecordingError } from "../probe/recording.js";

export const VERIFY_SCHEMA = "ctxreach.verify-recording/v1";
export const VERIFY_MANIFEST = "manifest.json";

const DeliveryJson = z.enum(["launch", "launch-cut", "import", "on-read", "maybe", "not-loaded", "decoy"]);

/** Like the probe's canary, but the token's hex may be upper case (the pilot bodies were planted by hand). */
export const OracleCanaryJson = z.object({
  token: z.string().regex(/^CTXR-[0-9a-fA-F]{8}$/),
  file: z.string(),
  position: z.enum(["head", "tail"]),
  offset: z.number().int().nonnegative(),
  decoy: z.boolean().optional(),
  scoped: z.boolean().optional(),
});

export const PredictedJson = z.object({
  file: z.string(),
  delivery: DeliveryJson,
  why: z.string(),
  rule: z.string(),
  cutAt: z.number().int().optional(),
  needsApproval: z.boolean().optional(),
  notModelled: z.boolean().optional(),
});

export const ChainPieceJson = z.object({
  file: z.string(),
  bytes: z.number().int().nonnegative(),
  keptBytes: z.number().int().nonnegative(),
  status: z.enum(["loaded", "cut", "no-budget", "empty", "global"]),
  text: z.string(),
  head: z.string(),
});

export const VerifyTrialJson = z.object({
  trial: z.number().int().positive(),
  /** Files in the recording directory, e.g. `trial-1.render.json` or `trial-1.capture.jsonl` and `trial-1.stdout.jsonl`. */
  files: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  stderr: z.string(),
  warnings: z.array(z.string()),
});

export const VerifyManifestJson = z.object({
  schema: z.literal(VERIFY_SCHEMA),
  ctxreach: z.string(),
  agent: z.enum(["codex", "claude"]),
  instrument: z.enum(["render", "capture"]),
  cliVersion: z.string(),
  os: z.object({ platform: z.string(), release: z.string(), arch: z.string() }),
  startedAt: z.string(),
  /** The copy's path as it appears in the trial files (a placeholder). */
  repo: z.string(),
  /** Launch directory relative to the copy, forward slashes. */
  launchDir: z.string(),
  sourceName: z.string(),
  trialsPlanned: z.number().int().positive(),
  args: z.array(z.string()),
  prompt: z.string(),
  /** The fresh token in the prompt that every trial must repeat. */
  controlToken: z.string().regex(/^CTXR-[0-9a-fA-F]{8}$/),
  canaries: z.array(OracleCanaryJson),
  predicted: z.array(PredictedJson),
  outside: z.array(z.object({ file: z.string(), delivery: DeliveryJson, why: z.string() })),
  unplanted: z.array(z.object({ file: z.string(), why: z.string() })),
  sandbox: z.object({ stripped: z.array(z.string()), skipped: z.array(z.string()), links: z.array(z.string()) }),
  /** Conditions of the run stated for the reader (where the copy lives, what the user's home holds). */
  notes: z.array(z.string()),
  /** False when the copy's files were left as they are (Codex, `--no-plant`): only the decoy and the prompt token were used. Absent means true. */
  planted: z.boolean().optional(),
  codex: z
    .object({
      /** The throwaway home, as a placeholder path. */
      codexHome: z.string(),
      seeded: z.object({
        from: z.string().optional(),
        keys: z.array(z.string()),
        globalFiles: z.array(z.string()),
        trust: z.string(),
        trustFrom: z.string(),
      }),
      projectConfigs: z.array(z.object({ file: z.string(), keys: z.array(z.string()) })),
      hooksFlag: z.enum(["accepted", "rejected"]).optional(),
      overrides: z.array(z.string()),
      /** map's predicted chain, with the text each file should contribute. */
      chain: z.array(ChainPieceJson),
      /** A `--codex-max-bytes` given to map only (the planted-fault pass). */
      mapMaxBytes: z.number().int().optional(),
    })
    .optional(),
  claude: z
    .object({
      configDir: z.string().optional(),
      home: z.string().optional(),
      model: z.string(),
      settingsFile: z.string().optional(),
      removedEnv: z.array(z.string()),
      /** The Project instructions mode map modelled. */
      mode: z.string(),
      /** A `--claude-mode` given to map only (the planted-fault pass). */
      mapMode: z.string().optional(),
    })
    .optional(),
  trials: z.array(VerifyTrialJson),
});

export type VerifyManifest = z.infer<typeof VerifyManifestJson>;
export type VerifyTrial = z.infer<typeof VerifyTrialJson>;
export type OracleCanary = z.infer<typeof OracleCanaryJson>;

export function writeVerifyManifest(dir: string, manifest: VerifyManifest): void {
  writeFileSync(path.join(dir, VERIFY_MANIFEST), JSON.stringify(VerifyManifestJson.parse(manifest), null, 2) + "\n");
}

export interface VerifyTrialFiles {
  /** `trial-N.render.json` (Codex). */
  render?: string;
  /** `trial-N.capture.jsonl` (Claude): the recorder's records. */
  capture?: string;
  /** `trial-N.stdout.jsonl` (Claude): the CLI's stream-json. */
  stdout?: string;
}

export interface VerifyRecording {
  dir: string;
  manifest: VerifyManifest;
  /** Per trial, in trial order; a missing file is left undefined. */
  trials: VerifyTrialFiles[];
}

export function readVerifyRecording(dir: string): VerifyRecording {
  const file = path.join(dir, VERIFY_MANIFEST);
  if (!existsSync(file)) throw new RecordingError(`${dir} has no ${VERIFY_MANIFEST}; is it a verify recording?`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new RecordingError(`${file}: not valid JSON (${(err as Error).message})`);
  }
  const parsed = VerifyManifestJson.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RecordingError(`${file}: ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? "invalid"}`);
  }
  const manifest = parsed.data;
  const trials = manifest.trials.map((t) => {
    const out: VerifyTrialFiles = {};
    for (const name of t.files) {
      if (path.isAbsolute(name) || name.split(/[\\/]/).includes(".."))
        throw new RecordingError(`${file}: trial file ${name} must be inside the recording`);
      const p = path.join(dir, name);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      if (name.endsWith(".render.json")) out.render = text;
      else if (name.endsWith(".capture.jsonl")) out.capture = text;
      else if (name.endsWith(".stdout.jsonl")) out.stdout = text;
    }
    return out;
  });
  return { dir, manifest, trials };
}
