/**
 * The `ctxreach verify` command. `src/program.ts` registers it with
 * `registerVerify(program, { io, setStatus, version })`; nothing here
 * imports `program.ts`.
 *
 * Exit status: 0 when every decided cell agrees with `map` and every chain
 * file is byte-exact; 1 when anything disagrees (what a conformance run
 * keys on); 2 for a usage, configuration or safety problem; 3 for an
 * instrument fault (a session assert failed, the must-appear token was
 * absent, or the decoy was delivered), which voids the run.
 */
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { CLAUDE_MODES, type ClaudeMode } from "../../agents/claude/settings.js";
import type { TrustLevel } from "../../agents/codex/config.js";
import type { Renderer } from "../../oracle/codex-render.js";
import { readVerifyRecording } from "../../oracle/recording.js";
import { OracleError, type OracleAgent } from "../../oracle/types.js";
import { agrees, DEFAULT_TRIALS, runVerify, scoreVerify } from "../../oracle/verify.js";
import { RecordingError } from "../../probe/recording.js";
import { SafetyError } from "../../probe/types.js";
import { renderVerify, verifyJson } from "../../report/verify.js";
import { ConfigError } from "../../util/errors.js";
import { displayPath, isInside } from "../../util/fs.js";
import { findRepoRoot } from "../../map/map.js";

export interface VerifyIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export interface VerifyCommandOptions {
  io: VerifyIo;
  /** Called with the exit status the command asks for. */
  setStatus(status: number): void;
  /** ctxreach's own version, stamped into recordings. */
  version: string;
  /** Test hooks: a stand-in renderer, a stand-in claude executable, and the environment to start from. */
  codexRenderer?: Renderer;
  claude?: { bin?: string; prefixArgs?: string[] };
  env?: NodeJS.ProcessEnv;
}

class UsageError extends Error {}

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

function parseCount(max: number) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new InvalidArgumentError(`must be a whole number from 1 to ${max}`);
    return n;
  };
}

function parseBytes(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("must be a whole number of bytes");
  return n;
}

