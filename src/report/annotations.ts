import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentId } from "../agents/types.js";
import { discoverSurfaces } from "../discover/surfaces.js";
import { map } from "../map/map.js";
import { isInside } from "../util/fs.js";
import { toJson, type MapJson } from "./json.js";
import { renderSummary } from "./markdown.js";

/**
 * GitHub workflow annotations for `map`'s warnings, and the GitHub Action
 * that prints them (`action.yml`, bundled into `action/dist/ctxreach.cjs`).
 *
 * Annotations are built from `map --json` output (schema `ctxreach.map/v1`),
 * one launch directory at a time, then merged: the same warning seen from
 * several launch directories becomes one annotation that names them all.
 */

export interface Annotation {
  /** Path relative to the scanned directory, forward slashes; absent for a warning about no one file. */
  file?: string;
  /** 1-based line, when the warning is about one line. */
  line?: number;
  /** Finding codes behind this annotation. */
  codes: string[];
  title: string;
  message: string;
  /** Launch directories (relative to the scanned directory) the warning holds from. */
  from: string[];
  /**
   * The files a warning on another file is about (the AGENTS.md files a
   * CLAUDE.md-family file switches off). Merging unions them and rebuilds the
   * message.
   */
  subjects?: string[];
}

type Finding = MapJson["findings"][number];

