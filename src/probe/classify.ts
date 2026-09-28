/**
 * Decide, for one trial, how each planted token reached the agent.
 *
 * The rules (see `Observation` in types.ts):
 * 1. A trial that used a tool it was not allowed is contaminated: in recall
 *    mode every tool counts, in task mode anything outside the read tools.
 *    A tool call that searches for the tokens themselves (its input contains
 *    `CTXR`) also contaminates a task-mode trial: the agent went looking for
 *    the canaries instead of doing the task.
 * 2. A token that was never repeated in the agent's own text is not seen.
 * 3. A token repeated after it appeared in a tool's output, or after a tool
 *    call named its file, was self-discovered.
 * 4. A token from a file below the launch directory, repeated after a tool
 *    call named a path in that file's directory, arrived on read. A rule file
 *    that declares `paths` loads on read of any matching file, so for it any
 *    path in the tree it covers counts, at or below the launch directory.
 * 5. Anything else repeated was preloaded.
 *
 * Only tool calls made before the first repeat count.
 */
import { ownerDir, recordedPaths, type RecordedPaths } from "./paths.js";
import type { Canary, Observation, ProbeMode, ToolUse, Transcript, TranscriptItem } from "./types.js";

export const TOKEN = /CTXR-[0-9a-f]{8}/g;
/** A search for the tokens: `CTXR` not followed by a letter, so the `ctxreach` in the sandbox's path does not count. */
const SEARCHES_TOKENS = /CTXR(?![a-z])/i;

export interface ClassifyContext {
  canaries: readonly Canary[];
  mode: ProbeMode;
  /** Absolute path of the repository copy the agent ran in, as recorded. */
  repo: string;
  /** Launch directory relative to `repo`, with forward slashes (`.` for the root). */
  launchDir: string;
  /** Tools allowed in task mode. */
  readTools: readonly string[];
  /** Paths a tool call read as whole files (from the adapter). */
  fileReads: (call: ToolUse) => string[];
}

export interface CanaryObservation {
  seen: Observation;
  /** Why, in words, for the report. */
  evidence: string;
  /**
   * A tool call read a file that could have triggered this file's delivery
   * (see rule 4 above) at some point in the trial, so an on-read delivery had
   * its chance. Always false for files at or above the launch directory,
   * other than rule files.
   */
  dirRead: boolean;
}

export interface TrialClassification {
  contaminated: boolean;
  /** Why the trial is contaminated: tool names, or a note that the agent searched for the tokens. */
  contaminatedBy: string[];
  toolCalls: number;
  toolNames: string[];
  observations: Record<string, CanaryObservation>;
  /** Tokens of the canary form that the agent repeated but ctxreach never planted. */
  unknownTokens: string[];
  /** Files the agent read outside the repository copy. */
  outsidePaths: string[];
}

