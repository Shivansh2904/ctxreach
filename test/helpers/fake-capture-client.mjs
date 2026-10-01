// A stand-in for the `claude` executable under capture, run as
// `node fake-capture-client.mjs <args>` by the oracle tests. It prints a
// stream-json `system/init`, sends the session's first request to
// ANTHROPIC_BASE_URL with the instruction files it loads (the documented
// rules: CLAUDE.md-family files at the launch directory and above, AGENTS.md
// when none of them exists, path-less rules at the launch directory,
// `@` imports that resolve inside the launch directory), waits for the
// recorder's answer, and prints an error result, as Claude Code 2.1.285 does
// against a 400.
//
// It writes a marker file into the config directory it was given, so a test
// can show the session was isolated. It never writes anything else.
//
// FAKE_CAPTURE_BEHAVIOUR: ok (default), no-plugin, wrong-model, echo-decoy,
// drop-control, no-request, wrong-cwd, old-version, hang.
// FAKE_CAPTURE_CEILING: stop the upward walk at this directory (the tests'
// temp root), so nothing above the temp directory changes a test's answer.
// FAKE_CAPTURE_VERSION: the version to report (default 2.1.285).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

const args = process.argv.slice(2);
const behaviour = process.env.FAKE_CAPTURE_BEHAVIOUR ?? "ok";
const version = behaviour === "old-version" ? "2.1.280" : (process.env.FAKE_CAPTURE_VERSION ?? "2.1.285");
if (args.includes("--version")) {
  process.stdout.write(`${version} (Claude Code)\n`);
  process.exit(0);
}
const base = process.env.ANTHROPIC_BASE_URL;
if (!base) {
  process.stderr.write("fake-capture-client: ANTHROPIC_BASE_URL is not set\n");
  process.exit(2);
}
const configDir =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), ".claude");
mkdirSync(configDir, { recursive: true });
writeFileSync(path.join(configDir, "ctxreach-fake-capture-marker.json"), JSON.stringify({ fake: true, args }));

const modelAt = args.indexOf("--model");
const model = behaviour === "wrong-model" ? "some-other-model" : modelAt >= 0 ? args[modelAt + 1] : "default-model";
const settingsAt = args.indexOf("--settings");
let mode = "claude-md-or-agents-md";
if (settingsAt >= 0) {
  try {
    const settings = JSON.parse(readFileSync(args[settingsAt + 1], "utf8"));
    mode = settings.pluginConfigs?.["agents-md@builtin"]?.options?.instructionFiles ?? mode;
  } catch {
    // Not a settings file the fake reads.
  }
}

const cwd = process.cwd();
const same = (a, b) =>
  process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : path.resolve(a) === path.resolve(b);
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const ceiling = process.env.FAKE_CAPTURE_CEILING;
const ancestors = [];
for (let d = cwd; ; d = path.dirname(d)) {
  ancestors.unshift(d);
  if ((ceiling && same(d, ceiling)) || path.dirname(d) === d) break;
}
const has = (dir, name) => {
  try {
    return statSync(path.join(dir, ...name.split("/"))).isFile();
  } catch {
    return false;
  }
};
const project = (p) => ({
  path: p,
  label: "project instructions, checked into the codebase",
  text: readFileSync(p, "utf8"),
});
const files = [];
const claudeNames = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"];
const shadowers = ancestors.flatMap((d) => claudeNames.filter((n) => has(d, n)));
const agentsOn = mode === "claude-md-and-agents-md" || (mode === "claude-md-or-agents-md" && shadowers.length === 0);

