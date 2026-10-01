import picocolors from "picocolors";
import { z } from "zod";
import type { CellScore, ProbeResult } from "../probe/score.js";
import type { Verdict } from "../probe/types.js";
import { table } from "./terminal.js";

type Colors = ReturnType<typeof picocolors.createColors>;

const TITLES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

/** Printed with every result, in the terminal and in JSON. */
export function scopeStatements(result: ProbeResult): string[] {
  const m = result.manifest;
  const title = TITLES[m.agent] ?? m.agent;
  return [
    "An echo proves the text was delivered to the model. It does not prove the model follows it.",
    `These results hold only for ${title} ${m.cliVersion} on ${m.os.platform} ${m.os.release}, on ${m.startedAt.slice(0, 10)}, with this repository and prompt.`,
    "Each fraction counts usable trials only; contaminated, failed and faulty trials are listed separately.",
  ];
}

function predictedText(c: CellScore): string {
  const p = c.predicted;
  if (c.expected === "not-modelled") return `not modelled (${p.why.replace(/:?\s*not modelled$/, "")})`;
  if (c.control && p.rule === "control") return "launch (positive control)";
  switch (p.delivery) {
    case "decoy":
      return "decoy: no rule loads it";
    case "launch":
      return "launch";
    case "import":
      // Recordings made before needsApproval was recorded carry it only in the reason.
      return p.needsApproval || /needs approval|already approved/.test(p.why)
        ? "launch (import, needs approval)"
        : "launch (import)";
    case "launch-cut":
      return c.expected === "launch" ? `launch (before the cut at ${p.cutAt})` : `no: past the cut at ${p.cutAt}`;
    case "on-read":
      return c.expected === "on-match" ? "on read of a matching file" : "on read";
    case "maybe":
      return "not preloaded";
    case "not-loaded":
      return `no: ${p.why}`;
  }
}

const OBS_LABELS: [keyof CellScore["seen"], string][] = [
  ["preloaded", "preloaded"],
  ["on-read", "on read"],
  ["self-discovered", "self-discovered"],
  ["not-seen", "not seen"],
];

export function observedText(c: CellScore, mode: string): string {
  if (c.usable === 0) return "no usable trial";
  const parts = OBS_LABELS.filter(([k]) => c.seen[k] > 0).map(([k, label]) => `${label} ${c.seen[k]}/${c.usable}`);
  // In task mode, how often the agent read a file that could have triggered delivery on read.
  if (mode === "task" && (c.expected === "on-read" || c.expected === "on-match" || c.dirRead > 0))
    parts.push(`read in its dir ${c.dirRead}/${c.usable}`);
  return parts.join(", ");
}

const VERDICT_LABELS: Record<Verdict, string> = {
  confirmed: "CONFIRMED",
  missed: "MISSED",
  extra: "EXTRA",
  discovered: "DISCOVERED",
  untested: "UNTESTED",
  "not-modelled": "NOT MODELLED",
  "no-data": "NO DATA",
};

function verdictText(c: CellScore, result: ProbeResult, pc: Colors): string {
  if (c.decoy) return result.instrument.decoy.echoed > 0 ? pc.red("control: FAULT") : pc.dim("control: ok");
  if (c.control) {
    const ctl = result.instrument.control;
    if (ctl.status !== "planted") return pc.yellow("positive control: n/a");
    return ctl.missed > 0 ? pc.red("positive control: FAULT") : pc.dim("positive control: ok");
  }
  const label = VERDICT_LABELS[c.verdict];
  if (c.verdict === "confirmed" || c.verdict === "discovered") return pc.green(label);
  if (c.verdict === "missed" || c.verdict === "extra") return pc.red(label);
  return pc.yellow(label);
}

/** The header rows for how the sessions ran and where the copy was; none for a recording made before they were recorded. */
function sessionRows(result: ProbeResult): string[][] {
  const m = result.manifest;
  const rows: string[][] = [];
  const s = m.session;
  if (s) {
    const model = s.model ? `model pinned to ${s.model.pin} (from ${s.model.from})` : "model not pinned";
    const isolation = s.isolation === "clean" ? "isolation clean (EXPERIMENTAL)" : "isolation machine";
    rows.push(["session", `${model}; InstructionsLoaded hook ${s.hook ? "on" : "off"}; ${isolation}`]);
  }
  const l = m.location;
  if (l)
    rows.push([
      "copy",
      `inside the home directory: ${l.underHome ? "yes" : "no"}; ~/.claude/CLAUDE.md exists: ${l.userClaudeMd ? "yes" : "no"}; instruction files above the copy: ${l.ancestors.length || "none"}`,
    ]);
  return rows;
}

