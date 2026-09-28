import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { claudeAdapter } from "./agents/claude/adapter.js";
import { CLAUDE_MODES } from "./agents/claude/settings.js";
import type { AgentId } from "./agents/types.js";
import { findRepoRoot, map } from "./map/map.js";
import { runProbe } from "./probe/probe.js";
import { readRecording, RecordingError } from "./probe/recording.js";
import { scoreRecording } from "./probe/score.js";
import { SafetyError, type AgentAdapter, type ProbeMode } from "./probe/types.js";
import { toJson } from "./report/json.js";
import { probeJson, renderProbe } from "./report/probe.js";
import { renderTerminal } from "./report/terminal.js";
import { ConfigError } from "./util/errors.js";
import { displayPath, isInside } from "./util/fs.js";

const AGENTS: AgentId[] = ["codex", "claude"];

function parseAgents(value: string): AgentId[] {
  const list = value
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  for (const a of list) {
    if (!AGENTS.includes(a as AgentId))
      throw new InvalidArgumentError(`unknown agent "${a}" (known: ${AGENTS.join(", ")})`);
  }
  return list as AgentId[];
}

function parseBytes(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("must be a whole number of bytes");
  return n;
}

function parseCount(max: number) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new InvalidArgumentError(`must be a whole number from 1 to ${max}`);
    return n;
  };
}

function parseVersion(value: string): string {
  if (!/^\d+(\.\d+)*$/.test(value)) throw new InvalidArgumentError("must look like 2.1.280");
  return value;
}

/** A directory option names something `map` cannot use. */
class UsageError extends Error {}

/** Resolve a directory option, or explain why it cannot be used. */
function existingDir(flag: string, given: string): string {
  const resolved = path.resolve(given);
  const where = resolved === given ? "" : ` (resolved to ${resolved})`;
  let isDir: boolean;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new UsageError(`${flag} ${given} does not exist${where}`);
    throw new UsageError(`${flag} ${given} cannot be read${where}: ${(err as Error).message}`);
  }
  if (!isDir) throw new UsageError(`${flag} ${given} is a file, not a directory${where}`);
  return resolved;
}

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface Cli {
  program: Command;
  /** Exit status the last command asked for. */
  status: number;
}

/** Build the command-line program. Output goes through `io` so tests can capture it. */
export interface CliOptions {
  exitOverride?: boolean;
  /** Build the adapter for an agent (tests pass a fake; the default drives the real CLI). */
  adapter?: (agent: AgentId, options: { bin?: string }) => AgentAdapter | undefined;
}

function defaultAdapter(agent: AgentId, options: { bin?: string }): AgentAdapter | undefined {
  if (agent === "claude") return claudeAdapter(options.bin !== undefined ? { bin: options.bin } : {});
  return undefined;
}

