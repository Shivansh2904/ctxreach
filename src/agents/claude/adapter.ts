/**
 * Drive Claude Code headless for `ctxreach probe`.
 *
 * The flags, and why each one is there, are listed in docs/rules.md (section
 * "Probe"), with the date they were checked against `claude --help` and the
 * documentation.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertReadyToRun, sandboxOf, SANDBOX_PREFIX } from "../../probe/sandbox.js";
import type {
  AgentAdapter,
  AgentEnvironment,
  Isolation,
  ProbeMode,
  Redaction,
  RunOutcome,
  RunRequest,
  SessionContext,
  SessionSetup,
  ToolUse,
} from "../../probe/types.js";
import { SafetyError } from "../../probe/types.js";
import { memoryDirOf, parseClaudeTranscript, redactClaudeTranscript, redactString } from "./events.js";
import { isFullyQualified, isInsideReal, sameReal } from "../../util/fs.js";
import {
  hookFiles,
  hookSettings,
  HOOK_SCRIPT_TEXT,
  reduceHookLog,
  sessionIdOf,
  settleLog,
  takeLiveLog,
  HOOK_SETTINGS,
  type HookFiles,
} from "./hook.js";
import { assertRunnable, CLEAN_ARGS, CLEAN_ENV, cleanSettings, killSwitchesIn, resolveModelPin } from "./isolation.js";
import { defaultClaudeHome } from "./settings.js";

export const CLAUDE_READ_TOOLS = ["Read", "Glob", "Grep"] as const;

/**
 * Flags for every run:
 * - `-p` with `stream-json` output (which needs `--verbose`), so every
 *   message, tool call and tool result is in the transcript;
 * - `--no-session-persistence`, so no session file is written;
 * - `--strict-mcp-config` with no `--mcp-config`, so no MCP server connects;
 * - `--permission-mode dontAsk`, so anything that would ask for permission is
 *   denied, including file reads outside the working directory.
 *
 * `--tools` sets the tools that exist in the session: none in recall mode,
 * only the read tools in task mode. No `--allowedTools` is passed: in
 * `dontAsk` mode, reads inside the working directory need no approval, and a
 * blanket `Read` rule would also allow reads anywhere else.
 *
 * Never `--bare`, `--safe-mode` or `--restricted`, which skip CLAUDE.md.
 * These are the flags every session starts from; the adapter's `session`
 * adds `--model` (the pin), `--settings` (the InstructionsLoaded hook) and,
 * with the experimental clean isolation only, `--setting-sources`.
 */
export function claudeArgs(mode: ProbeMode): string[] {
  const common = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
  ];
  return mode === "recall" ? [...common, "--tools", ""] : [...common, "--tools", CLAUDE_READ_TOOLS.join(",")];
}

/**
 * Variables that a running Claude Code session sets for the processes it
 * starts. When ctxreach itself runs inside a Claude Code session, these are
 * removed, so the probed agent starts as a top-level session rather than as
 * a child of the one running ctxreach. Variables a person sets themselves
 * (such as `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CONFIG_DIR`) are kept.
 */
const SESSION_VARS =
  /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_PREVIEW_.*|MCP_SERVER_CONNECTION_BATCH_SIZE|MCP_CONNECTION_NONBLOCKING|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|MESSAGING_.*|HOST_SESSION_ID|SSE_PORT|SDK_.*|SESSION_ATTENDED|EXECPATH|DESKTOP_APP_VERSION|TERMINAL_MCP_TOOLS|REPORT_FINDINGS|EMIT_TOOL_USE_SUMMARIES|ENABLE_SDK_FILE_CHECKPOINTING|EAGER_FLUSH|ENABLE_ASK_USER_QUESTION_TOOL|DISABLE_CRON|DISABLE_TERMINAL_TITLE|OAUTH_SCOPES))$/;

export function agentEnv(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; removed: string[] } {
  const removed = Object.keys(env)
    .filter((k) => SESSION_VARS.test(k))
    .sort();
  return { env: Object.fromEntries(Object.entries(env).filter(([k]) => !SESSION_VARS.test(k))), removed };
}

