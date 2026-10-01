// The behavioural harness's parts (study/behavioural/run-cells.mjs): lay out
// one trial, plant the harness's own tokens, build the instrument's command,
// read what the instrument observed, score the trial, and decide each cell by
// its pre-registered rule.
//
// The harness plants its own tokens (head and tail of every instruction file
// in the staging copy, one in each layout file, a positive control rule at
// the launch directory, a decoy beside it), so it can score any instrument
// from the tokens the instrument saw, whatever that instrument plants itself.

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { wilson } from "../census/lib/stats.mjs";

export const TOKEN = /CTXR-[0-9a-f]{8}/g;
/**
 * The built-in AGENTS.md plugin as system/init.plugins lists it: Claude Code
 * 2.1.280 as `agents-md@builtin`, 2.1.285 (the study's pin) as
 * `cc-plugin-agents-md@builtin`; `ctxreach verify` accepts the same two.
 */
export const AGENTS_MD_PLUGINS = ["agents-md@builtin", "cc-plugin-agents-md@builtin"];
export const CONTROL_RULE = ".claude/rules/ctxreach-cell-control.md";
export const DECOY = "ctxreach-cell-decoy.md";
const INSTRUCTION =
  /(^|\/)(AGENTS\.md|AGENTS\.override\.md|CLAUDE\.md|CLAUDE\.local\.md)$|(^|\/)\.claude\/rules\/.+\.md$/;

export function newToken() {
  return "CTXR-" + randomBytes(4).toString("hex");
}

export function loadCells(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function walk(dir, rel = "") {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

/** Substitute {home}, {outside} and friends in a path or argument. */
export function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/**
 * Lay out one trial under `trialDir`: a staging copy of the fixture with the
 * harness's tokens, the arm's layout files (ancestors, a home file), the
 * control rule and the decoy. Returns what the command and the scorer need.
 */
export function layoutTrial({ cells, cell, arm, trialDir, fixturesDir, vars }) {
  const fixture = arm.fixture ?? cell.fixture;
  const src = path.join(fixturesDir, fixture, "repo");
  const repo = path.join(trialDir, "stage", "repo");
  cpSync(src, repo, { recursive: true });
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const tokens = {}; // observable key ("AGENTS.md", "@ancestor") -> [tokens]
  const noTokens = new Set(cell.noTokens ?? []);
  for (const rel of walk(repo).filter((r) => INSTRUCTION.test(r) && !r.startsWith(".git/"))) {
    if (noTokens.has(rel)) continue;
    const file = path.join(repo, ...rel.split("/"));
    const head = newToken();
    const tail = newToken();
    const body = readFileSync(file, "utf8");
    writeFileSync(
      file,
      `ctxreach cell token ${head}\n\n${body}${body.endsWith("\n") ? "" : "\n"}\nctxreach cell token ${tail}\n`,
    );
    tokens[rel] = [head, tail];
  }
  const launchDir = path.join(repo, ...arm.launch.split("/").filter((s) => s !== "."));
  const control = newToken();
  const controlFile = path.join(launchDir, ...CONTROL_RULE.split("/"));
  mkdirSync(path.dirname(controlFile), { recursive: true });
  writeFileSync(
    controlFile,
    `# Positive control\n\nThis rule has no paths, so it loads at launch. Control token ${control}\n`,
  );
  const decoy = newToken();
  writeFileSync(path.join(launchDir, DECOY), `# Not an instruction file\n\nDecoy token ${decoy}\n`);

  const v = { ...vars, arm: path.join(trialDir) };
  const files = [];
  for (const f of arm.files ?? []) {
    const p = f.path.startsWith("{") ? path.resolve(fill(f.path, v)) : path.join(trialDir, f.path);
    const token = newToken();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, fill(f.text, { token }));
    tokens[`@${f.token}`] = [...(tokens[`@${f.token}`] ?? []), token];
    files.push(p);
  }
  const tmp = arm.tmp.startsWith("{") ? path.resolve(fill(arm.tmp, v)) : path.join(trialDir, arm.tmp);
  mkdirSync(tmp, { recursive: true });
  const env = { TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  for (const [k, val] of Object.entries(arm.env ?? {})) env[k] = fill(val, v);
  const save = path.join(trialDir, "save");
  return { repo, launchDir, tokens, control, decoy, files, tmp, env, save };
}

/** The instrument's argument list for one trial. */
export function instrumentArgs({ cells, cell, arm, trial, vars }) {
  const spec = cells.instruments[cell.instrument];
  const v = {
    ...vars,
    launch: trial.launchDir,
    repo: trial.repo,
    save: trial.save,
    mode: cell.mode ?? "recall",
    task: cell.task ?? "",
  };
  const args = spec.args.map((a) => fill(a, v));
  if (cell.homeArms && arm.env?.HOME && spec.homeArgs) args.push(...spec.homeArgs.map((a) => fill(a, v)));
  if (cell.mode === "task" && spec.taskArgs) args.push(...spec.taskArgs.map((a) => fill(a, v)));
  return args;
}

function jsonLines(file) {
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // not a JSON line
    }
  }
  return out;
}

