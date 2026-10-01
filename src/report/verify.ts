import picocolors from "picocolors";
import { z } from "zod";
import type { OracleCell, VerifyResult } from "../oracle/score.js";
import type { Verdict } from "../probe/types.js";
import { table } from "./terminal.js";

type Colors = ReturnType<typeof picocolors.createColors>;

const TITLES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
const INSTRUMENTS: Record<string, string> = {
  render: "render (codex debug prompt-input)",
  capture: "capture (loopback endpoint)",
};

const VERDICT_LABELS: Record<Verdict, string> = {
  confirmed: "CONFIRMED",
  missed: "MISSED",
  extra: "EXTRA",
  discovered: "DISCOVERED",
  untested: "UNTESTED",
  "not-modelled": "NOT MODELLED",
  "no-data": "NO DATA",
};

function predictedText(c: OracleCell): string {
  const p = c.predicted;
  if (c.expected === "not-modelled") return `not modelled (${p.why.replace(/:?\s*not modelled$/, "")})`;
  switch (p.delivery) {
    case "decoy":
      return "decoy: no rule loads it";
    case "launch":
      return "launch";
    case "import":
      return p.needsApproval ? "launch (import, needs approval)" : "launch (import)";
    case "launch-cut":
      return c.expected === "launch" ? `launch (before the cut at ${p.cutAt})` : `no: past the cut at ${p.cutAt}`;
    case "on-read":
      return "on read (not preloaded)";
    case "maybe":
      return "not preloaded";
    case "not-loaded":
      return `no: ${p.why}`;
  }
}

export function observedText(c: OracleCell): string {
  if (c.usable === 0) return "no usable trial";
  return `delivered ${c.seen}/${c.usable}`;
}

function verdictText(c: OracleCell, result: VerifyResult, pc: Colors): string {
  if (c.decoy) return result.score.instrument.decoy.seen > 0 ? pc.red("control: FAULT") : pc.dim("control: ok");
  const label = VERDICT_LABELS[c.verdict];
  if (c.verdict === "confirmed" || c.verdict === "discovered") return pc.green(label);
  if (c.verdict === "missed" || c.verdict === "extra") return pc.red(label);
  return pc.yellow(label);
}

const n = (x: number) => x.toLocaleString("en-US");

export interface RenderOptions {
  color?: boolean;
}

