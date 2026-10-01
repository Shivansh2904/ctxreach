import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HookEventJson,
  hookFiles,
  hookSettings,
  HOOK_SCRIPT_TEXT,
  installHook,
  parseHookLog,
  reduceHookLog,
  sessionIdOf,
  settleLog,
} from "../src/agents/claude/hook.js";
import { readRecording } from "../src/probe/recording.js";
import { scoreRecording } from "../src/probe/score.js";
import { fakeRepo, probeFake, withControl } from "./helpers/fake-claude-probe.js";
import { tempDir } from "./helpers/fixture.js";

const event = (over: Record<string, unknown> = {}) => ({
  session_id: "s1",
  transcript_path: "/home/u/.claude/projects/x/s1.jsonl",
  cwd: "/tmp/ctxreach-probe-abc/repo",
  hook_event_name: "InstructionsLoaded",
  file_path: "/tmp/ctxreach-probe-abc/repo/CLAUDE.md",
  memory_type: "Project",
  load_reason: "session_start",
  ...over,
});
const lines = (...events: unknown[]) => events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n");
const REDACT = [{ from: "/tmp/ctxreach-probe-abc", to: "/tmp/ctxreach-probe" }];

describe("the hook's files", () => {
  it("runs the script with an absolute Node in exec form, and never sets disableAllHooks", () => {
    const base = tempDir("hook-base");
    const { files, settings } = installHook(base, { claudeMdExcludes: ["/x/CLAUDE.md"] }, "/opt/node/bin/node");
    expect(settings).toEqual({
      claudeMdExcludes: ["/x/CLAUDE.md"],
      hooks: {
        InstructionsLoaded: [
          { hooks: [{ type: "command", command: "/opt/node/bin/node", args: [files.script, files.log] }] },
        ],
      },
    });
    expect(JSON.parse(readFileSync(files.settings, "utf8"))).toEqual(settings);
    expect(readFileSync(files.script, "utf8")).toBe(HOOK_SCRIPT_TEXT);
    expect(JSON.stringify(settings)).not.toContain("disableAllHooks");
    expect(() => installHook(base, { disableAllHooks: true })).toThrow(/disableAllHooks/);
    expect(hookSettings(hookFiles(base)).hooks.InstructionsLoaded[0]?.hooks[0]?.command).toBe(process.execPath);
  });

  it("empties the live log when installed, so one trial's events never reach the next", () => {
    const base = tempDir("hook-base");
    appendFileSync(hookFiles(base).log, JSON.stringify(event()) + "\n");
    installHook(base);
    expect(existsSync(hookFiles(base).log)).toBe(false);
  });

  it("appends each event as one line, and keeps what is not JSON as an unparsed line", () => {
    const { files } = installHook(tempDir("hook-base"));
    const run = (input: string) =>
      spawnSync(process.execPath, [files.script, files.log], { input, encoding: "utf8", windowsHide: true });
    // Pretty-printed, as a hook may receive it: still one line in the log.
    expect(run(JSON.stringify(event(), null, 2)).status).toBe(0);
    expect(run("not json").status).toBe(0);
    const logged = readFileSync(files.log, "utf8").trim().split("\n");
    expect(logged).toHaveLength(2);
    expect(JSON.parse(logged[0] ?? "")).toEqual(event());
    expect(JSON.parse(logged[1] ?? "")).toEqual({ ctxreachUnparsed: "not json" });
  });
});

