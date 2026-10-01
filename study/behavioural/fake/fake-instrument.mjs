// A stand-in for `ctxreach verify --agent claude` (capture) and `ctxreach
// probe --agent claude` (echo), for the harness's dry run. It runs no agent
// and reaches no network. It copies the repository under TEMP, as the real
// sandbox does, decides what "Claude Code" would load there by the rules the
// cells test (the hypotheses, as read from the source), and writes its
// observation in the shapes the harness reads: request bodies for capture, a
// stream-json transcript for echo.
//
// Usage: node fake-instrument.mjs <verify|probe> [the real command's flags]
// FAKE_INSTRUMENT_MODE: "ok" (default); "no-home-shadow" (the home file does
// not count as an ancestor: what a refuted B2 looks like); "drop-control";
// "echo-decoy"; "wrong-cwd" (the session reports a cwd outside the launch
// directory, which K10 voids); "silent" (saves nothing). Like the real
// commands, it records its copy of the repository in manifest.json.

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [command, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const mode = process.env.FAKE_INSTRUMENT_MODE ?? "ok";
const repo = path.resolve(opt("--repo"));
const from = path.resolve(opt("--from"));
const save = path.resolve(opt("--save"));
const model = opt("--model") ?? "fake-model";
const home = opt("--home") ?? process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
mkdirSync(save, { recursive: true });
if (mode === "silent") process.exit(0);

// The copy, where the real sandbox puts it: under the temporary directory.
const base = path.join(os.tmpdir(), `ctxr-fake-${randomBytes(4).toString("hex")}`);
const copy = path.join(base, "repo");
cpSync(repo, copy, { recursive: true });
const launch = path.join(copy, path.relative(repo, from));

const names = (dir) => {
  try {
    return new Set(readdirSync(dir));
  } catch {
    return new Set();
  }
};
const read = (p) => readFileSync(p, "utf8");
const isFile = (dir, n) => names(dir).has(n);
const isHome = (dir) => path.resolve(dir).toLowerCase() === path.resolve(home).toLowerCase();

// Directories from the ceiling (the dry run's own folder, so nothing outside
// it is ever listed) or the filesystem root down to the launch directory.
const ceiling = process.env.FAKE_INSTRUMENT_CEILING ? path.resolve(process.env.FAKE_INSTRUMENT_CEILING) : undefined;
const upward = [];
for (let d = launch; ; d = path.dirname(d)) {
  upward.unshift(d);
  if (path.dirname(d) === d || (ceiling && path.resolve(d).toLowerCase() === ceiling.toLowerCase())) break;
}
const loaded = [];
const claudeFiles = (dir) => {
  const out = [];
  if (isFile(dir, "CLAUDE.md")) out.push(path.join(dir, "CLAUDE.md"));
  if (isFile(path.join(dir, ".claude"), "CLAUDE.md") && !(mode === "no-home-shadow" && isHome(dir)))
    out.push(path.join(dir, ".claude", "CLAUDE.md"));
  if (isFile(dir, "CLAUDE.local.md")) out.push(path.join(dir, "CLAUDE.local.md"));
  return out;
};
const shadowed = upward.some((d) => claudeFiles(d).length > 0);
const within = (p, dir) => !path.relative(dir, p).startsWith("..") && !path.isAbsolute(path.relative(dir, p));
const importsOf = (file) => {
  for (const m of read(file).matchAll(/(?:^|\s)@(\S+)/g)) {
    const target = path.resolve(path.dirname(file), m[1]);
    // Headless: an import outside the launch directory needs an approval nobody gave.
    if (existsSync(target) && within(target, launch) && !loaded.includes(target)) loaded.push(target);
  }
};
// The user file loads in every session; the hypothesis under test is that it
// also counts as an ancestor's .claude/CLAUDE.md when the copy is below it.
const userFile = path.join(home, ".claude", "CLAUDE.md");
const homeInside = !ceiling || within(path.resolve(home), ceiling);
if (homeInside && existsSync(userFile)) loaded.push(userFile);
for (const d of upward) {
  for (const f of claudeFiles(d)) {
    if (loaded.includes(f)) continue;
    loaded.push(f);
    importsOf(f);
  }
  const rules = path.join(d, ".claude", "rules");
  for (const r of names(rules)) {
    const text = read(path.join(rules, r));
    if (
      r.endsWith(".md") &&
      !/^---[\s\S]*?paths\s*:/m.test(text) &&
      !(mode === "drop-control" && r.includes("control"))
    )
      loaded.push(path.join(rules, r));
  }
  if (!shadowed && isFile(d, "AGENTS.md")) loaded.push(path.join(d, "AGENTS.md"));
}
let text = loaded.map((f) => `Contents of ${f}:\n\n${read(f)}`).join("\n\n");
if (mode === "echo-decoy") text += "\n" + read(path.join(launch, "ctxreach-cell-decoy.md"));
const init = {
  type: "system",
  subtype: "init",
  cwd: mode === "wrong-cwd" ? base : launch,
  model,
  claude_code_version: "0.0.0-fake",
  plugins: [{ name: "agents-md", source: "agents-md@builtin" }],
};
// Where the copy is, as the real commands' manifest.json records it (this fake does not redact paths).
const launchRel = path.relative(repo, from).split(path.sep).join("/") || ".";
writeFileSync(
  path.join(save, "manifest.json"),
  JSON.stringify({ schema: "fake", command, repo: copy, launchDir: launchRel }) + "\n",
);
if (command === "verify") {
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: [{ type: "text", text: `<system-reminder>${text}</system-reminder>` }] }],
  });
  writeFileSync(
    path.join(save, "trial-1.capture.jsonl"),
    JSON.stringify({ method: "POST", url: "/v1/messages?beta=true", body }) + "\n",
  );
  writeFileSync(path.join(save, "trial-1.jsonl"), JSON.stringify(init) + "\n");
} else {
  const tokens = [...new Set(text.match(/CTXR-[0-9a-f]{8}/g) ?? [])];
  const events = [
    init,
    { type: "assistant", message: { content: [{ type: "text", text: tokens.join("\n") || "NONE" }] } },
  ];
  writeFileSync(path.join(save, "trial-1.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
rmSync(base, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ fake: true, command, loaded: loaded.length }) + "\n");