/** The positive control's line in the Instrument section. */
export function controlText(result: ProbeResult): string {
  const c = result.instrument.control;
  if (c.status === "absent")
    return "positive control: absent (recorded before F5; so were the hook, the model pin and the copy's location)";
  if (c.status === "not-applicable")
    return `positive control: not applicable (${c.why ?? "map says it does not load"})`;
  const read = c.readItself ? `, ${c.readItself} after the model opened it` : "";
  return `positive control repeated: ${c.echoed + c.readItself}/${c.checked} trials${read} (must be ${c.checked}/${c.checked})`;
}

const ROW_LABELS: [keyof NonNullable<ProbeResult["instrument"]["hook"]>["rows"], string][] = [
  ["both", "both"],
  ["hook-blind", "hook-blind (AGENTS.md)"],
  ["disagreement", "hook missed"],
  ["echo-miss", "echo missed"],
  ["neither", "neither"],
  ["undecided", "read by the model"],
];

/** The hook's lines in the Instrument section. */
export function hookLines(result: ProbeResult): string[] {
  const s = result.manifest.session;
  if (!s) return [];
  const h = result.instrument.hook;
  if (!s.hook || !h) return ["InstructionsLoaded hook: off"];
  const f = (x: { k: number; n: number }) => `${x.k}/${x.n}`;
  const out = [
    `InstructionsLoaded hook: ${h.events} events in ${h.trials} usable trials`,
    `  canary x hook, per file and trial: ${ROW_LABELS.map(([k, label]) => `${label} ${h.rows[k]}`).join(", ")}`,
    `  hook fired where the canary saw a hookable file: ${f(h.rates.hookGivenSeen)}; canary saw where the hook fired: ${f(h.rates.seenGivenHook)}; hook silent on AGENTS.md the canary saw: ${f(h.rates.agentsBlind)}`,
  ];
  for (const e of h.listed)
    out.push(
      `  trial ${e.trial} ${e.file}: canary ${e.canary}, hook ${e.hook} (${e.row === "echo-miss" ? "echo missed" : "hook missed"})`,
    );
  return out;
}

export interface RenderOptions {
  /** false: no colour codes at all (`--no-color`). Default: picocolors decides (NO_COLOR, the terminal). */
  color?: boolean;
}

export function renderProbe(result: ProbeResult, options: RenderOptions = {}): string {
  const pc = options.color === undefined ? picocolors : picocolors.createColors(options.color);
  const m = result.manifest;
  const title = TITLES[m.agent] ?? m.agent;
  const count = (s: string) => result.trials.filter((t) => t.status === s).length;
  const usable = count("usable");
  const lines: string[] = [];
  lines.push(
    `${pc.bold("ctxreach probe")}  ${title} ${m.cliVersion}, ${m.mode} mode, launch dir ${m.launchDir}  (${m.sourceName})`,
  );
  lines.push(
    table([
      [
        "run",
        `${m.startedAt} on ${m.os.platform} ${m.os.release} (${m.os.arch})${result.models.length ? `, model ${result.models.join(", ")}` : ""}`,
      ],
      [
        "trials",
        `${result.trials.length} of ${m.trialsPlanned} recorded: ${usable} usable, ${count("contaminated")} contaminated, ${count("failed")} failed, ${count("fault")} faulty`,
      ],
      ...sessionRows(result),
    ]),
  );
  for (const t of result.trials) {
    if (t.status === "usable") continue;
    lines.push(`    trial ${t.trial} ${t.status}: ${t.reasons.join("; ")}`);
  }
  lines.push("");

  const header = [
    pc.dim("file"),
    pc.dim("token"),
    pc.dim("map predicts"),
    pc.dim(`observed (of ${usable} usable)`),
    pc.dim("verdict"),
  ];
  const rows = result.cells.map((c) => [
    c.decoy ? `${c.file} (decoy)` : c.control ? `${c.file} (positive control)` : c.file,
    c.position,
    predictedText(c),
    observedText(c, m.mode),
    verdictText(c, result, pc),
  ]);
  lines.push(table([header, ...rows]));
  lines.push("");

  lines.push(pc.bold("Instrument"));
  const d = result.instrument.decoy;
  lines.push(`  decoy repeated without being read: ${d.echoed}/${d.usable} usable trials (must be 0)`);
  lines.push(`  ${controlText(result)}`);
  if (result.instrument.fault) {
    lines.push(pc.red("  INSTRUMENT FAULT: the results above are void."));
    for (const r of result.instrument.reasons) lines.push(`    ${r}`);
  }
  const unknown = result.trials.reduce((n, t) => n + Object.values(t.unknownEvents).reduce((a, b) => a + b, 0), 0);
  const events = result.trials.reduce((n, t) => n + t.events, 0);
  lines.push(`  stream events not understood: ${unknown} of ${events} (tolerated, counted)`);
  lines.push(...hookLines(result).map((l) => `  ${l}`));
  const pe = result.instrument.partial;
  lines.push(`  partial echoes (one of a file's two tokens repeated): ${pe.k}/${pe.n} file-trials`);
  for (const c of pe.cases) lines.push(`    trial ${c.trial} ${c.file}: only the ${c.repeated}`);

  // After an instrument fault the verdicts are void, so no agreement figure is given.
  if (!result.instrument.fault) {
    const a = result.agreement;
    const parts = (Object.keys(a.byVerdict) as Verdict[])
      .filter((v) => a.byVerdict[v] > 0)
      .map((v) => `${VERDICT_LABELS[v]} ${a.byVerdict[v]}`);
    lines.push("");
    lines.push(
      `${pc.bold("Agreement with map")}: ${a.agree} of ${a.decided} decided cells agree (${parts.join(", ") || "none"}); ${a.cells} cells in all.`,
    );
  }
  if (result.warnings.length) {
    lines.push("");
    lines.push(pc.bold("Warnings"));
    for (const w of result.warnings) lines.push(`  ${pc.yellow("warn")}  ${w}`);
  }
  if (result.notes.length) {
    lines.push("");
    lines.push(pc.bold("Notes"));
    for (const n of result.notes) lines.push(`  ${n}`);
  }
  lines.push("");
  for (const s of scopeStatements(result)) lines.push(pc.dim(s));
  lines.push(pc.dim(`Recording: ${result.recordingDir}  (re-score with: ctxreach probe --replay <dir>)`));
  return lines.join("\n") + "\n";
}

