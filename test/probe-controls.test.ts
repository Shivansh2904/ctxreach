import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/agents/claude/adapter.js";
import {
  ancestorExcludes,
  assertRunnable,
  KILL_SWITCHES,
  modelMatches,
  resolveModelPin,
} from "../src/agents/claude/isolation.js";
import { CONTROL_RULE } from "../src/probe/canary.js";
import { runProbe } from "../src/probe/probe.js";
import { readRecording } from "../src/probe/recording.js";
import { scoreRecording, type ProbeResult } from "../src/probe/score.js";
import { SafetyError, type AgentAdapter } from "../src/probe/types.js";
import { createCli } from "../src/program.js";
import { ProbeJson } from "../src/report/probe.js";
import { fakeAgent, type FakeBehaviour, type FakeRun, type FakeSetup } from "./helpers/fake-agent.js";
import { FAKE_CLAUDE, fakeClaude, fakeEnv, fakeRepo, probeFake, withControl } from "./helpers/fake-claude-probe.js";
import { materialise, tempDir } from "./helpers/fixture.js";

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "recorded");
const CONTROL_AT_API = `packages/api/${CONTROL_RULE}`;

/** A probe of the demo monorepo from packages/api with the in-process fake agent. */
async function demo(
  behaviour: (run: FakeRun) => FakeBehaviour,
  options: {
    setup?: FakeSetup;
    mode?: "recall" | "task";
    trials?: number;
    claudeHomeFiles?: Record<string, string>;
  } = {},
) {
  const fx = materialise("demo-monorepo", { example: true });
  for (const [rel, text] of Object.entries(options.claudeHomeFiles ?? {})) {
    mkdirSync(path.dirname(path.join(fx.claudeHome, rel)), { recursive: true });
    writeFileSync(path.join(fx.claudeHome, rel), text);
  }
  const agent = fakeAgent(behaviour, options.setup);
  const save = path.join(tempDir("probe-save"), "run");
  const tmp = tempDir("probe-tmp");
  const recording = await runProbe({
    adapter: agent,
    repoRoot: fx.repo,
    launchDir: fx.at("packages/api"),
    mode: options.mode ?? "recall",
    trials: options.trials ?? 2,
    timeoutMs: 1000,
    saveDir: save,
    claudeHome: fx.claudeHome,
    ctxreachVersion: "0.0.0-test",
    tmpRoot: tmp,
    homeDir: fx.home,
    ancestorCeiling: tmp,
  });
  return { fx, save, tmp, agent, result: scoreRecording(recording, agent) };
}

/** The tokens of the positive control in the copy the fake agent runs in. */
const controlTokens = (run: FakeRun) =>
  [...readFileSync(path.join(run.workdir, ...CONTROL_RULE.split("/")), "utf8").matchAll(/CTXR-[0-9a-f]{8}/g)].map(
    (m) => m[0],
  );

async function cli(adapter: AgentAdapter, ...args: string[]) {
  let stdout = "";
  const c = createCli(
    { stdout: (t) => (stdout += t), stderr: () => undefined },
    { exitOverride: true, adapter: () => adapter },
  );
  await c.program.parseAsync(["node", "ctxreach", ...args]);
  return { stdout, status: c.status };
}

/** A copy of a recorded run, changed by `change` (manifest) and `transcripts` (each trial's text). */
function recordedCopy(
  name: string,
  change: (m: Record<string, unknown>) => void,
  transcripts: (text: string) => string = (t) => t,
): string {
  const dir = path.join(tempDir("recorded-copy"), name);
  cpSync(path.join(RECORDED, name), dir, { recursive: true });
  const file = path.join(dir, "manifest.json");
  const m = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  change(m);
  writeFileSync(file, JSON.stringify(m));
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl")))
    writeFileSync(path.join(dir, f), transcripts(readFileSync(path.join(dir, f), "utf8")));
  return dir;
}
const rescore = (dir: string): ProbeResult => scoreRecording(readRecording(dir), claudeAdapter());

