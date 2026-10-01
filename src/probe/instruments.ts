/**
 * The probe's instruments beyond the canary itself: where the copy was, the
 * InstructionsLoaded hook set against the canary, and partial echoes.
 *
 * The canary shows what the model can repeat; the hook shows what Claude
 * Code says it loaded. Each can fail where the other does not, so they are
 * crossed per planted file and per usable trial:
 *
 * | canary  | hook                                  | row            | meaning |
 * |---------|---------------------------------------|----------------|---------|
 * | seen    | fired                                 | `both`         | delivered, both agree |
 * | seen    | silent, an AGENTS.md read through the setting | `hook-blind` | the documented blind spot (rule `claude.hook-blind`) |
 * | seen    | silent, any other file                | `disagreement` | the hook lost the event, or is broken; listed |
 * | not seen| fired                                 | `echo-miss`    | delivered but not repeated: a canary false negative; listed |
 * | not seen| silent                                | `neither`      | not delivered, both agree |
 *
 * "Seen" means repeated with no earlier tool call naming the file (preloaded,
 * or on read). A file the model opened itself (`self-discovered`) is left out
 * of the table (`undecided`): its echo says nothing about delivery.
 *
 * Two rates bound each instrument's error with the other: of the hookable
 * files the canary saw, how many the hook reported; and of the files the
 * hook reported, how many the canary saw.
 *
 * A partial echo is a trial in which a file's head token was repeated and
 * its tail was not, or the reverse. Claude Code does not cut files, so it is
 * a recall failure; it is the one check that also covers AGENTS.md, where
 * the hook is blind.
 */
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { redactString } from "../agents/claude/events.js";
import type { HookEvent } from "../agents/claude/hook.js";
import { ANCESTOR_FILES } from "../agents/claude/isolation.js";
import { ancestors, isInsideReal } from "../util/fs.js";
import { recordedPaths } from "./paths.js";
import type { Canary, Expectation, Observation, PredictedFile, Redaction } from "./types.js";

export interface Fraction {
  k: number;
  n: number;
}

const RULES_LIMIT = 200;

/** Every `.md` file under `dir` (a `.claude/rules` directory), without following links, at most `RULES_LIMIT`. */
function rulesUnder(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= RULES_LIMIT) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) rulesUnder(p, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(p);
  }
}

/**
 * Instruction files in the directories above `copyRoot`, nearest first: the
 * files in `ANCESTOR_FILES`, and rules under `.claude/rules/`. With
 * `ceiling`, no directory above it is looked at (the tests' stand-in for the
 * filesystem root).
 */
export function ancestorInstructionFiles(copyRoot: string, ceiling?: string): string[] {
  const out: string[] = [];
  for (const dir of ancestors(path.dirname(path.resolve(copyRoot)), ceiling)) {
    for (const name of ANCESTOR_FILES) {
      const p = path.join(dir, ...name.split("/"));
      try {
        if (lstatSync(p).isFile()) out.push(p);
      } catch {
        // Not there.
      }
    }
    const rules: string[] = [];
    rulesUnder(path.join(dir, ".claude", "rules"), rules);
    out.push(...rules.sort());
  }
  return out;
}

export interface CopyLocation {
  underHome: boolean;
  userClaudeMd: boolean;
  /** Redacted paths. */
  ancestors: string[];
}

/**
 * Where the copy is, as a stated condition of the run: Claude Code reads
 * instruction files from every directory above the launch directory, and
 * for a copy inside the home directory that includes `~/.claude/CLAUDE.md`
 * as an ancestor's `.claude/CLAUDE.md` (on Windows the system temp directory
 * is inside the home directory).
 */
export function copyLocation(options: {
  repo: string;
  home: string;
  redactions: readonly Redaction[];
  ceiling?: string | undefined;
}): CopyLocation {
  return {
    underHome: isInsideReal(options.repo, options.home),
    userClaudeMd: existsSync(path.join(options.home, ".claude", "CLAUDE.md")),
    ancestors: ancestorInstructionFiles(options.repo, options.ceiling).map((p) => redactString(p, options.redactions)),
  };
}

export type CrossRow = "both" | "hook-blind" | "disagreement" | "echo-miss" | "neither";

export interface CrossEntry {
  trial: number;
  file: string;
  canary: "seen" | "not-seen" | "read-itself";
  hook: "fired" | "silent";
  /** The hook reports this file when it loads: anything but an AGENTS.md read through the Project instructions setting. */
  hookable: boolean;
  row: CrossRow | "undecided";
}

export interface HookReport {
  /** Usable trials with a hook log. */
  trials: number;
  /** Events from the trials' own sessions. */
  events: number;
  /** Events that carried another session's id (not counted anywhere else). */
  otherSession: number;
  rows: Record<CrossRow | "undecided", number>;
  /** Every `disagreement` and `echo-miss` entry. */
  listed: CrossEntry[];
  rates: {
    /** Hookable files the canary saw: in how many the hook fired. */
    hookGivenSeen: Fraction;
    /** Files the hook fired for (and the canary could decide): in how many the canary saw them. */
    seenGivenHook: Fraction;
    /** AGENTS.md files read through the setting that the canary saw: in how many the hook stayed silent. */
    agentsBlind: Fraction;
  };
  /** Files outside the copy the hook saw load, with their memory type, as recorded. */
  outside: string[];
  /** Files inside the copy the hook saw load that carry no token. */
  unplanted: string[];
  /** Usable trials in which the hook fired for the decoy. */
  decoyFired: number;
  /** Usable trials in which the positive control was seen and the hook stayed silent for it. */
  controlSilent: number;
}

export interface PartialEchoes extends Fraction {
  cases: { trial: number; file: string; repeated: "head" | "tail" }[];
}

