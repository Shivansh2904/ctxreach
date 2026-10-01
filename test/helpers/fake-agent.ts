import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_READ_TOOLS, claudeArgs } from "../../src/agents/claude/adapter.js";
import { parseClaudeTranscript, redactClaudeTranscript } from "../../src/agents/claude/events.js";
import { reduceHookLog } from "../../src/agents/claude/hook.js";
import { CONTROL_RULE } from "../../src/probe/canary.js";
import { sandboxOf, STRIP } from "../../src/probe/sandbox.js";
import type { AgentAdapter, ProbeMode, RunRequest, SessionSetup, ToolUse } from "../../src/probe/types.js";

export interface FakeRun {
  workdir: string;
  repo: string;
  mode: ProbeMode;
  /** Stripped paths (relative to the copy) that were still present when the agent ran. */
  unstripped: string[];
  /** The repository has its own .git. */
  hasGit: boolean;
  /** Links (symlinks or junctions) in the copy when the agent ran, relative to it. */
  links: string[];
}

export interface FakeBehaviour {
  /** Files (relative to the copy) whose tokens the agent repeats as if they were preloaded. */
  preloads: string[];
  /** Files it reads with the Read tool, in order, before answering. Their tokens appear in the tool output. */
  reads?: string[];
  /** Tools the session reports (default: none in recall mode, the read tools in task mode). */
  toolsOffered?: string[];
  /** Reported version (default 9.9.9). */
  version?: string;
  /** Report a different working directory. */
  cwd?: string;
  /** Extra tokens to repeat. */
  extraTokens?: string[];
  /** Stop without a result event. */
  unfinished?: boolean;
  /** Do not repeat the positive control (default: it is repeated, as a working session does). */
  skipControl?: boolean;
  /** Reported model (default: the pin, else fake-model). */
  model?: string;
  /** Reported plugins (default: agents-md@builtin and telemetry@builtin). */
  plugins?: string[];
  /** Files (relative to the copy) the hook reports as loaded; only when the run has the hook. */
  hookFires?: string[];
  /** Absolute paths outside the copy the hook reports as loaded. */
  hookOutside?: string[];
  /** Report each hook event with another session's id. */
  hookOtherSession?: boolean;
  /** Write no hook log, although the run has the hook. */
  dropHookLog?: boolean;
  /** Arguments to report the agent was started with (default: the recorded ones). */
  args?: string[];
}

/** How the fake's sessions are set up (see `AgentAdapter.session`); without it, the fake has no `session`. */
export interface FakeSetup {
  model?: { pin: string; from: string } | null;
  hook?: boolean;
  isolation?: "machine" | "clean";
  settings?: Record<string, unknown>;
}

const TOKEN = /CTXR-[0-9a-f]{8}/g;

function linksUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push(path.relative(root, p));
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

function tokensIn(file: string): string[] {
  return existsSync(file) ? [...readFileSync(file, "utf8").matchAll(TOKEN)].map((m) => m[0]) : [];
}

/**
 * A stand-in for Claude Code that writes a stream-json transcript in the
 * shape the real CLI produces, so the probe pipeline, the real parser and
 * the redaction all run without an agent.
 */
