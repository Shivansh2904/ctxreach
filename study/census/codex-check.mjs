// Check K4: for each measured (repository, launch directory) pair, compare the
// AGENTS.md block that Codex's own renderer produces with the bytes `map`
// predicts, byte for byte.
//
// The renderer is `codex debug prompt-input`, which builds the model input
// and prints it as JSON without a login or a model call. Every render gets a
// throwaway CODEX_HOME (the command writes into it), proxy variables pointed
// at a closed port, and a fresh control token in the prompt that must come
// back in the rendered user message. Each pair is rendered twice; renders
// that differ are an instrument fault. The renderer sits behind one function
// (`render`) so that ctxreach's own oracle (src/oracle/codex-render, lane L2)
// or a future `codex debug agents-md` can replace it.
//
// Wording for anything built on this: "as rendered by `codex debug
// prompt-input` <version>; the model was not run".
//
// CLI (one reconstructed repository):
//   node study/census/codex-check.mjs --codex-bin <codex.js> --repo <dir> --from <dir> [--from ...] [--cli dist/cli.js]

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEAD_PROXY = "http://127.0.0.1:9";

function codexCommand(codexBin, args) {
  return /\.(c|m)?js$/.test(codexBin) ? [process.execPath, [codexBin, ...args]] : [codexBin, args];
}

function run(cmd, args, { cwd, env, timeoutMs = 60_000 }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
    child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: e.message }));
  });
}

/** The environment for one render: no credentials, no reachable proxy, its own CODEX_HOME. */
export function renderEnv(codexHome, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !/^(OPENAI_|CODEX_)/.test(k)));
  return {
    ...env,
    CODEX_HOME: codexHome,
    HTTPS_PROXY: DEAD_PROXY,
    HTTP_PROXY: DEAD_PROXY,
    ALL_PROXY: DEAD_PROXY,
    NO_PROXY: "",
    OPENAI_API_KEY: "",
    CODEX_API_KEY: "",
  };
}

