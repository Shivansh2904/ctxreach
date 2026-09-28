import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/agents/claude/adapter.js";
import { parseClaudeTranscript } from "../src/agents/claude/events.js";
import { readRecording } from "../src/probe/recording.js";
import { scoreRecording, type ProbeResult } from "../src/probe/score.js";
import { createCli } from "../src/program.js";
import { observedText } from "../src/report/probe.js";

// Real runs of Claude Code 2.1.280 on Windows, recorded on 2026-09-28 with
// `ctxreach probe --save test/recorded/<name>` (commands in
// test/recorded/README.md). Replaying them needs no agent. Every number
// below is what those runs produced; a change that alters one is a change in
// what the README reports.
const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "recorded");

const transcripts = readdirSync(RECORDED)
  .filter((d) => d !== "sources" && !d.endsWith(".md"))
  .flatMap((d) =>
    readdirSync(path.join(RECORDED, d))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => `${d}/${f}`),
  );

describe("parsing real claude -p stream-json transcripts", () => {
  it("has recorded transcripts to test against", () => {
    expect(transcripts.length).toBeGreaterThanOrEqual(20);
  });

  it.each(transcripts)("%s parses, finishes, and names its session", (rel) => {
    const t = parseClaudeTranscript(readFileSync(path.join(RECORDED, rel), "utf8"));
    expect(t.finished).toBe(true);
    expect(t.isError).toBe(false);
    expect(t.cliVersion).toBe("2.1.280");
    expect(t.cwd).toMatch(/^C:\\ctxreach-probe\\repo/);
    expect(t.items.some((i) => i.kind === "text")).toBe(true);
    // Only one kind of event in all the recordings is unknown to the parser.
    expect(Object.keys(t.events.unknown).filter((k) => k !== "system/thinking_tokens")).toEqual([]);
  });
});

function replay(name: string): ProbeResult {
  return scoreRecording(readRecording(path.join(RECORDED, name)), claudeAdapter());
}

/** One line per canary: "file position: observed -> VERDICT". */
function lines(r: ProbeResult): string[] {
  return r.cells.map(
    (c) =>
      `${c.file} ${c.position}: ${observedText(c, r.manifest.mode)} -> ${c.decoy ? "control" : c.verdict.toUpperCase()}`,
  );
}

const both = (file: string, observed: string, verdict: string) => [
  `${file} head: ${observed} -> ${verdict}`,
  `${file} tail: ${observed} -> ${verdict}`,
];