const Counts = z.object({
  preloaded: z.number().int(),
  "on-read": z.number().int(),
  "self-discovered": z.number().int(),
  "not-seen": z.number().int(),
});
const VerdictJson = z.enum(["confirmed", "missed", "extra", "discovered", "untested", "not-modelled", "no-data"]);
/** A fraction as "k/n". */
const FractionJson = z.string().regex(/^\d+\/\d+$/);
const RowsJson = z.object({
  both: z.number().int(),
  "hook-blind": z.number().int(),
  disagreement: z.number().int(),
  "echo-miss": z.number().int(),
  neither: z.number().int(),
  undecided: z.number().int(),
});

/** v1 plus, additively: the positive control, the hook and partial echoes under `instrument`, `cells[].control`, `session` and `location`. */
export const PROBE_JSON_SCHEMA = "ctxreach.probe/v2";

export const ProbeJson = z.object({
  schema: z.literal(PROBE_JSON_SCHEMA),
  ctxreach: z.string(),
  agent: z.enum(["claude", "codex"]),
  cliVersion: z.string(),
  os: z.object({ platform: z.string(), release: z.string(), arch: z.string() }),
  startedAt: z.string(),
  mode: z.enum(["recall", "task"]),
  launchDir: z.string(),
  models: z.array(z.string()),
  trials: z.array(
    z.object({
      trial: z.number().int(),
      status: z.enum(["usable", "contaminated", "failed", "fault"]),
      reasons: z.array(z.string()),
      toolCalls: z.number().int(),
      toolNames: z.array(z.string()),
      inventedTokens: z.array(z.string()),
    }),
  ),
  cells: z.array(
    z.object({
      file: z.string(),
      position: z.enum(["head", "tail"]),
      token: z.string(),
      decoy: z.boolean(),
      control: z.boolean(),
      predicted: z.object({ delivery: z.string(), why: z.string(), rule: z.string() }),
      expected: z.enum(["launch", "on-read", "on-match", "not-preloaded", "never", "not-modelled"]),
      seen: Counts,
      usable: z.number().int(),
      dirRead: z.number().int(),
      /** Each count as a fraction of usable trials, e.g. "3/3". */
      fractions: z.record(z.string(), z.string()),
      verdict: VerdictJson,
    }),
  ),
  instrument: z.object({
    fault: z.boolean(),
    reasons: z.array(z.string()),
    decoy: z.object({ echoed: z.number().int(), usable: z.number().int() }),
    control: z.object({
      status: z.enum(["absent", "not-applicable", "planted"]),
      file: z.string().optional(),
      why: z.string().optional(),
      echoed: z.number().int(),
      readItself: z.number().int(),
      missed: z.number().int(),
      checked: z.number().int(),
      /** Trials in which it was repeated, of the trials checked. */
      fraction: FractionJson,
    }),
    /** null when the run had no hook (or was recorded before it). */
    hook: z
      .object({
        trials: z.number().int(),
        events: z.number().int(),
        otherSession: z.number().int(),
        rows: RowsJson,
        listed: z.array(
          z.object({
            trial: z.number().int(),
            file: z.string(),
            canary: z.enum(["seen", "not-seen", "read-itself"]),
            hook: z.enum(["fired", "silent"]),
            hookable: z.boolean(),
            row: z.enum(["both", "hook-blind", "disagreement", "echo-miss", "neither", "undecided"]),
          }),
        ),
        rates: z.object({ hookGivenSeen: FractionJson, seenGivenHook: FractionJson, agentsBlind: FractionJson }),
        outside: z.array(z.string()),
        unplanted: z.array(z.string()),
        decoyFired: z.number().int(),
        controlSilent: z.number().int(),
      })
      .nullable(),
    partial: z.object({
      fraction: FractionJson,
      cases: z.array(z.object({ trial: z.number().int(), file: z.string(), repeated: z.enum(["head", "tail"]) })),
    }),
  }),
  /** How the sessions ran; null for a recording made before it was recorded. */
  session: z
    .object({
      args: z.array(z.string()),
      model: z.object({ pin: z.string(), from: z.string() }).nullable(),
      hook: z.boolean(),
      isolation: z.enum(["machine", "clean"]),
      experimental: z.boolean(),
    })
    .nullable(),
  /** Where the copy was; null for a recording made before it was recorded. */
  location: z.object({ underHome: z.boolean(), userClaudeMd: z.boolean(), ancestors: z.array(z.string()) }).nullable(),
  /** null after an instrument fault: the verdicts are void, so there is no agreement figure. */
  agreement: z
    .object({
      agree: z.number().int(),
      decided: z.number().int(),
      cells: z.number().int(),
      byVerdict: z.record(VerdictJson, z.number().int()),
    })
    .nullable(),
  warnings: z.array(z.string()),
  notes: z.array(z.string()),
  scope: z.array(z.string()),
});

