import { describe, expect, it } from "vitest";
import { classifyTrial, type ClassifyContext } from "../src/probe/classify.js";
import { expectationFor, verdictFor, type TrialObservation } from "../src/probe/compare.js";
import { ownerDir, recordedPaths } from "../src/probe/paths.js";
import type { Canary, ProbeMode, ToolUse, Transcript, TranscriptItem } from "../src/probe/types.js";

const REPO = "C:\\probe\\repo";
const canaries: Canary[] = [
  { token: "CTXR-00000001", file: "CLAUDE.md", position: "head", offset: 16 },
  { token: "CTXR-00000002", file: "packages/api/CLAUDE.md", position: "head", offset: 16 },
  { token: "CTXR-00000003", file: "packages/api/AGENTS.md", position: "head", offset: 16 },
  { token: "CTXR-00000004", file: ".claude/rules/api.md", position: "head", offset: 40, scoped: true },
  { token: "CTXR-00000005", file: ".claude/rules/style.md", position: "head", offset: 16 },
  { token: "CTXR-00000009", file: "ctxreach-decoy.md", position: "head", offset: 16, decoy: true },
];

function ctx(mode: ProbeMode, launchDir = "."): ClassifyContext {
  return {
    canaries,
    mode,
    repo: REPO,
    launchDir,
    readTools: ["Read", "Glob", "Grep"],
    fileReads: (call: ToolUse) => {
      const input = call.input as { file_path?: string };
      return call.name === "Read" && input.file_path ? [input.file_path] : [];
    },
  };
}

function transcript(items: TranscriptItem[], cwd = REPO): Transcript {
  return {
    items,
    cwd,
    toolsOffered: [],
    finished: true,
    isError: false,
    events: { total: items.length, byType: {}, unknown: {} },
  };
}

const say = (...tokens: string[]): TranscriptItem => ({ kind: "text", text: tokens.join("\n") });
const read = (file: string, id = "r"): TranscriptItem => ({
  kind: "tool-use",
  id,
  name: "Read",
  input: { file_path: `${REPO}\\${file.split("/").join("\\")}` },
});
const output = (text: string, id = "r"): TranscriptItem => ({
  kind: "tool-result",
  toolUseId: id,
  text,
  isError: false,
});

function seen(t: Transcript, c: ClassifyContext) {
  const r = classifyTrial(t, c);
  return Object.fromEntries(canaries.map((k) => [k.file, r.observations[k.token]?.seen]));
}

describe("classifying one trial", () => {
  it("calls a token repeated before any tool call preloaded", () => {
    expect(seen(transcript([say("CTXR-00000001")]), ctx("recall"))).toMatchObject({
      "CLAUDE.md": "preloaded",
      "packages/api/CLAUDE.md": "not-seen",
    });
  });

  it("calls a nested file's token repeated after a read in its directory on-read, and records the read", () => {
    const t = transcript([read("packages/api/src/index.ts"), output("export const x = 1;"), say("CTXR-00000002")]);
    const r = classifyTrial(t, ctx("task"));
    expect(r.observations["CTXR-00000002"]).toMatchObject({ seen: "on-read", dirRead: true });
    // A file in the same directory that never arrived: its directory was read, so its chance came.
    expect(r.observations["CTXR-00000003"]).toMatchObject({ seen: "not-seen", dirRead: true });
  });

  it("calls a token self-discovered when it appeared in a tool's output first", () => {
    const t = transcript([
      { kind: "tool-use", id: "g", name: "Grep", input: { pattern: "rule", path: "." } },
      output("CLAUDE.md:1:ctxreach canary CTXR-00000001", "g"),
      say("CTXR-00000001"),
    ]);
    expect(seen(t, ctx("task"))["CLAUDE.md"]).toBe("self-discovered");
  });

  it("calls a token self-discovered when a tool call named its file first", () => {
    const t = transcript([read("packages/api/AGENTS.md"), output("(content)"), say("CTXR-00000003")]);
    expect(seen(t, ctx("task"))["packages/api/AGENTS.md"]).toBe("self-discovered");
  });

  it("counts only tool calls made before the first repeat", () => {
    const t = transcript([say("CTXR-00000002"), read("packages/api/src/index.ts"), say("CTXR-00000002")]);
    expect(seen(t, ctx("task"))["packages/api/CLAUDE.md"]).toBe("preloaded");
  });

  it("attributes a scoped rule to any read in the tree it covers, and a path-less rule to none", () => {
    const t = transcript([read("packages/api/src/index.ts"), say("CTXR-00000004", "CTXR-00000005")]);
    const r = seen(t, ctx("task"));
    expect(r[".claude/rules/api.md"]).toBe("on-read");
    expect(r[".claude/rules/style.md"]).toBe("preloaded");
  });

  it("marks every tool call in recall mode as contamination", () => {
    const t = transcript([read("README.md"), say("CTXR-00000001")]);
    const r = classifyTrial(t, ctx("recall"));
    expect(r.contaminated).toBe(true);
    expect(r.contaminatedBy).toEqual(["Read"]);
    expect(Object.values(r.observations).every((o) => o.seen === "contaminated")).toBe(true);
  });

  it("marks a tool outside the read tools, or a search for the tokens, as contamination in task mode", () => {
    const bash = transcript([{ kind: "tool-use", id: "b", name: "Bash", input: { command: "cat CLAUDE.md" } }]);
    expect(classifyTrial(bash, ctx("task")).contaminatedBy).toEqual(["Bash"]);
    const hunt = transcript([{ kind: "tool-use", id: "g", name: "Grep", input: { pattern: "CTXR-[0-9a-f]{8}" } }]);
    expect(classifyTrial(hunt, ctx("task")).contaminatedBy).toEqual(["a search for the tokens"]);
    // The sandbox's own path contains "ctxreach", which is not a search for the tokens.
    const path = transcript([read("packages/api/src/index.ts")], "C:\\ctxreach-probe\\repo");
    expect(classifyTrial(path, { ...ctx("task"), repo: "C:\\ctxreach-probe\\repo" }).contaminated).toBe(false);
  });

  it("lists tokens of the canary form that were never planted, and reads outside the copy", () => {
    const t = transcript([
      { kind: "tool-use", id: "o", name: "Read", input: { file_path: "C:\\Users\\someone\\secret.md" } },
      say("CTXR-deadbeef CTXR-00000001"),
    ]);
    const r = classifyTrial(t, ctx("task"));
    expect(r.unknownTokens).toEqual(["CTXR-deadbeef"]);
    expect(r.outsidePaths).toEqual(["C:\\Users\\someone\\secret.md"]);
  });

  it("reads a token from the final answer when it is only reported there", () => {
    const t: Transcript = { ...transcript([]), finalText: "CTXR-00000001" };
    expect(seen(t, ctx("recall"))["CLAUDE.md"]).toBe("preloaded");
  });

  it("compares Windows paths from a recording the way Windows would, on any machine", () => {
    const p = recordedPaths("C:\\probe\\repo");
    expect(p.style).toBe("win32");
    expect(p.same("c:\\PROBE\\repo\\a.md", "C:\\probe\\repo\\a.md")).toBe(true);
    expect(p.inside("C:\\probe\\repo\\packages\\api\\x.ts", "C:\\probe\\repo\\packages\\api")).toBe(true);
    expect(p.inside("C:\\probe\\repo\\packages\\apix", "C:\\probe\\repo\\packages\\api")).toBe(false);
    expect(recordedPaths("/tmp/r").style).toBe("posix");
    expect(ownerDir("packages/api/.claude/CLAUDE.md")).toBe("packages/api");
    expect(ownerDir(".claude/rules/a/b.md")).toBe(".");
  });
});

