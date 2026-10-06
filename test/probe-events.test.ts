import { describe, expect, it } from "vitest";
import {
  memoryDirOf,
  parseClaudeTranscript,
  redactClaudeTranscript,
  redactString,
} from "../src/agents/claude/events.js";
import { TranscriptError } from "../src/probe/types.js";

const line = (o: object) => JSON.stringify(o);
const init = { type: "system", subtype: "init", cwd: "/r", tools: [], model: "m", claude_code_version: "2.1.280" };
const result = { type: "result", subtype: "success", is_error: false, result: "done" };

describe("parsing: shapes and failures", () => {
  it("reads messages, tool calls and tool results in stream order", () => {
    const t = parseClaudeTranscript(
      [
        line(init),
        line({
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "..." },
              { type: "text", text: "reading" },
              { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/a.md" } },
            ],
          },
        }),
        line({
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "CTXR-00000000" }] }],
          },
        }),
        line(result),
      ].join("\n"),
    );
    expect(t.items).toEqual([
      { kind: "text", text: "reading" },
      { kind: "tool-use", id: "t1", name: "Read", input: { file_path: "/r/a.md" } },
      { kind: "tool-result", toolUseId: "t1", text: "CTXR-00000000", isError: false },
    ]);
    expect(t.finalText).toBe("done");
    expect(t.events.unknown).toEqual({});
  });

  it("tolerates event types and content blocks it does not know, and counts them", () => {
    const t = parseClaudeTranscript(
      [
        line(init),
        line({ type: "brand_new_event", data: 1 }),
        line({ type: "system", subtype: "brand_new_subtype" }),
        line({ type: "assistant", message: { content: [{ type: "brand_new_block" }] } }),
        line({ type: "rate_limit_event", rate_limit_info: {} }),
        line(result),
      ].join("\n"),
    );
    expect(t.events.unknown).toEqual({
      brand_new_event: 1,
      "system/brand_new_subtype": 1,
      "assistant.content/brand_new_block": 1,
    });
    expect(t.events.total).toBe(6);
    expect(t.finished).toBe(true);
  });

  it("fails loudly, naming the line, when an event the classifier needs changes shape", () => {
    const bad = [line(init), line({ type: "assistant", message: { content: "not a list" } })].join("\n");
    expect(() => parseClaudeTranscript(bad)).toThrow(TranscriptError);
    expect(() => parseClaudeTranscript(bad)).toThrow(/line 2: assistant does not match/);
    const noTools = line({ type: "system", subtype: "init", cwd: "/r", model: "m" });
    expect(() => parseClaudeTranscript(noTools)).toThrow(/line 1: system\/init/);
    expect(() => parseClaudeTranscript("{not json")).toThrow(/line 1: not JSON/);
    const badResult = line({ type: "user", message: { content: [{ type: "tool_result" }] } });
    expect(() => parseClaudeTranscript(badResult)).toThrow(/tool_result block/);
  });

  it("marks a transcript with no result event as unfinished", () => {
    expect(parseClaudeTranscript(line(init)).finished).toBe(false);
  });
});

describe("redaction before a transcript is saved", () => {
  it("replaces paths whatever their slashes, and any letter case for Windows paths", () => {
    const r = [{ from: "C:\\Users\\me\\Temp\\ctxreach-probe-ab", to: "C:\\ctxreach-probe" }];
    expect(redactString("c:/users/ME/Temp/ctxreach-probe-ab/repo/x.md", r)).toBe("C:\\ctxreach-probe/repo/x.md");
    expect(redactString("C:\\Users\\me\\Temp\\ctxreach-probe-ab\\repo", r)).toBe("C:\\ctxreach-probe\\repo");
    const posix = [{ from: "/tmp/ctxreach-probe-ab", to: "/tmp/ctxreach-probe" }];
    expect(redactString("/TMP/ctxreach-probe-ab/repo", posix)).toBe("/TMP/ctxreach-probe-ab/repo");
    expect(redactString("/tmp/ctxreach-probe-ab/repo", posix)).toBe("/tmp/ctxreach-probe/repo");
  });

  it("removes the user's lists, memory paths and rate-limit details, and keeps what the classifier reads", () => {
    const raw = [
      line({
        ...init,
        cwd: "/home/me/t/ctxreach-probe-ab/repo",
        slash_commands: ["mine"],
        skills: ["s"],
        agents: ["a"],
        plugins: [
          { name: "agents-md", source: "agents-md@builtin" },
          { name: "private", source: "private@market" },
        ],
        memory_paths: { auto: "/home/me/.claude/projects/x/memory/" },
        messaging_socket_path: "/sock",
      }),
      line({ type: "system", subtype: "commands_changed", commands: [{ name: "mine" }] }),
      line({ type: "rate_limit_event", rate_limit_info: { utilization: 0.5 } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "CTXR-12345678 /home/me/x" }] } }),
      line(result),
    ].join("\n");
    expect(memoryDirOf(raw)).toBe("/home/me/.claude/projects/x/memory/");
    const out = redactClaudeTranscript(raw, [
      { from: "/home/me/t/ctxreach-probe-ab", to: "/tmp/ctxreach-probe" },
      { from: "/home/me", to: "/home/user" },
    ]);
    for (const gone of ["mine", '"s"', '"a"', "private", "memory_paths", "/sock", "utilization", "/home/me"])
      expect(out).not.toContain(gone);
    const t = parseClaudeTranscript(out);
    expect(t.cwd).toBe("/tmp/ctxreach-probe/repo");
    expect(t.items).toEqual([{ kind: "text", text: "CTXR-12345678 /home/user/x" }]);
    expect(out).toContain("agents-md@builtin");
    expect(memoryDirOf(out)).toBeUndefined();
  });

  it("keeps text that is itself JSON parseable when a placeholder brings in a backslash", () => {
    const report = JSON.stringify({
      cwd: "/tmp/ctxreach-probe-ab/repo",
      files: ["/tmp/ctxreach-probe-ab/repo/AGENTS.md"],
    });
    const raw = line({ type: "assistant", message: { content: [{ type: "text", text: report }] } });
    const out = redactClaudeTranscript(raw, [{ from: "/tmp/ctxreach-probe-ab", to: "C:\\ctxreach-probe" }]);
    const text = (parseClaudeTranscript(out).items[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual({
      cwd: "C:\\ctxreach-probe/repo",
      files: ["C:\\ctxreach-probe/repo/AGENTS.md"],
    });
  });
});
