import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "../src/agents/claude/hook.js";
import {
  ancestorInstructionFiles,
  copyLocation,
  hookBlind,
  hookReport,
  partialEchoes,
  type InstrumentTrial,
} from "../src/probe/instruments.js";
import type { Canary, Expectation, Observation, PredictedFile } from "../src/probe/types.js";
import { tempDir } from "./helpers/fixture.js";

const REPO = "C:\\ctxreach-probe\\repo";
let n = 0;
const canaries = (file: string, extra: Partial<Canary> = {}): Canary[] =>
  (["head", "tail"] as const).map((position) => ({
    token: `CTXR-${(n++).toString(16).padStart(8, "0")}`,
    file,
    position,
    offset: 0,
    ...extra,
  }));
const fired = (file: string, over: Partial<HookEvent> = {}): HookEvent => ({
  hook_event_name: "InstructionsLoaded",
  file_path: /^[A-Za-z]:/.test(file) ? file : `${REPO}\\${file.split("/").join("\\")}`,
  memory_type: "Project",
  load_reason: "session_start",
  session: "same",
  ...over,
});
const predicted =
  (delivery: PredictedFile["delivery"]) =>
  (c: Canary): PredictedFile => ({
    file: c.file,
    delivery,
    why: "",
    rule: "r",
  });

/** Observations for a trial: every token of `seen` with that observation, the rest not seen. */
function observe(all: Canary[], seen: Record<string, Observation>): InstrumentTrial["observations"] {
  return Object.fromEntries(all.map((c) => [c.token, { seen: seen[c.file] ?? "not-seen" }]));
}

describe("the hook against the canary, per file and trial", () => {
  const claude = canaries("CLAUDE.md");
  const agents = canaries("AGENTS.md");
  const rule = canaries(".claude/rules/style.md");
  const local = canaries("CLAUDE.local.md");
  const nested = canaries("packages/api/CLAUDE.md");
  const opened = canaries("docs/guide.md");
  const decoy = canaries("ctxreach-decoy.md", { decoy: true });
  const control = canaries(".claude/rules/ctxreach-control.md", { control: true });
  const all = [...claude, ...agents, ...rule, ...local, ...nested, ...opened, ...decoy, ...control];

  it("puts each file in one of the five rows, or leaves it undecided when the model opened it", () => {
    const r = hookReport({
      repo: REPO,
      canaries: all,
      predictionFor: predicted("launch"),
      trials: [
        {
          trial: 1,
          observations: observe(all, {
            "CLAUDE.md": "preloaded",
            "AGENTS.md": "preloaded",
            ".claude/rules/style.md": "on-read",
            "docs/guide.md": "self-discovered",
            ".claude/rules/ctxreach-control.md": "preloaded",
          }),
          hooks: [fired("CLAUDE.md"), fired("CLAUDE.local.md"), fired(".claude/rules/ctxreach-control.md")],
        },
      ],
    });
    expect(r.rows).toEqual({ both: 2, "hook-blind": 1, disagreement: 1, "echo-miss": 1, neither: 1, undecided: 1 });
    expect(r.listed).toEqual([
      { trial: 1, file: ".claude/rules/style.md", canary: "seen", hook: "silent", hookable: true, row: "disagreement" },
      { trial: 1, file: "CLAUDE.local.md", canary: "not-seen", hook: "fired", hookable: true, row: "echo-miss" },
    ]);
    // Hookable files seen: CLAUDE.md, style.md, the control; the hook fired for two.
    expect(r.rates.hookGivenSeen).toEqual({ k: 2, n: 3 });
    // Files the hook fired for: CLAUDE.md, CLAUDE.local.md, the control; the canary saw two.
    expect(r.rates.seenGivenHook).toEqual({ k: 2, n: 3 });
    expect(r.rates.agentsBlind).toEqual({ k: 1, n: 1 });
    expect(r).toMatchObject({ trials: 1, events: 3, otherSession: 0, decoyFired: 0, controlSilent: 0 });
  });

  it("treats an AGENTS.md brought in by an import as hookable, as the hook reports includes", () => {
    expect(hookBlind("packages/api/AGENTS.md", predicted("on-read")(agents[0]!))).toBe(true);
    expect(hookBlind("AGENTS.md", predicted("import")(agents[0]!))).toBe(false);
    expect(hookBlind("CLAUDE.md", predicted("launch")(claude[0]!))).toBe(false);
    const r = hookReport({
      repo: REPO,
      canaries: agents,
      predictionFor: predicted("import"),
      trials: [{ trial: 1, observations: observe(agents, { "AGENTS.md": "preloaded" }), hooks: [] }],
    });
    expect(r.rows).toMatchObject({ disagreement: 1, "hook-blind": 0 });
  });

  it("lists events outside the copy, and in it for files without tokens; counts other sessions, the decoy and a silent control", () => {
    const r = hookReport({
      repo: REPO,
      canaries: all,
      predictionFor: predicted("launch"),
      trials: [
        {
          trial: 1,
          observations: observe(all, { ".claude/rules/ctxreach-control.md": "preloaded" }),
          hooks: [
            fired("C:\\Users\\user\\.claude\\CLAUDE.md", { memory_type: "User" }),
            fired("docs/other.md"),
            fired("ctxreach-decoy.md"),
            fired("CLAUDE.md", { session: "other" }),
          ],
        },
        // A trial with no hook log is not counted at all.
        { trial: 2, observations: observe(all, {}), hooks: undefined },
      ],
    });
    expect(r.outside).toEqual(["C:\\Users\\user\\.claude\\CLAUDE.md (User)"]);
    expect(r.unplanted).toEqual([`${REPO}\\docs\\other.md`]);
    expect(r).toMatchObject({ trials: 1, events: 3, otherSession: 1, decoyFired: 1, controlSilent: 1 });
    // The other session's CLAUDE.md event does not count as the hook firing.
    expect(r.rows.neither).toBeGreaterThan(0);
    expect(r.listed.find((e) => e.file === "CLAUDE.md")).toBeUndefined();
  });

  it("compares paths the way the recording's system does: case and separators aside on Windows", () => {
    const r = hookReport({
      repo: REPO,
      canaries: claude,
      predictionFor: predicted("launch"),
      trials: [
        {
          trial: 1,
          observations: observe(claude, { "CLAUDE.md": "preloaded" }),
          hooks: [fired("c:/CTXREACH-PROBE/repo/claude.md")],
        },
      ],
    });
    expect(r.rows.both).toBe(1);
  });
});

