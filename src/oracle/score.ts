/**
 * Score a verify recording: per trial, check the instrument; per planted
 * token, compare what the oracle delivered with what `map` predicted.
 *
 * The vocabulary is the probe's (`probe/compare.ts`): a token found in the
 * delivered text counts as `preloaded`, one not found as `not-seen`, and
 * `verdictFor` in recall mode turns that into CONFIRMED, MISSED, EXTRA or
 * NOT MODELLED. A live run and `verify --replay` both end here.
 *
 * Two controls void a run (the whole run is an instrument fault):
 * - the must-appear token: the fresh token in the prompt must be in the
 *   last user message of every trial (V10: a 9-character regex once scored
 *   every token absent, and this token showed it);
 * - the decoy: a file no rule loads must never be delivered.
 *
 * Tokens are matched exactly: the planted string, not a pattern over the
 * text, and never followed by another hex digit.
 */
import { AGREEING, countSeen, DECIDED, expectationFor, verdictFor } from "../probe/compare.js";
import { recordedPaths } from "../probe/paths.js";
import type { Canary, Expectation, PredictedFile, Verdict } from "../probe/types.js";
import type { VerifyManifest } from "./recording.js";
import type { DeliveredFile, Segment } from "./types.js";

/** A scored verify run: what a live run and `verify --replay` both produce. */
export interface VerifyResult {
  manifest: VerifyManifest;
  recordingDir: string;
  score: OracleScore;
  /** Codex: the per-file byte comparison of the first usable render (every usable render is identical, or the run is a fault). */
  segments: Segment[];
  /** Codex: the whole rendered body equalled `map`'s prediction. */
  whole?: boolean;
  /** Claude: the files the first usable capture carried. */
  delivered: DeliveredFile[];
  /** The scope lines every report carries. */
  wording: string[];
}

/** The canary form: `CTXR-` and 8 hex digits (case-insensitive, for hand-planted pilot tokens). */
export const TOKEN_PATTERN = /^CTXR-[0-9a-f]{8}$/i;
/** Tokens of the canary form anywhere in a text, to find ones that were never planted. */
const ANY_TOKEN = /CTXR-[0-9a-fA-F]{8}(?![0-9a-fA-F])/g;

/** True when the exact token is in `text`, not as the prefix of a longer hex run. */
export function tokenPresent(text: string, token: string): boolean {
  if (!TOKEN_PATTERN.test(token)) return false;
  let from = 0;
  for (;;) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    const next = text.charAt(at + token.length);
    if (!/[0-9a-fA-F]/.test(next)) return true;
    from = at + 1;
  }
}

/** Tokens of the canary form in `text` that are not in `planted`. */
export function inventedTokens(text: string, planted: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ANY_TOKEN)) if (!planted.has(m[0])) out.add(m[0]);
  return [...out].sort();
}

/** A check the caller made on one trial (a session assert), with its outcome. */
export interface TrialCheck {
  ok: boolean;
  /** Why it failed, for the report. */
  reason: string;
}

/** What one trial delivered, as the caller read it from the trial's files. */
export interface TrialEvidence {
  trial: number;
  /** The trial did not run to a usable output (the agent failed before delivering anything); excluded, not a fault. */
  failed?: string;
  /** The delivered text the planted tokens are looked for in (the AGENTS block, or every delivered file's text). */
  delivered: string;
  /** Where the must-appear token must be (the last user message, or the whole request). */
  controlText: string;
  /** The working directory the agent reported, as recorded (compared with the launch directory). */
  cwd?: string;
  checks: TrialCheck[];
  /** Things the reader should know about this trial that are not faults (for example, a pilot recording with no session stream). */
  notes?: string[];
  /** Codex only: per-file byte comparison. */
  segments?: Segment[];
}

export interface OracleTrialScore {
  trial: number;
  status: "usable" | "fault" | "failed";
  reasons: string[];
  controlSeen: boolean;
  /** Decoy tokens found in the delivered text. */
  decoySeen: string[];
  inventedTokens: string[];
  segments?: Segment[];
}

export interface OracleCell {
  token: string;
  file: string;
  position: "head" | "tail";
  decoy: boolean;
  predicted: PredictedFile;
  expected: Expectation;
  /** Usable trials in which the token was delivered. */
  seen: number;
  usable: number;
  verdict: Verdict;
}

export interface OracleScore {
  trials: OracleTrialScore[];
  cells: OracleCell[];
  instrument: {
    fault: boolean;
    reasons: string[];
    control: { seen: number; usable: number };
    decoy: { seen: number; usable: number };
  };
  agreement: { agree: number; decided: number; cells: number; byVerdict: Record<Verdict, number> };
  warnings: string[];
}

function predictionFor(manifest: Pick<VerifyManifest, "predicted">, canary: Canary): PredictedFile {
  if (canary.decoy) return { file: canary.file, delivery: "decoy", why: "decoy: no rule loads it", rule: "decoy" };
  return (
    manifest.predicted.find((f) => f.file === canary.file) ?? {
      file: canary.file,
      delivery: "not-loaded",
      why: "map made no prediction for this file",
      rule: "none",
    }
  );
}

