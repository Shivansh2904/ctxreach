/**
 * Score a probe recording: classify each trial, compare each canary with
 * map's prediction, and check the instrument itself.
 *
 * A live probe and `probe --replay` both end here, reading the transcripts
 * as saved, so a live result is always exactly what a replay of its
 * recording reports.
 *
 * The instrument's checks, each of which voids the run when it fails:
 * - every trial's session is the one asked for: working directory, version,
 *   tools, the arguments recorded, the pinned model, and (Claude Code
 *   2.1.277 and later) the `agents-md` built-in plugin, without which
 *   AGENTS.md is never read;
 * - the decoy, which no rule loads, is never repeated without being read;
 * - the positive control, a rule ctxreach writes at the launch directory, is
 *   repeated in every trial (recordings made before it have none);
 * - nothing that turns instruction files off was set, and the hook was not
 *   turned off;
 * - with the hook, every trial has its log; under clean isolation, the hook
 *   saw nothing load from outside the copy.
 */
import { parseHookLog, type HookEvent } from "../agents/claude/hook.js";
import { AGENTS_MD_PLUGIN_SINCE, hasAgentsMdPlugin, killFlagsIn, modelMatches } from "../agents/claude/isolation.js";
import { compareVersions } from "../agents/claude/settings.js";
import { classifyTrial, type TrialClassification } from "./classify.js";
import { AGREEING, countSeen, DECIDED, expectationFor, verdictFor, type SeenCounts } from "./compare.js";
import { hookReport, partialEchoes, type HookReport, type PartialEchoes } from "./instruments.js";
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
 *   another working directory, another version, another model, no
 *   AGENTS.md plugin), or it did not repeat the positive control; excluded,
 *   and the whole run is flagged as an instrument fault.
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
  /** The positive control's tokens: an instrument check, never counted in the agreement. */
  control: boolean;
  predicted: PredictedFile;
  expected: Expectation;
  seen: SeenCounts;
  /** Usable trials: the denominator of every fraction in this cell. */
  usable: number;
  /** Usable trials in which a file in this canary's directory was read (files below the launch directory). */
  dirRead: number;
  verdict: Verdict;
}

/**
 * The positive control's result.
 * - `absent`: the recording was made before ctxreach planted one;
 * - `not-applicable`: map says the control does not load in this run (for
 *   example under `managed-only`), so it is not required;
 * - `planted`: required in every trial.
 */
export interface ControlCheck {
  status: "absent" | "not-applicable" | "planted";
  file?: string;
  why?: string;
  /** Trials in which both its tokens were repeated with no earlier tool call naming it. */
  echoed: number;
  /** Trials in which the model opened it before repeating it: no evidence either way, not a fault. */
  readItself: number;
  /** Trials in which a token of it was not repeated: each one is a faulty trial. */
  missed: number;
  /** Trials checked: those that were usable apart from this check. */
  checked: number;
}

export interface ProbeResult {
  manifest: Manifest;
  recordingDir: string;
  models: string[];
  trials: TrialScore[];
  cells: CellScore[];
  instrument: {
    fault: boolean;
    reasons: string[];
    decoy: { echoed: number; usable: number };
    control: ControlCheck;
    /** The hook set against the canary; null when the run had no hook. */
    hook: HookReport | null;
    partial: PartialEchoes;
  };
  agreement: { agree: number; decided: number; cells: number; byVerdict: Record<Verdict, number> };
  warnings: string[];
  notes: string[];
}

interface Checks {
  /** The trial's hook log was recorded and is present. */
  hookLog: boolean;
}

function statusOf(
  manifest: Manifest,
  adapter: AgentAdapter,
  transcript: Transcript,
  cls: TrialClassification,
  outcome: Manifest["trials"][number],
  checks: Checks,
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
  // AGENTS.md is read by a built-in plugin; without it every AGENTS.md cell would read as switched off.
  if (manifest.agent === "claude" && compareVersions(manifest.cliVersion, AGENTS_MD_PLUGIN_SINCE) >= 0) {
    if (transcript.plugins === undefined)
      faults.push("the transcript does not list the session's plugins, so AGENTS.md support cannot be checked");
    else if (!hasAgentsMdPlugin(transcript.plugins))
      faults.push("AGENTS.md support was off: system/init lists no agents-md@builtin plugin");
  }
  const session = manifest.session;
  const pin = session?.model;
  if (pin && transcript.model !== undefined && !modelMatches(pin.pin, transcript.model))
    faults.push(`the session ran ${transcript.model}, not the pinned model ${pin.pin} (from ${pin.from})`);
  if (session && outcome.args !== undefined && JSON.stringify(outcome.args) !== JSON.stringify(session.args))
    faults.push("the agent was started with other arguments than the run recorded");
  if (session?.isolation === "clean") {
    const others =
      (transcript.otherPlugins ?? 0) + (transcript.plugins ?? []).filter((x) => !x.endsWith("@builtin")).length;
    if (others > 0) faults.push(`${others} plugin(s) that are not built in loaded under clean isolation`);
  }
  if (session?.hook && !checks.hookLog)
    faults.push(`the hook log of trial ${outcome.trial} is missing, although the run had the hook`);
  if (faults.length) return { status: "fault", reasons: faults };
  if (failures.length) return { status: "failed", reasons: failures };

  if (cls.contaminated) return { status: "contaminated", reasons: [`used ${cls.contaminatedBy.join(", ")}`] };
  return { status: "usable", reasons: [] };
}

