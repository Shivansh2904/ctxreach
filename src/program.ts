import { statSync } from "node:fs";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import pkg from "../package.json" with { type: "json" };
import { CLAUDE_MODES } from "./agents/claude/settings.js";
import type { AgentId } from "./agents/types.js";
import { map } from "./map/map.js";
import { toJson } from "./report/json.js";
import { renderTerminal } from "./report/terminal.js";
import { ConfigError } from "./util/errors.js";
import { isInside } from "./util/fs.js";

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
export function createCli(io: Io, options: { exitOverride?: boolean } = {}): Cli {
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

  return cli;
}
