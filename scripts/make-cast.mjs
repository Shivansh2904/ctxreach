// Records the README demo: an asciicast v2 of `ctxreach map` on examples/demo-monorepo.
//
// The typing is simulated (one character every TYPE_MS); the output is the
// exact bytes the built CLI printed when this script ran it, line by line.
// The first line of the cast says so, with the ctxreach version, the commit
// and the date, so a still frame of the SVG carries its own label.
//
// The demo is copied to <work>/home/demo (with an empty .git, as the README's
// `git init` would give) and `node dist/cli.js map --from demo/packages/api`
// runs in <work>/home with HOME and USERPROFILE set to <work>/home: the
// repository prints as ~/demo, no personal Codex or Claude Code config is
// read, and no path of this machine appears in the output. The script refuses
// when an instruction file sits in any folder above the copy (it would change
// what map reports, for example a ~/.claude/CLAUDE.md above the temp folder);
// pass --work with a folder outside your home then.
//
// Writes the .cast and a sidecar <cast>.json holding the command, the
// version, the date, the platform and the SHA-256 of the raw output, which
// test/site.test.ts checks against the cast's output events.
//
// Usage: node scripts/make-cast.mjs [--cli dist/cli.js] [--out docs/demo.cast] [--work <dir>]
//          [--svg docs/demo.svg]   (renders the cast with `npx --yes svg-term-cli`)
// Exit status: 0 on success, 1 when map fails or svg-term-cli fails, 2 for a usage or safety problem.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), "..");

export const WIDTH = 120;
export const HEIGHT = 36;
export const TYPE_MS = 45;
export const LINE_MS = 30;
export const PROMPT = "$ ";
/** The command as typed; the script runs exactly these arguments. */
export const ARGS = ["map", "--from", "demo/packages/api"];
const INSTRUCTION_NAMES = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md"];

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Instruction files in `dir`'s ancestors (by name only; nothing is read). */
export function instructionFilesAbove(dir) {
  const found = [];
  let cursor = path.dirname(path.resolve(dir));
  for (;;) {
    for (const n of INSTRUCTION_NAMES) if (existsSync(path.join(cursor, n))) found.push(path.join(cursor, n));
    for (const n of ["CLAUDE.md", "AGENTS.md"])
      if (existsSync(path.join(cursor, ".claude", n))) found.push(path.join(cursor, ".claude", n));
    if (existsSync(path.join(cursor, ".claude", "rules"))) found.push(path.join(cursor, ".claude", "rules"));
    const up = path.dirname(cursor);
    if (up === cursor) break;
    cursor = up;
  }
  return found;
}

/** The label every cast carries in its first line and its title. */
export function label({ version, commit, date }) {
  return `typing simulated, output verbatim from ctxreach ${version} (${commit}) on ${date}`;
}

/**
 * The cast's events: a typed comment with the label, the typed command, then
 * the output one line at a time. Times are deterministic.
 */
export function castEvents({ labelText, command, output }) {
  const events = [];
  let t = 0.4;
  const type = (text) => {
    events.push([round(t), "o", PROMPT]);
    t += 0.3;
    for (const ch of text) {
      events.push([round(t), "o", ch]);
      t += TYPE_MS / 1000;
    }
    t += 0.35;
    events.push([round(t), "o", "\r\n"]);
  };
  type(`# ${labelText}`);
  t += 0.4;
  type(command);
  t += 0.25;
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    events.push([round(t), "o", `${line}\r\n`]);
    t += LINE_MS / 1000;
  }
  t += 0.2;
  events.push([round(t), "o", PROMPT]);
  t += 4;
  events.push([round(t), "o", ""]);
  return events;
}

function round(t) {
  return Math.round(t * 1000) / 1000;
}

/** The raw output bytes back from a cast's events: everything after the typed command's line, before the last prompt. */
export function outputOfCast(castText) {
  const lines = castText.split("\n").filter(Boolean);
  const events = lines.slice(1).map((l) => JSON.parse(l));
  const newlines = events.map((e, i) => (e[2] === "\r\n" ? i : -1)).filter((i) => i >= 0);
  // The first two "\r\n" events end the two typed lines; output events follow, then the closing prompt and the idle frame.
  const start = newlines[1] + 1;
  const body = events.slice(start, events.length - 2).map((e) => e[2]);
  return body.join("").replace(/\r\n/g, "\n");
}