const CLAUDE_FAMILY = new Set(["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]);

/** A path in `--json` output is inside the scanned directory when it is not absolute. */
export function inRepo(p: string): boolean {
  return !(p.startsWith("/") || /^[A-Za-z]:/.test(p));
}

/** The directory a file belongs to: for `x/.claude/CLAUDE.md`, `x`. `.` for the scanned directory. */
function ownerDir(rel: string): string {
  const parts = rel.split("/");
  parts.pop();
  if (parts[parts.length - 1] === ".claude") parts.pop();
  return parts.length ? parts.join("/") : ".";
}

/** The files that switch `file` (an AGENTS.md that does not reach Claude Code) off. */
function switchersOf(json: MapJson, file: string): string[] {
  const claude = json.claude;
  if (!claude) return [];
  if (!claude.agentsMd.read) return claude.shadowers;
  // AGENTS.md is on for the launch directory, so a file is off because of a
  // CLAUDE.md-family file in its own directory.
  const dir = ownerDir(file);
  return claude.files.filter((f) => CLAUDE_FAMILY.has(f.kind) && ownerDir(f.path) === dir).map((f) => f.path);
}

/** One launch directory's warnings as annotations (before merging across launch directories). */
export function annotationsFor(json: MapJson): Annotation[] {
  const out: Annotation[] = [];
  const from = [json.launchDir];
  const warnings = json.findings.filter((f) => f.severity === "warn");
  const byPath = (code: string, p: string | undefined) => warnings.find((f) => f.code === code && f.path === p);

  const shadowed = new Map<string, string[]>();
  for (const f of warnings) {
    const onFile = f.path !== undefined && inRepo(f.path) ? f.path : undefined;
    switch (f.code) {
      case "codex.cut": {
        const entry = json.codex?.chain.find((e) => e.path === f.path);
        const limit = json.codex?.budget.limit;
        if (!entry?.cut || limit === undefined) break;
        const chainByte = limit - entry.budgetBefore + entry.cut.at;
        const mid = byPath("codex.mid-codepoint", f.path);
        const lost = entry.cut.lostSections.length
          ? ` Sections after it never reach Codex: ${entry.cut.lostSections
              .slice(0, 5)
              .map((s) => `"${s}"`)
              .join(", ")}${entry.cut.lostSections.length > 5 ? ` and ${entry.cut.lostSections.length - 5} more` : ""}.`
          : "";
        out.push({
          ...(onFile !== undefined ? { file: onFile } : {}),
          line: entry.cut.line,
          codes: mid ? ["codex.cut", "codex.mid-codepoint"] : ["codex.cut"],
          title: "Codex stops reading here",
          message:
            `Codex stops reading here (byte ${chainByte} of the chain): project_doc_max_bytes is ${limit}, ` +
            `and this file is cut at its byte ${entry.cut.at} of ${entry.bytes}.${lost}` +
            (mid ? " The cut splits a multi-byte character, so Codex sees U+FFFD in its place." : ""),
          from,
        });
        break;
      }
      case "codex.mid-codepoint":
        // Folded into the codex.cut annotation on the same line.
        if (byPath("codex.cut", f.path)) break;
        out.push(generic(f, onFile, from));
        break;
      case "codex.no-budget":
        out.push({
          ...(onFile !== undefined ? { file: onFile } : {}),
          line: 1,
          codes: [f.code],
          title: "Codex never reads this file",
          message: `Codex never reads this file: files earlier in the chain use the whole ${json.codex?.budget.limit ?? "?"}-byte budget.`,
          from,
        });
        break;
      case "codex.nested":
        out.push({
          ...(onFile !== undefined ? { file: onFile } : {}),
          codes: [f.code],
          title: "Codex does not preload this file",
          message:
            "Codex does not preload this file: it is below the launch directory, so it is read only if the model decides to open it.",
          from,
        });
        break;
      case "claude.agents-shadowed": {
        const switchers = f.path !== undefined ? switchersOf(json, f.path).filter(inRepo) : [];
        if (switchers.length === 0 || f.path === undefined) {
          out.push(generic(f, onFile, from));
          break;
        }
        for (const s of switchers) shadowed.set(s, [...(shadowed.get(s) ?? []), f.path]);
        break;
      }
      default:
        out.push(generic(f, onFile, from));
    }
  }
  for (const [switcher, files] of shadowed) {
    out.push({
      file: switcher,
      codes: ["claude.agents-shadowed"],
      title: "Switches AGENTS.md off for Claude Code",
      message: switchesOffMessage(files),
      from,
      subjects: files,
    });
  }
  return out;
}

function switchesOffMessage(files: readonly string[]): string {
  const one = files.length === 1;
  return (
    `This file switches AGENTS.md off for Claude Code: ${files.join(", ")} ${one ? "does" : "do"} not reach it. ` +
    `Import ${one ? "it" : "them"} with @AGENTS.md, or set Project instructions to claude-md-and-agents-md.`
  );
}

function generic(f: Finding, file: string | undefined, from: string[]): Annotation {
  return {
    ...(file !== undefined ? { file } : {}),
    codes: [f.code],
    title: f.agent === "codex" ? "Codex" : "Claude Code",
    message: f.message,
    from,
  };
}

/**
 * Merge the annotations of several launch directories: the same warning on
 * the same line becomes one annotation naming every launch directory it
 * holds from. The order is the order first seen.
 */
export function mergeAnnotations(perLaunch: readonly Annotation[][]): Annotation[] {
  const merged = new Map<string, Annotation>();
  for (const list of perLaunch) {
    for (const a of list) {
      // A warning about other files merges on its file alone; any other on its whole text.
      const key = JSON.stringify([a.file ?? null, a.line ?? null, a.codes, a.subjects ? a.title : a.message]);
      const seen = merged.get(key);
      if (!seen) {
        merged.set(key, { ...a, from: [...a.from], ...(a.subjects ? { subjects: [...a.subjects] } : {}) });
        continue;
      }
      for (const d of a.from) if (!seen.from.includes(d)) seen.from.push(d);
      if (seen.subjects && a.subjects) {
        for (const s of a.subjects) if (!seen.subjects.includes(s)) seen.subjects.push(s);
        seen.message = switchesOffMessage(seen.subjects);
      }
    }
  }
  return [...merged.values()];
}

/** Escape workflow-command data (the message). */
export function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** Escape a workflow-command property value (file, title). */
export function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** The launch directories as the message shows them. */
function fromWords(from: readonly string[]): string {
  return from.map((d) => (d === "." ? "the root" : d)).join(", ");
}

/**
 * The `::warning` workflow command for one annotation. `prefix` is prepended
 * to the file path, so it is relative to the workspace when the scanned
 * directory is inside it.
 */
export function workflowCommand(a: Annotation, prefix = ""): string {
  const props: string[] = [];
  if (a.file !== undefined) props.push(`file=${escapeProperty(prefix + a.file)}`);
  if (a.line !== undefined) props.push(`line=${a.line}`);
  props.push(`title=${escapeProperty(`ctxreach: ${a.title} (${a.codes.join(", ")})`)}`);
  const message = `${a.message} Launched from: ${fromWords(a.from)}.`;
  return `::warning ${props.join(",")}::${escapeData(message)}`;
}

// ---------------------------------------------------------------------------
// The Action.

/** Parsed Action inputs. */
export interface ActionInputs {
  /** The directory to scan (the repository root), absolute. */
  root: string;
  /** `auto`, or launch directories relative to `root`. */
  launchDirs: "auto" | string[];
  agents: AgentId[];
  /** `none`, `warn`, or a list of finding codes that fail the step. */
  failOn: "none" | "warn" | string[];
}

export class InputError extends Error {}

const AGENTS: AgentId[] = ["codex", "claude"];

function list(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Read the Action's inputs from the environment variables `action.yml` sets.
 * `knownCodes` are the finding codes `fail-on` may name: a code that is not
 * one of them (a typo such as `codex.cuts`) would never match, so the step
 * would pass for ever; it is an input error instead.
 */
export function readInputs(env: NodeJS.ProcessEnv, cwd: string, knownCodes: readonly string[]): ActionInputs {
  if (knownCodes.length === 0) throw new Error("readInputs: no known finding codes to check fail-on against");
  const given = (env.INPUT_PATH ?? "").trim() || ".";
  const root = path.resolve(cwd, given);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new InputError(`path ${given} is not a directory (resolved to ${root})`);

  const dirsText = (env.INPUT_LAUNCH_DIRS ?? "").trim() || "auto";
  const launchDirs = dirsText === "auto" ? "auto" : list(dirsText);

  const agentsText = (env.INPUT_AGENTS ?? "").trim() || "all";
  const agents = agentsText === "all" ? AGENTS : (list(agentsText) as AgentId[]);
  for (const a of agents)
    if (!AGENTS.includes(a)) throw new InputError(`agents: unknown agent "${a}" (known: ${AGENTS.join(", ")}, all)`);
  if (agents.length === 0) throw new InputError("agents: name at least one agent");

  const failText = (env.INPUT_FAIL_ON ?? "").trim() || "none";
  let failOn: ActionInputs["failOn"];
  if (failText === "none" || failText === "warn") failOn = failText;
  else {
    failOn = list(failText);
    for (const c of failOn) {
      if (!/^(codex|claude)\.[a-z0-9-]+$/.test(c))
        throw new InputError(`fail-on: "${c}" is not none, warn, or a finding code such as codex.cut`);
      if (!knownCodes.includes(c))
        throw new InputError(
          `fail-on: "${c}" is not a finding code ctxreach reports (known: ${[...knownCodes].sort().join(", ")})`,
        );
    }
  }
  return { root, launchDirs, agents, failOn };
}

/** Forward-slash path of `p` relative to `root`; `.` for the root itself. */
function relTo(root: string, p: string): string {
  const r = path.relative(root, p).split(path.sep).join("/");
  return r === "" ? "." : r;
}

/**
 * The launch directories to model. `auto`: the scanned directory and every
 * directory that holds an instruction file (for files under `.claude/`, the
 * directory that holds `.claude`).
 */
export function launchDirsFor(root: string, launchDirs: ActionInputs["launchDirs"]): string[] {
  if (launchDirs !== "auto") {
    return launchDirs.map((d) => {
      const abs = path.resolve(root, d);
      if (!isInside(abs, root)) throw new InputError(`launch-dirs: ${d} is outside ${root}`);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new InputError(`launch-dirs: ${d} is not a directory`);
      return abs;
    });
  }
  const dirs = new Map<string, string>([[relTo(root, root), root]]);
  for (const s of discoverSurfaces(root)) dirs.set(relTo(root, s.dir), s.dir);
  return [...dirs.entries()]
    .sort(([a], [b]) => (a === "." ? -1 : b === "." ? 1 : a < b ? -1 : a > b ? 1 : 0))
    .map(([, d]) => d);
}

export interface ActionIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  version: string;
  /** The finding codes `fail-on` may name: the Findings table of docs/rules.md, which the bundle carries. */
  knownCodes: readonly string[];
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface ActionResult {
  status: number;
  runs: MapJson[];
  annotations: Annotation[];
}

/** Would these findings fail the step under `fail-on`? */
export function fails(runs: readonly MapJson[], failOn: ActionInputs["failOn"]): boolean {
  if (failOn === "none") return false;
  const findings = runs.flatMap((r) => r.findings);
  if (failOn === "warn") return findings.some((f) => f.severity === "warn");
  return findings.some((f) => failOn.includes(f.code));
}

/**
 * Run the Action: `map` from each launch directory, on a machine with no
 * personal Codex or Claude Code configuration and nothing above the scanned
 * directory; print one `::warning` per merged annotation; append the job
 * summary; set the step outputs. Returns the exit status: 0, 1 when
 * `fail-on` is met, 2 for an input error.
 */
export function runAction(io: ActionIo): ActionResult {
  let inputs: ActionInputs;
  let dirs: string[];
  try {
    inputs = readInputs(io.env, io.cwd, io.knownCodes);
    dirs = launchDirsFor(inputs.root, inputs.launchDirs);
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    io.stdout(`::error title=ctxreach::${escapeData(err.message)}\n`);
    return { status: 2, runs: [], annotations: [] };
  }

  const temp = io.env.RUNNER_TEMP && io.env.RUNNER_TEMP.trim() ? io.env.RUNNER_TEMP : os.tmpdir();
  mkdirSync(temp, { recursive: true });
  // An empty home: no ~/.codex, no ~/.claude, so the prediction is the same on every runner.
  const home = mkdtempSync(path.join(temp, "ctxreach-home-"));
  let runs: MapJson[];
  try {
    runs = dirs.map((launchDir) =>
      toJson(
        map({
          launchDir,
          repoRoot: inputs.root,
          agents: inputs.agents,
          codex: { home: path.join(home, ".codex") },
          claude: { home: path.join(home, ".claude"), homeDir: home, ceiling: inputs.root },
        }),
        io.version,
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const annotations = mergeAnnotations(runs.map(annotationsFor));
  const workspace = io.env.GITHUB_WORKSPACE?.trim() ? path.resolve(io.env.GITHUB_WORKSPACE) : undefined;
  const prefix =
    workspace !== undefined && isInside(inputs.root, workspace) && relTo(workspace, inputs.root) !== "."
      ? relTo(workspace, inputs.root) + "/"
      : "";
  for (const a of annotations) io.stdout(workflowCommand(a, prefix) + "\n");

  const scanned =
    workspace !== undefined && isInside(inputs.root, workspace) ? relTo(workspace, inputs.root) : inputs.root;
  const summary = renderSummary(runs, { version: io.version, scanned, annotations: annotations.length });
  if (io.env.GITHUB_STEP_SUMMARY?.trim()) appendFileSync(io.env.GITHUB_STEP_SUMMARY, summary + "\n");
  else io.stdout(summary + "\n");

  const jsonFile = path.join(temp, `ctxreach-map-${process.pid}-${Date.now()}.json`);
  writeFileSync(jsonFile, JSON.stringify({ schema: "ctxreach.action/v1", runs }, null, 2) + "\n");
  const warnings = runs.reduce((n, r) => n + r.findings.filter((f) => f.severity === "warn").length, 0);
  const outputs = [
    `annotations=${annotations.length}`,
    `warnings=${warnings}`,
    `launch-dirs=${runs.length}`,
    `json=${jsonFile}`,
  ];
  if (io.env.GITHUB_OUTPUT?.trim()) appendFileSync(io.env.GITHUB_OUTPUT, outputs.join("\n") + "\n");
  else io.stderr(outputs.map((o) => `ctxreach: ${o}`).join("\n") + "\n");

  const status = fails(runs, inputs.failOn) ? 1 : 0;
  if (status === 1)
    io.stdout(
      `::error title=ctxreach::${escapeData(`fail-on is ${Array.isArray(inputs.failOn) ? inputs.failOn.join(",") : inputs.failOn}, and map found a matching finding.`)}\n`,
    );
  return { status, runs, annotations };
}
