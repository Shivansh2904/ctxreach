import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLAUDE_READ_TOOLS, claudeArgs } from "../../src/agents/claude/adapter.js";
import { parseClaudeTranscript, redactClaudeTranscript } from "../../src/agents/claude/events.js";
import { sandboxOf, STRIP } from "../../src/probe/sandbox.js";
import type { AgentAdapter, ProbeMode, RunRequest, ToolUse } from "../../src/probe/types.js";

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
export function fakeAgent(behaviour: (run: FakeRun) => FakeBehaviour): AgentAdapter & { runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  return {
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
          model: "fake-model",
          claude_code_version: b.version ?? "9.9.9",
          slash_commands: ["personal-command"],
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
      const said = [
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
      return { exitCode: 0, timedOut: false, stderr: "", durationMs: 1, leftovers: [] };
    },
    parse: parseClaudeTranscript,
    fileReads(call: ToolUse) {
      const input = call.input as { file_path?: unknown } | null;
      return call.name === "Read" && typeof input?.file_path === "string" ? [input.file_path] : [];
    },
  };
}
