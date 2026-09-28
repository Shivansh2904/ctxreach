/**
 * Score a probe recording: classify each trial, compare each canary with
 * map's prediction, and check the instrument itself.
 *
 * A live probe and `probe --replay` both end here, reading the transcripts
 * as saved, so a live result is always exactly what a replay of its
 * recording reports.
 */
import { classifyTrial, type TrialClassification } from "./classify.js";
import { AGREEING, countSeen, DECIDED, expectationFor, verdictFor, type SeenCounts } from "./compare.js";
import { recordedPaths } from "./paths.js";
import type { Manifest, Recording } from "./recording.js";
import {
  TranscriptError,
  type AgentAdapter,
  type Canary,
  type Expectation,
  type PredictedFile,
  type Transcript,
  type UsableObservation,
  type Verdict,
} from "./types.js";

/**
 * - `usable`: counts towards every cell.
 * - `contaminated`: used a tool it was not allowed; excluded, and reported.
 * - `failed`: the agent did not finish (error, timeout, no result event, or
 *   a transcript ctxreach cannot read), or stopped before its session
 *   started (not logged in, killed at once); excluded, and reported.
 * - `fault`: the session was not the one ctxreach asked for (other tools,
 *   another working directory, another version); excluded, and the whole run
 *   is flagged as an instrument fault.
 */
export type TrialStatus = "usable" | "contaminated" | "failed" | "fault";

export interface TrialScore {
  trial: number;
  status: TrialStatus;
  reasons: string[];
  model?: string;
  toolCalls: number;
  toolNames: string[];
  unknownEvents: Record<string, number>;
  events: number;
  inventedTokens: string[];
  outsidePaths: string[];
  leftovers: string[];
}

export interface CellScore {
  token: string;
  file: string;
  position: "head" | "tail";
  decoy: boolean;
  predicted: PredictedFile;
  expected: Expectation;
  seen: SeenCounts;
  /** Usable trials: the denominator of every fraction in this cell. */
  usable: number;
  /** Usable trials in which a file in this canary's directory was read (files below the launch directory). */
  dirRead: number;
  verdict: Verdict;
}

export interface ProbeResult {
  manifest: Manifest;
  recordingDir: string;
  models: string[];
  trials: TrialScore[];
  cells: CellScore[];
  instrument: { fault: boolean; reasons: string[]; decoy: { echoed: number; usable: number } };
  agreement: { agree: number; decided: number; cells: number; byVerdict: Record<Verdict, number> };
  warnings: string[];
  notes: string[];
}

function statusOf(
  manifest: Manifest,
  adapter: AgentAdapter,
  transcript: Transcript,
  cls: TrialClassification,
  outcome: Manifest["trials"][number],
): { status: TrialStatus; reasons: string[] } {
  const p = recordedPaths(manifest.repo);
  const launchAbs =
    manifest.launchDir === "." ? manifest.repo : p.join(manifest.repo, ...manifest.launchDir.split("/"));

  const failures: string[] = [];
  if (outcome.timedOut) failures.push(`timed out after ${manifest.timeoutMs} ms`);
  if (outcome.exitCode !== 0) failures.push(`exited with status ${outcome.exitCode ?? "none"}`);
  if (!transcript.finished) failures.push("no final result event");
  if (transcript.isError) failures.push("the agent reported an error");

  // No system/init event, and the run failed: the agent stopped before its
  // session started (for example, not logged in, or killed at once), so there
  // is no session to check. A session that finished without one is a fault.
  const started = transcript.cwd !== undefined || transcript.toolsOffered !== undefined;
  if (!started && failures.length)
    return {
      status: "failed",
      reasons: ["the agent stopped before its session started (no system/init event)", ...failures],
    };

  const faults: string[] = [];
  if (transcript.cwd === undefined) faults.push("the transcript does not say which directory the agent ran in");
  else if (!p.same(transcript.cwd, launchAbs))
    faults.push(`the agent ran in ${transcript.cwd}, not the launch directory ${launchAbs}`);
  if (transcript.cliVersion !== undefined && transcript.cliVersion !== manifest.cliVersion)
    faults.push(`the transcript is from version ${transcript.cliVersion}, the run was stamped ${manifest.cliVersion}`);
  if (transcript.toolsOffered === undefined) {
    faults.push("the transcript does not list the session's tools");
  } else {
    const allowed = manifest.mode === "recall" ? new Set<string>() : new Set(adapter.readTools);
    const extra = transcript.toolsOffered.filter((t) => !allowed.has(t));
    if (extra.length)
      faults.push(
        `the session had tools it should not have had in ${manifest.mode} mode: ${extra.slice(0, 8).join(", ")}${extra.length > 8 ? ` and ${extra.length - 8} more` : ""}`,
      );
  }
  if (faults.length) return { status: "fault", reasons: faults };
  if (failures.length) return { status: "failed", reasons: failures };

  if (cls.contaminated) return { status: "contaminated", reasons: [`used ${cls.contaminatedBy.join(", ")}`] };
  return { status: "usable", reasons: [] };
}