describe("reducing and reading a hook log", () => {
  it("keeps the documented fields, redacted, and whether the event is the trial's own session", () => {
    const raw = lines(
      event(),
      event({ session_id: "s2", file_path: "/tmp/ctxreach-probe-abc/repo/.claude/rules/a.md", globs: ["*.ts"] }),
      event({
        session_id: undefined,
        load_reason: "include",
        parent_file_path: "/tmp/ctxreach-probe-abc/repo/CLAUDE.md",
      }),
    );
    const r = reduceHookLog(raw, { sessionId: "s1", redactions: REDACT });
    expect(r).toMatchObject({ events: 3, invalid: 0 });
    const saved = r.text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(saved[0]).toEqual({
      hook_event_name: "InstructionsLoaded",
      file_path: "/tmp/ctxreach-probe/repo/CLAUDE.md",
      memory_type: "Project",
      load_reason: "session_start",
      cwd: "/tmp/ctxreach-probe/repo",
      session: "same",
    });
    expect(saved.map((e) => e.session)).toEqual(["same", "other", "unknown"]);
    expect(saved[1]?.globs).toEqual(["*.ts"]);
    expect(saved[2]?.parent_file_path).toBe("/tmp/ctxreach-probe/repo/CLAUDE.md");
    // No session id, transcript path or anything else from the payload is saved.
    expect(r.text).not.toContain("s1");
    expect(r.text).not.toContain("transcript_path");
    expect(r.text).not.toContain("ctxreach-probe-abc");
  });

  it("counts, and does not save, lines that are not the documented event", () => {
    const raw = lines(
      "not json",
      { ctxreachUnparsed: "x" },
      event({ memory_type: "Somewhere" }),
      event({ load_reason: "because" }),
      event({ file_path: undefined }),
      event({ hook_event_name: "SessionStart" }),
      event(),
    );
    const r = reduceHookLog(raw, { sessionId: "s1", redactions: [] });
    expect(r).toMatchObject({ events: 1, invalid: 6 });
  });

  it("reads back only lines of the saved shape; an extra field makes a line invalid", () => {
    const good = reduceHookLog(lines(event()), { sessionId: "s1", redactions: [] }).text.trim();
    const parsed = parseHookLog([good, JSON.stringify({ ...JSON.parse(good), session_id: "s1" }), "{"].join("\n"));
    expect(parsed.events).toHaveLength(1);
    expect(parsed.invalid).toBe(2);
    expect(HookEventJson.safeParse(parsed.events[0]).success).toBe(true);
  });

  it("finds the session id of a raw transcript's system/init event", () => {
    const init = { type: "system", subtype: "init", session_id: "abc", cwd: "/r", tools: [], model: "m" };
    expect(sessionIdOf([JSON.stringify({ type: "x" }), JSON.stringify(init)].join("\n"))).toBe("abc");
    expect(sessionIdOf("")).toBeUndefined();
  });

  it("waits for a log that is still growing, and returns once it is quiet", async () => {
    const file = path.join(tempDir("settle"), "log.jsonl");
    writeFileSync(file, "a\n");
    setTimeout(() => appendFileSync(file, "b\n"), 150);
    const started = Date.now();
    await settleLog(file, 400, 3000);
    expect(readFileSync(file, "utf8")).toBe("a\nb\n");
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });
});

/** The five rows of the cross-table, one file each, from what the fake says it loaded. */
const FIVE = {
  "CLAUDE.md": "# Project\n\nUse tabs.\n",
  "AGENTS.md": "# Agents\n\nRun the tests.\n",
  ".claude/rules/style.md": "# Style\n\nShort functions.\n",
  "CLAUDE.local.md": "# Local\n\nMy notes.\n",
  "packages/api/CLAUDE.md": "# API\n\nValidate input.\n",
  "packages/api/src/index.ts": "export {};\n",
};

