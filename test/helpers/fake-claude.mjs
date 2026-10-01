// A stand-in for the `claude` executable, run as `node fake-claude.mjs <args>`
// by test/claude-adapter.test.ts and the probe tests. It writes a stream-json
// transcript that reports what it was given: its arguments, the prompt on
// stdin, and whether a parent Claude Code session's variables reached it.
//
// FAKE_CLAUDE_BEHAVIOUR: "ok" (default) or "hang" (print nothing, and exit only after 10 seconds).
// FAKE_CLAUDE_HOME: a Claude Code user directory; the fake creates an empty
// per-project memory folder there, as Claude Code does.
// FAKE_CLAUDE_STDERR: text to write to stderr.
// FAKE_CLAUDE_IGNORE_SIGTERM: "1" to ignore SIGTERM, as a busy agent might.
// FAKE_CLAUDE_PIDS: a file; the fake starts a process of its own (which also
// ends after 10 seconds) and writes both process ids there, as
// {"agent": <its own>, "child": <the one it started>}.
//
// What it says it loaded, for the probe's instruments:
// FAKE_CLAUDE_ECHO: comma-separated files (relative to its working directory,
// or absolute) whose CTXR- tokens it repeats, as if they were in its context.
// FAKE_CLAUDE_HOOK: comma-separated files it reports to the InstructionsLoaded
// hooks of the settings passed with --settings (unless they set
// disableAllHooks), running each hook command as Claude Code does in exec form.
// FAKE_CLAUDE_HOOK_LATE: comma-separated files it reports the same way 400 ms
// after it has exited (the hook runs asynchronously).
// FAKE_CLAUDE_HOOK_SESSION: the session id to send the hook (default: its own).
// FAKE_CLAUDE_MODEL: the model to report (default: --model, else fake-model).
// FAKE_CLAUDE_PLUGINS: comma-separated plugin sources to report (default:
// agents-md@builtin,telemetry@builtin; empty for none).
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

const after = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const list = (v) => (v ? v.split(",").filter(Boolean) : []);
const tools = list(after("--tools"));
const slug = process.cwd().replace(/[^A-Za-z0-9]/g, "-");
const memory = process.env.FAKE_CLAUDE_HOME
  ? path.join(process.env.FAKE_CLAUDE_HOME, "projects", slug, "memory")
  : undefined;
if (memory) mkdirSync(memory, { recursive: true });

if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR);

const sessionId = `fake-session-${process.pid}`;
const abs = (f) => path.resolve(process.cwd(), f);

/** The InstructionsLoaded hooks in the --settings file, as [command, args] pairs. */
function hooks() {
  const file = after("--settings");
  if (!file) return [];
  const settings = JSON.parse(readFileSync(file, "utf8"));
  if (settings.disableAllHooks === true) return [];
  return (settings.hooks?.InstructionsLoaded ?? []).flatMap((m) =>
    (m.hooks ?? []).filter((h) => h.type === "command").map((h) => [h.command, h.args ?? []]),
  );
}

function payload(file) {
  return JSON.stringify({
    session_id: process.env.FAKE_CLAUDE_HOOK_SESSION ?? sessionId,
    transcript_path: path.join(process.cwd(), "never-written.jsonl"),
    cwd: process.cwd(),
    hook_event_name: "InstructionsLoaded",
    file_path: abs(file),
    memory_type: "Project",
    load_reason: "session_start",
  });
}

const tokensOf = (f) =>
  existsSync(abs(f)) ? [...readFileSync(abs(f), "utf8").matchAll(/CTXR-[0-9a-f]{8}/g)].map((m) => m[0]) : [];

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_BEHAVIOUR === "hang") return;
  for (const [command, hookArgs] of hooks()) {
    for (const f of list(process.env.FAKE_CLAUDE_HOOK))
      spawnSync(command, hookArgs, { input: payload(f), windowsHide: true });
    const late = list(process.env.FAKE_CLAUDE_HOOK_LATE);
    if (late.length) {
      // Runs on after the fake has exited, like an asynchronous hook still finishing.
      const script = `setTimeout(() => { for (const p of ${JSON.stringify(late.map(payload))}) require("node:child_process").spawnSync(${JSON.stringify(command)}, ${JSON.stringify(hookArgs)}, { input: p, windowsHide: true }); }, 400);`;
      // From the temp directory, so it holds no directory of the copy open while the copy is deleted.
      // Detached: on Windows, a child that is not is stopped when the fake exits.
      spawn(process.execPath, ["-e", script], {
        cwd: os.tmpdir(),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    }
  }
  const report = {
    args,
    prompt,
    parentSession: process.env.CLAUDECODE ?? "unset",
    userVar: process.env.CLAUDE_CODE_USE_BEDROCK ?? "unset",
    autoMemory: process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? "unset",
  };
  const plugins =
    process.env.FAKE_CLAUDE_PLUGINS === undefined
      ? ["agents-md@builtin", "telemetry@builtin"]
      : list(process.env.FAKE_CLAUDE_PLUGINS);
  const echoed = list(process.env.FAKE_CLAUDE_ECHO).flatMap(tokensOf);
  const events = [
    {
      type: "system",
      subtype: "init",
      cwd: process.cwd(),
      session_id: sessionId,
      tools,
      model: process.env.FAKE_CLAUDE_MODEL ?? after("--model") ?? "fake-model",
      claude_code_version: "9.9.9",
      slash_commands: ["private-command"],
      plugins: plugins.map((source) => ({ name: source.split("@")[0], path: source.split("@")[1], source })),
      ...(memory ? { memory_paths: { auto: memory + path.sep } } : {}),
    },
    { type: "assistant", message: { content: [{ type: "text", text: JSON.stringify(report) }] } },
    ...(echoed.length
      ? [{ type: "assistant", message: { content: [{ type: "text", text: echoed.join("\n") }] } }]
      : []),
    { type: "result", subtype: "success", is_error: false, result: echoed.join("\n") || "done" },
  ];
  process.stdout.write(events.map((e) => JSON.stringify(e)).join("\n") + "\n");
});