describe("the positive control (F5)", () => {
  it("is a rule without paths at the launch directory, predicted at launch, and repeated in every trial", async () => {
    let text = "";
    const { result } = await demo((run) => {
      text = readFileSync(path.join(run.workdir, ...CONTROL_RULE.split("/")), "utf8");
      return { preloads: ["CLAUDE.local.md"] };
    });
    expect(text.startsWith("ctxreach canary CTXR-")).toBe(true);
    expect(text).not.toContain("paths:");
    expect(result.manifest.control).toMatchObject({ file: CONTROL_AT_API, delivery: "launch", rule: "claude.rules" });
    expect(result.manifest.predicted.map((p) => p.file)).not.toContain(CONTROL_AT_API);
    expect(result.instrument.control).toEqual({
      status: "planted",
      file: CONTROL_AT_API,
      why: "project rule",
      echoed: 2,
      readItself: 0,
      missed: 0,
      checked: 2,
    });
    const controlCells = result.cells.filter((c) => c.control);
    expect(controlCells.map((c) => [c.position, c.expected, c.verdict])).toEqual([
      ["head", "launch", "confirmed"],
      ["tail", "launch", "confirmed"],
    ]);
    // It is an instrument check, not one of map's predictions: the agreement is about the repository's files.
    expect(result.agreement).toMatchObject({ agree: 8, decided: 8, cells: 8 });
    expect(result.warnings.join()).not.toContain("positive control");
  });

  it("voids a trial that does not repeat it, and the run exits 3", async () => {
    const { result, save, agent } = await demo(() => ({ preloads: ["CLAUDE.local.md"], skipControl: true }));
    expect(result.trials.map((t) => t.status)).toEqual(["fault", "fault"]);
    expect(result.trials[0]?.reasons[0]).toContain("the positive control");
    expect(result.instrument).toMatchObject({ fault: true, control: { echoed: 0, missed: 2, checked: 2 } });
    // The command line scores the recording the same way, live or replayed.
    const out = await cli(agent, "probe", "--replay", save, "--no-color");
    expect(out.status).toBe(3);
    expect(out.stdout).toContain("positive control repeated: 0/2 trials (must be 2/2)");
    expect(out.stdout).toMatch(
      /\.claude\/rules\/ctxreach-control\.md \(positive control\)\s+head\s+launch \(positive control\)/,
    );
    expect(out.stdout).toContain("positive control: FAULT");
  });

  it("counts a control repeated only in part as missed", async () => {
    const { result } = await demo((run) => ({
      preloads: ["CLAUDE.local.md"],
      skipControl: true,
      extraTokens: controlTokens(run).slice(0, 1),
    }));
    expect(result.instrument.control).toMatchObject({ missed: 2, echoed: 0 });
    expect(result.instrument.fault).toBe(true);
  });

  it("does not fault a trial whose model opened the control itself, and says it shows nothing", async () => {
    const { result } = await demo(
      () => ({ preloads: ["CLAUDE.local.md"], skipControl: true, reads: [CONTROL_AT_API] }),
      {
        mode: "task",
      },
    );
    expect(result.instrument.control).toMatchObject({ echoed: 0, readItself: 2, missed: 0, checked: 2 });
    expect(result.instrument.fault).toBe(false);
    expect(result.warnings.join()).toContain("opened the positive control itself");
  });

  it("refuses a repository that already has a file where the control goes, and leaves no copy", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    mkdirSync(fx.at("packages/api/.claude/rules"), { recursive: true });
    writeFileSync(fx.at(CONTROL_AT_API), "# mine\n");
    const tmp = tempDir("probe-tmp");
    const agent = fakeAgent(() => ({ preloads: [] }));
    await expect(
      runProbe({
        adapter: agent,
        repoRoot: fx.repo,
        launchDir: fx.at("packages/api"),
        mode: "recall",
        trials: 1,
        timeoutMs: 1000,
        saveDir: path.join(tempDir("probe-save"), "run"),
        ctxreachVersion: "0",
        tmpRoot: tmp,
      }),
    ).rejects.toThrow(/already has packages\/api\/\.claude\/rules\/ctxreach-control\.md/);
    expect(agent.runs).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("does not apply where map says it cannot load (managed-only), and says the run has no positive control", async () => {
    const { result } = await demo(() => ({ preloads: [], skipControl: true }), {
      claudeHomeFiles: {
        "settings.json": JSON.stringify({
          pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "managed-only" } } },
        }),
      },
    });
    expect(result.manifest.control).toMatchObject({ delivery: "not-loaded" });
    expect(result.instrument.control.status).toBe("not-applicable");
    expect(result.instrument.fault).toBe(false);
    expect(result.warnings.join()).toContain("so this run has no positive control");
  });
});