const obs = (...list: [TrialObservation["seen"], boolean?][]): TrialObservation[] =>
  list.map(([seen, dirRead]) => ({ seen, dirRead: dirRead ?? false }));

describe("verdicts over trials", () => {
  it("recall: launch must be preloaded in every usable trial, anything else in none", () => {
    expect(verdictFor("recall", "launch", obs(["preloaded"], ["preloaded"]))).toBe("confirmed");
    expect(verdictFor("recall", "launch", obs(["preloaded"], ["not-seen"]))).toBe("missed");
    expect(verdictFor("recall", "never", obs(["not-seen"], ["not-seen"]))).toBe("confirmed");
    expect(verdictFor("recall", "never", obs(["not-seen"], ["preloaded"]))).toBe("extra");
    expect(verdictFor("recall", "on-read", obs(["not-seen"]))).toBe("confirmed");
    expect(verdictFor("recall", "launch", [])).toBe("no-data");
  });

  it("task: on-read is confirmed only where its directory was read, and missed where a read did not deliver it", () => {
    expect(verdictFor("task", "on-read", obs(["on-read", true], ["on-read", true]))).toBe("confirmed");
    expect(verdictFor("task", "on-read", obs(["on-read", true], ["not-seen", true]))).toBe("missed");
    expect(verdictFor("task", "on-read", obs(["not-seen", false], ["not-seen", false]))).toBe("untested");
    expect(verdictFor("task", "on-read", obs(["preloaded", false]))).toBe("extra");
    expect(verdictFor("task", "on-read", obs(["self-discovered", false]))).toBe("discovered");
  });

  it("task: a file predicted never to load is extra if it arrives by loading, discovered if opened", () => {
    expect(verdictFor("task", "never", obs(["on-read", true]))).toBe("extra");
    expect(verdictFor("task", "never", obs(["self-discovered"]))).toBe("discovered");
    expect(verdictFor("task", "never", obs(["not-seen", true]))).toBe("confirmed");
    expect(verdictFor("task", "on-match", obs(["not-seen", true]))).toBe("untested");
    expect(verdictFor("task", "on-match", obs(["on-read", true]))).toBe("confirmed");
  });

  it("maps map's predictions to what a probe can observe", () => {
    const c: Canary = { token: "CTXR-00000001", file: "AGENTS.md", position: "tail", offset: 40000 };
    const base = { file: "AGENTS.md", why: "", rule: "codex.budget" };
    expect(expectationFor(c, { ...base, delivery: "launch-cut", cutAt: 32768 })).toBe("never");
    expect(expectationFor({ ...c, offset: 10 }, { ...base, delivery: "launch-cut", cutAt: 32768 })).toBe("launch");
    expect(expectationFor(c, { ...base, delivery: "import" })).toBe("launch");
    expect(expectationFor(c, { ...base, delivery: "maybe" })).toBe("not-preloaded");
    expect(expectationFor(c, { ...base, delivery: "on-read", rule: "claude.rules" })).toBe("on-match");
    expect(expectationFor({ ...c, decoy: true }, { ...base, delivery: "launch" })).toBe("never");
  });
});