export function createCli(io: Io, options: CliOptions = {}): Cli {
  const program = new Command();
  const cli: Cli = { program, status: 0 };
  // Set before subcommands are added so they inherit it.
  program.configureOutput({ writeOut: io.stdout, writeErr: io.stderr });
  if (options.exitOverride) program.exitOverride();

  program
    .name("ctxreach")
    .description("Show which instruction files reach which coding agent, from which directory, up to which byte.")
    .version(pkg.version);

  program
    .command("map")
    .description(
      "Predict, from each agent's documented loading rules, which instruction files it receives when launched in a directory. Runs no agent.",
    )
    .option("--from <dir>", "directory the agent is launched in", ".")
    .option("--repo <dir>", "directory to scan for instruction files (default: nearest ancestor with .git)")
    .addOption(
      new Option("--agents <list>", "comma-separated agents to model")
        .argParser(parseAgents)
        .default(AGENTS, AGENTS.join(",")),
    )
    .option("--json", "print JSON (schema ctxreach.map/v1) instead of a table")
    .option("--fail-on-warn", "exit with status 1 when there is any warning")
    .option("--no-color", "print without colours (also honours NO_COLOR)")
    .option("--codex-home <dir>", "Codex home directory (default: $CODEX_HOME, then ~/.codex)")
    .option("--codex-max-bytes <n>", "Codex project_doc_max_bytes, overriding every config file", parseBytes)
    .addOption(
      new Option("--codex-trust <level>", "assume this Codex trust level instead of reading it from config").choices([
        "trusted",
        "untrusted",
        "unknown",
      ]),
    )
    .option("--claude-home <dir>", "Claude Code user directory (default: ~/.claude)")
    .addOption(
      new Option("--claude-mode <mode>", "assume this Claude Code Project instructions value").choices(CLAUDE_MODES),
    )
    .option(
      "--claude-version <version>",
      "model this Claude Code version's AGENTS.md support (e.g. 2.1.280)",
      parseVersion,
    )
    .action((opts) => {
      try {
        const launchDir = existingDir("--from", opts.from);
        const repoRoot = opts.repo !== undefined ? existingDir("--repo", opts.repo) : undefined;
        if (repoRoot !== undefined && !isInside(launchDir, repoRoot))
          throw new UsageError(`--from ${launchDir} is outside --repo ${repoRoot}`);
        const result = map({
          launchDir,
          ...(repoRoot !== undefined ? { repoRoot } : {}),
          agents: opts.agents,
          codex: {
            ...(opts.codexHome !== undefined ? { home: path.resolve(opts.codexHome) } : {}),
            ...(opts.codexMaxBytes !== undefined ? { maxBytes: opts.codexMaxBytes } : {}),
            ...(opts.codexTrust !== undefined ? { trust: opts.codexTrust } : {}),
          },
          claude: {
            ...(opts.claudeHome !== undefined ? { home: path.resolve(opts.claudeHome) } : {}),
            ...(opts.claudeMode !== undefined ? { mode: opts.claudeMode } : {}),
            ...(opts.claudeVersion !== undefined ? { version: opts.claudeVersion } : {}),
          },
        });
        io.stdout(opts.json ? JSON.stringify(toJson(result, pkg.version), null, 2) + "\n" : renderTerminal(result));
        cli.status = opts.failOnWarn && result.findings.some((f) => f.severity === "warn") ? 1 : 0;
      } catch (err) {
        if (err instanceof ConfigError || err instanceof UsageError) {
          io.stderr(`ctxreach: ${err.message}\n`);
          cli.status = 2;
          return;
        }
        throw err;
      }
    });

  program
    .command("probe")
    .description(
      "Check map's predictions against a real agent: plant random tokens in a temporary copy of the repository, run the agent there headless and read-only, and record which tokens it repeats. With --replay, score a saved run instead; no agent runs.",
    )
    .addOption(new Option("--agent <agent>", "agent to probe").choices(AGENTS).default("claude"))
    .option("--from <dir>", "directory the agent is launched in", ".")
    .option("--repo <dir>", "repository to copy (default: nearest ancestor with .git)")
    .addOption(
      new Option("--mode <mode>", "recall: no tools; task: read tools only")
        .choices(["recall", "task"])
        .default("recall"),
    )
    .option("--trials <n>", "number of runs (1 to 10)", parseCount(10), 3)
    .option("--task <text>", "the read-only request to give the agent in task mode")
    .option("--replay <dir>", "score a saved run instead of running the agent")
    .option("--save <dir>", "where to save the run (default: a new directory under the system temp directory)")
    .option("--timeout <seconds>", "time limit for each run", parseCount(3600), 300)
    .option("--json", "print JSON (schema ctxreach.probe/v1) instead of a table")
    .option("--no-color", "print without colours (also honours NO_COLOR)")
    .option("--claude-bin <path>", "the claude executable (default: found on PATH)")
    .option("--claude-home <dir>", "Claude Code user directory map reads for its prediction (default: ~/.claude)")
    .action(async (opts) => {
      const agent = opts.agent as AgentId;
      const build = options.adapter ?? defaultAdapter;
      const adapter = build(agent, opts.claudeBin !== undefined ? { bin: opts.claudeBin } : {});
      try {
        if (!adapter) throw new UsageError(`probe has no ${agent} adapter yet; only --agent claude is supported`);
        let dir: string;
        if (opts.replay !== undefined) {
          dir = existingDir("--replay", opts.replay);
        } else {
          const launchDir = existingDir("--from", opts.from);
          const repoRoot =
            opts.repo !== undefined ? existingDir("--repo", opts.repo) : (findRepoRoot(launchDir) ?? launchDir);
          if (!isInside(launchDir, repoRoot)) throw new UsageError(`--from ${launchDir} is outside --repo ${repoRoot}`);
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          dir = path.resolve(opts.save ?? path.join(os.tmpdir(), "ctxreach-runs", `${agent}-${opts.mode}-${stamp}`));
          await runProbe({
            adapter,
            repoRoot,
            launchDir,
            mode: opts.mode as ProbeMode,
            trials: opts.trials,
            timeoutMs: opts.timeout * 1000,
            saveDir: dir,
            ...(opts.task !== undefined ? { task: opts.task } : {}),
            ...(opts.claudeHome !== undefined ? { claudeHome: path.resolve(opts.claudeHome) } : {}),
            ctxreachVersion: pkg.version,
            progress: (line) => io.stderr(`ctxreach: ${line}\n`),
          });
        }
        const result = scoreRecording(readRecording(dir), adapter);
        // Shown relative to the current directory when it is inside it.
        result.recordingDir = displayPath(dir, process.cwd());
        if (result.manifest.agent !== agent)
          throw new UsageError(`${dir} is a ${result.manifest.agent} recording; pass --agent ${result.manifest.agent}`);
        io.stdout(opts.json ? JSON.stringify(probeJson(result), null, 2) + "\n" : renderProbe(result));
        cli.status = result.instrument.fault ? 3 : result.trials.some((t) => t.status === "usable") ? 0 : 1;
      } catch (err) {
        if (
          err instanceof ConfigError ||
          err instanceof UsageError ||
          err instanceof SafetyError ||
          err instanceof RecordingError
        ) {
          io.stderr(`ctxreach: ${err.message}\n`);
          cli.status = 2;
          return;
        }
        throw err;
      }
    });

  return cli;
}
