import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentEnv, claudeAdapter, claudeArgs, findClaude } from "../src/agents/claude/adapter.js";
import { createSandbox, gitEnv, removeSandbox, SANDBOX_PREFIX } from "../src/probe/sandbox.js";
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
    sandboxNonce: "",
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

  it("ignores relative PATH entries, which name a different directory wherever ctxreach runs", () => {
    const dir = tempDir("relative-bin");
    const name = process.platform === "win32" ? "claude.exe" : "claude";
    writeFileSync(path.join(dir, name), "");
    // Run from that directory, so that each entry below names it. (The tests
    // themselves may run on another drive than the temp directory, as on
    // GitHub's Windows runners, from where no relative spelling reaches it.)
    const entries = [".", "", path.join("..", path.basename(dir))];
    // On Windows, a rooted path without a drive names a directory on
    // whichever drive is current, and `C:name` one under its current directory.
    if (process.platform === "win32") entries.push(dir.slice(2), `${dir.slice(0, 2)}.`);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      for (const entry of entries) expect([entry, findClaude({ PATH: entry })]).toEqual([entry, undefined]);
      expect(findClaude({ PATH: entries.join(path.delimiter) })).toBeUndefined();
      // The same directory, given absolutely, is searched.
      expect(findClaude({ PATH: dir })).toBe(path.join(dir, name));
      expect(findClaude({ PATH: [...entries, dir].join(path.delimiter) })).toBe(path.join(dir, name));
    } finally {
      process.chdir(cwd);
    }
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
      const req = request(box.repo, {
        sandboxNonce: box.nonce,
        redactions: [{ from: box.base, to: "C:\\ctxreach-probe" }],
      });
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
      const out = await agent.run(request(box.repo, { sandboxNonce: box.nonce }));
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
          sandboxNonce: box.nonce,
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
    await expect(agent.run(request(fx.repo))).rejects.toThrow(/is not inside a ctxreach sandbox/);
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      // The sandbox directory itself, outside its repo/ copy, is refused too.
      await expect(agent.run(request(box.base, { sandboxNonce: box.nonce }))).rejects.toThrow(
        /is not inside the sandbox's copy/,
      );
    } finally {
      removeSandbox(box);
    }
  });

  describe("which claude executable runs", () => {
    // Relative to the directory the tests run in; from inside a sandbox's copy it names nothing.
    const nodeFromHere = path.relative(process.cwd(), process.execPath);

    it.skipIf(path.isAbsolute(nodeFromHere))(
      "takes a relative --claude-bin from the directory ctxreach runs in, not from the copy",
      async () => {
        const fx = materialise("claude-local-shadows-agents");
        const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
        try {
          const claudeHome = tempDir("claude-home");
          const agent = claudeAdapter({
            bin: nodeFromHere,
            prefixArgs: [FAKE],
            claudeHome,
            env: { ...process.env, FAKE_CLAUDE_HOME: claudeHome },
          });
          const out = await agent.run(request(box.repo, { sandboxNonce: box.nonce }));
          expect(out).toMatchObject({ exitCode: 0, timedOut: false });
        } finally {
          removeSandbox(box);
        }
      },
    );

    it("refuses a claude executable inside the copy, reached directly or through a link", async () => {
      const fx = materialise("claude-local-shadows-agents");
      const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
      const via = path.join(tempDir("via"), "copy");
      symlinkSync(box.repo, via, process.platform === "win32" ? "junction" : "dir");
      try {
        const name = process.platform === "win32" ? "claude.exe" : "claude";
        writeFileSync(path.join(box.repo, name), "");
        for (const bin of [path.join(box.repo, name), path.join(via, name)]) {
          const claudeHome = tempDir("claude-home");
          const agent = claudeAdapter({ bin, claudeHome, env: { ...process.env, FAKE_CLAUDE_HOME: claudeHome } });
          await expect(agent.run(request(box.repo, { sandboxNonce: box.nonce }))).rejects.toThrow(
            /inside the temporary copy of the repository/,
          );
        }
      } finally {
        rmSync(via);
        removeSandbox(box);
      }
    });
  });

  describe("a directory made to look like a sandbox", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** A directory with a well-formed marker, a repo/ with its own .git, and the given name, under `parent`. */
    function forge(parent: string, name: string, source: string): string {
      const base = path.join(parent, name);
      mkdirSync(path.join(base, "repo", ".git"), { recursive: true });
      writeFileSync(path.join(base, "ctxreach-sandbox.json"), JSON.stringify({ tool: "ctxreach", base, source }));
      return path.join(base, "repo");
    }

    it("is refused when it is not inside the system temp directory", async () => {
      const fx = materialise("claude-local-shadows-agents");
      const repo = forge(tempDir("forged"), `${SANDBOX_PREFIX}forged`, fx.repo);
      // Seen from a system temp directory elsewhere, the forged sandbox is outside it.
      const elsewhere = tempDir("other-tmp");
      vi.spyOn(os, "tmpdir").mockReturnValue(elsewhere);
      const { agent, claudeHome } = adapter();
      await expect(agent.run(request(repo))).rejects.toThrow(/not inside the system temp directory/);
      // Refused before the agent started: it made no per-project folder.
      expect(existsSync(path.join(claudeHome, "projects"))).toBe(false);
    });

    it("is refused when its name does not start with the sandbox prefix", async () => {
      const fx = materialise("claude-local-shadows-agents");
      const repo = forge(tempDir("forged"), "not-a-sandbox", fx.repo);
      const { agent, claudeHome } = adapter();
      await expect(agent.run(request(repo))).rejects.toThrow(/not named like a ctxreach sandbox/);
      expect(existsSync(path.join(claudeHome, "projects"))).toBe(false);
    });

    it("is refused by removeSandbox too, and left in place", () => {
      const fx = materialise("claude-local-shadows-agents");
      const repo = forge(tempDir("forged"), `${SANDBOX_PREFIX}forged`, fx.repo);
      vi.spyOn(os, "tmpdir").mockReturnValue(tempDir("other-tmp"));
      expect(() => removeSandbox({ base: path.dirname(repo) })).toThrow(SafetyError);
      expect(existsSync(repo)).toBe(true);
    });

    it("is refused, in the right place and with the right name, when its marker does not say it was finished", async () => {
      // As createSandbox leaves a sandbox before stripping it: a marker that says where, not that it was stripped.
      const fx = materialise("claude-local-shadows-agents");
      const repo = forge(tempDir("sandboxes"), `${SANDBOX_PREFIX}unfinished`, fx.repo);
      mkdirSync(path.join(repo, ".claude"));
      writeFileSync(path.join(repo, ".claude", "settings.json"), '{"hooks":{}}');
      const { agent, claudeHome } = adapter();
      await expect(agent.run(request(repo, { sandboxNonce: "0".repeat(32) }))).rejects.toThrow(/never finished/);
      expect(existsSync(path.join(claudeHome, "projects"))).toBe(false);
    });
  });

  describe("checks made on the copy right before the agent starts", () => {
    /** A finished sandbox, and the fake agent; `started()` says whether the agent ever ran. */
    function setUp() {
      const fx = materialise("claude-local-shadows-agents");
      const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
      const { agent, claudeHome } = adapter();
      return { box, agent, started: () => existsSync(path.join(claudeHome, "projects")) };
    }

    it("refuses a sandbox this run did not make: its marker carries another nonce", async () => {
      const { box, agent, started } = setUp();
      try {
        await expect(agent.run(request(box.repo, { sandboxNonce: "0".repeat(32) }))).rejects.toThrow(/another nonce/);
        expect(started()).toBe(false);
      } finally {
        removeSandbox(box);
      }
    });

    it("refuses a copy that holds a stripped path again, in any case", async () => {
      const { box, agent, started } = setUp();
      try {
        mkdirSync(path.join(box.repo, ".Claude"));
        writeFileSync(path.join(box.repo, ".Claude", "Settings.json"), '{"hooks":{}}');
        await expect(agent.run(request(box.repo, { sandboxNonce: box.nonce }))).rejects.toThrow(
          /still holds \.Claude\/Settings\.json/,
        );
        rmSync(path.join(box.repo, ".Claude"), { recursive: true });
        mkdirSync(path.join(box.repo, "sub"));
        writeFileSync(path.join(box.repo, "sub", ".MCP.json"), "{}");
        await expect(agent.run(request(box.repo, { sandboxNonce: box.nonce }))).rejects.toThrow(
          /still holds sub\/\.MCP\.json/,
        );
        expect(started()).toBe(false);
      } finally {
        removeSandbox(box);
      }
    });

    it("refuses a copy that holds a link", async () => {
      const { box, agent, started } = setUp();
      try {
        symlinkSync(
          tempDir("outside"),
          path.join(box.repo, "linked"),
          process.platform === "win32" ? "junction" : "dir",
        );
        await expect(agent.run(request(box.repo, { sandboxNonce: box.nonce }))).rejects.toThrow(
          /holds a link at linked/,
        );
        expect(started()).toBe(false);
      } finally {
        rmSync(path.join(box.repo, "linked"));
        removeSandbox(box);
      }
    });

    it("refuses a copy whose .git is a gitdir file, not a directory of its own", async () => {
      const { box, agent, started } = setUp();
      try {
        rmSync(path.join(box.repo, ".git"), { recursive: true });
        writeFileSync(path.join(box.repo, ".git"), `gitdir: ${path.join(tempDir("elsewhere"), ".git")}\n`);
        await expect(agent.run(request(box.repo, { sandboxNonce: box.nonce }))).rejects.toThrow(
          /no \.git directory of its own/,
        );
        expect(started()).toBe(false);
      } finally {
        removeSandbox(box);
      }
    });

    it("refuses a launch directory where git finds another repository", async () => {
      const { box, agent, started } = setUp();
      try {
        const pkg = path.join(box.repo, "pkg");
        mkdirSync(pkg);
        execFileSync("git", ["init", "-q", "--template="], { cwd: pkg, env: gitEnv(), stdio: "ignore" });
        await expect(agent.run(request(pkg, { sandboxNonce: box.nonce }))).rejects.toThrow(/not the copy's own/);
        expect(started()).toBe(false);
      } finally {
        removeSandbox(box);
      }
    });
  });

  it("stops a run that does not finish in time", async () => {
    const fx = materialise("claude-local-shadows-agents");
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      const { agent } = adapter({ FAKE_CLAUDE_BEHAVIOUR: "hang" });
      const out = await agent.run(request(box.repo, { sandboxNonce: box.nonce, timeoutMs: 800 }));
      expect(out.timedOut).toBe(true);
      // Stopped at the limit, not when the fake gave up on its own after 10 seconds.
      expect(out.durationMs).toBeLessThan(5000);
    } finally {
      removeSandbox(box);
    }
  }, 20_000);
});