const truthy = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/**
 * Find the Claude Code executable. On Windows, npm installs `claude` as a
 * `.cmd` shim, which cannot be started without a shell; the executable the
 * shim calls is used instead. Only fully qualified PATH directories are
 * searched (`isFullyQualified`): a relative one (`.`, `bin`, or an empty
 * entry), or on Windows one without a drive (`\bin`), names a different
 * directory wherever ctxreach happens to run, such as inside the repository
 * it probes. The path found keeps the spelling PATH gives it (a short name
 * such as `C:\Users\RUNNER~1\...` included); it is compared with the copy by
 * `isInsideReal`, which puts spellings aside.
 */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const given = env.CTXREACH_CLAUDE_BIN;
  if (given) return given;
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((dir) => isFullyQualified(dir));
  for (const dir of dirs) {
    if (process.platform === "win32") {
      const exe = path.join(dir, "claude.exe");
      if (existsSync(exe)) return exe;
      if (existsSync(path.join(dir, "claude.cmd"))) {
        const shimmed = path.join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        if (existsSync(shimmed)) return shimmed;
      }
    } else {
      const bin = path.join(dir, "claude");
      try {
        if (statSync(bin).isFile()) return bin;
      } catch {
        // Not in this directory.
      }
    }
  }
  return undefined;
}

export interface ClaudeAdapterOptions {
  /**
   * Path of the `claude` executable (default: found on PATH, or
   * $CTXREACH_CLAUDE_BIN). A relative path is taken from the current
   * directory when the adapter is made, never from the copy the agent runs in.
   */
  bin?: string;
  /** Arguments placed before ctxreach's own, for a wrapper such as `node script.mjs` (used by the tests). */
  prefixArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /**
   * Claude Code's user directory, where it may leave an empty project folder,
   * and whose `settings.json` may name the model (default ~/.claude).
   */
  claudeHome?: string;
  /**
   * The model to pass with `--model` (default: `ANTHROPIC_MODEL`, then
   * `model` in `<claudeHome>/settings.json`; with neither, none is passed and
   * the report says so). Every session's `system/init` model must match it.
   */
  model?: string;
  /** Install the InstructionsLoaded hook (default true). */
  hook?: boolean;
  /** `machine` (default), or `clean`, which is EXPERIMENTAL (see isolation.ts). */
  isolation?: Isolation;
  /** How long the hook log must stay unchanged once the agent exits, and the most to wait for it, in ms. */
  hookSettle?: { quietMs: number; maxMs: number };
  /** The Node executable the hook runs with (default: the one running ctxreach). */
  node?: string;
}

const STDERR_KEEP = 4000;

function redactJson(v: unknown, redactions: readonly Redaction[]): unknown {
  if (typeof v === "string") return redactString(v, redactions);
  if (Array.isArray(v)) return v.map((x) => redactJson(x, redactions));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactJson(x, redactions)]));
  return v;
}

/** One probe's sessions, worked out from the adapter's options and the sandbox. */
interface SessionPlan {
  /** Arguments after the executable (and any prefix), not redacted. */
  args: string[];
  env: NodeJS.ProcessEnv;
  setEnv: string[];
  model: { pin: string; from: string } | null;
  isolation: Isolation;
  /** The `--settings` layer, and where it is written; absent when none is passed. */
  settings?: { file: string; value: Record<string, unknown> };
  /** The hook's files, when the hook is on. */
  hook?: HookFiles;
}

/**
 * Remove the empty per-project folder Claude Code creates for a sandbox, and
 * say what could not be removed. The folder is removed only when it is
 * directly under the user directory's `projects/`, however the agent spelled
 * it; the paths reported keep the agent's spelling.
 */
function cleanUpMemoryDir(memoryDir: string | undefined, claudeHome: string): string[] {
  if (!memoryDir) return [];
  const projectDir = path.dirname(path.resolve(memoryDir));
  const projects = path.join(claudeHome, "projects");
  if (!(sameReal(path.dirname(projectDir), projects) && path.basename(projectDir).includes(SANDBOX_PREFIX)))
    return existsSync(projectDir) ? [projectDir] : [];
  // Only empty directories are removed: anything with a file in it is reported instead.
  const removeEmpty = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    let empty = true;
    for (const e of entries) {
      if (e.isDirectory()) empty = removeEmpty(path.join(dir, e.name)) && empty;
      else empty = false;
    }
    if (empty) {
      try {
        rmdirSync(dir);
      } catch {
        return false;
      }
    }
    return empty;
  };
  if (!existsSync(projectDir)) return [];
  return removeEmpty(projectDir) ? [] : [projectDir];
}

/**
 * Stop the agent at once and, on Windows, every process it started
 * (`taskkill /T /F`), so that nothing keeps running in the copy while it is
 * deleted. Synchronous, so a signal handler can call it before exiting.
 */
function stopProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // By its full path: run by name, it would be looked for in the current directory first.
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const r = spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 10_000,
    });
    if (r.error || r.status !== 0) child.kill("SIGKILL");
  } else {
    // SIGKILL: an agent busy with its own work may ignore SIGTERM.
    child.kill("SIGKILL");
  }
}

/** Refuse an executable that is, however it is spelled or linked, inside the temporary copy of the repository. */
function assertOutsideCopy(exe: string, base: string): void {
  // Windows also runs `claude` as `claude.com` or `claude.exe`.
  const candidates =
    process.platform === "win32" && path.extname(exe) === "" ? [exe, `${exe}.com`, `${exe}.exe`] : [exe];
  if (candidates.some((c) => isInsideReal(c, base)))
    throw new SafetyError(
      `refusing to run ${exe}: it is inside the temporary copy of the repository; pass --claude-bin outside it`,
    );
}

export function claudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const baseEnv = options.env ?? process.env;
  const { env, removed } = agentEnv(baseEnv);
  const claudeHome = options.claudeHome ?? baseEnv.CLAUDE_CONFIG_DIR ?? defaultClaudeHome();
  // The agent runs with the copy as its working directory, so a relative
  // path would name a file in the copy: resolve it here, from where ctxreach runs.
  const cwd = process.cwd();
  let bin: string | undefined = options.bin !== undefined ? path.resolve(cwd, options.bin) : undefined;
  const prefix = options.prefixArgs ?? [];
  const settle = options.hookSettle ?? { quietMs: 300, maxMs: 3000 };
  const binary = (): string => {
    if (bin === undefined) {
      const found = findClaude(baseEnv);
      if (found) bin = path.resolve(cwd, found);
    }
    if (!bin) throw new Error("could not find the claude executable on PATH; pass --claude-bin");
    return bin;
  };

  /**
   * The sessions' set-up for a sandbox: the same inputs give the same plan,
   * so what `session` records is what `run` passes (and score checks that
   * each trial's arguments equal the recorded ones).
   */
  const plan = (mode: ProbeMode, base: string, repo: string, claudeMode: string | undefined): SessionPlan => {
    const isolation = options.isolation ?? "machine";
    const model = resolveModelPin({ model: options.model, env: baseEnv, claudeHome }) ?? null;
    if (isolation === "clean" && !model)
      throw new SafetyError(
        "--isolation clean needs a model to pin (pass --model): without the user's settings, Claude Code would pick its own",
      );
    const hook = options.hook === false ? undefined : hookFiles(base);
    const value: Record<string, unknown> = {
      ...(isolation === "clean" ? cleanSettings({ copyRoot: repo, claudeMode }) : {}),
      ...(hook ? hookSettings(hook, options.node) : {}),
    };
    const settings = Object.keys(value).length ? { file: path.join(base, HOOK_SETTINGS), value } : undefined;
    const args = [
      ...claudeArgs(mode),
      ...(model ? ["--model", model.pin] : []),
      ...(settings ? ["--settings", settings.file] : []),
      ...(isolation === "clean" ? CLEAN_ARGS : []),
    ];
    return {
      args,
      env: isolation === "clean" ? { ...env, ...CLEAN_ENV } : env,
      setEnv: isolation === "clean" ? Object.keys(CLEAN_ENV) : [],
      model,
      isolation,
      ...(settings ? { settings } : {}),
      ...(hook ? { hook } : {}),
    };
  };

  /** Refuse a session that could not see instruction files, or whose hook would be off. */
  const refuse = (p: SessionPlan): void =>
    assertRunnable({ env: baseEnv, args: [...prefix, ...p.args], settings: p.settings?.value });

  return {
    id: "claude",
    title: "Claude Code",
    readTools: CLAUDE_READ_TOOLS,

    async version() {
      const r = spawnSync(binary(), [...prefix, "--version"], {
        env,
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true,
      });
      if (r.error) throw new Error(`could not run ${binary()} --version: ${r.error.message}`);
      const m = /(\d+\.\d+\.\d+)/.exec(r.stdout ?? "");
      if (!m?.[1]) throw new Error(`could not read a version from "${(r.stdout ?? "").trim()}"`);
      return m[1];
    },

    args: claudeArgs,

    environment(): AgentEnvironment {
      const notes: string[] = [];
      const killSwitches = killSwitchesIn(baseEnv);
      const bare = truthy(baseEnv.CLAUDE_CODE_SIMPLE);
      if (bare) notes.push("CLAUDE_CODE_SIMPLE is set, which turns on bare mode: Claude Code skips CLAUDE.md.");
      if (truthy(baseEnv.CLAUDE_CODE_SAFE_MODE))
        notes.push("CLAUDE_CODE_SAFE_MODE is set, which turns off CLAUDE.md and other customisations.");
      if (truthy(baseEnv.CLAUDE_CODE_DISABLE_CLAUDE_MDS))
        notes.push("CLAUDE_CODE_DISABLE_CLAUDE_MDS is set, which turns off every CLAUDE.md file.");
      if (truthy(baseEnv.CLAUDE_CODE_DISABLE_ATTACHMENTS))
        notes.push(
          "CLAUDE_CODE_DISABLE_ATTACHMENTS is set, which turns off attachments, the way instruction files reach the model.",
        );
      if (baseEnv.CLAUDE_CONFIG_DIR) notes.push("CLAUDE_CONFIG_DIR is set; the agent uses that user directory.");
      return { bare: killSwitches.length > 0, killSwitches, removedEnv: removed, notes };
    },

    session(context: SessionContext): SessionSetup {
      const p = plan(context.mode, context.sandboxBase, context.repo, context.claudeMode);
      refuse(p);
      return {
        args: p.args.map((a) => redactString(a, context.redactions)),
        model: p.model,
        hook: p.hook !== undefined,
        isolation: p.isolation,
        ...(p.settings
          ? { settings: redactJson(p.settings.value, context.redactions) as Record<string, unknown> }
          : {}),
        setEnv: p.setEnv,
        notes: [],
      };
    },

    async run(request: RunRequest): Promise<RunOutcome> {
      // The agent only ever runs inside a sandbox's copy of the repository,
      // one this run finished, checked again on disk right before it starts.
      const box = sandboxOf(request.workdir);
      assertReadyToRun(box, request.sandboxNonce, request.workdir);
      const exe = binary();
      assertOutsideCopy(exe, box.base);
      const p = plan(request.mode, box.base, box.repo, request.claudeMode);
      refuse(p);
      // Written next to the copy, never in it, and deleted with the sandbox.
      if (p.settings) writeFileSync(p.settings.file, JSON.stringify(p.settings.value, null, 2) + "\n");
      if (p.hook) {
        writeFileSync(p.hook.script, HOOK_SCRIPT_TEXT);
        rmSync(p.hook.log, { force: true });
      }
      if (request.signal?.aborted) throw new Error("the probe was stopped before the agent started");
      const started = Date.now();
      const child = spawn(exe, [...prefix, ...p.args], {
        cwd: request.workdir,
        env: p.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stop = () => stopProcessTree(child);
      request.signal?.addEventListener("abort", stop, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => (stdout += d));
      child.stderr.on("data", (d: string) => {
        if (stderr.length < STDERR_KEEP) stderr += d;
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, request.timeoutMs);
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code));
        child.stdin.on("error", () => undefined);
        child.stdin.end(request.prompt);
      }).finally(() => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", stop);
      });
      const durationMs = Date.now() - started;

      // The hook runs asynchronously: its last events can land after the
      // agent exits, so the log is read once it has stopped growing.
      let hooks: RunOutcome["hooks"];
      if (p.hook && request.hookLogPath !== undefined) {
        await settleLog(p.hook.log, settle.quietMs, settle.maxMs);
        const reduced = reduceHookLog(takeLiveLog(p.hook.log), {
          sessionId: sessionIdOf(stdout),
          redactions: request.redactions,
        });
        writeFileSync(request.hookLogPath, reduced.text);
        hooks = { log: path.basename(request.hookLogPath), events: reduced.events, invalid: reduced.invalid };
      } else if (p.hook) {
        takeLiveLog(p.hook.log);
      }

      const leftovers = cleanUpMemoryDir(memoryDirOf(stdout), claudeHome).map((x) =>
        redactString(x, request.redactions),
      );
      writeFileSync(request.transcriptPath, redactClaudeTranscript(stdout, request.redactions));
      return {
        exitCode,
        timedOut,
        // Saved in the manifest, so redacted like the transcript.
        stderr: redactString(stderr.slice(0, STDERR_KEEP), request.redactions),
        durationMs,
        leftovers,
        args: p.args.map((a) => redactString(a, request.redactions)),
        ...(hooks ? { hooks } : {}),
      };
    },

    parse: parseClaudeTranscript,

    fileReads(call: ToolUse): string[] {
      if (call.name !== "Read") return [];
      const input = call.input as { file_path?: unknown } | null;
      return typeof input?.file_path === "string" ? [input.file_path] : [];
    },
  };
}