/** Every string inside a tool's input, and each whitespace-separated word of it. */
export function pathCandidates(input: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6) return;
    if (typeof v === "string") {
      const s = v.trim();
      if (s) out.push(s);
      for (const word of s.split(/\s+/)) {
        const w = word.replace(/^["'`]+|["'`;,]+$/g, "");
        if (w && w !== s) out.push(w);
      }
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(input, 0);
  return out;
}

interface ToolCall {
  index: number;
  name: string;
  /** Every path-like string in the input, resolved against the working directory. */
  paths: string[];
  /** Files it read. */
  reads: string[];
  searchesTokens: boolean;
}

function toolCalls(items: TranscriptItem[], cwd: string, p: RecordedPaths, ctx: ClassifyContext): ToolCall[] {
  const calls: ToolCall[] = [];
  items.forEach((item, index) => {
    if (item.kind !== "tool-use") return;
    calls.push({
      index,
      name: item.name,
      paths: pathCandidates(item.input).map((s) => p.resolve(cwd, s)),
      reads: ctx.fileReads(item).map((s) => p.resolve(cwd, s)),
      searchesTokens: SEARCHES_TOKENS.test(JSON.stringify(item.input ?? null)),
    });
  });
  return calls;
}

export function classifyTrial(transcript: Transcript, ctx: ClassifyContext): TrialClassification {
  const p = recordedPaths(ctx.repo);
  const launchAbs = ctx.launchDir === "." ? ctx.repo : p.join(ctx.repo, ...ctx.launchDir.split("/"));
  const cwd = transcript.cwd ?? launchAbs;
  const items = transcript.items;
  const calls = toolCalls(items, cwd, p, ctx);

  const allowed = ctx.mode === "recall" ? new Set<string>() : new Set(ctx.readTools);
  const contaminatedBy = [...new Set(calls.filter((c) => !allowed.has(c.name)).map((c) => c.name))];
  if (ctx.mode === "task" && calls.some((c) => c.searchesTokens)) contaminatedBy.push("a search for the tokens");
  const contaminated = contaminatedBy.length > 0;

  // Where each token is first repeated in the agent's own text. The final
  // answer, when reported separately, counts as coming after every item.
  const firstEcho = new Map<string, number>();
  const echoed = new Set<string>();
  items.forEach((item, index) => {
    if (item.kind !== "text") return;
    for (const m of item.text.matchAll(TOKEN)) {
      echoed.add(m[0]);
      if (!firstEcho.has(m[0])) firstEcho.set(m[0], index);
    }
  });
  for (const m of (transcript.finalText ?? "").matchAll(TOKEN)) {
    echoed.add(m[0]);
    if (!firstEcho.has(m[0])) firstEcho.set(m[0], items.length);
  }

  const planted = new Set(ctx.canaries.map((c) => c.token));
  const observations: Record<string, CanaryObservation> = {};
  for (const c of ctx.canaries) {
    const fileAbs = p.join(ctx.repo, ...c.file.split("/"));
    const owner = ownerDir(c.file);
    const ownerAbs = owner === "." ? ctx.repo : p.join(ctx.repo, ...owner.split("/"));
    const below = p.inside(ownerAbs, launchAbs) && !p.same(ownerAbs, launchAbs);
    // Where a tool call can trigger this file's delivery: its own directory
    // tree for a file below the launch directory; for a rule file, any file
    // in its owner's tree that is also at or below the launch directory.
    const rule = c.scoped === true;
    const scope = rule ? (p.inside(launchAbs, ownerAbs) ? launchAbs : ownerAbs) : below ? ownerAbs : undefined;
    const inScope = (x: string) => scope !== undefined && p.inside(x, scope) && !p.same(x, fileAbs);
    const dirRead = calls.some((call) => call.reads.some(inScope));

    if (contaminated) {
      observations[c.token] = { seen: "contaminated", evidence: `trial used ${contaminatedBy.join(", ")}`, dirRead };
      continue;
    }
    const at = firstEcho.get(c.token);
    if (at === undefined) {
      observations[c.token] = { seen: "not-seen", evidence: "never repeated", dirRead };
      continue;
    }
    const before = calls.filter((call) => call.index < at);

    const inOutput = items.some(
      (item, index) => index < at && item.kind === "tool-result" && item.text.includes(c.token),
    );
    if (inOutput) {
      observations[c.token] = { seen: "self-discovered", evidence: "appeared in a tool's output first", dirRead };
      continue;
    }
    const opened = before.find((call) => call.paths.some((x) => p.same(x, fileAbs)));
    if (opened) {
      observations[c.token] = { seen: "self-discovered", evidence: `${opened.name} named the file first`, dirRead };
      continue;
    }
    const nearby = before.find((call) => call.paths.some(inScope));
    if (nearby) {
      observations[c.token] = {
        seen: "on-read",
        evidence: `${nearby.name} named a path in ${rule ? "the tree the rule covers" : `${owner}/`} first, not the file itself`,
        dirRead,
      };
      continue;
    }
    observations[c.token] = {
      seen: "preloaded",
      evidence: before.length ? "no earlier tool call named its file or directory" : "repeated before any tool call",
      dirRead,
    };
  }

  const outside = new Set<string>();
  for (const call of calls) for (const r of call.reads) if (!p.inside(r, ctx.repo)) outside.add(r);

  return {
    contaminated,
    contaminatedBy,
    toolCalls: calls.length,
    toolNames: [...new Set(calls.map((c) => c.name))],
    observations,
    unknownTokens: [...echoed].filter((t) => !planted.has(t)).sort(),
    outsidePaths: [...outside].sort(),
  };
}