describe("the hook against the canary, with the real adapter and a fake claude", () => {
  it("produces all five rows of the cross-table, and both bounding rates", async () => {
    const fx = fakeRepo(FIVE);
    const { result, saveDir } = await probeFake(fx, {
      env: {
        // seen + fired, seen + silent (AGENTS.md, hook-blind), seen + silent (a rule: disagreement)
        FAKE_CLAUDE_ECHO: withControl("CLAUDE.md", "AGENTS.md", ".claude/rules/style.md"),
        // fired but not seen (echo miss); packages/api/CLAUDE.md is in neither
        FAKE_CLAUDE_HOOK: withControl("CLAUDE.md", "CLAUDE.local.md"),
      },
    });
    const hook = result.instrument.hook;
    expect(hook).not.toBeNull();
    expect(hook?.rows).toEqual({ both: 2, "hook-blind": 1, disagreement: 1, "echo-miss": 1, neither: 1, undecided: 0 });
    expect(hook?.listed.map((e) => [e.file, e.row])).toEqual([
      [".claude/rules/style.md", "disagreement"],
      ["CLAUDE.local.md", "echo-miss"],
    ]);
    expect(hook?.rates).toEqual({
      hookGivenSeen: { k: 2, n: 3 },
      seenGivenHook: { k: 2, n: 3 },
      agentsBlind: { k: 1, n: 1 },
    });
    expect(hook?.controlSilent).toBe(0);
    expect(result.instrument.fault).toBe(false);
    expect(result.instrument.control).toMatchObject({ status: "planted", echoed: 1, checked: 1 });
    expect(result.warnings.join("\n")).toContain("The hook and the canary disagree in 2 file-trials");

    // The saved log: the events of the trial, redacted, in the saved shape only.
    const log = readFileSync(path.join(saveDir, "trial-1.hooks.jsonl"), "utf8");
    expect(log).not.toContain(fx.tmp);
    expect(log).not.toContain(fx.tmp.split(path.sep).join("/"));
    expect(parseHookLog(log)).toMatchObject({ invalid: 0 });
    expect(parseHookLog(log).events.map((e) => e.session)).toEqual(["same", "same", "same"]);
    // The manifest says the run had the hook, with the settings that were passed.
    const m = readRecording(saveDir).manifest;
    expect(m.session).toMatchObject({ hook: true, isolation: "machine", model: null });
    expect(m.trials[0]?.hooks).toEqual({ log: "trial-1.hooks.jsonl", events: 3, invalid: 0 });
    expect(m.args).toContain("--settings");
    expect(JSON.stringify(m.session?.settings)).toContain("InstructionsLoaded");
  }, 30_000);

  it("waits for hook events that land after the agent has exited", async () => {
    const fx = fakeRepo(FIVE);
    const env = {
      FAKE_CLAUDE_ECHO: withControl("CLAUDE.md"),
      FAKE_CLAUDE_HOOK: withControl(),
      FAKE_CLAUDE_HOOK_LATE: "CLAUDE.md",
    };
    const waited = await probeFake(fx, { env, adapter: { hookSettle: { quietMs: 2500, maxMs: 8000 } } });
    expect(waited.result.instrument.hook?.rows).toMatchObject({ both: 2, disagreement: 0 });
    // Without the wait, the late event is lost and shows as the hook missing a file the canary saw.
    const fx2 = fakeRepo(FIVE);
    const hasty = await probeFake(fx2, { env, adapter: { hookSettle: { quietMs: 0, maxMs: 0 } } });
    expect(hasty.result.instrument.hook?.rows).toMatchObject({ both: 1, disagreement: 1 });
  }, 30_000);

  it("does not count events from another session, and says the hook missed the positive control", async () => {
    const fx = fakeRepo(FIVE);
    const { result } = await probeFake(fx, {
      env: { FAKE_CLAUDE_ECHO: withControl(), FAKE_CLAUDE_HOOK: withControl(), FAKE_CLAUDE_HOOK_SESSION: "elsewhere" },
    });
    expect(result.instrument.hook).toMatchObject({ events: 0, otherSession: 1, controlSilent: 1 });
    expect(result.warnings.join("\n")).toContain("1 hook events carried another session's id");
    expect(result.warnings.join("\n")).toContain("The hook stayed silent for the positive control in 1/1");
  }, 30_000);

  it("flags a file outside the copy that the hook saw load", async () => {
    const fx = fakeRepo(FIVE, { ".claude/CLAUDE.md": "# Me\n" });
    const outside = path.join(fx.home, ".claude", "CLAUDE.md");
    const { result } = await probeFake(fx, {
      env: { FAKE_CLAUDE_ECHO: withControl(), FAKE_CLAUDE_HOOK: withControl(outside) },
    });
    expect(result.instrument.hook?.outside).toHaveLength(1);
    expect(result.instrument.hook?.outside[0]).toMatch(/\.claude[\\/]CLAUDE\.md \(Project\)$/);
    // Under machine isolation it is a condition of the run, not a fault.
    expect(result.instrument.fault).toBe(false);
    expect(result.warnings.join("\n")).toContain("The hook saw files outside the copy load");
  }, 30_000);

  it("faults a trial whose hook log is missing, though the run had the hook", async () => {
    const fx = fakeRepo(FIVE);
    const { saveDir, adapter } = await probeFake(fx, {
      env: { FAKE_CLAUDE_ECHO: withControl(), FAKE_CLAUDE_HOOK: withControl() },
    });
    expect(scoreRecording(readRecording(saveDir), adapter).instrument.fault).toBe(false);
    writeFileSync(path.join(saveDir, "trial-1.hooks.jsonl"), "");
    // An empty log is a log: the hook just reported nothing.
    expect(scoreRecording(readRecording(saveDir), adapter).instrument.hook?.events).toBe(0);
    const { rmSync } = await import("node:fs");
    rmSync(path.join(saveDir, "trial-1.hooks.jsonl"));
    const r = scoreRecording(readRecording(saveDir), adapter);
    expect(r.trials[0]?.status).toBe("fault");
    expect(r.instrument.reasons.join()).toContain("the hook log of trial 1 is missing");
  }, 30_000);

  it("runs without the hook when asked, and says so", async () => {
    const fx = fakeRepo(FIVE);
    const { result, saveDir } = await probeFake(fx, {
      env: { FAKE_CLAUDE_ECHO: withControl(), FAKE_CLAUDE_HOOK: withControl() },
      adapter: { hook: false },
    });
    expect(result.instrument.hook).toBeNull();
    expect(result.manifest.args).not.toContain("--settings");
    expect(existsSync(path.join(saveDir, "trial-1.hooks.jsonl"))).toBe(false);
    expect(result.instrument.fault).toBe(false);
  }, 30_000);
});

describe("the decoy, seen by the hook", () => {
  it("is an instrument fault when the hook reports it loaded", async () => {
    const fx = fakeRepo(FIVE);
    const { result } = await probeFake(fx, {
      env: { FAKE_CLAUDE_ECHO: withControl(), FAKE_CLAUDE_HOOK: withControl("ctxreach-decoy.md") },
    });
    expect(result.instrument.hook?.decoyFired).toBe(1);
    expect(result.instrument.reasons.join()).toContain("the hook reported the decoy");
    expect(result.instrument.fault).toBe(true);
  }, 30_000);
});