describe("where the copy was", () => {
  it("records whether the copy is inside the home directory, whether ~/.claude/CLAUDE.md exists, and the files above it", async () => {
    const fx = fakeRepo({ "CLAUDE.md": "# P\n" });
    // A stand-in home directory that holds the sandboxes, like %TEMP% inside %USERPROFILE% on Windows.
    const home = tempDir("home-like");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "# Me\n");
    const tmp = path.join(home, "AppData", "Temp");
    mkdirSync(tmp, { recursive: true });
    const { result } = await probeFake(fx, {
      env: { FAKE_CLAUDE_ECHO: withControl("CLAUDE.md"), FAKE_CLAUDE_HOOK: withControl("CLAUDE.md") },
      probe: { tmpRoot: tmp, homeDir: home, ancestorCeiling: home },
    });
    const ph = process.platform === "win32" ? "C:\\Users\\user" : "/home/user";
    expect(result.manifest.location).toEqual({
      underHome: true,
      userClaudeMd: true,
      ancestors: [`${ph}${path.sep}.claude${path.sep}CLAUDE.md`],
    });
    expect(result.warnings.join("\n")).toContain(
      "The copy was inside the home directory and ~/.claude/CLAUDE.md exists",
    );
    expect(result.notes.join("\n")).toContain("Instruction files in the directories above the copy:");
  }, 30_000);
});

describe("the model pin", () => {
  it("is passed with --model from the user's settings, and every session must run it", async () => {
    const fx = fakeRepo({ "CLAUDE.md": "# P\n" }, { ".claude/settings.json": JSON.stringify({ model: "fable" }) });
    const env = { FAKE_CLAUDE_ECHO: withControl(), FAKE_CLAUDE_HOOK: withControl() };
    const ok = await probeFake(fx, { env: { ...env, FAKE_CLAUDE_MODEL: "claude-fable-5-1" } });
    expect(ok.result.manifest.session?.model).toEqual({ pin: "fable", from: "settings.json (model)" });
    expect(ok.result.manifest.args.join(" ")).toContain("--model fable");
    expect(ok.result.instrument.fault).toBe(false);
    const other = await probeFake(fx, { env: { ...env, FAKE_CLAUDE_MODEL: "claude-opus-5-5[1m]" } });
    expect(other.result.instrument.fault).toBe(true);
    expect(other.result.trials[0]?.reasons.join()).toContain(
      "the session ran claude-opus-5-5[1m], not the pinned model fable (from settings.json (model))",
    );
  }, 30_000);

  it("is not passed when nothing names a model, and the report says so", async () => {
    const fx = fakeRepo({ "CLAUDE.md": "# P\n" });
    const { result } = await probeFake(fx, {
      env: { FAKE_CLAUDE_ECHO: withControl(), FAKE_CLAUDE_HOOK: withControl() },
    });
    expect(result.manifest.session?.model).toBeNull();
    expect(result.manifest.args).not.toContain("--model");
    expect(result.warnings.join()).toContain("The model was not pinned");
  }, 30_000);

  it("comes from --model, then ANTHROPIC_MODEL, then settings.json", () => {
    const home = tempDir("claude-home");
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ model: "fable" }));
    expect(resolveModelPin({ model: "opus", env: { ANTHROPIC_MODEL: "sonnet" }, claudeHome: home })).toEqual({
      pin: "opus",
      from: "--model",
    });
    expect(resolveModelPin({ env: { ANTHROPIC_MODEL: "sonnet" }, claudeHome: home })).toEqual({
      pin: "sonnet",
      from: "ANTHROPIC_MODEL",
    });
    expect(resolveModelPin({ env: {}, claudeHome: home })).toEqual({ pin: "fable", from: "settings.json (model)" });
    expect(resolveModelPin({ env: {}, claudeHome: tempDir("empty-home") })).toBeUndefined();
  });

  it("matches a full id exactly and a one-word alias by its family", () => {
    const cases: [string, string, boolean][] = [
      ["fable", "claude-fable-5-1", true],
      ["opus[1m]", "claude-opus-5-5[1m]", true],
      ["claude-opus-5-5", "claude-opus-5-5[1m]", true],
      ["claude-opus-5-5", "claude-opus-5-6", false],
      ["fable", "claude-opus-5-5", false],
      ["opus", "claude-opusplan-1", false],
      ["default", "claude-default-1", false],
      ["opusplan", "claude-opus-5-5", false],
    ];
    for (const [pin, reported, expected] of cases)
      expect([pin, reported, modelMatches(pin, reported)]).toEqual([pin, reported, expected]);
  });
});