export function registerVerify(program: Command, options: VerifyCommandOptions): Command {
  const { io } = options;
  return program
    .command("verify")
    .description(
      "Check map's predictions against an agent's own machinery, at no cost and with no login: Codex's prompt renderer (codex debug prompt-input) or a Claude Code session captured at a loopback endpoint. Tokens are planted in a temporary copy of the repository, as probe does. With --replay, score a saved run instead; no agent runs.",
    )
    .addOption(new Option("--agent <agent>", "agent to verify").choices(["codex", "claude"]).default("codex"))
    .option("--from <dir>", "directory the agent is launched in", ".")
    .option("--repo <dir>", "repository to copy (default: nearest ancestor with .git)")
    .option(
      "--trials <n>",
      "number of renders or captures (1 to 10); two must be identical",
      parseCount(10),
      DEFAULT_TRIALS,
    )
    .option("--replay <dir>", "score a saved run instead of running the agent")
    .option("--save <dir>", "where to save the run (default: a new directory under the system temp directory)")
    .option("--timeout <seconds>", "time limit for each run", parseCount(3600), 300)
    .option("--json", "print JSON (schema ctxreach.verify/v1) instead of a table")
    .option("--no-color", "print without colours (also honours NO_COLOR)")
    .option(
      "--codex-bin <path>",
      "the codex executable or its bin/codex.js (default: found on PATH, or $CTXREACH_CODEX_BIN)",
    )
    .option(
      "--codex-home <dir>",
      "the Codex home to seed the throwaway CODEX_HOME from (default: $CODEX_HOME, then ~/.codex)",
    )
    .option("--clean", "seed nothing into the throwaway CODEX_HOME: what the repository alone delivers")
    .option(
      "--no-plant",
      "Codex: plant no tokens, so the bytes are compared on the copy's files as they are (decoy and prompt token only)",
    )
    .option(
      "--codex-max-bytes <n>",
      "give map this project_doc_max_bytes, and Codex its real one: the planted-fault pass",
      parseBytes,
    )
    .addOption(
      new Option(
        "--codex-trust <level>",
        "write this trust level for the copy instead of mirroring the repository's",
      ).choices(["trusted", "untrusted", "unknown"]),
    )
    .option("--claude-bin <path>", "the claude executable (default: found on PATH)")
    .option("--model <name>", "Claude Code: the model to pin with --model and assert from system/init (required)")
    .option(
      "--home <dir>",
      "Claude Code: a scratch home directory (~ follows it, CLAUDE_CONFIG_DIR is unset) instead of a fresh config dir",
    )
    .option(
      "--settings <file>",
      "Claude Code: a --settings file to pass through (a hook, or a Project instructions mode)",
    )
    .addOption(
      new Option(
        "--claude-mode <mode>",
        "give map this Project instructions value; the session keeps its own: the planted-fault pass",
      ).choices(CLAUDE_MODES),
    )
    .action(async (opts) => {
      const agent = opts.agent as OracleAgent;
      try {
        let dir: string;
        if (opts.replay !== undefined) {
          dir = existingDir("--replay", opts.replay);
        } else {
          const launchDir = existingDir("--from", opts.from);
          const repoRoot =
            opts.repo !== undefined ? existingDir("--repo", opts.repo) : (findRepoRoot(launchDir) ?? launchDir);
          if (!isInside(launchDir, repoRoot)) throw new UsageError(`--from ${launchDir} is outside --repo ${repoRoot}`);
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          dir = path.resolve(opts.save ?? path.join(os.tmpdir(), "ctxreach-runs", `verify-${agent}-${stamp}`));
          await runVerify({
            agent,
            repoRoot,
            launchDir,
            trials: opts.trials,
            timeoutMs: opts.timeout * 1000,
            saveDir: dir,
            ctxreachVersion: options.version,
            ...(opts.plant === false ? { plant: false } : {}),
            ...(options.env !== undefined ? { env: options.env } : {}),
            codex: {
              ...(opts.codexBin !== undefined ? { bin: opts.codexBin } : {}),
              ...(opts.codexHome !== undefined ? { userHome: path.resolve(opts.codexHome) } : {}),
              ...(opts.clean ? { clean: true } : {}),
              ...(opts.codexMaxBytes !== undefined ? { mapMaxBytes: opts.codexMaxBytes } : {}),
              ...(opts.codexTrust !== undefined ? { trust: opts.codexTrust as TrustLevel } : {}),
              ...(options.codexRenderer !== undefined ? { renderer: options.codexRenderer } : {}),
            },
            claude: {
              ...(opts.claudeBin !== undefined
                ? { bin: opts.claudeBin }
                : options.claude?.bin !== undefined
                  ? { bin: options.claude.bin }
                  : {}),
              ...(options.claude?.prefixArgs !== undefined ? { prefixArgs: options.claude.prefixArgs } : {}),
              ...(opts.model !== undefined ? { model: opts.model } : {}),
              ...(opts.home !== undefined ? { home: opts.home } : {}),
              ...(opts.settings !== undefined ? { settingsFile: opts.settings } : {}),
              ...(opts.claudeMode !== undefined ? { mapMode: opts.claudeMode as ClaudeMode } : {}),
            },
            progress: (line) => io.stderr(`ctxreach: ${line}\n`),
          });
        }
        const result = scoreVerify(readVerifyRecording(dir));
        result.recordingDir = displayPath(dir, process.cwd());
        if (result.manifest.agent !== agent)
          throw new UsageError(`${dir} is a ${result.manifest.agent} recording; pass --agent ${result.manifest.agent}`);
        io.stdout(
          opts.json
            ? JSON.stringify(verifyJson(result), null, 2) + "\n"
            : renderVerify(result, opts.color === false ? { color: false } : {}),
        );
        const usable = result.score.trials.some((t) => t.status === "usable");
        options.setStatus(result.score.instrument.fault ? 3 : !usable ? 1 : agrees(result) ? 0 : 1);
      } catch (err) {
        if (
          err instanceof ConfigError ||
          err instanceof UsageError ||
          err instanceof SafetyError ||
          err instanceof RecordingError ||
          err instanceof OracleError
        ) {
          io.stderr(`ctxreach: ${err.message}\n`);
          options.setStatus(2);
          return;
        }
        throw err;
      }
    });
}