function predictionFor(manifest: Manifest, canary: Canary): PredictedFile {
  if (canary.decoy) return { file: canary.file, delivery: "decoy", why: "decoy: no rule loads it", rule: "decoy" };
  if (canary.control) {
    const c = manifest.control;
    if (c && c.delivery !== "launch") return { file: canary.file, delivery: c.delivery, why: c.why, rule: c.rule };
    return { file: canary.file, delivery: "launch", why: "positive control: a rule without paths", rule: "control" };
  }
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

/** How the positive control fared in one otherwise usable trial. */
function controlIn(cls: TrialClassification, controls: readonly Canary[]): "echoed" | "read-itself" | "missed" {
  const seen = controls.map((c) => cls.observations[c.token]?.seen ?? "not-seen");
  if (seen.some((s) => s === "not-seen")) return "missed";
  return seen.every((s) => s === "preloaded" || s === "on-read") ? "echoed" : "read-itself";
}

export function scoreRecording(recording: Recording, adapter: AgentAdapter): ProbeResult {
  const { manifest } = recording;
  const warnings: string[] = [];
  const notes: string[] = [];
  const trials: TrialScore[] = [];
  const perTrial: (TrialClassification | undefined)[] = [];
  const hookEvents: (HookEvent[] | undefined)[] = [];
  let hookInvalid = 0;
  const models = new Set<string>();

  const controls = manifest.canaries.filter((c) => c.control);
  const controlApplies = controls.length > 0 && manifest.control?.delivery === "launch";
  const control: ControlCheck = {
    status: controls.length === 0 ? "absent" : controlApplies ? "planted" : "not-applicable",
    ...(controls[0] ? { file: controls[0].file } : {}),
    ...(manifest.control ? { why: manifest.control.why } : {}),
    echoed: 0,
    readItself: 0,
    missed: 0,
    checked: 0,
  };

  manifest.trials.forEach((outcome, i) => {
    const text = recording.transcripts[i];
    const hookText = recording.hookLogs?.[i];
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
      hookEvents.push(undefined);
      return;
    }
    let transcript: Transcript;
    try {
      transcript = adapter.parse(text);
    } catch (err) {
      if (!(err instanceof TranscriptError)) throw err;
      trials.push({ ...base, status: "failed", reasons: [`${outcome.transcript}: ${err.message}`] });
      perTrial.push(undefined);
      hookEvents.push(undefined);
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
    let { status, reasons } = statusOf(manifest, adapter, transcript, cls, outcome, {
      hookLog: outcome.hooks !== undefined && hookText !== undefined,
    });
    // The positive control, in a trial that is otherwise usable.
    if (status === "usable" && controlApplies) {
      control.checked++;
      const how = controlIn(cls, controls);
      if (how === "echoed") control.echoed++;
      else if (how === "read-itself") control.readItself++;
      else {
        control.missed++;
        status = "fault";
        reasons = [
          `the positive control (${controls[0]?.file}) was not repeated in full, so this session cannot be trusted to repeat what it was given`,
        ];
      }
    }
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
    if (hookText !== undefined) {
      const parsed = parseHookLog(hookText);
      hookInvalid += parsed.invalid + (outcome.hooks?.invalid ?? 0);
      hookEvents.push(parsed.events);
    } else {
      hookEvents.push(undefined);
    }
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
      control: canary.control === true,
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
  const killSwitches = manifest.environment.killSwitches ?? [];
  if (killSwitches.length)
    reasons.push(`the run was made with ${killSwitches.join(", ")} set, which turns instruction files off`);
  else if (manifest.environment.bare)
    reasons.push(
      `the run was made with a setting that turns instruction files off: ${manifest.environment.notes.join(" ")}`,
    );
  const killFlags = killFlagsIn(manifest.args);
  if (killFlags.length) reasons.push(`the agent was run with ${killFlags.join(", ")}, which skips instruction files`);
  const session = manifest.session;
  if (session?.settings && "disableAllHooks" in session.settings)
    reasons.push("the settings passed to the agent set disableAllHooks, which turns the hook off");

  // The hook set against the canary, over usable trials.
  const usableTrials = trials
    .map((t, i) => ({ t, cls: perTrial[i], hooks: hookEvents[i] }))
    .filter((x): x is { t: TrialScore; cls: TrialClassification; hooks: HookEvent[] | undefined } => !!x.cls);
  const hook = session?.hook
    ? hookReport({
        repo: manifest.repo,
        canaries: manifest.canaries,
        predictionFor: (c) => predictionFor(manifest, c),
        trials: usableTrials.map((x) => ({ trial: x.t.trial, observations: x.cls.observations, hooks: x.hooks })),
      })
    : null;
  const partial = partialEchoes({
    canaries: manifest.canaries,
    expectationFor: (c) => expectationFor(c, predictionFor(manifest, c)),
    trials: usableTrials.map((x) => ({ trial: x.t.trial, observations: x.cls.observations })),
  });
  if (hook) {
    if (hook.decoyFired > 0)
      reasons.push(
        `the hook reported the decoy, which no rule loads, as loaded in ${pct(hook.decoyFired, hook.trials)} usable trials (must be 0)`,
      );
    if (session?.isolation === "clean" && hook.outside.length)
      reasons.push(
        `under clean isolation, the hook saw files outside the copy load (must be none): ${hook.outside.join(", ")}`,
      );
  }

  const real = cells.filter((c) => !c.decoy && !c.control);
  if (!real.some((c) => c.expected === "launch"))
    warnings.push(
      control.status === "absent"
        ? "No planted file is predicted to load at launch, so this run has no positive control: a broken instrument that sees nothing would look like agreement."
        : "No planted file of the repository is predicted to load at launch; only the positive control shows that the agent repeats what it is given.",
    );
  if (usable.length > 0 && real.every((c) => c.seen.preloaded + c.seen["on-read"] + c.seen["self-discovered"] === 0))
    warnings.push("No planted token was repeated in any usable trial.");
  if (control.status === "not-applicable")
    warnings.push(
      `The positive control was planted but map says it does not load here (${control.why}), so this run has no positive control.`,
    );
  if (control.readItself > 0)
    warnings.push(
      `In ${pct(control.readItself, control.checked)} trials the model opened the positive control itself before repeating it, which shows nothing about delivery.`,
    );
  if (session && session.model === null)
    warnings.push(
      `The model was not pinned: no --model, no ANTHROPIC_MODEL and no model in the user's settings.json. The sessions ran ${[...models].sort().join(", ") || "an unknown model"}.`,
    );
  if (session?.isolation === "clean")
    warnings.push(
      "--isolation clean is EXPERIMENTAL: four of its parts are unverified (docs/rules.md, Probe), so its results are not yet evidence.",
    );
  if (hook) {
    if (hook.controlSilent > 0)
      warnings.push(
        `The hook stayed silent for the positive control in ${pct(hook.controlSilent, hook.trials)} usable trials although the canary saw it: the hook did not run or lost events, so its rows say little.`,
      );
    if (hook.rows.disagreement > 0 || hook.rows["echo-miss"] > 0)
      warnings.push(
        `The hook and the canary disagree in ${hook.rows.disagreement + hook.rows["echo-miss"]} file-trials: ${hook.rows.disagreement} the hook missed, ${hook.rows["echo-miss"]} the canary missed (listed under Instrument).`,
      );
    if (session?.isolation !== "clean" && hook.outside.length)
      warnings.push(
        `The hook saw files outside the copy load, which carry no tokens and are part of what the agent received: ${hook.outside.join(", ")}.`,
      );
    if (hook.otherSession > 0)
      warnings.push(`${hook.otherSession} hook events carried another session's id and were not counted.`);
    if (hook.unplanted.length)
      notes.push(`The hook saw files in the copy load that carry no tokens: ${hook.unplanted.join(", ")}.`);
  }
  if (hookInvalid > 0)
    warnings.push(
      `${hookInvalid} hook log lines did not match the InstructionsLoaded event's shape and were not used.`,
    );
  if (partial.k > 0)
    warnings.push(
      `In ${pct(partial.k, partial.n)} file-trials only one of a file's two tokens was repeated: the model did not list everything it was given.`,
    );
  const location = manifest.location;
  if (location?.underHome && location.userClaudeMd)
    warnings.push(
      "The copy was inside the home directory and ~/.claude/CLAUDE.md exists: Claude Code also reads that file as an ancestor's .claude/CLAUDE.md (anthropics/claude-code#80580), so it is one of this run's conditions.",
    );
  if (location?.ancestors.length)
    notes.push(`Instruction files in the directories above the copy: ${location.ancestors.join(", ")}.`);

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
  if (session?.setEnv.length) notes.push(`Set in the agent's environment by ctxreach: ${session.setEnv.join(", ")}.`);
  notes.push(...(session?.notes ?? []));

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
      control,
      hook,
      partial,
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
