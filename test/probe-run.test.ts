import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/agents/claude/adapter.js";
import { runProbe, type ProbeOptions } from "../src/probe/probe.js";
import { SANDBOX_PREFIX } from "../src/probe/sandbox.js";
import { scoreRecording, type ProbeResult } from "../src/probe/score.js";
import { SafetyError, type AgentAdapter } from "../src/probe/types.js";
import { createCli } from "../src/program.js";
import { ProbeJson } from "../src/report/probe.js";
import { fakeAgent, type FakeBehaviour, type FakeRun } from "./helpers/fake-agent.js";
import { materialise, tempDir, type Materialised } from "./helpers/fixture.js";

/** Hash of every file under `dir`, so a test can show the source was not changed. */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(path.relative(dir, p) + "\0").update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-claude.mjs");

/** True while a process with this id exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Wait until `check` is true; fail after `ms`. */
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`still not true after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface Probed {
  fx: Materialised;
  tmp: string;
  result: ProbeResult;
  runs: FakeRun[];
  before: string;
  after: string;
}

async function probe(
  behaviour: (run: FakeRun) => FakeBehaviour,
  options: Partial<ProbeOptions> & { from?: string; fx?: Materialised } = {},
): Promise<Probed> {
  const fx = options.fx ?? materialise("demo-monorepo", { example: true });
  const tmp = tempDir("probe-tmp");
  const save = path.join(tempDir("probe-save"), "run");
  const agent = fakeAgent(behaviour);
  const before = treeHash(fx.repo);
  const recording = await runProbe({
    adapter: agent,
    repoRoot: fx.repo,
    launchDir: fx.at(options.from ?? "packages/api"),
    mode: options.mode ?? "recall",
    trials: options.trials ?? 3,
    timeoutMs: 1000,
    saveDir: save,
    claudeHome: fx.claudeHome,
    ctxreachVersion: "0.0.0-test",
    tmpRoot: tmp,
    ...(options.task !== undefined ? { task: options.task } : {}),
  });
  return {
    fx,
    tmp,
    result: scoreRecording(recording, agent),
    runs: agent.runs,
    before,
    after: treeHash(fx.repo),
  };
}

function cells(result: ProbeResult) {
  return result.cells.map((c) => [
    c.file,
    c.position,
    c.verdict,
    Object.entries(c.seen)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k} ${v}/${c.usable}`)
      .join(", "),
  ]);
}