describe("AGENTS.md support in the session", () => {
  it("is a fault when system/init lists no agents-md built-in plugin, under either name", async () => {
    const fx = fakeRepo({ "AGENTS.md": "# A\n" });
    const env = { FAKE_CLAUDE_ECHO: withControl("AGENTS.md"), FAKE_CLAUDE_HOOK: withControl() };
    const off = await probeFake(fx, { env: { ...env, FAKE_CLAUDE_PLUGINS: "telemetry@builtin" } });
    expect(off.result.instrument.fault).toBe(true);
    expect(off.result.trials[0]?.reasons.join()).toContain("AGENTS.md support was off");
    const renamed = await probeFake(fx, { env: { ...env, FAKE_CLAUDE_PLUGINS: "cc-plugin-agents-md@builtin" } });
    expect(renamed.result.instrument.fault).toBe(false);
  }, 30_000);

  it("is checked from the version that has it: a transcript with no plugin list is a fault on 2.1.280, not on 2.1.276", () => {
    const noPlugins = (t: string) =>
      t
        .split("\n")
        .map((l) => (l.includes('"subtype":"init"') ? JSON.stringify({ ...JSON.parse(l), plugins: undefined }) : l))
        .join("\n");
    const r = rescore(recordedCopy("agents-recall", () => undefined, noPlugins));
    expect(r.instrument.fault).toBe(true);
    expect(r.instrument.reasons.join()).toContain("does not list the session's plugins");
    const old = rescore(
      recordedCopy(
        "agents-recall",
        (m) => (m.cliVersion = "2.1.276"),
        (t) => noPlugins(t).split('"claude_code_version":"2.1.280"').join('"claude_code_version":"2.1.276"'),
      ),
    );
    expect(old.instrument.fault).toBe(false);
  });
});