describe("replaying the recorded real runs", () => {
  it("demo monorepo from packages/api, recall: CLAUDE.local.md switches every AGENTS.md off", () => {
    const r = replay("demo-api-recall");
    expect(r.manifest).toMatchObject({ cliVersion: "2.1.280", mode: "recall", launchDir: "packages/api" });
    expect(r.trials.map((t) => t.status)).toEqual(["usable", "usable", "usable"]);
    expect(lines(r)).toEqual([
      ...both("AGENTS.md", "not seen 3/3", "CONFIRMED"),
      ...both("CLAUDE.local.md", "preloaded 3/3", "CONFIRMED"),
      ...both("packages/api/AGENTS.md", "not seen 3/3", "CONFIRMED"),
      ...both("packages/web/AGENTS.md", "not seen 3/3", "CONFIRMED"),
      ...both("packages/api/ctxreach-decoy.md", "not seen 3/3", "control"),
    ]);
    expect(r.instrument).toEqual({ fault: false, reasons: [], decoy: { echoed: 0, usable: 3 } });
    expect(r.agreement).toMatchObject({ agree: 8, decided: 8, cells: 8 });
  });

  it("demo monorepo from the root, task: reading payments.ts does not bring in the switched-off AGENTS.md", () => {
    const r = replay("demo-root-task");
    expect(lines(r)).toEqual([
      ...both("AGENTS.md", "not seen 3/3", "CONFIRMED"),
      ...both("CLAUDE.local.md", "preloaded 3/3", "CONFIRMED"),
      ...both("packages/api/AGENTS.md", "not seen 3/3, read in its dir 3/3", "CONFIRMED"),
      ...both("packages/web/AGENTS.md", "not seen 3/3", "CONFIRMED"),
      ...both("ctxreach-decoy.md", "not seen 3/3", "control"),
    ]);
    expect(r.trials.every((t) => t.toolNames.includes("Read"))).toBe(true);
    expect(r.warnings).toEqual([
      "Stream events of kinds ctxreach does not know were tolerated and counted: system/thinking_tokens (6).",
    ]);
  });

  it("CLAUDE.md family from the root, recall: imports and path-less rules preload, the rest wait", () => {
    const r = replay("nested-recall");
    expect(lines(r)).toEqual([
      ...both(".claude/rules/api-only.md", "not seen 2/2", "CONFIRMED"),
      ...both(".claude/rules/style.md", "preloaded 2/2", "CONFIRMED"),
      ...both("AGENTS.md", "not seen 2/2", "CONFIRMED"),
      ...both("CLAUDE.md", "preloaded 2/2", "CONFIRMED"),
      ...both("docs/testing.md", "preloaded 2/2", "CONFIRMED"),
      ...both("packages/api/CLAUDE.md", "not seen 2/2", "CONFIRMED"),
      ...both("packages/web/AGENTS.md", "not seen 2/2", "CONFIRMED"),
      ...both("ctxreach-decoy.md", "not seen 2/2", "control"),
    ]);
  });

  it("CLAUDE.md family from the root, task: a read in packages/api delivers its CLAUDE.md and the scoped rule", () => {
    const r = replay("nested-task");
    expect(lines(r)).toEqual([
      ...both(".claude/rules/api-only.md", "on read 3/3, read in its dir 3/3", "CONFIRMED"),
      ...both(".claude/rules/style.md", "preloaded 3/3", "CONFIRMED"),
      ...both("AGENTS.md", "not seen 3/3", "CONFIRMED"),
      ...both("CLAUDE.md", "preloaded 3/3", "CONFIRMED"),
      ...both("docs/testing.md", "preloaded 3/3", "CONFIRMED"),
      ...both("packages/api/CLAUDE.md", "on read 3/3, read in its dir 3/3", "CONFIRMED"),
      ...both("packages/web/AGENTS.md", "not seen 3/3", "CONFIRMED"),
      ...both("ctxreach-decoy.md", "not seen 3/3", "control"),
    ]);
  });

  it("AGENTS.md only, recall and task: the root file preloads, a nested one arrives on read", () => {
    expect(lines(replay("agents-recall"))).toEqual([
      ...both("AGENTS.md", "preloaded 2/2", "CONFIRMED"),
      ...both("packages/api/AGENTS.md", "not seen 2/2", "CONFIRMED"),
      ...both("packages/web/AGENTS.md", "not seen 2/2", "CONFIRMED"),
      ...both("ctxreach-decoy.md", "not seen 2/2", "control"),
    ]);
    const task = replay("agents-task");
    expect(lines(task)).toEqual([
      ...both("AGENTS.md", "preloaded 3/3", "CONFIRMED"),
      ...both("packages/api/AGENTS.md", "on read 3/3, read in its dir 3/3", "CONFIRMED"),
      ...both("packages/web/AGENTS.md", "not seen 3/3, read in its dir 0/3", "UNTESTED"),
      ...both("ctxreach-decoy.md", "not seen 3/3", "control"),
    ]);
    expect(task.agreement).toMatchObject({ agree: 4, decided: 4, cells: 6 });
  });

  it("CLAUDE.md family from packages/api, recall: two disagreements with map", () => {
    const r = replay("nested-api-recall");
    expect(lines(r)).toEqual([
      ...both(".claude/rules/api-only.md", "not seen 2/2", "CONFIRMED"),
      // map does not model an ancestor's rules and shows them as not loaded; this one was preloaded.
      ...both(".claude/rules/style.md", "preloaded 2/2", "EXTRA"),
      ...both("AGENTS.md", "not seen 2/2", "CONFIRMED"),
      ...both("CLAUDE.md", "preloaded 2/2", "CONFIRMED"),
      // An import from outside the launch directory, which map says needs approval: not loaded under -p.
      ...both("docs/testing.md", "not seen 2/2", "MISSED"),
      ...both("packages/api/CLAUDE.md", "preloaded 2/2", "CONFIRMED"),
      ...both("packages/web/AGENTS.md", "not seen 2/2", "CONFIRMED"),
      ...both("packages/api/ctxreach-decoy.md", "not seen 2/2", "control"),
    ]);
    expect(r.instrument.fault).toBe(false);
    expect(r.agreement).toMatchObject({ agree: 10, decided: 14 });
    expect(r.manifest.predicted.find((f) => f.file === "docs/testing.md")?.why).toContain("needs approval");
  });

  it("an ancestor's imports: the one inside the launch directory loads, the one outside does not", () => {
    expect(lines(replay("ancestor-imports-recall"))).toEqual([
      ...both("CLAUDE.md", "preloaded 2/2", "CONFIRMED"),
      ...both("docs/outside.md", "not seen 2/2", "MISSED"),
      ...both("packages/api/inside.md", "preloaded 2/2", "CONFIRMED"),
      ...both("packages/api/ctxreach-decoy.md", "not seen 2/2", "control"),
    ]);
  });

  it("prints the README's example from the recording, with no agent", async () => {
    let stdout = "";
    const cli = createCli({ stdout: (t) => (stdout += t), stderr: () => undefined }, { exitOverride: true });
    await cli.program.parseAsync([
      "node",
      "ctxreach",
      "probe",
      "--replay",
      path.join(RECORDED, "demo-api-recall"),
      "--no-color",
    ]);
    expect(cli.status).toBe(0);
    // eslint-disable-next-line no-control-regex
    const plain = stdout.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain(
      "ctxreach probe  Claude Code 2.1.280, recall mode, launch dir packages/api  (demo-monorepo)",
    );
    expect(plain).toContain("Agreement with map: 8 of 8 decided cells agree (CONFIRMED 8); 8 cells in all.");
  });
});