function predictionFor(manifest: Manifest, canary: Canary): PredictedFile {
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

export function scoreRecording(recording: Recording, adapter: AgentAdapter): ProbeResult {
  const { manifest } = recording;
  const warnings: string[] = [];
  const notes: string[] = [];
  const trials: TrialScore[] = [];
  const perTrial: (TrialClassification | undefined)[] = [];
  const models = new Set<string>();

  manifest.trials.forEach((outcome, i) => {
    const text = recording.transcripts[i];
    const base = {
      trial: outcome.trial,
      toolCalls: 0,
      toolNames: [] as string[],
      unknownEvents: {} as Record<string, number>,
      events: 0,
      inventedTokens: [] as string[],
      outsidePaths: [] as string[],
      leftovers: outcome.leftovers,
    };
    if (text === undefined) {
      trials.push({ ...base, status: "failed", reasons: [`${outcome.transcript} is missing`] });
      perTrial.push(undefined);
      return;
    }
    let transcript: Transcript;
    try {
      transcript = adapter.parse(text);
    } catch (err) {
      if (!(err instanceof TranscriptError)) throw err;
      trials.push({ ...base, status: "failed", reasons: [`${outcome.transcript}: ${err.message}`] });
      perTrial.push(undefined);
      return;
    }
    if (transcript.model) models.add(transcript.model);
    const cls = classifyTrial(transcript, {
      canaries: manifest.canaries,
      mode: manifest.mode,
      repo: manifest.repo,
      launchDir: manifest.launchDir,
      readTools: adapter.readTools,
      fileReads: adapter.fileReads,
    });
    const { status, reasons } = statusOf(manifest, adapter, transcript, cls, outcome);
    trials.push({
      ...base,
      status,
      reasons,
      ...(transcript.model ? { model: transcript.model } : {}),
      toolCalls: cls.toolCalls,
      toolNames: cls.toolNames,
      unknownEvents: transcript.events.unknown,
      events: transcript.events.total,
      inventedTokens: cls.unknownTokens,
      outsidePaths: cls.outsidePaths,
    });
    perTrial.push(status === "usable" ? cls : undefined);
  });

  const usable = perTrial.filter((c): c is TrialClassification => c !== undefined);
  const cells: CellScore[] = manifest.canaries.map((canary) => {
    const predicted = predictionFor(manifest, canary);
    const expected = expectationFor(canary, predicted);
    const obs = usable.map((cls) => {
      const o = cls.observations[canary.token];
      // A usable trial is never contaminated, so every observation is usable.
      return { seen: (o?.seen ?? "not-seen") as UsableObservation, dirRead: o?.dirRead ?? false };
    });
    return {
      token: canary.token,
      file: canary.file,
      position: canary.position,
      decoy: canary.decoy === true,
      predicted,
      expected,
      seen: countSeen(obs),
      usable: obs.length,
      dirRead: obs.filter((o) => o.dirRead).length,
      verdict: verdictFor(manifest.mode, expected, obs),
    };
  });

  // The instrument's own checks.
  const reasons: string[] = [];
  for (const t of trials) if (t.status === "fault") reasons.push(`trial ${t.trial}: ${t.reasons.join("; ")}`);
  const decoys = cells.filter((c) => c.decoy);
  const decoyEchoed = usable.filter((cls) =>
    decoys.some((d) => cls.observations[d.token]?.seen === "preloaded"),
  ).length;
  if (decoys.length === 0)
    reasons.push("no decoy was planted, so nothing checks that the agent does not echo tokens it was never given");
  if (decoyEchoed > 0)
    reasons.push(
      `the decoy, which no rule loads, was repeated without being read in ${pct(decoyEchoed, usable.length)} usable trials (must be 0)`,
    );

  const real = cells.filter((c) => !c.decoy);
  if (!real.some((c) => c.expected === "launch"))
    warnings.push(
      "No planted file is predicted to load at launch, so this run has no positive control: a broken instrument that sees nothing would look like agreement.",
    );
  if (usable.length > 0 && real.every((c) => c.seen.preloaded + c.seen["on-read"] + c.seen["self-discovered"] === 0))
    warnings.push("No planted token was repeated in any usable trial.");
  const unknown = new Map<string, number>();
  for (const t of trials)
    for (const [k, v] of Object.entries(t.unknownEvents)) unknown.set(k, (unknown.get(k) ?? 0) + v);
  if (unknown.size)
    warnings.push(
      `Stream events of kinds ctxreach does not know were tolerated and counted: ${[...unknown].map(([k, v]) => `${k} (${v})`).join(", ")}.`,
    );
  const invented = [...new Set(trials.flatMap((t) => t.inventedTokens))];
  if (invented.length)
    warnings.push(
      `The agent repeated ${invented.length} token(s) of the canary form that were never planted: ${invented.join(", ")}.`,
    );
  const outside = [...new Set(trials.flatMap((t) => t.outsidePaths))];
  if (outside.length) warnings.push(`The agent read files outside the temporary copy: ${outside.join(", ")}.`);
  const leftovers = [...new Set(trials.flatMap((t) => t.leftovers))];
  if (leftovers.length) warnings.push(`The agent left files ctxreach did not remove: ${leftovers.join(", ")}.`);
  if (manifest.environment.bare) warnings.push(...manifest.environment.notes);
  else notes.push(...manifest.environment.notes);
  if (manifest.unplanted.length)
    notes.push(`Not planted: ${manifest.unplanted.map((u) => `${u.file} (${u.why})`).join(", ")}.`);
  if (manifest.outside.length)
    notes.push(
      `Instruction files outside the copy that map says also reach the agent (no tokens in them): ${manifest.outside.map((o) => o.file).join(", ")}.`,
    );
  if (manifest.sandbox.stripped.length)
    notes.push(`Removed from the copy before any run: ${manifest.sandbox.stripped.join(", ")}.`);
  const links = manifest.sandbox.links ?? [];
  if (links.length)
    notes.push(
      `The copy holds no links, so each link in the repository was copied as what it points to, or left out: ${links.join("; ")}.`,
    );
  if (manifest.environment.removedEnv.length)
    notes.push(
      `Removed from the agent's environment (set by the Claude Code session that ran ctxreach): ${manifest.environment.removedEnv.length} variables.`,
    );

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
    manifest,
    recordingDir: recording.dir,
    models: [...models].sort(),
    trials,
    cells,
    instrument: {
      fault: reasons.length > 0,
      reasons,
      decoy: { echoed: decoyEchoed, usable: usable.length },
    },
    agreement: {
      agree: real.filter((c) => AGREEING.includes(c.verdict)).length,
      decided: real.filter((c) => DECIDED.includes(c.verdict)).length,
      cells: real.length,
      byVerdict,
    },
    warnings,
    notes,
  };
}