export async function codexVersion(codexBin) {
  const [cmd, args] = codexCommand(codexBin, ["--version"]);
  const r = await run(cmd, args, { cwd: process.cwd(), env: process.env, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim() : `unknown (exit ${r.code})`;
}

/** Run the renderer once. The single place to swap in another renderer. */
export async function render({ codexBin, cwd, codexHome, prompt }) {
  const [cmd, args] = codexCommand(codexBin, ["debug", "prompt-input", prompt]);
  mkdirSync(codexHome, { recursive: true });
  try {
    return await run(cmd, args, { cwd, env: renderEnv(codexHome) });
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
}

/**
 * The AGENTS.md block of a render: the content item tagged
 * `agents_md.instructions`, split into its header's directory and the text
 * between <INSTRUCTIONS> and </INSTRUCTIONS>. `text` is null when Codex sent
 * no block. Throws on a shape it does not recognise.
 */
export function extractBlock(items) {
  if (!Array.isArray(items)) throw new Error("render is not a JSON array");
  let found;
  for (const item of items) {
    const kinds = item?.internal_chat_message_metadata_passthrough?.content_item_kinds;
    if (!Array.isArray(kinds) || !Array.isArray(item.content)) continue;
    const i = kinds.indexOf("agents_md.instructions");
    if (i >= 0) {
      if (typeof item.content[i]?.text !== "string") throw new Error("agents_md.instructions item has no text");
      found = item.content[i].text;
      break;
    }
  }
  const users = items.filter((i) => i?.role === "user");
  const lastUser = users.length ? JSON.stringify(users[users.length - 1].content ?? "") : "";
  if (found === undefined) {
    // A block under another tag is a format change, not an absent block.
    if (JSON.stringify(items).includes("# AGENTS.md instructions for "))
      throw new Error("AGENTS.md text found outside an agents_md.instructions item: unknown render shape");
    return { text: null, cwd: undefined, lastUser };
  }
  const header = /^# AGENTS\.md instructions for (.+)\n/.exec(found);
  const open = found.indexOf("<INSTRUCTIONS>\n");
  const close = found.lastIndexOf("\n</INSTRUCTIONS>");
  if (!header || open < 0 || close < open) throw new Error("agents_md.instructions text has an unknown layout");
  return { text: found.slice(open + "<INSTRUCTIONS>\n".length, close), cwd: header[1], lastUser };
}

/** What `map` says Codex receives from this launch directory: kept bytes of each chain file, decoded leniently, joined by a blank line. */
export function predictedBlock(pair, readBytes) {
  const pieces = [];
  for (const e of pair.codex.chain) {
    if (!(e.kept > 0)) continue;
    const text = new TextDecoder("utf-8", { fatal: false }).decode(readBytes(e.path).subarray(0, e.kept));
    if (text.trim() !== "") pieces.push(text);
  }
  return pieces.join("\n\n");
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const sameDir = (a, b) => {
  const n = (p) => path.resolve(p).split(path.sep).join("/");
  return process.platform === "win32" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

/** Render one pair `trials` times and compare with the prediction. */
/** Renders per pair; renders that differ are an instrument fault. */
export const K4_TRIALS = 2;

export async function checkPair({
  codexBin,
  repoDir,
  pair,
  readBytes,
  workDir,
  trials = K4_TRIALS,
  renderFn = render,
}) {
  const cwd = pair.dir === "." ? repoDir : path.join(repoDir, ...pair.dir.split("/"));
  const predicted = Buffer.from(predictedBlock(pair, readBytes), "utf8");
  const faults = [];
  const texts = [];
  let stderrFirst = "";
  for (let t = 1; t <= trials; t++) {
    const token = "CTXR-" + randomBytes(4).toString("hex");
    const r = await renderFn({
      codexBin,
      cwd,
      codexHome: path.join(workDir, `codex-home-${randomBytes(4).toString("hex")}`),
      prompt: `ctxreach census K4 control ${token}`,
    });
    if (!stderrFirst && r.stderr) stderrFirst = r.stderr.split("\n")[0].slice(0, 200);
    if (r.code !== 0) {
      faults.push(`render ${t} exited ${r.code}: ${r.stderr.slice(0, 200)}`);
      continue;
    }
    let block;
    try {
      block = extractBlock(JSON.parse(r.stdout));
    } catch (err) {
      faults.push(`render ${t}: ${err.message}`);
      continue;
    }
    if (!block.lastUser.includes(token)) faults.push(`render ${t}: control token missing from the last user message`);
    if (block.text !== null && !sameDir(block.cwd, cwd)) faults.push(`render ${t}: rendered for ${block.cwd}`);
    texts.push(block.text);
  }
  if (texts.length === trials && texts.some((t) => t !== texts[0])) faults.push("renders differ");
  const base = { dir: pair.dir, type: pair.type, predictedBytes: predicted.length, renders: texts.length };
  if (texts.length === 0) return { ...base, verdict: "FAULT", faults, stderr: stderrFirst };
  const rendered = texts[0] === null ? null : Buffer.from(texts[0], "utf8");
  let verdict;
  if (rendered === null) verdict = predicted.length === 0 ? "EXACT" : "NO-BLOCK";
  else if (rendered.equals(predicted)) verdict = "EXACT";
  else verdict = "OFF";
  return {
    ...base,
    verdict: faults.length ? "FAULT" : verdict,
    renderedBytes: rendered === null ? 0 : rendered.length,
    ...(verdict === "OFF"
      ? { offBy: rendered.length - predicted.length, firstDiff: firstDiff(rendered, predicted) }
      : {}),
    faults,
    ...(stderrFirst ? { stderr: stderrFirst } : {}),
  };
}

/** K4 for one measured repository (types 1 and 2 unless `types` says otherwise). */
export async function codexCheck({ codexBin, repoDir, pairs, readBytes, workDir, types = [1, 2], renderFn }) {
  const out = [];
  for (const pair of pairs) {
    if (pair.error || !types.includes(pair.type)) continue;
    out.push(await checkPair({ codexBin, repoDir, pair, readBytes, workDir, renderFn }));
  }
  return {
    pairs: out,
    exact: out.filter((p) => p.verdict === "EXACT").length,
    n: out.length,
    faults: out.filter((p) => p.verdict === "FAULT").length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const froms = args.flatMap((a, i) => (a === "--from" ? [args[i + 1]] : []));
  const codexBin = opt("--codex-bin");
  const repo = opt("--repo");
  const cli = opt("--cli") ?? "dist/cli.js";
  if (!codexBin || !repo || !froms.length) {
    console.error("usage: node study/census/codex-check.mjs --codex-bin <codex.js> --repo <dir> --from <dir> [...]");
    process.exit(2);
  }
  const { spawnMapRunner } = await import("./lib/maprun.mjs");
  const work = path.resolve(opt("--work") ?? path.join(repo, "..", "k4-work"));
  mkdirSync(path.join(work, "home", ".codex"), { recursive: true });
  mkdirSync(path.join(work, "home", ".claude"), { recursive: true });
  const runner = spawnMapRunner(path.resolve(cli));
  const readBytes = (rel) => readFileSync(path.join(repo, ...rel.split("/")));
  console.log(`codex: ${await codexVersion(codexBin)}`);
  let exact = 0;
  for (const from of froms) {
    const m = await runner({
      launchDir: path.resolve(repo, from),
      repoRoot: path.resolve(repo),
      codexHome: path.join(work, "home", ".codex"),
      claudeHome: path.join(work, "home", ".claude"),
    });
    if (m.error) {
      console.log(`${from}: map failed: ${m.error}`);
      continue;
    }
    const pair = {
      dir: m.json.launchDir,
      type: 1,
      codex: { chain: m.json.codex.chain.map((c) => ({ path: c.path, kept: c.keptBytes })) },
    };
    const r = await checkPair({ codexBin, repoDir: path.resolve(repo), pair, readBytes, workDir: work });
    if (r.verdict === "EXACT") exact++;
    console.log(`${from}: ${r.verdict}${r.offBy !== undefined ? ` by ${r.offBy} B` : ""} (map ${r.predictedBytes} B)`);
    for (const f of r.faults) console.log(`  fault: ${f}`);
  }
  console.log(`K4: ${exact}/${froms.length} exact`);
  rmSync(work, { recursive: true, force: true });
}