const pct = (k: number, n: number) => `${k}/${n}`;

export function scoreTrials(
  manifest: Pick<VerifyManifest, "canaries" | "predicted" | "controlToken" | "repo" | "launchDir" | "planted">,
  evidence: readonly TrialEvidence[],
): OracleScore {
  const p = recordedPaths(manifest.repo);
  const launchAbs =
    manifest.launchDir === "." ? manifest.repo : p.join(manifest.repo, ...manifest.launchDir.split("/"));
  const planted = new Set([...manifest.canaries.map((c) => c.token), manifest.controlToken]);
  const decoys = manifest.canaries.filter((c) => c.decoy === true);

  const trials: OracleTrialScore[] = evidence.map((e) => {
    const base = {
      trial: e.trial,
      controlSeen: false,
      decoySeen: [] as string[],
      inventedTokens: [] as string[],
      ...(e.segments !== undefined ? { segments: e.segments } : {}),
    };
    if (e.failed !== undefined) return { ...base, status: "failed", reasons: [e.failed] };
    // The caller's checks first: an output of an unknown shape explains every check after it.
    const reasons: string[] = e.checks.filter((c) => !c.ok).map((c) => c.reason);
    const controlSeen = tokenPresent(e.controlText, manifest.controlToken);
    if (!controlSeen)
      reasons.push(`the must-appear token ${manifest.controlToken} from the prompt is not in the output`);
    const decoySeen = decoys.filter((d) => tokenPresent(e.delivered, d.token)).map((d) => d.token);
    if (decoySeen.length) reasons.push(`the decoy, which no rule loads, was delivered (${decoySeen.join(", ")})`);
    if (e.cwd === undefined) reasons.push("the output does not say which directory the agent ran in");
    else if (!p.same(e.cwd, launchAbs))
      reasons.push(`the agent ran in ${e.cwd}, not the launch directory ${launchAbs}`);
    return {
      ...base,
      status: reasons.length ? "fault" : "usable",
      reasons,
      controlSeen,
      decoySeen,
      inventedTokens: inventedTokens(e.delivered, planted),
    };
  });

  const usableEvidence = evidence.filter((_e, i) => trials[i]?.status === "usable");
  const cells: OracleCell[] = manifest.canaries.map((canary) => {
    const predicted = predictionFor(manifest, canary);
    const expected = expectationFor(canary, predicted);
    const obs = usableEvidence.map((e) => ({
      seen: (tokenPresent(e.delivered, canary.token) ? "preloaded" : "not-seen") as "preloaded" | "not-seen",
      dirRead: false,
    }));
    return {
      token: canary.token,
      file: canary.file,
      position: canary.position,
      decoy: canary.decoy === true,
      predicted,
      expected,
      seen: countSeen(obs).preloaded,
      usable: obs.length,
      verdict: verdictFor("recall", expected, obs),
    };
  });

  const reasons: string[] = [];
  for (const t of trials) if (t.status === "fault") reasons.push(`trial ${t.trial}: ${t.reasons.join("; ")}`);
  if (decoys.length === 0)
    reasons.push("no decoy was planted, so nothing checks that the oracle does not deliver files no rule loads");
  const usable = trials.filter((t) => t.status === "usable").length;
  const warnings: string[] = [];
  const real = cells.filter((c) => !c.decoy);
  if (manifest.planted === false)
    warnings.push(
      "No tokens were planted (--no-plant): the bytes are the evidence, and the decoy and the prompt's token are the controls.",
    );
  else if (!real.some((c) => c.expected === "launch"))
    warnings.push(
      "No planted file is predicted to load at launch: only the prompt's token acts as a positive control.",
    );
  const invented = [...new Set(trials.flatMap((t) => t.inventedTokens))];
  if (invented.length)
    warnings.push(`Tokens of the canary form that were never planted appeared: ${invented.join(", ")}.`);
  if (evidence.length && usable === 0 && !reasons.length) warnings.push("No trial was usable.");
  for (const note of new Set(evidence.flatMap((e) => e.notes ?? []))) warnings.push(note);

  const byVerdict: Record<Verdict, number> = {
    confirmed: 0,
    missed: 0,
    extra: 0,
    discovered: 0,
    untested: 0,
    "not-modelled": 0,
    "no-data": 0,
  };
  for (const c of real) byVerdict[c.verdict]++;
  return {
    trials,
    cells,
    instrument: {
      fault: reasons.length > 0,
      reasons,
      control: { seen: trials.filter((t) => t.status !== "failed" && t.controlSeen).length, usable },
      decoy: { seen: trials.filter((t) => t.decoySeen.length > 0).length, usable },
    },
    agreement: {
      agree: real.filter((c) => AGREEING.includes(c.verdict)).length,
      decided: real.filter((c) => DECIDED.includes(c.verdict)).length,
      cells: real.length,
      byVerdict,
    },
    warnings,
  };
}

/** `"3/3"` and similar, for reports. */
export const fraction = pct;