describe("probe on the demo monorepo with a fake agent", () => {
  it("confirms the documented behaviour, leaves the source alone and removes the copy", async () => {
    const p = await probe(() => ({ preloads: ["CLAUDE.local.md"] }));
    expect(cells(p.result)).toEqual([
      ["AGENTS.md", "head", "confirmed", "not-seen 3/3"],
      ["AGENTS.md", "tail", "confirmed", "not-seen 3/3"],
      ["CLAUDE.local.md", "head", "confirmed", "preloaded 3/3"],
      ["CLAUDE.local.md", "tail", "confirmed", "preloaded 3/3"],
      ["packages/api/AGENTS.md", "head", "confirmed", "not-seen 3/3"],
      ["packages/api/AGENTS.md", "tail", "confirmed", "not-seen 3/3"],
      ["packages/web/AGENTS.md", "head", "confirmed", "not-seen 3/3"],
      ["packages/web/AGENTS.md", "tail", "confirmed", "not-seen 3/3"],
      ["packages/api/ctxreach-decoy.md", "head", "confirmed", "not-seen 3/3"],
      ["packages/api/ctxreach-decoy.md", "tail", "confirmed", "not-seen 3/3"],
    ]);
    expect(p.result.instrument).toEqual({ fault: false, reasons: [], decoy: { echoed: 0, usable: 3 } });
    expect(p.result.agreement).toMatchObject({ agree: 8, decided: 8, cells: 8 });
    expect(p.result.trials.map((t) => t.status)).toEqual(["usable", "usable", "usable"]);
    expect(p.after).toBe(p.before);
    expect(readdirSync(p.tmp).filter((n) => n.startsWith(SANDBOX_PREFIX))).toEqual([]);
    // Every run happened in the copy's launch directory, which had its own .git.
    for (const run of p.runs) {
      expect(run.hasGit).toBe(true);
      expect(path.relative(run.repo, run.workdir).split(path.sep).join("/")).toBe("packages/api");
      expect(run.workdir.startsWith(p.tmp)).toBe(true);
    }
  });

  it("keeps map's prediction, with its rule, in the recording", async () => {
    const p = await probe(() => ({ preloads: ["CLAUDE.local.md"] }));
    const pred = p.result.manifest.predicted.find((f) => f.file === "AGENTS.md");
    expect(pred).toMatchObject({ delivery: "not-loaded", rule: "claude.agents-default" });
  });

  it("reports EXTRA when a file map says is switched off arrives anyway", async () => {
    const p = await probe(() => ({ preloads: ["CLAUDE.local.md", "AGENTS.md"] }), { trials: 2 });
    const agents = p.result.cells.filter((c) => c.file === "AGENTS.md");
    expect(agents.map((c) => [c.verdict, c.seen.preloaded, c.usable])).toEqual([
      ["extra", 2, 2],
      ["extra", 2, 2],
    ]);
    expect(p.result.agreement).toMatchObject({ agree: 6, decided: 8 });
  });

  it("reports MISSED when a file predicted at launch is not repeated in every trial", async () => {
    let n = 0;
    const p = await probe(() => ({ preloads: n++ === 0 ? [] : ["CLAUDE.local.md"] }));
    const local = p.result.cells.filter((c) => c.file === "CLAUDE.local.md");
    expect(local.map((c) => [c.verdict, c.seen.preloaded, c.seen["not-seen"]])).toEqual([
      ["missed", 2, 1],
      ["missed", 2, 1],
    ]);
  });

  it("flags an instrument fault when the decoy is repeated without being read", async () => {
    const p = await probe(() => ({ preloads: ["CLAUDE.local.md", "packages/api/ctxreach-decoy.md"] }), {
      trials: 2,
    });
    expect(p.result.instrument.fault).toBe(true);
    expect(p.result.instrument.decoy).toEqual({ echoed: 2, usable: 2 });
    expect(p.result.instrument.reasons.join()).toContain("decoy");
  });

  it("gives an ancestor's rule, which map does not model, no verdict and leaves it out of the agreement", async () => {
    const fx = materialise("claude-local-shadows-agents");
    mkdirSync(fx.at(".claude/rules"), { recursive: true });
    writeFileSync(fx.at(".claude/rules/style.md"), "# Style\n\nUse tabs.\n");
    mkdirSync(fx.at("packages/api"), { recursive: true });
    const p = await probe(() => ({ preloads: ["CLAUDE.local.md", ".claude/rules/style.md"] }), {
      fx,
      from: "packages/api",
      trials: 2,
    });
    expect(p.result.manifest.predicted.find((f) => f.file === ".claude/rules/style.md")).toMatchObject({
      delivery: "not-loaded",
      notModelled: true,
    });
    const style = p.result.cells.filter((c) => c.file === ".claude/rules/style.md");
    expect(style.map((c) => [c.expected, c.verdict, c.seen.preloaded])).toEqual([
      ["not-modelled", "not-modelled", 2],
      ["not-modelled", "not-modelled", 2],
    ]);
    // CLAUDE.local.md (2 cells) and AGENTS.md (2 cells) are decided; the rule's 2 cells are not.
    expect(p.result.agreement).toMatchObject({ agree: 4, decided: 4, cells: 6 });
  });

  it("does not flag the decoy when the agent read it before repeating it", async () => {
    const p = await probe(() => ({ preloads: ["CLAUDE.local.md"], reads: ["packages/api/ctxreach-decoy.md"] }), {
      mode: "task",
      trials: 2,
    });
    const decoy = p.result.cells.filter((c) => c.decoy);
    expect(decoy.map((c) => c.seen["self-discovered"])).toEqual([2, 2]);
    expect(p.result.instrument).toEqual({ fault: false, reasons: [], decoy: { echoed: 0, usable: 2 } });
  });

  it("flags an instrument fault when a recall session had tools, and excludes that trial", async () => {
    let n = 0;
    const p = await probe(() => ({ preloads: ["CLAUDE.local.md"], ...(n++ === 1 ? { toolsOffered: ["Bash"] } : {}) }));
    expect(p.result.trials.map((t) => t.status)).toEqual(["usable", "fault", "usable"]);
    expect(p.result.instrument.fault).toBe(true);
    expect(p.result.cells.find((c) => c.file === "CLAUDE.local.md")?.usable).toBe(2);
  });

  it("flags an instrument fault when the agent ran somewhere else", async () => {
    const p = await probe((run) => ({ preloads: ["CLAUDE.local.md"], cwd: run.repo }), { trials: 1 });
    expect(p.result.trials[0]?.status).toBe("fault");
    expect(p.result.instrument.reasons.join()).toContain("not the launch directory");
  });

  it("counts a trial with no result event as failed, not as a trial that saw nothing", async () => {
    const p = await probe(() => ({ preloads: [], unfinished: true }), { trials: 1 });
    expect(p.result.trials[0]).toMatchObject({ status: "failed", reasons: ["no final result event"] });
    expect(p.result.cells.every((c) => c.verdict === "no-data")).toBe(true);
  });

  it("in task mode, calls a file the agent opened itself DISCOVERED, not preloaded", async () => {
    const p = await probe(() => ({ preloads: ["CLAUDE.local.md"], reads: ["packages/api/AGENTS.md"] }), {
      mode: "task",
      trials: 2,
    });
    const api = p.result.cells.filter((c) => c.file === "packages/api/AGENTS.md");
    expect(api.map((c) => [c.verdict, c.seen["self-discovered"]])).toEqual([
      ["discovered", 2],
      ["discovered", 2],
    ]);
    expect(p.result.manifest.prompt).toContain("Use only the Read, Glob and Grep tools");
  });

  it("warns that there is no positive control when nothing is predicted at launch", async () => {
    const fx = materialise("codex-nested-below-cwd");
    const p = await probe(() => ({ preloads: [] }), { fx, from: ".", trials: 1 });
    // AGENTS.md loads at launch here, so there is a positive control...
    expect(p.result.warnings.join()).not.toContain("positive control");
    // ...and when the agent repeats nothing, the MISSED cells and the warning say so.
    expect(p.result.cells.find((c) => c.file === "AGENTS.md")?.verdict).toBe("missed");
    expect(p.result.warnings.join()).toContain("No planted token was repeated");
  });
});