describe("settings that turn instruction files off", () => {
  it.each(KILL_SWITCHES)("refuses to probe with %s set, before copying anything", async (name) => {
    const fx = fakeRepo({ "CLAUDE.md": "# P\n" });
    const adapter = fakeClaude(fx, { [name]: "1" });
    expect(adapter.environment().killSwitches).toEqual([name]);
    await expect(probeFake(fx, { agent: adapter })).rejects.toThrow(new RegExp(`${name} is set`));
    expect(readdirSync(fx.tmp)).toEqual([]);
    // The adapter refuses too, whoever calls it.
    expect(() => adapter.session?.({ mode: "recall", sandboxBase: fx.tmp, repo: fx.repo, redactions: [] })).toThrow(
      SafetyError,
    );
  });

  it("refuses --bare, --safe-mode and --restricted", async () => {
    const fx = fakeRepo({ "CLAUDE.md": "# P\n" });
    for (const flag of ["--bare", "--safe-mode", "--restricted"]) {
      const adapter = claudeAdapter({
        bin: process.execPath,
        prefixArgs: [FAKE_CLAUDE, flag],
        claudeHome: fx.claudeHome,
        env: fakeEnv(),
      });
      await expect(probeFake(fx, { agent: adapter })).rejects.toThrow(
        new RegExp(`refusing to run Claude Code with ${flag}`),
      );
    }
  }, 30_000);

  it("voids a recording made with one, with such a flag, or with the hook turned off", () => {
    const killed = rescore(
      recordedCopy("demo-api-recall", (m) => {
        (m.environment as Record<string, unknown>).killSwitches = ["CLAUDE_CODE_DISABLE_CLAUDE_MDS"];
      }),
    );
    expect(killed.instrument.reasons.join()).toContain("CLAUDE_CODE_DISABLE_CLAUDE_MDS set");
    // A v1 recording says only that bare mode was on.
    const bare = rescore(
      recordedCopy("demo-api-recall", (m) => {
        m.environment = { bare: true, removedEnv: [], notes: ["CLAUDE_CODE_SIMPLE is set, which turns on bare mode."] };
      }),
    );
    expect(bare.instrument.reasons.join()).toContain(
      "a setting that turns instruction files off: CLAUDE_CODE_SIMPLE is set",
    );
    const flagged = rescore(recordedCopy("demo-api-recall", (m) => (m.args as string[]).push("--restricted")));
    expect(flagged.instrument.reasons.join()).toContain("--restricted");
    const unhooked = rescore(
      recordedCopy("demo-api-recall", (m) => {
        m.session = {
          args: m.args,
          model: null,
          hook: false,
          isolation: "machine",
          settings: { disableAllHooks: true },
          setEnv: [],
          notes: [],
        };
      }),
    );
    expect(unhooked.instrument.reasons.join()).toContain("disableAllHooks");
    expect(rescore(path.join(RECORDED, "demo-api-recall")).instrument.fault).toBe(false);
  });

  it("faults a trial started with other arguments than the run recorded", async () => {
    const { result } = await demo(() => ({ preloads: ["CLAUDE.local.md"], args: ["-p", "--bare"] }), {
      setup: { model: null },
      trials: 1,
    });
    expect(result.trials[0]?.reasons.join()).toContain("other arguments than the run recorded");
    const same = await demo(() => ({ preloads: ["CLAUDE.local.md"] }), { setup: { model: null }, trials: 1 });
    expect(same.result.instrument.fault).toBe(false);
  });
});

