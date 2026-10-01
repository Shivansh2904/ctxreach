/**
 * `ctxreach verify`: plant tokens in a temporary copy of a repository, ask
 * an agent's own machinery what it delivers from there (a Codex render, or
 * a Claude Code capture), record the answer, and score it against `map`.
 *
 * The copy is the probe's sandbox, made and checked through its exported
 * functions only (`createSandbox`, `sandboxOf`, `assertReadyToRun`,
 * `removeSandbox`). The run is recorded (manifest plus the agent's raw
 * output per trial) and then scored from the recording, the same way
 * `--replay` scores it, so a live result is exactly what its replay reports.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findClaude } from "../agents/claude/adapter.js";
import { redactClaudeTranscript, redactString } from "../agents/claude/events.js";
import { CLAUDE_DEFAULT_MODE, modeInSettings, type ClaudeMode } from "../agents/claude/settings.js";
import { defaultCodexHome, type TrustLevel } from "../agents/codex/config.js";
import { map, type MapOptions } from "../map/map.js";
import { plantDecoy, plantFile, TokenSource, type RandomSource } from "../probe/canary.js";
import { placeholders } from "../probe/probe.js";
import { assertReadyToRun, createSandbox, removeSandbox, sandboxOf, type Sandbox } from "../probe/sandbox.js";
import { SafetyError, type Canary, type Redaction } from "../probe/types.js";
import { displayPath, isInside, isInsideReal, nearestExisting } from "../util/fs.js";
import { decodeLossy } from "../util/text.js";
import { startCapture, type CaptureRecord } from "./capture.js";
import {
  assertCaptureVersion,
  captureArgs,
  captureEnv,
  claudeCaptureVersion,
  hasAgentsMdPlugin,
  initInfo,
  parseCaptureBody,
  reduceCaptureBody,
  runClaudeCapture,
  type CaptureRunOutcome,
} from "./claude-capture.js";
import { assertThrowawayHome, prepareProjectConfig, seedCodexHome } from "./codex-home.js";
import {
  blockSegments,
  codexVersion,
  parseRender,
  reduceRender,
  renderCodex,
  renderEnv,
  resolveCodexBin,
  type CodexBin,
  type Renderer,
} from "./codex-render.js";
import {
  readVerifyRecording,
  VERIFY_SCHEMA,
  writeVerifyManifest,
  type VerifyManifest,
  type VerifyRecording,
  type VerifyTrialFiles,
} from "./recording.js";
import { scoreTrials, type TrialCheck, type TrialEvidence, type VerifyResult } from "./score.js";
import {
  honestWording,
  OracleError,
  RenderShapeError,
  type ChainPiece,
  type DeliveredFile,
  type OracleAgent,
  type Segment,
} from "./types.js";

export const DEFAULT_TRIALS = 2;

export interface VerifyOptions {
  agent: OracleAgent;
  repoRoot: string;
  launchDir: string;
  trials: number;
  timeoutMs: number;
  /** Where to record the run; created if missing, must be empty, must not be inside `repoRoot`. */
  saveDir: string;
  ctxreachVersion: string;
  tmpRoot?: string;
  /**
   * Plant a head and a tail token in every instruction file of the copy (default). With `false` only the
   * decoy and the prompt token are used and the copy's files stay as they are: the byte comparison then
   * measures the repository itself (a whitespace-only override stays empty, a cut lands on the byte it was
   * built for). Codex only; a Claude Code run always plants.
   */
  plant?: boolean;
  codex?: {
    bin?: string;
    /** The user's Codex home to seed the throwaway from (default `$CODEX_HOME`, then `~/.codex`). */
    userHome?: string;
    /** Seed nothing. */
    clean?: boolean;
    /** Given to `map` only: the planted-fault pass. */
    mapMaxBytes?: number;
    trust?: TrustLevel;
    renderer?: Renderer;
    /** Stamp this version instead of running `codex --version` (a batch that checked it once). */
    version?: string;
  };
  claude?: {
    bin?: string;
    prefixArgs?: string[];
    /** Required: the `--model` pin, asserted from `system/init`. */
    model?: string;
    /** A scratch home directory (`~` follows it; `CLAUDE_CONFIG_DIR` is unset). Never the real one. */
    home?: string;
    /** A `--settings` file to pass through (for example a hook written by the probe controls, or a Project instructions mode). */
    settingsFile?: string;
    /** Given to `map` only: the planted-fault pass. */
    mapMode?: ClaudeMode;
  };
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  random?: RandomSource;
  progress?: (line: string) => void;
  host?: Pick<NodeJS.Process, "once" | "removeListener" | "exit">;
}