export type ProbeJson = z.infer<typeof ProbeJson>;

export function probeJson(result: ProbeResult): ProbeJson {
  const m = result.manifest;
  const out: ProbeJson = {
    schema: PROBE_JSON_SCHEMA,
    ctxreach: m.ctxreach,
    agent: m.agent,
    cliVersion: m.cliVersion,
    os: m.os,
    startedAt: m.startedAt,
    mode: m.mode,
    launchDir: m.launchDir,
    models: result.models,
    trials: result.trials.map((t) => ({
      trial: t.trial,
      status: t.status,
      reasons: t.reasons,
      toolCalls: t.toolCalls,
      toolNames: t.toolNames,
      inventedTokens: t.inventedTokens,
    })),
    cells: result.cells.map((c) => ({
      file: c.file,
      position: c.position,
      token: c.token,
      decoy: c.decoy,
      control: c.control,
      predicted: { delivery: c.predicted.delivery, why: c.predicted.why, rule: c.predicted.rule },
      expected: c.expected,
      seen: c.seen,
      usable: c.usable,
      dirRead: c.dirRead,
      fractions: Object.fromEntries(Object.entries(c.seen).map(([k, v]) => [k, `${v}/${c.usable}`])),
      verdict: c.verdict,
    })),
    instrument: instrumentJson(result),
    session: m.session
      ? {
          args: m.session.args,
          model: m.session.model,
          hook: m.session.hook,
          isolation: m.session.isolation,
          experimental: m.session.isolation === "clean",
        }
      : null,
    location: m.location ?? null,
    agreement: result.instrument.fault ? null : result.agreement,
    warnings: result.warnings,
    notes: result.notes,
    scope: scopeStatements(result),
  };
  return ProbeJson.parse(out);
}

function instrumentJson(result: ProbeResult): ProbeJson["instrument"] {
  const i = result.instrument;
  const f = (x: { k: number; n: number }) => `${x.k}/${x.n}`;
  return {
    fault: i.fault,
    reasons: i.reasons,
    decoy: i.decoy,
    control: { ...i.control, fraction: f({ k: i.control.echoed + i.control.readItself, n: i.control.checked }) },
    hook: i.hook
      ? {
          ...i.hook,
          rates: {
            hookGivenSeen: f(i.hook.rates.hookGivenSeen),
            seenGivenHook: f(i.hook.rates.seenGivenHook),
            agentsBlind: f(i.hook.rates.agentsBlind),
          },
        }
      : null,
    partial: { fraction: f(i.partial), cases: i.partial.cases },
  };
}
