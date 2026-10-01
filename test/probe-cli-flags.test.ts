import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../src/agents/claude/adapter.js";
import type { AgentAdapter } from "../src/probe/types.js";
import { createCli, defaultAdapter, type ProbeAdapterOptions } from "../src/program.js";
import { tempDir } from "./helpers/fixture.js";

// The probe command's flags for the model pin, the hook and the isolation,
// as src/program.ts hands them to the adapter, and as the default adapter
// hands them to Claude Code's.

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "recorded");

/** Run `ctxreach probe --replay <a recording> ...flags`, and say what the adapter was built with. */
async function built(...flags: string[]) {
  const seen: ProbeAdapterOptions[] = [];
  let stdout = "";
  const cli = createCli(
    { stdout: (t) => (stdout += t), stderr: () => undefined },
    {
      exitOverride: true,
      adapter: (_agent, options): AgentAdapter => {
        seen.push(options);
        return claudeAdapter();
      },
    },
  );
  await cli.program.parseAsync([
    "node",
    "ctxreach",
    "probe",
    "--replay",
    path.join(RECORDED, "demo-api-recall"),
    "--no-color",
    ...flags,
  ]);
  expect(seen).toHaveLength(1);
  return { options: seen[0] as ProbeAdapterOptions, status: cli.status, stdout };
}

describe("ctxreach probe's flags reach the adapter", () => {
  it("defaults: machine isolation, the hook on, no model and no user directory given", async () => {
    const { options, status, stdout } = await built();
    expect(status).toBe(0);
    expect(stdout).toContain("Agreement with map: 8 of 8 decided cells agree");
    expect(options).toEqual({ isolation: "machine", hook: true });
  });

  it("--model, --isolation clean, --no-hook, --claude-home and --claude-bin, each as given", async () => {
    const home = tempDir("claude-home");
    const { options } = await built(
      "--model",
      " claude-opus-5-5 ",
      "--isolation",
      "clean",
      "--no-hook",
      "--claude-home",
      home,
      "--claude-bin",
      "some/claude",
    );
    expect(options).toEqual({
      bin: "some/claude",
      model: "claude-opus-5-5",
      isolation: "clean",
      hook: false,
      claudeHome: path.resolve(home),
    });
  });

  it("refuses an unknown isolation and an empty model", async () => {
    await expect(built("--isolation", "sealed")).rejects.toThrow(/Allowed choices are machine, clean/);
    await expect(built("--model", "  ")).rejects.toThrow(/must name a model/);
  });

  it("says in --help that clean is EXPERIMENTAL and that --json is ctxreach.probe/v2", () => {
    const cli = createCli({ stdout: () => undefined, stderr: () => undefined }, { exitOverride: true });
    const probe = cli.program.commands.find((c) => c.name() === "probe");
    // Commander wraps help to the terminal's width; join it back into one line.
    const help = (probe?.helpInformation() ?? "").replace(/\s+/g, " ");
    expect(help).toContain("--isolation <isolation>");
    expect(help).toMatch(/clean: EXPERIMENTAL/);
    expect(help).toContain("--no-hook");
    expect(help).toContain("--model <id>");
    expect(help).toContain("schema ctxreach.probe/v2");
    expect(help).not.toContain("ctxreach.probe/v1");
  });
});

describe("the default adapter passes the flags on to Claude Code's adapter", () => {
  // The variables that would choose a model or refuse the session are the test's to set.
  const VARS = [
    "ANTHROPIC_MODEL",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_SIMPLE",
    "CLAUDE_CODE_SAFE_MODE",
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
    "CLAUDE_CODE_DISABLE_ATTACHMENTS",
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const v of VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  /** The session the default adapter sets up for a recall run in a scratch sandbox. */
  function session(options: ProbeAdapterOptions) {
    const base = tempDir("flags-sandbox");
    const repo = path.join(base, "repo");
    mkdirSync(repo, { recursive: true });
    const adapter = defaultAdapter("claude", options);
    if (!adapter?.session) throw new Error("the default claude adapter has no session()");
    return adapter.session({ mode: "recall", sandboxBase: base, repo, redactions: [] });
  }

  it("--model is pinned, and the hook is on by default, in machine isolation", () => {
    const s = session({ model: "claude-opus-5-5", isolation: "machine", hook: true });
    expect(s.model).toEqual({ pin: "claude-opus-5-5", from: "--model" });
    expect(s.args).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5", "--settings"]));
    expect(s.hook).toBe(true);
    expect(s.isolation).toBe("machine");
    expect(s.args).not.toContain("--setting-sources");
  });

  it("--no-hook installs no hook and passes no settings layer", () => {
    const s = session({ model: "opus", isolation: "machine", hook: false });
    expect(s.hook).toBe(false);
    expect(s.args).not.toContain("--settings");
  });

  it("--isolation clean adds the clean flags", () => {
    const s = session({ model: "opus", isolation: "clean", hook: true });
    expect(s.isolation).toBe("clean");
    expect(s.args).toEqual(expect.arrayContaining(["--setting-sources", "project,local"]));
  });

  it("--claude-home is where the model pin is read from when no --model is given", () => {
    const home = tempDir("claude-home");
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({ model: "claude-pinned-from-home" }));
    const s = session({ isolation: "machine", hook: true, claudeHome: home });
    expect(s.model).toEqual({ pin: "claude-pinned-from-home", from: "settings.json (model)" });
    // The control: a user directory with no settings pins nothing.
    expect(session({ isolation: "machine", hook: true, claudeHome: tempDir("claude-home") }).model).toBeNull();
  });
});
