/**
 * Compare what a probe observed with what `map` predicted, one canary at a
 * time, over all usable trials.
 */
import type { Canary, Expectation, PredictedFile, ProbeMode, UsableObservation, Verdict } from "./types.js";

export const TOKEN_LENGTH = "CTXR-00000000".length;

/**
 * `map` marks a file it does not model (an ancestor directory's rules).
 * Recordings made before `notModelled` was recorded carry it only in the reason.
 */
export function isNotModelled(predicted: PredictedFile): boolean {
  return predicted.notModelled === true || /\bnot modelled\b/.test(predicted.why);
}

/** What `map`'s prediction for a file means for one canary in it. */
export function expectationFor(canary: Canary, predicted: PredictedFile): Expectation {
  if (canary.decoy || predicted.delivery === "decoy") return "never";
  if (isNotModelled(predicted)) return "not-modelled";
  switch (predicted.delivery) {
    case "launch":
    case "import":
      return "launch";
    case "launch-cut":
      // Only a token that lies wholly inside the kept bytes can be repeated.
      return predicted.cutAt !== undefined && canary.offset + TOKEN_LENGTH <= predicted.cutAt ? "launch" : "never";
    case "on-read":
      // A rule file loads on read of a file matching its `paths`, which map does not resolve.
      return predicted.rule === "claude.rules" ? "on-match" : "on-read";
    case "maybe":
      return "not-preloaded";
    case "not-loaded":
      return "never";
  }
}

/** One usable trial's observation of one canary. */
export interface TrialObservation {
  seen: UsableObservation;
  /** A file in the canary's directory (below the launch directory) was read during the trial. */
  dirRead: boolean;
}

export type SeenCounts = Record<UsableObservation, number>;

export function countSeen(trials: readonly TrialObservation[]): SeenCounts {
  const counts: SeenCounts = { preloaded: 0, "on-read": 0, "self-discovered": 0, "not-seen": 0 };
  for (const t of trials) counts[t.seen]++;
  return counts;
}

/**
 * The verdict for one canary over its usable trials.
 *
 * Recall mode measures preloading only: a canary predicted at launch must be
 * repeated, preloaded, in every usable trial, and any other canary in none.
 *
 * Task mode lets the agent read files, so it can also measure delivery on
 * read:
 * - predicted at launch: seen in every trial, by any route;
 * - predicted on read: in every trial that read a file in its directory, it
 *   arrived (on read, or because the model opened it); never preloaded. With
 *   no such trial the prediction is `untested`, unless it arrived anyway
 *   after some tool call or the model opened the file itself (`discovered`);
 * - predicted on a matching read (a rule with `paths`): never preloaded, and
 *   `confirmed` when it arrived after a read; otherwise `untested`, since
 *   ctxreach cannot tell whether any file read matched;
 * - predicted not to arrive: never preloaded and never delivered on read;
 *   seen only if the model opened the file itself (`discovered`).
 *
 * A file `map` does not model gets no verdict (`not-modelled`) in either
 * mode, whatever was observed: `map` did not predict that it stays out, so
 * what was seen is neither agreement nor disagreement.
 */
export function verdictFor(mode: ProbeMode, expectation: Expectation, trials: readonly TrialObservation[]): Verdict {
  const n = trials.length;
  if (n === 0) return "no-data";
  if (expectation === "not-modelled") return "not-modelled";
  const seen = countSeen(trials);
  const pre = seen.preloaded;
  const onRead = seen["on-read"];
  const self = seen["self-discovered"];

  if (mode === "recall") {
    if (expectation === "launch") return pre === n ? "confirmed" : "missed";
    return pre > 0 ? "extra" : "confirmed";
  }
  if (expectation === "launch") return pre + onRead + self === n ? "confirmed" : "missed";
  if (expectation === "on-read") {
    if (pre > 0) return "extra";
    const chances = trials.filter((t) => t.dirRead);
    if (chances.length === 0) return onRead > 0 ? "confirmed" : self > 0 ? "discovered" : "untested";
    return chances.every((t) => t.seen === "on-read" || t.seen === "self-discovered") ? "confirmed" : "missed";
  }
  if (expectation === "on-match") {
    if (pre > 0) return "extra";
    if (onRead > 0) return "confirmed";
    return self > 0 ? "discovered" : "untested";
  }
  if (pre > 0 || onRead > 0) return "extra";
  return self > 0 ? "discovered" : "confirmed";
}

/** Verdicts that agree with the prediction. */
export const AGREEING: readonly Verdict[] = ["confirmed", "discovered"];
/** Verdicts that are evidence either way (not `untested`, `not-modelled` or `no-data`). */
export const DECIDED: readonly Verdict[] = ["confirmed", "discovered", "missed", "extra"];
