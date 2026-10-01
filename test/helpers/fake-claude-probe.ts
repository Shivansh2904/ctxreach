import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claudeAdapter, type ClaudeAdapterOptions } from "../../src/agents/claude/adapter.js";
import { KILL_SWITCHES } from "../../src/agents/claude/isolation.js";
import { runProbe, type ProbeOptions } from "../../src/probe/probe.js";
import { scoreRecording, type ProbeResult } from "../../src/probe/score.js";
import type { AgentAdapter } from "../../src/probe/types.js";
import { tempDir } from "./fixture.js";

/** The stand-in for the `claude` executable (see its header for what it can be told to do). */
export const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");

export interface FakeRepo {
  repo: string;
  /** Stands in for the home directory: never an ancestor of the copy. */
  home: string;
  claudeHome: string;
  /** Where the probe's sandboxes go; also the ceiling of the location report's search. */
  tmp: string;
  at: (rel: string) => string;
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, ...rel.split("/"));
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
}

/** A repository (with an empty `.git`) made of `files`, and a home directory made of `homeFiles`. */
export function fakeRepo(files: Record<string, string>, homeFiles: Record<string, string> = {}): FakeRepo {
  const root = tempDir("fake-repo");
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  write(repo, files);
  const home = path.join(root, "home");
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  write(home, homeFiles);
  return {
    repo,
    home,
    claudeHome: path.join(home, ".claude"),
    tmp: tempDir("probe-tmp"),
    at: (rel) => path.join(repo, ...rel.split("/")),
  };
}

/** The test's environment without anything that would change the session (a model, a kill switch), plus `extra`. */
export function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["ANTHROPIC_MODEL", ...KILL_SWITCHES]) delete env[k];
  return { ...env, ...extra };
}

export function fakeClaude(
  fx: FakeRepo,
  env: Record<string, string> = {},
  options: Partial<ClaudeAdapterOptions> = {},
) {
  return claudeAdapter({
    bin: process.execPath,
    prefixArgs: [FAKE_CLAUDE],
    claudeHome: fx.claudeHome,
    env: fakeEnv({ FAKE_CLAUDE_HOME: fx.claudeHome, ...env }),
    hookSettle: { quietMs: 100, maxMs: 3000 },
    ...options,
  });
}

/** Run `ctxreach probe` with the real Claude Code adapter driving the fake executable, and score it. */
export async function probeFake(
  fx: FakeRepo,
  options: {
    env?: Record<string, string>;
    adapter?: Partial<ClaudeAdapterOptions>;
    agent?: AgentAdapter;
    probe?: Partial<ProbeOptions>;
    from?: string;
  } = {},
): Promise<{ result: ProbeResult; saveDir: string; adapter: AgentAdapter }> {
  const adapter = options.agent ?? fakeClaude(fx, options.env, options.adapter);
  const saveDir = path.join(tempDir("probe-save"), "run");
  const recording = await runProbe({
    adapter,
    repoRoot: fx.repo,
    launchDir: fx.at(options.from ?? "."),
    mode: "recall",
    trials: 1,
    timeoutMs: 30_000,
    saveDir,
    claudeHome: fx.claudeHome,
    ctxreachVersion: "0.0.0-test",
    tmpRoot: fx.tmp,
    homeDir: fx.home,
    ancestorCeiling: fx.tmp,
    ...options.probe,
  });
  return { result: scoreRecording(recording, adapter), saveDir, adapter };
}

/** FAKE_CLAUDE_ECHO / FAKE_CLAUDE_HOOK value: the positive control and `files`, relative to the launch directory. */
export const withControl = (...files: string[]) => [".claude/rules/ctxreach-control.md", ...files].join(",");
