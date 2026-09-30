// A stand-in for the `claude` executable, run as `node fake-claude.mjs <args>`
// by test/claude-adapter.test.ts. It writes a stream-json transcript that
// reports what it was given: its arguments, the prompt on stdin, and whether
// a parent Claude Code session's variables reached it.
//
// FAKE_CLAUDE_BEHAVIOUR: "ok" (default) or "hang" (print nothing, and exit only after 10 seconds).
// FAKE_CLAUDE_HOME: a Claude Code user directory; the fake creates an empty
// per-project memory folder there, as Claude Code does.
// FAKE_CLAUDE_STDERR: text to write to stderr.
// FAKE_CLAUDE_IGNORE_SIGTERM: "1" to ignore SIGTERM, as a busy agent might.
// FAKE_CLAUDE_PIDS: a file; the fake starts a process of its own (which also
// ends after 10 seconds) and writes both process ids there, as
// {"agent": <its own>, "child": <the one it started>}.
import { spawn } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("9.9.9 (Claude Code)\n");
  process.exit(0);
}
// "hang" ends by itself after 10 seconds, so a test that fails to stop it leaves no process behind.
if (process.env.FAKE_CLAUDE_BEHAVIOUR === "hang") setTimeout(() => process.exit(0), 10_000);
if (process.env.FAKE_CLAUDE_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => undefined);
if (process.env.FAKE_CLAUDE_PIDS) {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore", windowsHide: true });
  // Written whole, then renamed, so a reader never sees half of it.
  writeFileSync(`${process.env.FAKE_CLAUDE_PIDS}.tmp`, JSON.stringify({ agent: process.pid, child: child.pid }));
  renameSync(`${process.env.FAKE_CLAUDE_PIDS}.tmp`, process.env.FAKE_CLAUDE_PIDS);
}

const toolsAt = args.indexOf("--tools");
const tools = toolsAt >= 0 && args[toolsAt + 1] ? args[toolsAt + 1].split(",") : [];
const slug = process.cwd().replace(/[^A-Za-z0-9]/g, "-");
const memory = process.env.FAKE_CLAUDE_HOME
  ? path.join(process.env.FAKE_CLAUDE_HOME, "projects", slug, "memory")
  : undefined;
if (memory) mkdirSync(memory, { recursive: true });

if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR);

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_BEHAVIOUR === "hang") return;
  const report = {
    args,
    prompt,
    parentSession: process.env.CLAUDECODE ?? "unset",
    userVar: process.env.CLAUDE_CODE_USE_BEDROCK ?? "unset",
  };
  const events = [
    {
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      tools,
      model: "fake-model",
      claude_code_version: "9.9.9",
      slash_commands: ["private-command"],
      ...(memory ? { memory_paths: { auto: memory + path.sep } } : {}),
    },
    { type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(report) }] } },
    { type: "result", subtype: "success", is_error: false, result: "done" },
  ];
  process.stdout.write(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
});