function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/") || ".";
}

function redactValue(v: unknown, redactions: readonly Redaction[]): unknown {
  if (typeof v === "string") return redactString(v, redactions);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, redactions));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x, redactions)]));
  return v;
}

/**
 * A render as saved: every string redacted, then reduced to what ctxreach scores (`reduceRender`: the AGENTS
 * block and the prompt whole, Codex's own items as digests), re-serialised the same way each time. Output that
 * is not JSON is not saved, since it could be Codex's prompt in another form: a line giving its length and
 * SHA-256 stands in for it, and is no more JSON than the output was, so the run scores the same.
 */
export function renderAsSaved(raw: string, redactions: readonly Redaction[]): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    if (raw.trim() === "") return raw;
    const text = redactString(raw, redactions);
    const hash = createHash("sha256").update(text, "utf8").digest("hex");
    return `ctxreach: codex printed ${Buffer.byteLength(text, "utf8")} bytes that are not JSON (sha256 ${hash}); not saved, since they may hold Codex's own prompt text.\n`;
  }
  return JSON.stringify(reduceRender(redactValue(value, redactions)), null, 2) + "\n";
}

const REMOVED = "(removed by ctxreach)";

/** Claude Code also names a path in slug form, as its per-project directory (`C--Users-name-...`). */
const slug = (s: string) => s.replace(/[^A-Za-z0-9]/g, "-");

/** Every redaction applied as a path (either slash, any case on Windows) and again in slug form. */
export function redactWithSlugs(text: string, redactions: readonly Redaction[]): string {
  let out = redactString(text, redactions);
  for (const r of redactions) {
    if (!r.from) continue;
    out = out.split(slug(r.from)).join(slug(r.to));
    // Codex prints a path debug-escaped in its warnings (`C:\\Users\\...`), which the path form does not match.
    const doubled = (p: string) => p.replace(/\\/g, "\\\\");
    out = out.split(doubled(r.from)).join(doubled(r.to));
  }
  return out;
}