describe("probe sandbox safety, end to end", () => {
  it("removes hooks, MCP servers, skills and Codex config from the copy before the agent runs", async () => {
    const fx = materialise("claude-local-shadows-agents");
    const files: Record<string, string> = {
      ".claude/settings.json": '{"hooks":{"SessionStart":[]}}',
      ".claude/settings.local.json": "{}",
      ".claude/skills/x/SKILL.md": "# skill",
      ".claude/agents/a.md": "# agent",
      ".mcp.json": '{"mcpServers":{}}',
      ".codex/config.toml": "project_doc_max_bytes = 1",
      "packages/api/.claude/settings.local.json": "{}",
      "packages/api/.mcp.json": "{}",
    };
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(path.dirname(fx.at(rel)), { recursive: true });
      writeFileSync(fx.at(rel), text);
    }
    const p = await probe(() => ({ preloads: [] }), { fx, from: ".", trials: 1 });
    expect(p.runs[0]?.unstripped).toEqual([]);
    expect(p.result.manifest.sandbox.stripped).toEqual([
      ".claude/agents",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".claude/skills",
      ".codex",
      ".mcp.json",
      "packages/api/.claude/settings.local.json",
      "packages/api/.mcp.json",
    ]);
    // The source still has them all.
    for (const rel of Object.keys(files)) expect(statSync(fx.at(rel)).isFile()).toBe(true);
    expect(p.result.manifest.sandbox.skipped).toEqual([".git"]);
  });

  it("runs the agent in a copy with no links, leaves a linked .claude outside untouched, and says so", async () => {
    const fx = materialise("claude-local-shadows-agents");
    const outside = tempDir("linked-claude");
    mkdirSync(path.join(outside, "skills", "x"), { recursive: true });
    writeFileSync(path.join(outside, "settings.json"), '{"hooks":{"SessionStart":[]}}');
    writeFileSync(path.join(outside, "skills", "x", "SKILL.md"), "# skill");
    const link = (target: string, at: string) =>
      symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
    link(outside, fx.at(".claude"));
    mkdirSync(fx.at("packages/api"), { recursive: true });
    writeFileSync(fx.at("packages/api/AGENTS.md"), "# API\n");
    link(fx.at("packages/api"), fx.at("packages/shared"));
    const before = treeHash(outside);

    const p = await probe(() => ({ preloads: [] }), { fx, from: ".", trials: 1 });
    expect(treeHash(outside)).toBe(before);
    expect(p.runs[0]?.links).toEqual([]);
    expect(p.result.manifest.sandbox.links).toEqual([
      ".claude: not copied (a link to outside the repository)",
      "packages/shared: copied as a directory (a link to packages/api)",
    ]);
    expect(p.result.notes.join("\n")).toContain(
      "each link in the repository was copied as what it points to, or left out: .claude: not copied",
    );
    // The linked directory's copy is a directory of its own, so its file is planted separately.
    expect(p.result.cells.map((c) => c.file)).toContain("packages/shared/AGENTS.md");
  });

  it("refuses to record inside the repository being probed", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const agent = fakeAgent(() => ({ preloads: [] }));
    await expect(
      runProbe({
        adapter: agent,
        repoRoot: fx.repo,
        launchDir: fx.repo,
        mode: "recall",
        trials: 1,
        timeoutMs: 1000,
        saveDir: fx.at("probe-out"),
        ctxreachVersion: "0",
      }),
    ).rejects.toThrow(SafetyError);
    expect(agent.runs).toEqual([]);
  });

  it("refuses to record inside the repository reached through a link, and writes nothing there", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const via = path.join(tempDir("via"), "repo");
    symlinkSync(fx.repo, via, process.platform === "win32" ? "junction" : "dir");
    const before = treeHash(fx.repo);
    const agent = fakeAgent(() => ({ preloads: [] }));
    try {
      await expect(
        runProbe({
          adapter: agent,
          repoRoot: fx.repo,
          launchDir: fx.repo,
          mode: "recall",
          trials: 1,
          timeoutMs: 1000,
          saveDir: path.join(via, "probe-out"),
          ctxreachVersion: "0",
          tmpRoot: tempDir("probe-tmp"),
        }),
      ).rejects.toThrow(/refusing to record inside the repository/);
      expect(agent.runs).toEqual([]);
      expect(treeHash(fx.repo)).toBe(before);
    } finally {
      rmSync(via);
    }
  });

  it("when interrupted, stops the agent (and on Windows what it started) before deleting the copy", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const tmp = tempDir("probe-tmp");
    const pids = path.join(tempDir("pids"), "pids.json");
    const claudeHome = tempDir("claude-home");
    const adapter = claudeAdapter({
      bin: process.execPath,
      prefixArgs: [FAKE_CLAUDE],
      claudeHome,
      env: {
        ...process.env,
        FAKE_CLAUDE_HOME: claudeHome,
        FAKE_CLAUDE_BEHAVIOUR: "hang",
        FAKE_CLAUDE_IGNORE_SIGTERM: "1",
        FAKE_CLAUDE_PIDS: pids,
      },
    });
    // Stands in for the process: its signals, and an exit that only records the status.
    const exits: number[] = [];
    const host = Object.assign(new EventEmitter(), { exit: (code: number) => void exits.push(code) });
    const running = runProbe({
      adapter,
      repoRoot: fx.repo,
      launchDir: fx.repo,
      mode: "recall",
      trials: 1,
      timeoutMs: 60_000,
      saveDir: path.join(tempDir("probe-save"), "run"),
      claudeHome: fx.claudeHome,
      ctxreachVersion: "0",
      tmpRoot: tmp,
      host: host as unknown as ProbeOptions["host"],
    }).catch((err: unknown) => err);
    await until(() => existsSync(pids));
    const { agent, child } = JSON.parse(readFileSync(pids, "utf8")) as { agent: number; child: number };
    try {
      expect(alive(agent)).toBe(true);

      host.emit("SIGTERM", "SIGTERM");
      expect(exits).toEqual([143]);
      // The copy is gone at once, although the agent had its working directory in it.
      expect(readdirSync(tmp)).toEqual([]);
      // Stopped now, not when the fake gives up after 10 seconds.
      await until(() => !alive(agent) && (process.platform !== "win32" || !alive(child)), 5000);
    } finally {
      // Whatever failed above, leave no process running: it would hold the temporary directories.
      for (const pid of [agent, child]) if (alive(pid)) process.kill(pid, "SIGKILL");
      // Elsewhere than Windows, the fake's own child can stay a zombie until whoever adopted it reaps it.
      await until(() => !alive(agent) && (process.platform !== "win32" || !alive(child)), 5000);
      await running;
    }
  }, 20_000);

  it("removes the copy when the agent fails", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const tmp = tempDir("probe-tmp");
    const agent: AgentAdapter = {
      ...fakeAgent(() => ({ preloads: [] })),
      run: async () => {
        throw new Error("agent crashed");
      },
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
    ).rejects.toThrow("agent crashed");
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("saves transcripts without the copy's real path, the home directory or the user's command list", async () => {
    const p = await probe(() => ({ preloads: ["CLAUDE.local.md"] }), { trials: 1 });
    const text = readFileSync(path.join(p.result.recordingDir, "trial-1.jsonl"), "utf8");
    expect(text).not.toContain(p.tmp.split(path.sep).join("\\\\"));
    expect(text).not.toContain(p.tmp.split(path.sep).join("/"));
    expect(text).not.toContain("personal-command");
    expect(text).not.toContain("utilization");
    expect(text).not.toContain("memory_paths");
    expect(text).toContain(p.result.manifest.repo.split("\\").join("\\\\"));
  });
});

