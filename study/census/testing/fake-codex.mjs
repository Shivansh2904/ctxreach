// A stand-in for `codex` that answers `--version` and `debug prompt-input
// <prompt>` in the JSON shape Codex 0.159.2 printed on 2026-09-30 (five
// messages; the AGENTS.md text in the content item tagged
// `agents_md.instructions`). It exists to test the plumbing of check K4
// (study/census/codex-check.mjs); it proves nothing about Codex.
//
// Its loading rule is deliberately simple: from the nearest directory with a
// `.git` down to the working directory, one file per directory
// (AGENTS.override.md, else AGENTS.md), a whitespace-only file takes the slot
// and gives nothing, a shared budget of FAKE_CODEX_MAX_BYTES (default 32768)
// cut at a raw byte offset, files joined by a blank line.
//
// FAKE_CODEX_MODE: "ok" (default); "flaky" (every other render differs);
// "drop-prompt" (the prompt is not echoed); "wrong-cwd"; "no-block";
// "bad-shape"; "fail" (exit 1).
// FAKE_CODEX_COUNTER: a file the "flaky" mode counts renders in.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\n");
  process.exit(0);
}
if (args[0] !== "debug" || args[1] !== "prompt-input") {
  process.stderr.write(`fake codex: unsupported arguments ${args.join(" ")}\n`);
  process.exit(2);
}
if (mode === "fail") {
  process.stderr.write("fake codex: planted failure\n");
  process.exit(1);
}
if (!process.env.CODEX_HOME || !existsSync(process.env.CODEX_HOME)) {
  process.stderr.write("fake codex: CODEX_HOME must exist\n");
  process.exit(3);
}
// Codex writes into its home; so does the fake, so a test can see it is thrown away.
writeFileSync(path.join(process.env.CODEX_HOME, "installation_id"), "fake\n");

const cwd = process.cwd();
let root = cwd;
for (;;) {
  if (existsSync(path.join(root, ".git"))) break;
  const up = path.dirname(root);
  if (up === root) {
    root = cwd;
    break;
  }
  root = up;
}
const dirs = [];
for (let d = cwd; ; d = path.dirname(d)) {
  dirs.unshift(d);
  if (d === root || path.dirname(d) === d) break;
}
let budget = Number(process.env.FAKE_CODEX_MAX_BYTES ?? 32768);
const pieces = [];
for (const d of dirs) {
  const names = new Set(readdirSync(d));
  const name = ["AGENTS.override.md", "AGENTS.md"].find((n) => names.has(n));
  if (!name) continue;
  const bytes = readFileSync(path.join(d, name));
  if (bytes.toString("utf8").trim() === "") continue;
  if (budget <= 0) break;
  const kept = bytes.subarray(0, Math.min(bytes.length, budget));
  budget -= kept.length;
  pieces.push(new TextDecoder("utf-8", { fatal: false }).decode(kept));
}
let body = pieces.join("\n\n");
if (mode === "flaky") {
  const counter = process.env.FAKE_CODEX_COUNTER;
  const n = counter && existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  if (counter) writeFileSync(counter, String(n + 1));
  if (n % 2 === 1) body += "\nflaky";
}
const shownCwd = mode === "wrong-cwd" ? path.join(cwd, "elsewhere") : cwd;
const kinds = (k) => ({ turn_id: "fake", content_item_kinds: k });
const text = (t) => ({ type: "input_text", text: t });
const agentsItem =
  mode === "no-block" || pieces.length === 0
    ? []
    : [text(`# AGENTS.md instructions for ${shownCwd}\n\n<INSTRUCTIONS>\n${body}\n</INSTRUCTIONS>`)];
const items = [
  {
    type: "message",
    role: "developer",
    content: [text("<permissions instructions>fake")],
    internal_chat_message_metadata_passthrough: kinds(["permissions.instructions"]),
  },
  {
    type: "message",
    role: "developer",
    content: [text("<multi_agent_role>fake")],
    internal_chat_message_metadata_passthrough: kinds(["multi_agent.role_instructions"]),
  },
  {
    type: "message",
    role: "developer",
    content: [text("<multi_agent_mode>fake")],
    internal_chat_message_metadata_passthrough: kinds(["multi_agent.mode_instructions"]),
  },
  {
    type: "message",
    role: "user",
    content: [...agentsItem, text(`<environment_context>\n  <cwd>${shownCwd}</cwd>\n</environment_context>`)],
    internal_chat_message_metadata_passthrough: kinds([
      ...(agentsItem.length ? [mode === "bad-shape" ? "agents_md.unknown" : "agents_md.instructions"] : []),
      "environments.environment_context",
    ]),
  },
  {
    type: "message",
    role: "user",
    content: [text(mode === "drop-prompt" ? "x" : (args[2] ?? ""))],
    internal_chat_message_metadata_passthrough: kinds(["user.text"]),
  },
];
process.stdout.write(JSON.stringify(items, null, 2) + "\n");