describe("partial echoes", () => {
  const a = canaries("CLAUDE.md");
  const b = canaries("AGENTS.md");
  const cut = canaries("big/AGENTS.md");
  const decoy = canaries("ctxreach-decoy.md", { decoy: true });
  const all = [...a, ...b, ...cut, ...decoy];
  // The cut file's tail is past the cut, so only its head can be repeated: not a partial echo.
  const expectation = (c: Canary): Expectation =>
    c.file === "big/AGENTS.md" && c.position === "tail" ? "never" : "launch";

  it("counts file-trials in which exactly one of the two tokens was repeated", () => {
    const seen = (tokens: Canary[]) => Object.fromEntries(tokens.map((c) => [c.token, { seen: "preloaded" as const }]));
    const r = partialEchoes({
      canaries: all,
      expectationFor: expectation,
      trials: [
        { trial: 1, observations: { ...seen(a), ...seen([b[0]!]), ...seen([cut[0]!]), ...seen([decoy[0]!]) } },
        { trial: 2, observations: { ...seen(a), ...seen(b) } },
      ],
    });
    expect(r).toEqual({ k: 1, n: 4, cases: [{ trial: 1, file: "AGENTS.md", repeated: "head" }] });
  });
});

describe("where the copy is", () => {
  it("lists the instruction files above the copy, nearest first, up to the ceiling", () => {
    const top = tempDir("location");
    const write = (rel: string) => {
      const p = path.join(top, ...rel.split("/"));
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, "# x\n");
      return p;
    };
    const userFile = write("home/.claude/CLAUDE.md");
    const rule = write("home/.claude/rules/a/b.md");
    write("home/.claude/rules/not-a-rule.txt");
    const agents = write("home/work/AGENTS.md");
    const local = write("home/work/CLAUDE.local.md");
    // Inside the copy: not an ancestor's file.
    write("home/work/copy/CLAUDE.md");
    // Above the ceiling: never looked at.
    write("CLAUDE.md");
    const copy = path.join(top, "home", "work", "copy");
    expect(ancestorInstructionFiles(copy, path.join(top, "home"))).toEqual([local, agents, userFile, rule]);

    const loc = copyLocation({
      repo: copy,
      home: path.join(top, "home"),
      redactions: [{ from: path.join(top, "home"), to: "/home/user" }],
      ceiling: path.join(top, "home"),
    });
    expect(loc.underHome).toBe(true);
    expect(loc.userClaudeMd).toBe(true);
    expect(loc.ancestors).toEqual([
      `/home/user${path.sep}work${path.sep}CLAUDE.local.md`,
      `/home/user${path.sep}work${path.sep}AGENTS.md`,
      `/home/user${path.sep}.claude${path.sep}CLAUDE.md`,
      `/home/user${path.sep}.claude${path.sep}rules${path.sep}a${path.sep}b.md`,
    ]);
    const bare = tempDir("bare-copy");
    mkdirSync(path.join(bare, "repo"));
    const elsewhere = copyLocation({
      repo: path.join(bare, "repo"),
      home: tempDir("other-home"),
      redactions: [],
      ceiling: bare,
    });
    expect(elsewhere).toEqual({ underHome: false, userClaudeMd: false, ancestors: [] });
  });
});