async function ctxreach(adapter: AgentAdapter | undefined, ...args: string[]) {
  let stdout = "";
  let stderr = "";
  const cli = createCli(
    { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
    { exitOverride: true, adapter: () => adapter },
  );
  await cli.program.parseAsync(["node", "ctxreach", ...args]);
  // eslint-disable-next-line no-control-regex
  return { stdout: stdout.replace(/\u001b\[[0-9;]*m/g, ""), stderr, status: cli.status };
}

describe("ctxreach probe (command line)", () => {
  it("runs, records, and prints every cell as a fraction with the version stamp and the scope", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const save = path.join(tempDir("probe-save"), "run");
    const agent = fakeAgent(() => ({ preloads: ["CLAUDE.local.md"] }));
    const out = await ctxreach(agent, "probe", "--from", fx.at("packages/api"), "--trials", "2", "--save", save);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("Claude Code 9.9.9, recall mode, launch dir packages/api");
    expect(out.stdout).toMatch(/CLAUDE\.local\.md\s+head\s+launch\s+preloaded 2\/2\s+CONFIRMED/);
    expect(out.stdout).toMatch(/AGENTS\.md\s+head\s+no: switched off by CLAUDE\.local\.md\s+not seen 2\/2\s+CONFIRMED/);
    expect(out.stdout).toContain("decoy repeated without being read: 0/2 usable trials (must be 0)");
    expect(out.stdout).toContain("An echo proves the text was delivered to the model. It does not prove");
    expect(out.stderr).toContain("trial 2 of 2");

    // The same recording, replayed, gives the same report.
    const replay = await ctxreach(agent, "probe", "--replay", save);
    expect(replay.stdout).toBe(out.stdout);
    const json = ProbeJson.parse(JSON.parse((await ctxreach(agent, "probe", "--replay", save, "--json")).stdout));
    expect(json.cells.find((c) => c.file === "CLAUDE.local.md")?.fractions.preloaded).toBe("2/2");
    expect(json.scope[0]).toContain("does not prove");
  });

  it("exits 3 on an instrument fault", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const save = path.join(tempDir("probe-save"), "run");
    const agent = fakeAgent(() => ({ preloads: ["ctxreach-decoy.md"] }));
    const out = await ctxreach(agent, "probe", "--from", fx.repo, "--trials", "1", "--save", save);
    expect(out.stdout).toContain("INSTRUMENT FAULT");
    // The results are void, so no agreement figure is printed.
    expect(out.stdout).not.toContain("Agreement with map");
    expect(out.status).toBe(3);
  });

  it("says plainly that there is no Codex adapter yet", async () => {
    const out = await ctxreach(undefined, "probe", "--agent", "codex", "--replay", ".");
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("probe has no codex adapter yet");
  });

  it("exits 2 when --replay is not a recording", async () => {
    const out = await ctxreach(
      fakeAgent(() => ({ preloads: [] })),
      "probe",
      "--replay",
      tempDir("empty"),
    );
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("is it a probe recording?");
  });
});