function expandImports(file) {
  for (const m of readFileSync(file, "utf8").matchAll(/(?:^|\s)@(\S+)/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    try {
      if (!statSync(target).isFile()) continue;
    } catch {
      continue;
    }
    // Headless: an import from outside the launch directory does not load (no approval dialog).
    if (!inside(target, cwd)) continue;
    files.push(project(target));
  }
}

if (mode !== "managed-only" && has(configDir, "CLAUDE.md")) {
  const user = path.join(configDir, "CLAUDE.md");
  files.push({
    path: user,
    label: "user's private global instructions for all projects",
    text: readFileSync(user, "utf8"),
  });
}
for (const d of ancestors) {
  if (mode !== "managed-only")
    for (const n of claudeNames)
      if (has(d, n)) {
        const p = path.join(d, ...n.split("/"));
        files.push(project(p));
        expandImports(p);
      }
  if (agentsOn)
    for (const n of ["AGENTS.md", ".claude/AGENTS.md"])
      if (has(d, n)) files.push(project(path.join(d, ...n.split("/"))));
}
const rulesDir = path.join(cwd, ".claude", "rules");
if (existsSync(rulesDir))
  for (const name of readdirSync(rulesDir).sort()) {
    if (!name.endsWith(".md")) continue;
    const p = path.join(rulesDir, name);
    const text = readFileSync(p, "utf8");
    if (!/^---\r?\n[\s\S]*?^paths\s*:[\s\S]*?\n---/m.test(text)) files.push(project(p));
  }
if (behaviour === "echo-decoy" && existsSync(path.join(cwd, "ctxreach-decoy.md")))
  files.push(project(path.join(cwd, "ctxreach-decoy.md")));

let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => void main());

async function main() {
  if (behaviour === "hang") {
    setTimeout(() => process.exit(0), 10_000);
    return;
  }
  const plugins =
    behaviour === "no-plugin"
      ? [{ name: "telemetry", path: "builtin", source: "telemetry@builtin" }]
      : [
          { name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" },
          { name: "telemetry", path: "builtin", source: "telemetry@builtin" },
        ];
  const shownCwd = behaviour === "wrong-cwd" ? path.dirname(cwd) : cwd;
  const init = {
    type: "system",
    subtype: "init",
    cwd: shownCwd,
    tools: [],
    model,
    claude_code_version: version,
    plugins,
    slash_commands: ["private-command"],
    skills: [],
    agents: [],
    memory_paths: { auto: path.join(configDir, "projects", "fake", "memory") },
  };
  process.stdout.write(JSON.stringify(init) + "\n");
  if (behaviour === "no-request") {
    process.stdout.write(
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "no request" }) +
        "\n",
    );
    return;
  }
  const reminder = files.length
    ? `<system-reminder>\nThe stand-in's preamble, in place of Claude Code's.\n\n${files.map((f) => `Contents of ${f.path} (${f.label}):\n\n${f.text}`).join("\n\n")}\n</system-reminder>`
    : undefined;
  const environment = `# Environment (stand-in)\n - Primary working directory: ${shownCwd}\n - Platform: ${process.platform}\n`;
  const content = [
    ...(reminder ? [{ type: "text", text: reminder }] : []),
    {
      type: "text",
      text: "<system-reminder>\nThe stand-in's git status.\nCurrent branch: master\nGit user: Fake User\n</system-reminder>\n",
    },
    ...(behaviour === "drop-control" ? [] : [{ type: "text", text: prompt }]),
  ];
  const body = JSON.stringify({
    model,
    max_tokens: 100,
    system: [{ type: "text", text: "You are a fake." }],
    messages: [
      { role: "user", content },
      { role: "system", content: [{ type: "text", text: environment }] },
    ],
    metadata: { user_id: JSON.stringify({ device_id: "fake-device-id" }) },
    stream: true,
  });
  const status = await new Promise((resolve) => {
    const req = http.request(
      new URL("/v1/messages?beta=true", base),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          authorization: "Bearer never-record-me",
          "x-claude-code-session-id": "fake-session-id",
          "user-agent": `claude-cli/${version} (fake)`,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    req.on("error", () => resolve(0));
    req.end(body);
  });
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: `API error ${status}`,
      total_cost_usd: 0,
    }) + "\n",
  );
}