function initOf(e) {
  return {
    plugins: (e.plugins ?? []).map((p) => (typeof p === "string" ? p : (p.source ?? p.name))),
    model: e.model,
    cwd: e.cwd,
    version: e.claude_code_version,
  };
}

/**
 * The instrument's copy of the repository, as its `manifest.json` records it
 * (`ctxreach verify` and `ctxreach probe` both write one): `repo`, the copy's
 * path as it appears in the trial files (a placeholder in a redacted
 * recording), and `launchDir`, relative to it. Undefined when there is none.
 */
function copyOf(saveDir) {
  const file = path.join(saveDir, "manifest.json");
  if (!existsSync(file)) return undefined;
  try {
    const m = JSON.parse(readFileSync(file, "utf8"));
    return typeof m.repo === "string" && m.repo ? { repo: m.repo, launchDir: m.launchDir } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the instrument observed, from its saved files:
 * - echo: the probe recording's trial transcripts (the model's own words);
 * - capture: every recorded POST to /v1/messages (what reached the endpoint),
 *   plus any stream-json init event saved beside it;
 * - both: the copy of the repository the session ran in (`manifest.json`).
 */
export function readObservation(instrument, saveDir) {
  const tokens = new Set();
  let init;
  if (!existsSync(saveDir)) return { tokens, init, files: 0 };
  const copy = copyOf(saveDir);
  const files = walk(saveDir).filter((f) => f.endsWith(".jsonl"));
  for (const rel of files) {
    for (const e of jsonLines(path.join(saveDir, ...rel.split("/")))) {
      if (e.type === "system" && e.subtype === "init" && !init) init = initOf(e);
      if (instrument === "echo") {
        const texts = [];
        if (e.type === "assistant")
          for (const c of e.message?.content ?? []) if (typeof c.text === "string") texts.push(c.text);
        if (e.type === "result" && typeof e.result === "string") texts.push(e.result);
        for (const t of texts) for (const m of t.matchAll(TOKEN)) tokens.add(m[0]);
      } else if (e.method === "POST" && String(e.url ?? "").includes("/v1/messages")) {
        for (const m of String(e.body ?? "").matchAll(TOKEN)) tokens.add(m[0]);
      }
    }
  }
  return { tokens, init, files: files.length, ...(copy ? { copy } : {}) };
}

/**
 * K10's cwd assert (study/PREREG.md section 8): the session ran in the
 * trial's launch directory, in the instrument's copy of the repository. The
 * instrument copies the staging repository and launches from the same
 * relative directory, so the expected cwd is the copy's path (from its
 * manifest.json) joined with the launch directory relative to the staging
 * repository; paths are compared as the copy's platform spells them (Windows:
 * either separator, any case). Returns the reason the trial is void, or
 * undefined.
 */
function cwdProblem(trial, obs) {
  const cwd = obs.init.cwd;
  if (typeof cwd !== "string" || !cwd) return "system/init gives no cwd";
  const copy = obs.copy?.repo;
  if (typeof copy !== "string" || !copy)
    return "the instrument recorded no copy of the repository (manifest.json repo), so the session's cwd cannot be checked";
  const rel = path.relative(trial.repo, trial.launchDir).split(path.sep).filter(Boolean);
  const win = /^[A-Za-z]:[\\/]|^\\\\/.test(copy);
  const api = win ? path.win32 : path.posix;
  const expected = api.join(copy, ...rel);
  const key = (p) => {
    const r = api.normalize(p).replace(/[\\/]+$/, "");
    return win ? r.toLowerCase() : r;
  };
  if (key(cwd) !== key(expected))
    return `the session ran in ${cwd}, not the launch directory ${expected} (system/init.cwd)`;
  return undefined;
}

/**
 * Score one trial against the harness's tokens. A trial is void when the
 * control is missing, the decoy is seen, or a session assert of K10 fails:
 * `agents-md@builtin` in system/init.plugins, the pinned model (live runs),
 * and the session's cwd at the launch directory. A trial whose instrument
 * saved no system/init event is void too: none of those asserts can be made.
 */
export function scoreTrial({ cell, trial, obs, pin }) {
  const reasons = [];
  if (obs.files === 0) reasons.push("the instrument saved no observation");
  if (!obs.tokens.has(trial.control)) reasons.push("positive control not seen");
  if (obs.tokens.has(trial.decoy)) reasons.push("decoy seen");
  if (!obs.init) reasons.push("no system/init event: the session asserts (K10) cannot be made");
  else {
    if (!obs.init.plugins.some((p) => AGENTS_MD_PLUGINS.includes(p)))
      reasons.push("agents-md@builtin not in system/init.plugins");
    if (pin && obs.init.model !== pin) reasons.push(`model ${obs.init.model}, not the pinned ${pin}`);
    const where = cwdProblem(trial, obs);
    if (where) reasons.push(where);
  }
  const seen = {};
  const partial = {};
  for (const [key, refs] of Object.entries(cell.observe)) {
    const toks = refs.flatMap((r) => trial.tokens[r] ?? []);
    const hits = toks.filter((t) => obs.tokens.has(t)).length;
    seen[key] = hits > 0;
    partial[key] = hits > 0 && hits < toks.length;
  }
  const known = new Set([trial.control, trial.decoy, ...Object.values(trial.tokens).flat()]);
  const unknown = [...obs.tokens].filter((t) => !known.has(t));
  return { status: reasons.length ? "void" : "usable", reasons, seen, partial, unknownTokens: unknown };
}

/** k/n per arm and observable over usable trials, with Wilson intervals. */
export function summariseCell(cell, trials) {
  const arms = {};
  for (const arm of cell.arms) {
    const own = trials.filter((t) => t.arm === arm.id && !t.warmup);
    const usable = own.filter((t) => t.status === "usable");
    const obs = {};
    for (const key of Object.keys(cell.observe)) {
      const k = usable.filter((t) => t.seen[key]).length;
      const w = wilson(k, usable.length);
      obs[key] = {
        k,
        n: usable.length,
        lo: w.lo ?? null,
        hi: w.hi ?? null,
        partial: usable.filter((t) => t.partial[key]).length,
      };
    }
    arms[arm.id] = {
      planned: arm.trials,
      ran: own.length,
      usable: usable.length,
      void: own.length - usable.length,
      observe: obs,
    };
  }
  return arms;
}

/** Minimum usable trials for an arm to be decided: 80% of those planned. */
export function minUsable(planned) {
  return Math.ceil(planned * 0.8);
}

function holds([arm, key, op, x], arms) {
  const a = arms[arm]?.observe[key];
  if (!a || a.n === 0) return false;
  const p = a.k / a.n;
  return op === "<=" ? p <= x + 1e-12 : p >= x - 1e-12;
}

/** The cell's verdict under its pre-registered rule. */
export function decideCell(cell, arms, { precondition } = {}) {
  if (precondition === false) return "precondition-failed";
  const ruled = [...(cell.confirm ?? []), ...(cell.refute ?? [])].map((c) => c[0]);
  for (const id of new Set(ruled)) {
    const a = arms[id];
    if (!a || a.usable < minUsable(a.planned)) return "insufficient";
  }
  if (!cell.confirm?.length) return "reported";
  if ((cell.refute ?? []).length && cell.refute.every((c) => holds(c, arms))) return "refuted";
  if (cell.confirm.every((c) => holds(c, arms))) return "confirmed";
  return cell.refute?.length ? "inconclusive" : "not-confirmed";
}

/** Instruction files anywhere above `dir` (by name; nothing is read). */
export function instructionFilesAbove(dir) {
  const names = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md", ".claude/AGENTS.md"];
  const found = [];
  let cursor = path.resolve(dir);
  for (;;) {
    for (const n of names) if (existsSync(path.join(cursor, ...n.split("/")))) found.push(path.join(cursor, n));
    const rules = path.join(cursor, ".claude", "rules");
    if (existsSync(rules) && statSync(rules).isDirectory()) found.push(rules);
    const up = path.dirname(cursor);
    if (up === cursor) break;
    cursor = up;
  }
  return found;
}