function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

function git(args) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[k];
  const r = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", env });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function main(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const cli = path.resolve(opt("--cli", path.join(ROOT, "dist", "cli.js")));
  const out = path.resolve(opt("--out", path.join(ROOT, "docs", "demo.cast")));
  const svg = opt("--svg");
  if (!existsSync(cli)) {
    console.error(`${cli} does not exist: run npm run build first`);
    return 2;
  }
  if (statSync(cli).mtimeMs < newestMtime(path.join(ROOT, "src"))) {
    console.error(`${cli} is older than a file in src/: run npm run build first, so the cast shows this source`);
    return 2;
  }
  const dirty = git(["status", "--porcelain", "--", "src", "package.json", "examples"]);
  if (dirty === undefined || dirty !== "") {
    console.error(
      "src/, package.json or examples/ has uncommitted changes (or git failed): commit first, so the label names the source",
    );
    return 2;
  }
  const commit = git(["rev-parse", "--short=7", "HEAD"]);
  const version = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const date = new Date().toISOString().slice(0, 10);

  const work = opt("--work") ? path.resolve(opt("--work")) : mkdtempSync(path.join(os.tmpdir(), "ctxreach-cast-"));
  mkdirSync(work, { recursive: true });
  const home = path.join(work, "home");
  const demo = path.join(home, "demo");
  if (existsSync(home)) {
    console.error(`${home} already exists: pass an empty --work`);
    return 2;
  }
  const above = instructionFilesAbove(home);
  if (above.length) {
    console.error(
      `refusing: instruction files above ${home} would change map's output:\n  ${above.join("\n  ")}\npass --work <a folder with none above it>`,
    );
    return 2;
  }
  try {
    cpSync(path.join(ROOT, "examples", "demo-monorepo"), demo, { recursive: true });
    mkdirSync(path.join(demo, ".git"));
    const env = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: "1" };
    for (const k of ["NO_COLOR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) delete env[k];
    const r = spawnSync(process.execPath, [cli, ...ARGS], { cwd: home, env, encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`map exited ${r.status}:\n${r.stderr}`);
      return 1;
    }
    const output = r.stdout;
    const labelText = label({ version, commit, date });
    const command = `ctxreach ${ARGS.join(" ")}`;
    const header = {
      version: 2,
      width: WIDTH,
      height: HEIGHT,
      title: `ctxreach map on examples/demo-monorepo: ${labelText}`,
      env: { TERM: "xterm-256color", SHELL: "/bin/sh" },
    };
    const events = castEvents({ labelText, command, output });
    const cast = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join("\n") + "\n";
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, cast);
    const sidecar = {
      schema: "ctxreach.demo-cast/v1",
      cast: path.basename(out),
      label: labelText,
      command,
      ran: `node dist/cli.js ${ARGS.join(" ")} (cwd: a scratch home holding demo/, a copy of examples/demo-monorepo with an empty .git; HOME and USERPROFILE set to it; FORCE_COLOR=1)`,
      ctxreach: { version, commit },
      date,
      node: process.version,
      platform: `${process.platform} ${os.release()} ${process.arch}`,
      outputSha256: sha256(output.replace(/\r\n/g, "\n")),
      outputLines: output
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((l, i, a) => i < a.length - 1 || l !== "").length,
    };
    writeFileSync(`${out}.json`, JSON.stringify(sidecar, null, 2) + "\n");
    console.log(`wrote ${path.relative(ROOT, out)} (${events.length} events) and ${path.relative(ROOT, out)}.json`);
    console.log(labelText);
    if (svg) {
      const svgOut = path.resolve(svg);
      const s = spawnSync(
        "npx",
        [
          "--yes",
          "svg-term-cli",
          "--in",
          out,
          "--out",
          svgOut,
          "--window",
          "--width",
          String(WIDTH),
          "--height",
          String(HEIGHT),
          "--padding",
          "12",
        ],
        { encoding: "utf8", shell: process.platform === "win32" },
      );
      if (s.status !== 0) {
        console.error(`svg-term-cli failed (exit ${s.status}); the .cast is still written:\n${s.stderr}`);
        return 1;
      }
      console.log(`wrote ${path.relative(ROOT, svgOut)} with svg-term-cli`);
    }
    return 0;
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (!opt("--work")) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = main(process.argv.slice(2));
}
