// A stand-in for @openai/codex's bin/codex.js, run as `node fake-codex.mjs <args>`
// by the oracle tests. It renders `debug prompt-input` the way Codex 0.159.2
// does, from the files on disk and the config it is given (rules in
// docs/rules.md, Codex section), and prints JSON of the same shape, so the
// verify pipeline runs with no Codex installed. Like the real one, it writes
// into CODEX_HOME and prints the helper-binaries warning.
//
// FAKE_CODEX_BEHAVIOUR:
//   ok (default), ignore-budget (never cuts), wrong-separator (joins files
//   with one newline), nondeterministic (a different render every time),
//   bad-shape (no content_item_kinds metadata), echo-decoy (delivers
//   ctxreach-decoy.md from the launch directory), wrong-cwd (reports the
//   parent directory), no-control (drops the prompt message),
//   reject-hooks-flag (exits 1 when -c features.hooks=false is given).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const behaviour = process.env.FAKE_CODEX_BEHAVIOUR ?? "ok";
const warn = () =>
  process.stderr.write(
    `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir (codex_home: ${JSON.stringify(home ?? "")})\n`,
  );

if (args[0] === "--version") {
  warn();
  process.stdout.write("codex-cli 9.9.9\n");
  process.exit(0);
}
if (args[0] !== "debug" || args[1] !== "prompt-input") {
  process.stderr.write("fake-codex: only `debug prompt-input` and `--version` are known\n");
  process.exit(2);
}
if (!home) {
  process.stderr.write("fake-codex: CODEX_HOME is not set\n");
  process.exit(2);
}
// The real one writes these into whatever home it is given.
mkdirSync(path.join(home, "skills"), { recursive: true });
writeFileSync(path.join(home, "installation_id"), "fake-installation-id\n");
writeFileSync(path.join(home, ".sandbox_migration"), "1\n");
warn();

const overrides = [];
let prompt = "";
for (let i = 2; i < args.length; i++) {
  const a = args[i];
  if (a === "-c" || a === "--config") overrides.push(args[++i]);
  else if (a === "--disable" || a === "--enable") overrides.push(`features.${args[++i]}=${a === "--enable"}`);
  else prompt = a;
}
if (behaviour === "reject-hooks-flag" && overrides.some((o) => o.startsWith("features."))) {
  process.stderr.write("error: unknown feature `hooks`\n");
  process.exit(1);
}

const same = (a, b) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const configFile = path.join(home, "config.toml");
const userConfig = existsSync(configFile) ? parseToml(readFileSync(configFile, "utf8")) : {};
const config = { ...userConfig };
for (const o of overrides) {
  const eq = o.indexOf("=");
  const key = o.slice(0, eq);
  const raw = o.slice(eq + 1);
  let value;
  try {
    value = parseToml(`v = ${raw}`).v;
  } catch {
    value = raw;
  }
  if (!key.startsWith("features.")) config[key] = value;
}

const cwd = process.cwd();
let root = cwd;
for (;;) {
  if (existsSync(path.join(root, ".git"))) break;
  const parent = path.dirname(root);
  if (parent === root) {
    root = cwd;
    break;
  }
  root = parent;
}
const trustOf = (dir) => {
  for (const [key, value] of Object.entries(config.projects ?? {}))
    if (same(key, dir) && value && typeof value.trust_level === "string") return value.trust_level;
  return undefined;
};
const trust = trustOf(cwd) ?? trustOf(root) ?? "unknown";
const dirs = [];
for (let d = cwd; ; d = path.dirname(d)) {
  dirs.unshift(d);
  if (same(d, root) || path.dirname(d) === d) break;
}
let maxBytes = typeof userConfig.project_doc_max_bytes === "number" ? userConfig.project_doc_max_bytes : 32768;
let fallback = Array.isArray(userConfig.project_doc_fallback_filenames)
  ? userConfig.project_doc_fallback_filenames
  : [];