export function renderVerify(result: VerifyResult, options: RenderOptions = {}): string {
  const pc = options.color === undefined ? picocolors : picocolors.createColors(options.color);
  const m = result.manifest;
  const s = result.score;
  const title = TITLES[m.agent] ?? m.agent;
  const count = (status: string) => s.trials.filter((t) => t.status === status).length;
  const usable = count("usable");
  const lines: string[] = [];
  lines.push(
    `${pc.bold("ctxreach verify")}  ${title} ${m.cliVersion}, ${INSTRUMENTS[m.instrument] ?? m.instrument}, launch dir ${m.launchDir}  (${m.sourceName})`,
  );
  lines.push(
    table([
      ["run", `${m.startedAt} on ${m.os.platform} ${m.os.release} (${m.os.arch})`],
      [
        "trials",
        `${s.trials.length} of ${m.trialsPlanned} recorded: ${usable} usable, ${count("failed")} failed, ${count("fault")} faulty`,
      ],
      ...(m.planted === false
        ? [
            [
              "tokens",
              "none planted (--no-plant): the bytes are the evidence; the decoy and the prompt token are the controls",
            ],
          ]
        : []),
      ...(m.codex
        ? [
            [
              "CODEX_HOME",
              `${m.codex.codexHome} (throwaway; seeded ${m.codex.seeded.from ? `from ${m.codex.seeded.from}: ${[...m.codex.seeded.keys, ...m.codex.seeded.globalFiles].join(", ") || "nothing to take"}` : "nothing"}; trust ${m.codex.seeded.trust})`,
            ],
            ...(m.codex.projectConfigs.length
              ? [["project config", m.codex.projectConfigs.map((l) => `${l.file} (${l.keys.join(", ")})`).join("; ")]]
              : []),
            ...(m.codex.mapMaxBytes !== undefined
              ? [["planted", `map predicted with project_doc_max_bytes = ${m.codex.mapMaxBytes}; Codex did not`]]
              : []),
          ]
        : []),
      ...(m.claude
        ? [
            [
              "isolation",
              m.claude.home !== undefined
                ? `scratch home ${m.claude.home} (CLAUDE_CONFIG_DIR unset)`
                : `fresh CLAUDE_CONFIG_DIR ${m.claude.configDir ?? "?"}`,
            ],
            ["model", `${m.claude.model} (pinned, asserted from system/init)`],
            ...(m.claude.mapMode !== undefined
              ? [
                  [
                    "planted",
                    `map predicted with Project instructions "${m.claude.mapMode}"; the session ran with "${m.claude.mode}"`,
                  ],
                ]
              : []),
          ]
        : []),
    ]),
  );
  for (const t of s.trials) {
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
  const rows = s.cells.map((c) => [
    c.decoy ? `${c.file} (decoy)` : c.file,
    c.position,
    predictedText(c),
    observedText(c),
    verdictText(c, result, pc),
  ]);
  lines.push(table([header, ...rows]));
  lines.push("");

  if (m.instrument === "render" && result.segments.length) {
    lines.push(pc.bold("Bytes, per chain file (first usable render)"));
    const segRows = result.segments.map((seg) => {
      const verdict =
        seg.verdict === "EXACT"
          ? pc.green("EXACT")
          : seg.verdict === "OFF BY"
            ? pc.red(`OFF BY ${seg.offBy !== undefined && seg.offBy > 0 ? "+" : ""}${n(seg.offBy ?? 0)}`)
            : pc.red(seg.verdict);
      return [
        seg.file,
        `kept ${n(seg.observedBytes)} of ${n(seg.bytes)} B (map: ${n(seg.predictedBytes)})`,
        verdict + (seg.note ? pc.dim(`  ${seg.note}`) : ""),
      ];
    });
    lines.push(table(segRows));
    lines.push("");
  }
  if (m.instrument === "capture" && result.delivered.length) {
    lines.push(pc.bold("Files in the request (first usable capture)"));
    lines.push(
      table(result.delivered.map((d) => [d.path, `${n(Buffer.byteLength(d.text, "utf8"))} B`, pc.dim(d.label)])),
    );
    lines.push("");
  }

  lines.push(pc.bold("Instrument"));
  lines.push(
    `  must-appear token from the prompt seen: ${s.instrument.control.seen}/${s.instrument.control.usable} usable trials (must be all)`,
  );
  lines.push(`  decoy delivered: ${s.instrument.decoy.seen}/${s.instrument.decoy.usable} usable trials (must be 0)`);
  if (s.instrument.fault) {
    lines.push(pc.red("  INSTRUMENT FAULT: the results above are void."));
    for (const r of s.instrument.reasons) lines.push(`    ${r}`);
  }

  if (!s.instrument.fault) {
    const a = s.agreement;
    const parts = (Object.keys(a.byVerdict) as Verdict[])
      .filter((v) => a.byVerdict[v] > 0)
      .map((v) => `${VERDICT_LABELS[v]} ${a.byVerdict[v]}`);
    lines.push("");
    lines.push(
      `${pc.bold("Agreement with map")}: ${a.agree} of ${a.decided} decided cells agree (${parts.join(", ") || "none"}); ${a.cells} cells in all.`,
    );
    if (m.instrument === "render" && result.segments.length) {
      const exact = result.segments.filter((x) => x.verdict === "EXACT").length;
      lines.push(
        `${pc.bold("Bytes")}: ${exact} of ${result.segments.length} chain files exact${result.whole ? "; the whole block equals map's prediction" : ""}.`,
      );
    }
  }
  if (s.warnings.length) {
    lines.push("");
    lines.push(pc.bold("Warnings"));
    for (const w of s.warnings) lines.push(`  ${pc.yellow("warn")}  ${w}`);
  }
  if (m.notes.length) {
    lines.push("");
    lines.push(pc.bold("Notes"));
    for (const note of m.notes) lines.push(`  ${note}`);
  }
  lines.push("");
  for (const w of result.wording) lines.push(pc.dim(w));
  lines.push(
    pc.dim(`Recording: ${result.recordingDir}  (re-score with: ctxreach verify --agent ${m.agent} --replay <dir>)`),
  );
  return lines.join("\n") + "\n";
}

const VerdictJson = z.enum(["confirmed", "missed", "extra", "discovered", "untested", "not-modelled", "no-data"]);

export const VerifyJson = z.object({
  schema: z.literal("ctxreach.verify/v1"),
  ctxreach: z.string(),
  agent: z.enum(["claude", "codex"]),
  instrument: z.enum(["render", "capture"]),
  cliVersion: z.string(),
  os: z.object({ platform: z.string(), release: z.string(), arch: z.string() }),
  startedAt: z.string(),
  launchDir: z.string(),
  sourceName: z.string(),
  trials: z.array(
    z.object({
      trial: z.number().int(),
      status: z.enum(["usable", "fault", "failed"]),
      reasons: z.array(z.string()),
      controlSeen: z.boolean(),
      decoySeen: z.array(z.string()),
      inventedTokens: z.array(z.string()),
    }),
  ),
  cells: z.array(
    z.object({
      file: z.string(),
      position: z.enum(["head", "tail"]),
      token: z.string(),
      decoy: z.boolean(),
      predicted: z.object({ delivery: z.string(), why: z.string(), rule: z.string() }),
      expected: z.enum(["launch", "on-read", "on-match", "not-preloaded", "never", "not-modelled"]),
      seen: z.number().int(),
      usable: z.number().int(),
      fraction: z.string(),
      verdict: VerdictJson,
    }),
  ),
  segments: z.array(
    z.object({
      file: z.string(),
      status: z.string(),
      bytes: z.number().int(),
      predictedBytes: z.number().int(),
      observedBytes: z.number().int(),
      verdict: z.enum(["EXACT", "OFF BY", "MISSING", "EXTRA"]),
      offBy: z.number().int().optional(),
      note: z.string().optional(),
    }),
  ),
  delivered: z.array(z.object({ path: z.string(), label: z.string(), bytes: z.number().int() })),
  instrument_checks: z.object({
    fault: z.boolean(),
    reasons: z.array(z.string()),
    control: z.object({ seen: z.number().int(), usable: z.number().int() }),
    decoy: z.object({ seen: z.number().int(), usable: z.number().int() }),
  }),
  /** null after an instrument fault: the verdicts are void. */
  agreement: z
    .object({
      agree: z.number().int(),
      decided: z.number().int(),
      cells: z.number().int(),
      byVerdict: z.record(VerdictJson, z.number().int()),
      bytesExact: z.number().int(),
      bytesCompared: z.number().int(),
    })
    .nullable(),
  warnings: z.array(z.string()),
  notes: z.array(z.string()),
  scope: z.array(z.string()),
});

export type VerifyJson = z.infer<typeof VerifyJson>;

export function verifyJson(result: VerifyResult): VerifyJson {
  const m = result.manifest;
  const s = result.score;
  const out: VerifyJson = {
    schema: "ctxreach.verify/v1",
    ctxreach: m.ctxreach,
    agent: m.agent,
    instrument: m.instrument,
    cliVersion: m.cliVersion,
    os: m.os,
    startedAt: m.startedAt,
    launchDir: m.launchDir,
    sourceName: m.sourceName,
    trials: s.trials.map((t) => ({
      trial: t.trial,
      status: t.status,
      reasons: t.reasons,
      controlSeen: t.controlSeen,
      decoySeen: t.decoySeen,
      inventedTokens: t.inventedTokens,
    })),
    cells: s.cells.map((c) => ({
      file: c.file,
      position: c.position,
      token: c.token,
      decoy: c.decoy,
      predicted: { delivery: c.predicted.delivery, why: c.predicted.why, rule: c.predicted.rule },
      expected: c.expected,
      seen: c.seen,
      usable: c.usable,
      fraction: `${c.seen}/${c.usable}`,
      verdict: c.verdict,
    })),
    segments: result.segments,
    delivered: result.delivered.map((d) => ({
      path: d.path,
      label: d.label,
      bytes: Buffer.byteLength(d.text, "utf8"),
    })),
    instrument_checks: s.instrument,
    agreement: s.instrument.fault
      ? null
      : {
          ...s.agreement,
          bytesExact: result.segments.filter((x) => x.verdict === "EXACT").length,
          bytesCompared: result.segments.length,
        },
    warnings: s.warnings,
    notes: m.notes,
    scope: result.wording,
  };
  return VerifyJson.parse(out);
}