/** A capture record as saved: paths redacted, the session id and the request's account metadata removed, the git user's name removed. */
export function redactCaptureRecord(record: CaptureRecord, redactions: readonly Redaction[]): CaptureRecord {
  const headers = { ...record.headers };
  if (headers["x-claude-code-session-id"] !== undefined) headers["x-claude-code-session-id"] = REMOVED;
  let body: string;
  try {
    const value = JSON.parse(record.body) as Record<string, unknown>;
    if (value.metadata !== undefined) value.metadata = REMOVED;
    body = JSON.stringify(redactValue(value, redactions));
  } catch {
    body = redactString(record.body, redactions);
  }
  body = redactWithSlugs(body, redactions).replace(/Git user: [^\n\\"]*/g, `Git user: ${REMOVED}`);
  return { ...record, headers, body };
}

/**
 * A capture record as saved: redacted (`redactCaptureRecord`), then its body reduced to what ctxreach scores
 * (`reduceCaptureBody`: ctxreach's prompt and the instruction files whole, Claude Code's own prompt text as
 * digests), so a digest never hashes a real path and Claude Code's prompt is never written.
 */
export function captureRecordAsSaved(
  record: CaptureRecord,
  redactions: readonly Redaction[],
  prompt: string,
): CaptureRecord {
  const redacted = redactCaptureRecord(record, redactions);
  return { ...redacted, body: reduceCaptureBody(redacted.body, prompt) };
}

/** What the agent set-up found, before anything was planted. */
interface Preflight {
  cliVersion: string;
  mapOptions: Pick<MapOptions, "codex" | "claude">;
  codex?: { manifest: NonNullable<VerifyManifest["codex"]>; env: NodeJS.ProcessEnv; bin: CodexBin };
  claude?: {
    manifest: NonNullable<VerifyManifest["claude"]>;
    bin: string;
    prefixArgs: string[];
    /** One of the two is set: the fresh config directory, or the scratch home. */
    configDir?: string;
    home?: string;
    args: string[];
  };
}

async function preflight(
  options: VerifyOptions,
  box: Sandbox,
  launchAbs: string,
  repoRoot: string,
  launchDir: string,
  baseEnv: NodeJS.ProcessEnv,
  redact: (p: string) => string,
): Promise<Preflight> {
  if (options.agent === "codex") {
    const bin = resolveCodexBin(options.codex?.bin, baseEnv);
    if (!bin)
      throw new OracleError(
        "could not find the codex executable on PATH; pass --codex-bin (or set CTXREACH_CODEX_BIN)",
      );
    const codexHome = path.join(box.base, "codex-home");
    assertThrowawayHome(codexHome, box.base);
    const userHome = options.codex?.userHome ?? defaultCodexHome();
    const seeded = seedCodexHome(codexHome, {
      ...(options.codex?.clean ? {} : { from: userHome }),
      sourceRoot: repoRoot,
      sourceLaunch: launchDir,
      copyRoot: box.repo,
      copyLaunch: launchAbs,
      ...(options.codex?.trust !== undefined ? { trustOverride: options.codex.trust } : {}),
    });
    const env = renderEnv(baseEnv, codexHome);
    const cliVersion = options.codex?.version ?? codexVersion(bin, env);
    // The copy is checked as the probe checks it; then the project config layers are written back.
    assertReadyToRun(sandboxOf(launchAbs), box.nonce, launchAbs);
    const projectConfigs = prepareProjectConfig(box.repo, repoRoot, launchDir, userHome);
    const plain = seeded.trustFrom === "override" || seeded.trustFrom === "not set";
    return {
      cliVersion,
      mapOptions: {
        codex: {
          home: codexHome,
          ...(options.codex?.mapMaxBytes !== undefined ? { maxBytes: options.codex.mapMaxBytes } : {}),
          ...(options.codex?.trust !== undefined ? { trust: options.codex.trust } : {}),
        },
      },
      codex: {
        env,
        bin,
        manifest: {
          codexHome: redact(codexHome),
          seeded: {
            ...(seeded.from !== undefined ? { from: redact(seeded.from) } : {}),
            keys: seeded.keys,
            globalFiles: seeded.globalFiles,
            trust: seeded.trust,
            trustFrom: plain ? seeded.trustFrom : redact(seeded.trustFrom),
          },
          projectConfigs,
          overrides: [],
          chain: [],
          ...(options.codex?.mapMaxBytes !== undefined ? { mapMaxBytes: options.codex.mapMaxBytes } : {}),
        },
      },
    };
  }

  const claude = options.claude ?? {};
  const bin = claude.bin ?? findClaude(baseEnv);
  if (!bin) throw new OracleError("could not find the claude executable on PATH; pass --claude-bin");
  if (!claude.model)
    throw new OracleError("verify --agent claude needs --model <pin>: the model is asserted from system/init");
  let home: string | undefined;
  let configDir: string | undefined;
  if (claude.home !== undefined) {
    home = path.resolve(claude.home);
    if (!existsSync(home)) throw new OracleError(`--home ${home} does not exist`);
    // The real home, or a directory that contains it, would make the session read (and write) the real ~/.claude.
    if (isInsideReal(os.homedir(), home))
      throw new OracleError(`refusing to use ${home} as a scratch home: it is the real home directory, or contains it`);
    if (existsSync(path.join(home, ".claude", ".credentials.json")))
      throw new OracleError(`refusing to use ${home} as a scratch home: its .claude holds a login`);
  } else {
    configDir = path.join(box.base, "claude-config");
    mkdirSync(configDir);
  }
  const prefixArgs = claude.prefixArgs ?? [];
  const where = home !== undefined ? { home } : { configDir: configDir ?? "" };
  // Never without the capture settings, even for --version: a dead loopback URL and the dummy key.
  const { env: versionEnv, removed } = captureEnv(baseEnv, { baseUrl: "http://127.0.0.1:9", ...where });
  const cliVersion = await claudeCaptureVersion(bin, prefixArgs, versionEnv);
  assertCaptureVersion(cliVersion);
  assertReadyToRun(sandboxOf(launchAbs), box.nonce, launchAbs);
  const settingsFile = claude.settingsFile !== undefined ? path.resolve(claude.settingsFile) : undefined;
  // The session's mode is the default unless the --settings file sets one; map models that, or the planted mode.
  const sessionMode: ClaudeMode =
    (settingsFile !== undefined ? modeInSettings(settingsFile) : undefined) ?? CLAUDE_DEFAULT_MODE;
  const mapMode = claude.mapMode ?? sessionMode;
  return {
    cliVersion,
    mapOptions: {
      claude: {
        home: home !== undefined ? path.join(home, ".claude") : (configDir ?? ""),
        homeDir: home ?? box.base,
        version: cliVersion,
        mode: mapMode,
      },
    },
    claude: {
      bin,
      prefixArgs,
      ...(configDir !== undefined ? { configDir } : {}),
      ...(home !== undefined ? { home } : {}),
      args: captureArgs(claude.model, settingsFile),
      manifest: {
        ...(configDir !== undefined ? { configDir: redact(configDir) } : {}),
        ...(home !== undefined ? { home: redact(home) } : {}),
        model: claude.model,
        ...(settingsFile !== undefined ? { settingsFile: redact(settingsFile) } : {}),
        removedEnv: removed,
        mode: sessionMode,
        ...(claude.mapMode !== undefined ? { mapMode: claude.mapMode } : {}),
      },
    },
  };
}

export async function runVerify(options: VerifyOptions): Promise<VerifyRecording> {
  const repoRoot = path.resolve(options.repoRoot);
  const launchDir = path.resolve(options.launchDir);
  const saveDir = path.resolve(options.saveDir);
  if (!isInside(launchDir, repoRoot) || !isInsideReal(launchDir, repoRoot))
    throw new SafetyError(`${launchDir} is outside the repository ${repoRoot}`);
  if (isInside(saveDir, repoRoot) || isInsideReal(nearestExisting(saveDir), repoRoot))
    throw new SafetyError(
      `refusing to record inside the repository being verified (${saveDir}); pass --save elsewhere`,
    );
  if (existsSync(saveDir) && readdirSync(saveDir).length > 0)
    throw new SafetyError(`${saveDir} is not empty; pass --save with a new or empty directory`);
  if (options.trials < 1) throw new OracleError("--trials must be at least 1");
  if (options.agent === "claude" && !options.claude?.model)
    throw new OracleError("verify --agent claude needs --model <pin>: the model is asserted from system/init");
  if (options.agent === "codex" && options.codex?.bin !== undefined && !existsSync(path.resolve(options.codex.bin)))
    throw new OracleError(`--codex-bin ${options.codex.bin} does not exist`);
  const say = options.progress ?? (() => undefined);
  const baseEnv = options.env ?? process.env;
  const launchRel = relPosix(repoRoot, launchDir);
  const ph = placeholders();

  let sandbox: Sandbox | undefined;
  const cleanUp = () => {
    if (sandbox) removeSandbox(sandbox);
    sandbox = undefined;
  };
  const host = options.host ?? process;
  const onSignal = (signal: NodeJS.Signals) => {
    cleanUp();
    host.exit(signal === "SIGINT" ? 130 : 143);
  };
  host.once("exit", cleanUp);
  host.once("SIGINT", onSignal);
  host.once("SIGTERM", onSignal);
  try {
    sandbox = createSandbox(repoRoot, {
      launchDir: launchRel,
      ...(options.tmpRoot !== undefined ? { tmpRoot: options.tmpRoot } : {}),
    });
    const box = sandbox;
    say(`copied ${box.files} files to a temporary directory`);
    const launchAbs = path.join(box.repo, ...(launchRel === "." ? [] : launchRel.split("/")));
    if (!existsSync(launchAbs)) throw new SafetyError(`${launchRel} was not copied (it is inside a skipped directory)`);
    const redactions: Redaction[] = [
      { from: box.base, to: ph.base },
      { from: os.homedir(), to: ph.home },
    ];
    const redact = (p: string) => redactString(p, redactions);
    const notes: string[] = [
      `The copy is ${isInsideReal(box.base, os.homedir()) ? "under" : "outside"} the home directory.`,
      `~/.claude/CLAUDE.md ${existsSync(path.join(os.homedir(), ".claude", "CLAUDE.md")) ? "exists" : "does not exist"} on this machine.`,
    ];

    // Agent set-up, before anything is planted: the throwaway home, the executable, its version.
    const pre = await preflight(options, box, launchAbs, repoRoot, launchDir, baseEnv, redact);
    if (pre.claude?.home !== undefined)
      notes.push(`The session's home directory is the scratch home ${redact(pre.claude.home)}, not the real one.`);

    const predict = () => map({ launchDir: launchAbs, repoRoot: box.repo, agents: [options.agent], ...pre.mapOptions });

    const tokens = new TokenSource(options.random);
    const controlToken = tokens.next();
    const prompt = `ctxreach verify ${controlToken}: list every token that starts with CTXR- in your instructions.`;
    const canaries: Canary[] = [];
    const unplanted: { file: string; why: string }[] = [];
    const planting = options.plant !== false;
    if (!planting && options.agent !== "codex")
      throw new OracleError("--no-plant is for --agent codex only: a capture is scored by its tokens");
    for (const row of planting ? predict().matrix : []) {
      if (!isInside(row.path, box.repo)) continue;
      const rel = relPosix(box.repo, row.path);
      const st = lstatSync(row.path, { throwIfNoEntry: false });
      if (!st?.isFile()) {
        unplanted.push({ file: rel, why: st ? "not a regular file" : "not in the copy" });
        continue;
      }
      canaries.push(...plantFile(box.repo, rel, tokens));
    }
    canaries.push(...plantDecoy(box.repo, launchRel, tokens));

    const after = predict();
    const predicted: VerifyManifest["predicted"] = [];
    const outside: VerifyManifest["outside"] = [];
    for (const row of after.matrix) {
      const cell = row.cells[options.agent];
      if (!cell) continue;
      if (isInside(row.path, box.repo)) {
        predicted.push({
          file: relPosix(box.repo, row.path),
          delivery: cell.delivery,
          why: cell.why,
          rule: cell.rule,
          ...(cell.cut ? { cutAt: cell.cut.at } : {}),
          ...(cell.needsApproval ? { needsApproval: true } : {}),
          ...(cell.notModelled ? { notModelled: true } : {}),
        });
      } else if (cell.delivery !== "not-loaded") {
        outside.push({ file: displayPath(redact(row.path), box.repo), delivery: cell.delivery, why: cell.why });
      }
    }

    // Codex: the text each chain file should contribute, in map's order.
    const chain: ChainPiece[] = [];
    if (after.codex) {
      const global = after.codex.global;
      if (global) {
        const bytes = readFileSync(global.path);
        chain.push({
          file: `$CODEX_HOME/${path.basename(global.path)}`,
          bytes: bytes.length,
          keptBytes: bytes.length,
          status: "global",
          text: decodeLossy(bytes),
          head: decodeLossy(bytes.subarray(0, 64)),
        });
      }
      for (const entry of after.codex.chain) {
        const bytes = readFileSync(entry.path);
        chain.push({
          file: relPosix(box.repo, entry.path),
          bytes: entry.bytes,
          keptBytes: entry.keptBytes,
          status: entry.status,
          text: entry.keptBytes > 0 ? decodeLossy(bytes.subarray(0, entry.keptBytes)) : "",
          head: decodeLossy(bytes.subarray(0, 64)),
        });
      }
    }

    mkdirSync(saveDir, { recursive: true });
    const manifest: VerifyManifest = {
      schema: VERIFY_SCHEMA,
      ctxreach: options.ctxreachVersion,
      agent: options.agent,
      instrument: options.agent === "codex" ? "render" : "capture",
      cliVersion: pre.cliVersion,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      repo: path.join(ph.base, "repo"),
      launchDir: launchRel,
      sourceName: path.basename(repoRoot),
      trialsPlanned: options.trials,
      args: pre.claude ? pre.claude.args : ["debug", "prompt-input"],
      prompt,
      controlToken,
      canaries,
      predicted,
      outside,
      unplanted,
      sandbox: { stripped: box.stripped, skipped: box.skipped, links: box.links },
      notes,
      planted: planting,
      ...(pre.codex ? { codex: { ...pre.codex.manifest, chain } } : {}),
      ...(pre.claude ? { claude: pre.claude.manifest } : {}),
      trials: [],
    };
    writeVerifyManifest(saveDir, manifest);

    for (let trial = 1; trial <= options.trials; trial++) {
      say(
        `trial ${trial} of ${options.trials}: ${options.agent === "codex" ? "rendering with codex debug prompt-input" : "capturing a Claude Code session"}`,
      );
      if (pre.codex) {
        const file = `trial-${trial}.render.json`;
        const out = renderCodex(
          { bin: pre.codex.bin, cwd: launchAbs, env: pre.codex.env, prompt, timeoutMs: options.timeoutMs },
          options.codex?.renderer,
        );
        writeFileSync(path.join(saveDir, file), renderAsSaved(out.stdout, redactions));
        if (manifest.codex) {
          manifest.codex.hooksFlag = out.hooksFlag;
          manifest.codex.overrides = out.overrides;
          manifest.args = ["debug", "prompt-input", ...out.overrides.flatMap((o) => ["-c", o])];
        }
        manifest.trials.push({
          trial,
          files: [file],
          exitCode: out.exitCode,
          timedOut: false,
          durationMs: out.durationMs,
          stderr: redactWithSlugs(out.stderr.slice(0, 4000), redactions),
          warnings: out.warnings.map((w) => redactWithSlugs(w, redactions)),
        });
      } else if (pre.claude) {
        const captureFile = `trial-${trial}.capture.jsonl`;
        const stdoutFile = `trial-${trial}.stdout.jsonl`;
        // The recorder keeps each request only as saved: redacted and reduced, in memory and on disk.
        const server = await startCapture({
          file: path.join(saveDir, captureFile),
          save: (r) => captureRecordAsSaved(r, redactions, prompt),
        });
        let out: CaptureRunOutcome;
        try {
          const where =
            pre.claude.home !== undefined ? { home: pre.claude.home } : { configDir: pre.claude.configDir ?? "" };
          const { env } = captureEnv(baseEnv, { baseUrl: server.url, ...where });
          out = await runClaudeCapture({
            bin: pre.claude.bin,
            prefixArgs: pre.claude.prefixArgs,
            cwd: launchAbs,
            env,
            args: pre.claude.args,
            prompt,
            timeoutMs: options.timeoutMs,
          });
        } finally {
          await server.close();
        }
        writeFileSync(
          path.join(saveDir, stdoutFile),
          redactWithSlugs(redactClaudeTranscript(out.stdout, redactions), redactions),
        );
        manifest.trials.push({
          trial,
          files: [captureFile, stdoutFile],
          exitCode: out.exitCode,
          timedOut: out.timedOut,
          durationMs: out.durationMs,
          stderr: redactWithSlugs(out.stderr, redactions),
          warnings: [],
        });
      }
      writeVerifyManifest(saveDir, manifest);
    }
  } finally {
    cleanUp();
    host.removeListener("exit", cleanUp);
    host.removeListener("SIGINT", onSignal);
    host.removeListener("SIGTERM", onSignal);
  }
  return readVerifyRecording(saveDir);
}

function parseRecords(text: string): CaptureRecord[] {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as CaptureRecord);
}

/** What one trial's files say, for the scorer. */
interface Read {
  evidence: TrialEvidence;
  segments?: Segment[];
  whole?: boolean;
  delivered?: DeliveredFile[];
}

function readRender(
  manifest: VerifyManifest,
  trial: number,
  name: string,
  text: string | undefined,
  firstBody: string | undefined,
): Read {
  if (text === undefined)
    return { evidence: { trial, failed: `${name} is missing`, delivered: "", controlText: "", checks: [] } };
  let parsed;
  try {
    parsed = parseRender(text);
  } catch (err) {
    if (!(err instanceof RenderShapeError)) throw err;
    return {
      evidence: { trial, delivered: "", controlText: "", checks: [{ ok: false, reason: `${name}: ${err.message}` }] },
    };
  }
  const checks: TrialCheck[] = [];
  if (parsed.body !== undefined && parsed.headerCwd !== parsed.environmentCwd)
    checks.push({
      ok: false,
      reason: `the AGENTS block is for ${parsed.headerCwd}, but the session's cwd is ${parsed.environmentCwd}`,
    });
  const body = parsed.body ?? "";
  if (firstBody !== undefined && body !== firstBody)
    checks.push({
      ok: false,
      reason: "this render differs from the first one: renders of the same copy must be identical",
    });
  const split = blockSegments(parsed.body, manifest.codex?.chain ?? []);
  return {
    evidence: {
      trial,
      delivered: body,
      controlText: parsed.lastUserText ?? "",
      cwd: parsed.environmentCwd,
      checks,
      segments: split.segments,
    },
    segments: split.segments,
    whole: split.whole,
  };
}

function readCapture(manifest: VerifyManifest, trial: VerifyManifest["trials"][number], files: VerifyTrialFiles): Read {
  const name = trial.files.join(" and ") || `trial-${trial.trial}`;
  if (files.stdout === undefined && files.capture === undefined)
    return { evidence: { trial: trial.trial, failed: `${name} missing`, delivered: "", controlText: "", checks: [] } };
  const init = initInfo(files.stdout ?? "");
  const records = parseRecords(files.capture ?? "");
  const post = records.find((r) => r.method === "POST" && r.url.startsWith("/v1/messages"));
  if (!post) {
    const why = [
      "no request reached the recorder",
      ...(init.found ? [] : ["no system/init event"]),
      ...(trial.exitCode !== 0 ? [`exited with status ${trial.exitCode ?? "none"}`] : []),
    ];
    return { evidence: { trial: trial.trial, failed: why.join("; "), delivered: "", controlText: "", checks: [] } };
  }
  let body;
  try {
    body = parseCaptureBody(post.body);
  } catch (err) {
    if (!(err instanceof OracleError)) throw err;
    return {
      evidence: {
        trial: trial.trial,
        delivered: "",
        controlText: "",
        checks: [{ ok: false, reason: `${trial.files[0] ?? name}: ${err.message}` }],
      },
    };
  }
  const checks: TrialCheck[] = [];
  const notes: string[] = [];
  const pin = manifest.claude?.model;
  // A recording that lists no stream file (the pilot bodies were kept without one) cannot be
  // asserted from system/init; it is scored from the wire alone and says so. A live run always
  // records the stream, and a listed stream that is missing or has no init event is a fault.
  const streamRecorded = trial.files.some((f) => f.endsWith(".stdout.jsonl"));
  if (!streamRecorded) {
    notes.push(
      `trial ${trial.trial}: no session stream was recorded, so the agents-md@builtin plugin and the model were not asserted from system/init; the working directory comes from the request's Environment block.`,
    );
    if (pin !== undefined && body.model !== undefined && body.model !== pin)
      checks.push({ ok: false, reason: `the request names model ${body.model}, not the pinned ${pin}` });
  } else {
    if (!init.found) checks.push({ ok: false, reason: "no system/init event in the session's output" });
    if (!hasAgentsMdPlugin(init))
      checks.push({
        ok: false,
        reason: `system/init lists no agents-md@builtin plugin (${init.plugins.join(", ") || "none"}): AGENTS.md support is off in this session`,
      });
    if (pin !== undefined && init.model !== pin)
      checks.push({ ok: false, reason: `system/init reports model ${init.model ?? "none"}, not the pinned ${pin}` });
    if (init.version !== undefined && init.version !== manifest.cliVersion)
      checks.push({
        ok: false,
        reason: `the session is version ${init.version}, the run was stamped ${manifest.cliVersion}`,
      });
  }
  const cwd = init.cwd ?? body.cwd;
  return {
    evidence: {
      trial: trial.trial,
      delivered: body.files.map((f) => f.text).join("\n\n"),
      controlText: body.texts.join("\n"),
      ...(cwd !== undefined ? { cwd } : {}),
      checks,
      notes,
    },
    delivered: body.files,
  };
}

/** Score a recording. A live run and `--replay` both end here. */
export function scoreVerify(recording: VerifyRecording): VerifyResult {
  const { manifest } = recording;
  const reads: Read[] = [];
  let firstBody: string | undefined;
  manifest.trials.forEach((t, i) => {
    const files: VerifyTrialFiles = recording.trials[i] ?? {};
    const read =
      manifest.instrument === "render"
        ? readRender(manifest, t.trial, t.files[0] ?? `trial-${t.trial}.render.json`, files.render, firstBody)
        : readCapture(manifest, t, files);
    if (manifest.instrument === "render" && firstBody === undefined && read.evidence.failed === undefined)
      firstBody = read.evidence.delivered;
    reads.push(read);
  });
  const clean = (r: Read) => r.evidence.failed === undefined && r.evidence.checks.every((c) => c.ok);
  const shown = reads.find(clean) ?? reads.find((r) => r.segments !== undefined || r.delivered !== undefined);
  return {
    manifest,
    recordingDir: recording.dir,
    score: scoreTrials(
      manifest,
      reads.map((r) => r.evidence),
    ),
    segments: shown?.segments ?? [],
    ...(shown?.whole !== undefined ? { whole: shown.whole } : {}),
    delivered: shown?.delivered ?? [],
    wording: honestWording(manifest.instrument, manifest.cliVersion),
  };
}

/** True when nothing in a scored run disagrees with map: every decided cell agrees and every chain file is byte-exact. */
export function agrees(result: VerifyResult): boolean {
  const a = result.score.agreement;
  return a.agree === a.decided && result.segments.every((s) => s.verdict === "EXACT");
}