if (trust === "trusted")
  for (const d of dirs) {
    const layer = path.join(d, ".codex", "config.toml");
    if (!existsSync(layer) || same(path.join(d, ".codex"), home)) continue;
    const c = parseToml(readFileSync(layer, "utf8"));
    if (typeof c.project_doc_max_bytes === "number") maxBytes = c.project_doc_max_bytes;
    if (Array.isArray(c.project_doc_fallback_filenames)) fallback = c.project_doc_fallback_filenames;
  }
if (typeof config.project_doc_max_bytes === "number" && overrides.some((o) => o.startsWith("project_doc_max_bytes=")))
  maxBytes = config.project_doc_max_bytes;

const lossy = (buf) => new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buf);
const candidates = ["AGENTS.override.md", "AGENTS.md", ...fallback];
const pieces = [];
let left = maxBytes;
if (trust !== "untrusted" && maxBytes > 0)
  for (const d of dirs) {
    const names = new Set(readdirSync(d));
    const name = candidates.find((n) => names.has(n) && statSync(path.join(d, n)).isFile());
    if (!name || left === 0) continue;
    const buf = readFileSync(path.join(d, name));
    const kept = behaviour === "ignore-budget" ? buf : buf.subarray(0, Math.min(buf.length, left));
    const text = lossy(kept);
    if (text.trim() === "") continue;
    pieces.push(text);
    left -= kept.length;
  }
if (behaviour === "echo-decoy" && existsSync(path.join(cwd, "ctxreach-decoy.md")))
  pieces.push(lossy(readFileSync(path.join(cwd, "ctxreach-decoy.md"))));
let body = pieces.join(behaviour === "wrong-separator" ? "\n" : "\n\n");
for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
  const file = path.join(home, name);
  if (!existsSync(file)) continue;
  const text = lossy(readFileSync(file));
  if (text.trim() === "") continue;
  body = body ? `${text}\n--- project-doc ---\n\n${body}` : text;
  break;
}
if (behaviour === "nondeterministic") body += `\nrender ${Date.now()} ${Math.random()}\n`;

const shownCwd = behaviour === "wrong-cwd" ? path.dirname(cwd) : cwd;
const item = (role, kinds, content) => ({
  type: "message",
  id: "msg_fake",
  role,
  content,
  ...(behaviour === "bad-shape"
    ? {}
    : {
        internal_chat_message_metadata_passthrough: {
          turn_id: "auto-compact-0",
          create_time: 0,
          content_item_kinds: kinds,
        },
      }),
});
const text = (t) => ({ type: "input_text", text: t });
const items = [
  item(
    "developer",
    ["host_skills.instructions", "permissions.instructions", "collaboration_mode.instructions"],
    [
      text("<skills_instructions>\n## Skills\n(fake)\n</skills_instructions>"),
      text("<permissions instructions>\n(fake)\n</permissions instructions>"),
      text("<collaboration_mode>(fake)</collaboration_mode>"),
    ],
  ),
  item("developer", ["multi_agent.role_instructions"], [text("<multi_agent_role>(fake)</multi_agent_role>")]),
  item("developer", ["multi_agent.mode_instructions"], [text("<multi_agent_mode>(fake)</multi_agent_mode>")]),
  item(
    "user",
    body ? ["agents_md.instructions", "environments.environment_context"] : ["environments.environment_context"],
    [
      ...(body ? [text(`# AGENTS.md instructions for ${shownCwd}\n\n<INSTRUCTIONS>\n${body}\n</INSTRUCTIONS>`)] : []),
      text(`<environment_context>\n  <cwd>${shownCwd}</cwd>\n  <shell>powershell</shell>\n</environment_context>`),
    ],
  ),
  ...(behaviour === "no-control" ? [] : [item("user", ["user.text"], [text(prompt)])]),
];
process.stdout.write(JSON.stringify(items, null, 2) + "\n");
