import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readVerifyRecording } from "../src/oracle/recording.js";
import { scoreVerify } from "../src/oracle/verify.js";
import { verifyJson, type VerifyJson } from "../src/report/verify.js";
// @ts-expect-error -- plain JavaScript script without type declarations
import { launchesFor, parseArgs, PLANTED, recordFrom, summarise } from "../scripts/conformance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = path.join(HERE, "recorded", "verify");

function pilot(name: string): VerifyJson {
  return verifyJson(scoreVerify(readVerifyRecording(path.join(RECORDED, name))));
}

describe("scripts/conformance.mjs", () => {
  it("runs every fixture named after an agent, from each launch directory that exists", () => {
    const launches = launchesFor(path.join(HERE, "fixtures"), ["codex", "claude"]) as {
      fixture: string;
      agent: string;
      launchDir: string;
    }[];
    expect(launches.filter((l) => l.agent === "codex")).toHaveLength(22);
    expect(launches.filter((l) => l.agent === "claude").length).toBeGreaterThanOrEqual(14);
    expect(launches.every((l) => l.fixture.startsWith(`${l.agent}-`))).toBe(true);
    expect(launches.filter((l) => l.fixture === "codex-over-cap").map((l) => l.launchDir)).toEqual(["."]);
    expect(launches.filter((l) => l.fixture === "codex-root-starves-nested").map((l) => l.launchDir)).toEqual([
      ".",
      "packages/api",
    ]);
    expect(launchesFor(path.join(HERE, "fixtures"), ["codex"], "codex-utf8-cut")).toHaveLength(1);
  });

  it("plants a wrong budget for Codex and a wrong mode for Claude Code, on a fixture where that must disagree", () => {
    expect(PLANTED).toEqual({
      codex: { fixture: "codex-over-cap", launchDir: ".", flags: ["--codex-max-bytes", "30000"] },
      claude: { fixture: "claude-local-shadows-agents-twin", launchDir: ".", flags: ["--claude-mode", "claude-md"] },
    });
  });

  it("turns a verify --json output into one record with the fields the site reads", () => {
    const json = pilot("capture-pilot-A");
    const record = recordFrom(json, { fixture: "cfx-A", agent: "claude", launchDir: "." }) as Record<string, unknown>;
    expect(record).toMatchObject({
      fixture: "cfx-A",
      launchDir: ".",
      agent: "claude",
      version: "2.1.285",
      os: "win32 10.0.26200 x64",
      instrument: "capture",
      verdict: "agree",
      predicted: ["../.claude/CLAUDE.md", ".claude/rules/style.md"],
      observed: ["../.claude/CLAUDE.md", ".claude/rules/style.md"],
      keptBytes: null,
    });
    expect(record.date).toBe(json.startedAt);
    expect((record.cells as { verdict: string }[]).map((c) => c.verdict)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
      "confirmed",
      "confirmed",
    ]);
    expect(record.controls).toMatchObject({ control: { seen: 1, usable: 1 }, decoy: { seen: 0, usable: 1 } });
  });

  it("calls a run with a MISSED or EXTRA cell a disagreement, a faulty run a fault, and counts them", () => {
    const json = pilot("capture-pilot-B");
    const agree = recordFrom(json, { fixture: "b", agent: "claude", launchDir: "." }) as { verdict: string };
    expect(agree.verdict).toBe("agree");
    const cell = json.cells.find((c) => c.file === "AGENTS.md");
    if (!cell) throw new Error("no AGENTS.md cell");
    const disagree = recordFrom(
      { ...json, cells: json.cells.map((c) => (c === cell ? { ...c, verdict: "missed" } : c)) },
      { fixture: "b", agent: "claude", launchDir: "." },
    ) as { verdict: string };
    expect(disagree.verdict).toBe("disagree");
    const fault = recordFrom(
      { ...json, instrument_checks: { ...json.instrument_checks, fault: true, reasons: ["x"] } },
      { fixture: "b", agent: "claude", launchDir: "." },
    ) as { verdict: string };
    expect(fault.verdict).toBe("fault");
    const bytesOff = recordFrom(
      {
        ...json,
        instrument: "render",
        segments: [
          {
            file: "AGENTS.md",
            status: "cut",
            bytes: 10,
            predictedBytes: 5,
            observedBytes: 7,
            verdict: "OFF BY",
            offBy: 2,
          },
        ],
      },
      { fixture: "b", agent: "codex", launchDir: "." },
    ) as { verdict: string; keptBytes: Record<string, unknown> };
    expect(bytesOff.verdict).toBe("disagree");
    expect(bytesOff.keptBytes).toEqual({ "AGENTS.md": { predicted: 5, observed: 7, verdict: "OFF BY 2" } });
    expect(summarise([agree, disagree, fault, bytesOff])).toEqual({
      total: 4,
      agree: 1,
      disagree: 2,
      fault: 1,
      failed: 0,
    });
  });

  it("reads its arguments, and refuses an agent that has no oracle", () => {
    const opts = parseArgs([
      "--agents",
      "codex,claude",
      "--model",
      "pin",
      "--trials",
      "3",
      "--out",
      "r.json",
      "--only",
      "codex-over-cap",
    ]) as Record<string, unknown>;
    expect(opts).toMatchObject({
      agents: ["codex", "claude"],
      model: "pin",
      trials: 3,
      out: "r.json",
      only: "codex-over-cap",
    });
    expect(() => parseArgs(["--agents", "gemini"])).toThrow(/no oracle for agent gemini/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
  });
});
