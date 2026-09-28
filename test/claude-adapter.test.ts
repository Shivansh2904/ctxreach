import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentEnv, claudeAdapter, claudeArgs, findClaude } from "../src/agents/claude/adapter.js";
import { createSandbox, removeSandbox } from "../src/probe/sandbox.js";
import { SafetyError, type RunRequest } from "../src/probe/types.js";
import { materialise, tempDir } from "./helpers/fixture.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers", "fake-claude.mjs");

function adapter(env: NodeJS.ProcessEnv = {}, claudeHome = tempDir("claude-home")) {
  return {
    claudeHome,
    agent: claudeAdapter({
      bin: process.execPath,
      prefixArgs: [FAKE],
      claudeHome,
      env: { ...process.env, FAKE_CLAUDE_HOME: claudeHome, ...env },
    }),
  };
}

function request(workdir: string, extra: Partial<RunRequest> = {}): RunRequest {
  return {
    workdir,
    prompt: "list the tokens",
    mode: "recall",
    timeoutMs: 30_000,
    transcriptPath: path.join(tempDir("transcript"), "t.jsonl"),
    redactions: [],
    ...extra,
  };
}

describe("claude -p arguments", () => {
  it("turns every tool off in recall mode and allows only the read tools in task mode", () => {
    const recall = claudeArgs("recall");
    const task = claudeArgs("task");
    expect(recall.slice(recall.indexOf("--tools"), recall.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(task.slice(task.indexOf("--tools"), task.indexOf("--tools") + 2)).toEqual(["--tools", "Read,Glob,Grep"]);
    for (const args of [recall, task]) {
      expect(args).toEqual(
        expect.arrayContaining([
          "-p",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--strict-mcp-config",
          "--permission-mode",
          "dontAsk",
        ]),
      );
      // Never bare mode (skips CLAUDE.md), never a blanket allow rule, never a settings override.
      for (const banned of ["--bare", "--allowedTools", "--allowed-tools", "--settings", "--setting-sources"])
        expect(args).not.toContain(banned);
    }
  });

  it("removes the variables a parent Claude Code session sets, and keeps the user's own", () => {
    const { env, removed } = agentEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "x",
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CONFIG_DIR: "/c",
      PATH: "/bin",
    });
    expect(removed).toEqual(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"]);
    expect(Object.keys(env).sort()).toEqual(["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CONFIG_DIR", "PATH"]);
  });

  it("reports bare and safe mode as settings that skip instruction files", () => {
    expect(claudeAdapter({ env: { CLAUDE_CODE_SIMPLE: "1" } }).environment().bare).toBe(true);
    expect(claudeAdapter({ env: { CLAUDE_CODE_SAFE_MODE: "true" } }).environment().bare).toBe(true);
    expect(claudeAdapter({ env: { CLAUDE_CODE_SIMPLE: "0" } }).environment().bare).toBe(false);
  });
});

describe("finding the claude executable", () => {
  it("prefers CTXREACH_CLAUDE_BIN", () => {
    expect(findClaude({ CTXREACH_CLAUDE_BIN: "/opt/claude", PATH: "" })).toBe("/opt/claude");
  });

  it.runIf(process.platform === "win32")("uses the executable behind npm's claude.cmd shim on Windows", () => {
    const dir = tempDir("npm-bin");
    writeFileSync(path.join(dir, "claude.cmd"), "@echo off\n");
    const exe = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    mkdirSync(path.dirname(exe), { recursive: true });
    writeFileSync(exe, "");
    expect(findClaude({ PATH: dir })).toBe(exe);
  });

  it.runIf(process.platform !== "win32")("finds claude on PATH", () => {
    const dir = tempDir("bin");
    writeFileSync(path.join(dir, "claude"), "#!/bin/sh\n");
    expect(findClaude({ PATH: dir })).toBe(path.join(dir, "claude"));
  });

  it("returns nothing when there is no claude", () => {
    expect(findClaude({ PATH: tempDir("empty-bin") })).toBeUndefined();
  });
});

describe("running the agent (with a fake claude executable)", () => {
  it("reads the version", async () => {
    expect(await adapter().agent.version()).toBe("9.9.9");
  });

  it("runs in the sandbox, passes the prompt on stdin, scrubs the parent session and redacts the transcript", async () => {
    const fx = materialise("claude-local-shadows-agents");
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      const { agent, claudeHome } = adapter({ CLAUDECODE: "1", CLAUDE_CODE_USE_BEDROCK: "1" });
      const req = request(box.repo, { redactions: [{ from: box.base, to: "C:\\ctxreach-probe" }] });
      const out = await agent.run(req);
      expect(out).toMatchObject({ exitCode: 0, timedOut: false, leftovers: [] });
      const text = readFileSync(req.transcriptPath, "utf8");
      const t = agent.parse(text);
      const report = JSON.parse((t.items[0] as { text: string }).text) as Record<string, unknown>;
      expect(report.prompt).toBe("list the tokens");
      expect(report.parentSession).toBe("unset");
      expect(report.userVar).toBe("1");
      expect(report.args).toEqual(claudeArgs("recall"));
      expect(t.cwd?.replace(/\//g, "\\")).toBe("C:\\ctxreach-probe\\repo");
      expect(t.toolsOffered).toEqual([]);
      expect(text).not.toContain("private-command");
      // The empty per-project folder the agent made in the user directory is gone.
      expect(readdirSync(path.join(claudeHome, "projects"))).toEqual([]);
    } finally {
      removeSandbox(box);
    }
  });

  it("reports a per-project folder it could not remove because it holds a file", async () => {
    const fx = materialise("claude-local-shadows-agents");
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      const { agent, claudeHome } = adapter();
      const slug = box.repo.replace(/[^A-Za-z0-9]/g, "-");
      mkdirSync(path.join(claudeHome, "projects", slug, "memory"), { recursive: true });
      writeFileSync(path.join(claudeHome, "projects", slug, "memory", "MEMORY.md"), "note");
      const out = await agent.run(request(box.repo));
      expect(out.leftovers).toEqual([path.join(claudeHome, "projects", slug)]);
      expect(existsSync(path.join(claudeHome, "projects", slug, "memory", "MEMORY.md"))).toBe(true);
    } finally {
      removeSandbox(box);
    }
  });

  it("redacts the stderr and leftover paths it returns, since they are saved in the manifest", async () => {
    const fx = materialise("claude-local-shadows-agents");
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      const { agent, claudeHome } = adapter({ FAKE_CLAUDE_STDERR: `warning: cannot read ${box.repo}\n` });
      const slug = box.repo.replace(/[^A-Za-z0-9]/g, "-");
      mkdirSync(path.join(claudeHome, "projects", slug, "memory"), { recursive: true });
      writeFileSync(path.join(claudeHome, "projects", slug, "memory", "MEMORY.md"), "note");
      const out = await agent.run(
        request(box.repo, {
          redactions: [
            { from: box.base, to: "/tmp/ctxreach-probe" },
            { from: claudeHome, to: "/home/user/.claude" },
          ],
        }),
      );
      expect(out.stderr).toBe("warning: cannot read /tmp/ctxreach-probe" + path.sep + "repo\n");
      expect(out.leftovers).toEqual(["/home/user/.claude" + path.sep + "projects" + path.sep + slug]);
    } finally {
      removeSandbox(box);
    }
  });

  it("refuses to run anywhere but a sandbox's copy, even in a directory with its own .git", async () => {
    const fx = materialise("claude-local-shadows-agents");
    const { agent } = adapter();
    await expect(agent.run(request(fx.repo))).rejects.toThrow(SafetyError);
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      // The sandbox directory itself, outside its repo/ copy, is refused too.
      await expect(agent.run(request(box.base))).rejects.toThrow(SafetyError);
    } finally {
      removeSandbox(box);
    }
  });

  it("stops a run that does not finish in time", async () => {
    const fx = materialise("claude-local-shadows-agents");
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      const { agent } = adapter({ FAKE_CLAUDE_BEHAVIOUR: "hang" });
      const out = await agent.run(request(box.repo, { timeoutMs: 800 }));
      expect(out.timedOut).toBe(true);
      // Stopped at the limit, not when the fake gave up on its own after 10 seconds.
      expect(out.durationMs).toBeLessThan(5000);
    } finally {
      removeSandbox(box);
    }
  }, 20_000);
});