describe("--isolation clean (EXPERIMENTAL)", () => {
  it("runs with the repository's settings only, a pinned model and the ancestors excluded, and says it is experimental", async () => {
    const fx = fakeRepo({ "CLAUDE.md": "# P\n" });
    const { result, saveDir } = await probeFake(fx, {
      env: { FAKE_CLAUDE_ECHO: withControl("CLAUDE.md"), FAKE_CLAUDE_HOOK: withControl("CLAUDE.md") },
      adapter: { isolation: "clean", model: "fable" },
    });
    const args = result.manifest.args;
    expect(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2)).toEqual([
      "--setting-sources",
      "project,local",
    ]);
    expect(args).toContain("--disable-slash-commands");
    expect(args.join(" ")).toContain("--model fable");
    const s = result.manifest.session;
    expect(s).toMatchObject({ isolation: "clean", hook: true, setEnv: ["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] });
    const excludes = (s?.settings?.claudeMdExcludes ?? []) as string[];
    expect(excludes.length).toBeGreaterThan(5);
    expect(excludes.every((e) => !e.includes("\\") || /^[A-Z]:\\ctxreach-probe/i.test(e))).toBe(true);
    expect(excludes.some((e) => e.endsWith("/.claude/CLAUDE.md"))).toBe(true);
    expect(s?.settings?.pluginConfigs).toEqual({
      "agents-md@builtin": { options: { instructionFiles: "claude-md-or-agents-md" } },
    });
    expect(result.instrument.fault).toBe(false);
    expect(result.warnings.join()).toContain("--isolation clean is EXPERIMENTAL");
    // The agent got the variable that turns auto memory off.
    const report = JSON.parse(
      (readFileSync(path.join(saveDir, "trial-1.jsonl"), "utf8").split("\n")[1] ?? "").replace(/^/, ""),
    ) as { message: { content: { text: string }[] } };
    expect(JSON.parse(report.message.content[0]?.text ?? "{}")).toMatchObject({ autoMemory: "1" });
  }, 30_000);

  it("refuses to run without a model to pin", async () => {
    const fx = fakeRepo({ "CLAUDE.md": "# P\n" });
    await expect(probeFake(fx, { adapter: { isolation: "clean" } })).rejects.toThrow(/needs a model to pin/);
    expect(readdirSync(fx.tmp)).toEqual([]);
  });

  it("faults a session with a plugin that is not built in, or a file from outside the copy", async () => {
    const fx = fakeRepo({ "CLAUDE.md": "# P\n" });
    const plugin = await probeFake(fx, {
      env: {
        FAKE_CLAUDE_ECHO: withControl(),
        FAKE_CLAUDE_HOOK: withControl(),
        FAKE_CLAUDE_PLUGINS: "agents-md@builtin,mine@market",
      },
      adapter: { isolation: "clean", model: "fable" },
    });
    expect(plugin.result.trials[0]?.reasons.join()).toContain("1 plugin(s) that are not built in");
    const outside = await probeFake(fx, {
      env: { FAKE_CLAUDE_ECHO: withControl(), FAKE_CLAUDE_HOOK: withControl(path.join(fx.home, "CLAUDE.md")) },
      adapter: { isolation: "clean", model: "fable" },
    });
    expect(outside.result.instrument.reasons.join()).toContain(
      "under clean isolation, the hook saw files outside the copy",
    );
  }, 30_000);

  it("excludes, for every directory above the copy, each instruction file it could hold, by exact path", () => {
    expect(ancestorExcludes("C:\\t\\ctxreach-probe-x\\repo")).toEqual([
      ...["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", ".claude/AGENTS.md"].map(
        (f) => `C:/t/ctxreach-probe-x/${f}`,
      ),
      "C:/t/ctxreach-probe-x/.claude/rules/**",
      ...["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", ".claude/AGENTS.md"].map(
        (f) => `C:/t/${f}`,
      ),
      "C:/t/.claude/rules/**",
      ...["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md", "AGENTS.md", ".claude/AGENTS.md"].map((f) => `C:/${f}`),
      "C:/.claude/rules/**",
    ]);
    expect(ancestorExcludes("/tmp/repo")).toContain("/tmp/.claude/CLAUDE.md");
    expect(ancestorExcludes("/tmp/repo")).toContain("/.claude/rules/**");
    expect(ancestorExcludes("/tmp/repo").some((e) => e.startsWith("/tmp/repo"))).toBe(false);
  });
});

describe("the report", () => {
  it("prints the session, the copy's location and the hook's rows, and gives them in JSON (v2)", async () => {
    const fx = fakeRepo(
      { "CLAUDE.md": "# P\n", "AGENTS.md": "# A\n" },
      { ".claude/settings.json": '{"model":"fable"}' },
    );
    const { saveDir: save, adapter } = await probeFake(fx, {
      env: {
        FAKE_CLAUDE_ECHO: withControl("CLAUDE.md"),
        FAKE_CLAUDE_HOOK: withControl("CLAUDE.md"),
        FAKE_CLAUDE_MODEL: "claude-fable-5-1",
      },
    });
    const out = await cli(adapter, "probe", "--replay", save, "--no-color");
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(
      /session\s+model pinned to fable \(from settings\.json \(model\)\); InstructionsLoaded hook on; isolation machine/,
    );
    expect(out.stdout).toMatch(
      /copy\s+inside the home directory: no; ~\/\.claude\/CLAUDE\.md exists: no; instruction files above the copy: none/,
    );
    expect(out.stdout).toContain("positive control repeated: 1/1 trials (must be 1/1)");
    expect(out.stdout).toContain("InstructionsLoaded hook: 2 events in 1 usable trials");
    expect(out.stdout).toContain(
      "canary x hook, per file and trial: both 2, hook-blind (AGENTS.md) 0, hook missed 0, echo missed 0, neither 1, read by the model 0",
    );
    expect(out.stdout).toContain("partial echoes (one of a file's two tokens repeated): 0/2 file-trials");
    const json = ProbeJson.parse(JSON.parse((await cli(adapter, "probe", "--replay", save, "--json")).stdout));
    expect(json.schema).toBe("ctxreach.probe/v2");
    expect(json.session).toMatchObject({
      model: { pin: "fable" },
      hook: true,
      isolation: "machine",
      experimental: false,
    });
    expect(json.instrument.control).toMatchObject({ status: "planted", fraction: "1/1" });
    expect(json.instrument.hook?.rates).toEqual({ hookGivenSeen: "2/2", seenGivenHook: "2/2", agentsBlind: "0/0" });
    expect(json.cells.filter((c) => c.control).map((c) => c.position)).toEqual(["head", "tail"]);
    expect(json.location).toEqual({ underHome: false, userClaudeMd: false, ancestors: [] });
    expect(existsSync(path.join(save, "trial-1.hooks.jsonl"))).toBe(true);
  }, 30_000);
});

describe("the refusals, one by one", () => {
  it("assertRunnable refuses each kill switch, each kill flag, and any disableAllHooks", () => {
    for (const name of KILL_SWITCHES)
      expect(() => assertRunnable({ env: { [name]: "1" }, args: [] })).toThrow(new RegExp(`${name} is set`));
    expect(() => assertRunnable({ env: { CLAUDE_CODE_SIMPLE: "0" }, args: [] })).not.toThrow();
    for (const flag of ["--bare", "--safe-mode", "--restricted", "--restricted=1"])
      expect(() => assertRunnable({ env: {}, args: ["-p", flag] })).toThrow(/refusing to run Claude Code with/);
    for (const value of [true, false])
      expect(() => assertRunnable({ env: {}, args: [], settings: { disableAllHooks: value } })).toThrow(
        /disableAllHooks/,
      );
    expect(() => assertRunnable({ env: {}, args: ["-p"], settings: { hooks: {} } })).not.toThrow();
  });

  it("runProbe refuses an agent whose environment turns instruction files off, before copying", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const tmp = tempDir("probe-tmp");
    const agent = {
      ...fakeAgent(() => ({ preloads: [] })),
      environment: () => ({ bare: true, killSwitches: ["CLAUDE_CODE_SIMPLE"], removedEnv: [], notes: [] }),
    };
    await expect(
      runProbe({
        adapter: agent,
        repoRoot: fx.repo,
        launchDir: fx.repo,
        mode: "recall",
        trials: 1,
        timeoutMs: 1000,
        saveDir: path.join(tempDir("probe-save"), "run"),
        ctxreachVersion: "0",
        tmpRoot: tmp,
      }),
    ).rejects.toThrow(/CLAUDE_CODE_SIMPLE is set, which turns instruction files off/);
    expect(agent.runs).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("refuses a v2 recording that lacks the control, the location or the session", () => {
    for (const key of ["control", "location", "session"]) {
      const dir = recordedCopy("demo-api-recall", (m) => {
        m.schema = "ctxreach.probe-recording/v2";
        m.control = { file: CONTROL_AT_API, delivery: "launch", why: "project rule", rule: "claude.rules" };
        m.location = { underHome: false, userClaudeMd: false, ancestors: [] };
        m.session = { args: m.args, model: null, hook: false, isolation: "machine", setEnv: [], notes: [] };
        delete m[key];
      });
      expect(() => readRecording(dir)).toThrow(new RegExp(`${key}: required in ctxreach.probe-recording/v2`));
    }
  });
});