/** One usable trial, as the instruments need it. */
export interface InstrumentTrial {
  trial: number;
  observations: Record<string, { seen: Observation } | undefined>;
  /** The trial's hook events; undefined when it has no hook log. */
  hooks: HookEvent[] | undefined;
}

interface FileCanaries {
  file: string;
  head?: Canary;
  tail?: Canary;
  decoy: boolean;
  control: boolean;
}

function byFile(canaries: readonly Canary[]): FileCanaries[] {
  const files = new Map<string, FileCanaries>();
  for (const c of canaries) {
    const f = files.get(c.file) ?? {
      file: c.file,
      decoy: c.decoy === true,
      control: c.control === true,
    };
    f[c.position] = c;
    files.set(c.file, f);
  }
  return [...files.values()];
}

/** An AGENTS.md that Claude Code reads through the Project instructions setting, which the hook does not report. */
export function hookBlind(file: string, predicted: PredictedFile): boolean {
  return path.posix.basename(file).toLowerCase() === "agents.md" && predicted.delivery !== "import";
}

/** The cross-table, its rates, and what the hook saw that no canary covers. */
export function hookReport(options: {
  repo: string;
  canaries: readonly Canary[];
  predictionFor: (c: Canary) => PredictedFile;
  trials: readonly InstrumentTrial[];
}): HookReport {
  const p = recordedPaths(options.repo);
  const files = byFile(options.canaries);
  const rows: HookReport["rows"] = {
    both: 0,
    "hook-blind": 0,
    disagreement: 0,
    "echo-miss": 0,
    neither: 0,
    undecided: 0,
  };
  const listed: CrossEntry[] = [];
  const outside = new Set<string>();
  const unplanted = new Set<string>();
  let trials = 0;
  let events = 0;
  let otherSession = 0;
  let decoyFired = 0;
  let controlSilent = 0;
  const rate = () => ({ k: 0, n: 0 });
  const rates = { hookGivenSeen: rate(), seenGivenHook: rate(), agentsBlind: rate() };

  for (const t of options.trials) {
    if (t.hooks === undefined) continue;
    trials++;
    const own = t.hooks.filter((e) => e.session !== "other");
    otherSession += t.hooks.length - own.length;
    events += own.length;
    const fired = (file: string) => own.some((e) => p.same(e.file_path, p.join(options.repo, ...file.split("/"))));
    for (const e of own) {
      if (!p.inside(e.file_path, options.repo)) outside.add(`${e.file_path} (${e.memory_type})`);
      else if (!files.some((f) => p.same(e.file_path, p.join(options.repo, ...f.file.split("/")))))
        unplanted.add(e.file_path);
    }
    for (const f of files) {
      const hook = fired(f.file) ? "fired" : "silent";
      if (f.decoy) {
        if (hook === "fired") decoyFired++;
        continue;
      }
      const seen = [f.head, f.tail].map((c) => (c ? t.observations[c.token]?.seen : undefined));
      const canary = seen.some((s) => s === "preloaded" || s === "on-read")
        ? "seen"
        : seen.some((s) => s === "self-discovered")
          ? "read-itself"
          : "not-seen";
      const anyCanary = f.head ?? f.tail;
      const predicted = anyCanary ? options.predictionFor(anyCanary) : undefined;
      const hookable = predicted ? !hookBlind(f.file, predicted) : true;
      let row: CrossEntry["row"];
      if (canary === "read-itself") row = "undecided";
      else if (canary === "seen") row = hook === "fired" ? "both" : hookable ? "disagreement" : "hook-blind";
      else row = hook === "fired" ? "echo-miss" : "neither";
      rows[row]++;
      const entry: CrossEntry = { trial: t.trial, file: f.file, canary, hook, hookable, row };
      if (row === "disagreement" || row === "echo-miss") listed.push(entry);
      if (f.control && canary === "seen" && hook === "silent") controlSilent++;
      if (canary === "seen" && hookable) {
        rates.hookGivenSeen.n++;
        if (hook === "fired") rates.hookGivenSeen.k++;
      }
      if (canary !== "read-itself" && hook === "fired") {
        rates.seenGivenHook.n++;
        if (canary === "seen") rates.seenGivenHook.k++;
      }
      if (canary === "seen" && !hookable) {
        rates.agentsBlind.n++;
        if (hook === "silent") rates.agentsBlind.k++;
      }
    }
  }
  return {
    trials,
    events,
    otherSession,
    rows,
    listed,
    rates,
    outside: [...outside].sort(),
    unplanted: [...unplanted].sort(),
    decoyFired,
    controlSilent,
  };
}

/**
 * Partial echoes: over usable trials and planted files (not the decoy) whose
 * head and tail are expected alike (not split by a cut), the pairs in which
 * exactly one of the two tokens was repeated, out of those in which at least one was.
 */
export function partialEchoes(options: {
  canaries: readonly Canary[];
  expectationFor: (c: Canary) => Expectation;
  trials: readonly Omit<InstrumentTrial, "hooks">[];
}): PartialEchoes {
  const out: PartialEchoes = { k: 0, n: 0, cases: [] };
  const files = byFile(options.canaries).filter(
    (f) => !f.decoy && f.head && f.tail && options.expectationFor(f.head) === options.expectationFor(f.tail),
  );
  for (const t of options.trials) {
    for (const f of files) {
      const head = (t.observations[f.head!.token]?.seen ?? "not-seen") !== "not-seen";
      const tail = (t.observations[f.tail!.token]?.seen ?? "not-seen") !== "not-seen";
      if (!head && !tail) continue;
      out.n++;
      if (head !== tail) {
        out.k++;
        out.cases.push({ trial: t.trial, file: f.file, repeated: head ? "head" : "tail" });
      }
    }
  }
  return out;
}