export function fakeAgent(
  behaviour: (run: FakeRun) => FakeBehaviour,
  setup?: FakeSetup,
): AgentAdapter & { runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const sessionOf = (mode: ProbeMode): SessionSetup => ({
    args: [...claudeArgs(mode), ...(setup?.model ? ["--model", setup.model.pin] : [])],
    model: setup?.model ?? null,
    hook: setup?.hook ?? false,
    isolation: setup?.isolation ?? "machine",
    ...(setup?.settings ? { settings: setup.settings } : {}),
    setEnv: [],
    notes: [],
  });
  return {
    ...(setup ? { session: (context: { mode: ProbeMode }) => sessionOf(context.mode) } : {}),
    id: "claude",
    title: "Fake Claude",
    readTools: CLAUDE_READ_TOOLS,
    runs,
    async version() {
      return "9.9.9";
    },
    args: claudeArgs,
    environment() {
      return { bare: false, removedEnv: [], notes: [] };
    },
    async run(request: RunRequest) {
      const box = sandboxOf(request.workdir);
      const unstripped: string[] = [];
      const check = (dir: string) => {
        for (const item of STRIP) if (existsSync(path.join(dir, ...item.split("/")))) unstripped.push(item);
      };
      check(box.repo);
      check(request.workdir);
      const run: FakeRun = {
        workdir: request.workdir,
        repo: box.repo,
        mode: request.mode,
        unstripped,
        hasGit: existsSync(path.join(box.repo, ".git")),
        links: linksUnder(box.repo),
      };
      runs.push(run);
      const b = behaviour(run);
      const at = (rel: string) => path.join(box.repo, ...rel.split("/"));
      const lines: object[] = [
        {
          type: "system",
          subtype: "init",
          cwd: b.cwd ?? request.workdir,
          tools: b.toolsOffered ?? (request.mode === "recall" ? [] : [...CLAUDE_READ_TOOLS]),
          model: b.model ?? setup?.model?.pin ?? "fake-model",
          claude_code_version: b.version ?? "9.9.9",
          session_id: "fake-session",
          slash_commands: ["personal-command"],
          plugins: (b.plugins ?? ["agents-md@builtin", "telemetry@builtin"]).map((source) => ({
            name: source.split("@")[0],
            path: source.split("@")[1] ?? "",
            source,
          })),
          memory_paths: { auto: path.join(box.base, "memory") },
        },
      ];
      (b.reads ?? []).forEach((rel, i) => {
        const id = `toolu_${i}`;
        lines.push({
          type: "assistant",
          message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: at(rel) } }] },
        });
        const content = existsSync(at(rel)) ? readFileSync(at(rel), "utf8") : "";
        lines.push({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content }] } });
      });
      // A working session repeats the positive control, a rule at the launch directory.
      const control = path.join(request.workdir, ...CONTROL_RULE.split("/"));
      const said = [
        ...(b.skipControl ? [] : tokensIn(control)),
        ...b.preloads.flatMap((rel) => tokensIn(at(rel))),
        ...(b.reads ?? []).flatMap((rel) => tokensIn(at(rel))),
        ...(b.extraTokens ?? []),
      ];
      const text = said.length ? said.join("\n") : "NONE";
      lines.push({ type: "assistant", message: { content: [{ type: "text", text }] } });
      lines.push({ type: "rate_limit_event", rate_limit_info: { status: "allowed", utilization: 0.5 } });
      if (!b.unfinished) lines.push({ type: "result", subtype: "success", is_error: false, result: text });
      const raw = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
      writeFileSync(request.transcriptPath, redactClaudeTranscript(raw, request.redactions));
      let hooks;
      if (request.hookLogPath !== undefined && !b.dropHookLog) {
        // The events Claude Code sends the hook, reduced the way the real adapter reduces them.
        const event = (file: string) =>
          JSON.stringify({
            session_id: b.hookOtherSession ? "another-session" : "fake-session",
            transcript_path: path.join(box.base, "t.jsonl"),
            cwd: request.workdir,
            hook_event_name: "InstructionsLoaded",
            file_path: file,
            memory_type: "Project",
            load_reason: "session_start",
          });
        const fires = [
          ...(existsSync(control) && !b.skipControl ? [control] : []),
          ...(b.hookFires ?? []).map(at),
          ...(b.hookOutside ?? []),
        ];
        const reduced = reduceHookLog(fires.map(event).join("\n"), {
          sessionId: "fake-session",
          redactions: request.redactions,
        });
        writeFileSync(request.hookLogPath, reduced.text);
        hooks = { log: path.basename(request.hookLogPath), events: reduced.events, invalid: reduced.invalid };
      }
      return {
        exitCode: 0,
        timedOut: false,
        stderr: "",
        durationMs: 1,
        leftovers: [],
        ...(setup ? { args: b.args ?? sessionOf(request.mode).args } : {}),
        ...(hooks ? { hooks } : {}),
      };
    },
    parse: parseClaudeTranscript,
    fileReads(call: ToolUse) {
      const input = call.input as { file_path?: unknown } | null;
      return call.name === "Read" && typeof input?.file_path === "string" ? [input.file_path] : [];
    },
  };
}
