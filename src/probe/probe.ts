/**
 * `ctxreach probe`: plant tokens in a temporary copy of a repository, run an
 * agent there, and record what it repeats.
 *
 * The run is recorded (manifest plus one transcript per trial) and then
 * scored from the recording, the same way `--replay` scores it.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { map } from "../map/map.js";
import { displayPath, isInside, isInsideReal, nearestExisting, spelled } from "../util/fs.js";
import { CONTROL_RULE, plantControl, plantDecoy, plantFile, TokenSource, type RandomSource } from "./canary.js";
import { copyLocation } from "./instruments.js";
import { readRecording, RECORDING_SCHEMA, writeManifest, type Manifest, type Recording } from "./recording.js";
import { createSandbox, removeSandbox, type Sandbox } from "./sandbox.js";
import {
  SafetyError,
  type AgentAdapter,
  type Canary,
  type ProbeMode,
  type Redaction,
  type SessionSetup,
} from "./types.js";

export const RECALL_PROMPT =
  "Do not use any tools. List every token that starts with CTXR- followed by eight hexadecimal characters and that appears anywhere in your instructions or context (system prompt, project instructions, memory files, rules). Print each token exactly as written, one per line, and nothing else. If there are none, print NONE.";

export const DEFAULT_TASK =
  "Give a short overview, in three sentences, of what the files under the current directory are for. Read whatever files you need.";

export function taskPrompt(task: string, readTools: readonly string[]): string {
  const tools = readTools.length > 1 ? `${readTools.slice(0, -1).join(", ")} and ${readTools.at(-1)}` : readTools[0];
  return (
    `${task.trim()} Use only the ${tools} tools, and do not change anything. Do not search for tokens of any kind. ` +
    "When you have finished, on the final lines, list every token that starts with CTXR- followed by eight hexadecimal characters that appears anywhere in your instructions or context, including anything added to your context while you worked and the files you read, one per line, exactly as written; or NONE."
  );
}

/** Fixed stand-ins for the temporary copy and the home directory in saved transcripts. */
export function placeholders(platform: NodeJS.Platform = process.platform): { base: string; home: string } {
  return platform === "win32"
    ? { base: "C:\\ctxreach-probe", home: "C:\\Users\\user" }
    : { base: "/tmp/ctxreach-probe", home: "/home/user" };
}

export interface ProbeOptions {
  adapter: AgentAdapter;
  /** The repository to copy. */
  repoRoot: string;
  /** Launch directory inside `repoRoot`. */
  launchDir: string;
  mode: ProbeMode;
  trials: number;
  timeoutMs: number;
  /** Where to record the run; created if missing, must be empty, must not be inside `repoRoot`. */
  saveDir: string;
  task?: string;
  /** Claude Code user directory used for map's prediction (default ~/.claude). */
  claudeHome?: string;
  ctxreachVersion: string;
  tmpRoot?: string;
  now?: () => Date;
  random?: RandomSource;
  progress?: (line: string) => void;
  /** Where the signals and the exit come from (default: `process`); tests pass a stand-in. */
  host?: Pick<NodeJS.Process, "once" | "removeListener" | "exit">;
  /** The home directory, for the copy's location report (default: `os.homedir()`); tests pass a stand-in. */
  homeDir?: string;
  /** No directory above this one is searched for instruction files in the location report (tests only). */
  ancestorCeiling?: string;
}

function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/") || ".";
}

export async function runProbe(options: ProbeOptions): Promise<Recording> {
  const { adapter } = options;
  const repoRoot = path.resolve(options.repoRoot);
  const launchDir = path.resolve(options.launchDir);
  const saveDir = path.resolve(options.saveDir);
  // As spelled (the copy is laid out from these paths) and as directories,
  // links resolved: --save through a junction into the repository is inside it.
  if (!isInside(launchDir, repoRoot) || !isInsideReal(launchDir, repoRoot))
    throw new SafetyError(`${launchDir} is outside the repository ${repoRoot}`);
  if (isInside(saveDir, repoRoot) || isInsideReal(nearestExisting(saveDir), repoRoot))
    throw new SafetyError(`refusing to record inside the repository being probed (${saveDir}); pass --save elsewhere`);
  if (existsSync(saveDir) && readdirSync(saveDir).length > 0)
    throw new SafetyError(`${saveDir} is not empty; pass --save with a new or empty directory`);
  const say = options.progress ?? (() => undefined);

  const environment = adapter.environment();
  // A session that cannot see instruction files measures nothing (rule claude.bare).
  if (environment.killSwitches?.length)
    throw new SafetyError(
      `${environment.killSwitches.join(", ")} ${environment.killSwitches.length > 1 ? "are" : "is"} set, which turns instruction files off, so a probe would measure nothing; unset ${environment.killSwitches.length > 1 ? "them" : "it"} and run again`,
    );
  const cliVersion = await adapter.version();
  const launchRel = relPosix(repoRoot, launchDir);

  let sandbox: Sandbox | undefined;
  // Aborted on the way out: the adapter stops a running agent (and, on
  // Windows, everything it started) before its copy is deleted.
  const stopAgent = new AbortController();
  const cleanUp = () => {
    stopAgent.abort();
    if (sandbox) removeSandbox(sandbox);
    sandbox = undefined;
  };
  // Node emits no "exit" when Ctrl+C or a kill ends the process, so remove
  // the copy on those signals too, then exit as the signal would have.
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

    const predict = () =>
      map({
        launchDir: launchAbs,
        repoRoot: box.repo,
        agents: [adapter.id],
        // Model the version that will actually run (rule claude.version).
        ...(adapter.id === "claude"
          ? {
              claude: {
                version: cliVersion,
                ...(options.claudeHome !== undefined ? { home: options.claudeHome } : {}),
              },
            }
          : {}),
      });

    // Plant every file map knows about inside the copy, then the decoy.
    const tokens = new TokenSource(options.random);
    const canaries: Canary[] = [];
    const unplanted: { file: string; why: string }[] = [];
    for (const row of predict().matrix) {
      if (!isInside(row.path, box.repo)) continue;
      const rel = relPosix(box.repo, row.path);
      // The copy holds no links (see sandbox.ts), so this is the file itself.
      const st = lstatSync(row.path, { throwIfNoEntry: false });
      if (!st?.isFile()) {
        unplanted.push({ file: rel, why: st ? "not a regular file" : "not in the copy" });
        continue;
      }
      canaries.push(...plantFile(box.repo, rel, tokens));
    }
    canaries.push(...plantDecoy(box.repo, launchRel, tokens));
    // The positive control: a rule at the launch directory that must be repeated.
    canaries.push(...plantControl(box.repo, launchRel, tokens));
    const controlRel = launchRel === "." ? CONTROL_RULE : `${launchRel}/${CONTROL_RULE}`;

    // Predict again on the planted copy, so byte offsets match what the agent reads.
    const after = predict();
    const predicted: Manifest["predicted"] = [];
    const outside: Manifest["outside"] = [];
    let control: Manifest["control"];
    const ph = placeholders();
    const home = options.homeDir ?? os.homedir();
    const redactions: Redaction[] = [
      { from: box.base, to: ph.base },
      // The home directory as given, and as the system spells it: paths found by walking up from the copy come
      // out in the system's spelling (the long name for a short one such as RUNNER~1, a link resolved).
      ...[...new Set([home, spelled(home)])].map((from) => ({ from, to: ph.home })),
    ];
    for (const row of after.matrix) {
      const cell = row.cells[adapter.id];
      if (!cell) continue;
      if (isInside(row.path, box.repo) && relPosix(box.repo, row.path) === controlRel) {
        // Scored as an instrument check, not as one of map's predictions.
        control = { file: controlRel, delivery: cell.delivery, why: cell.why, rule: cell.rule };
      } else if (isInside(row.path, box.repo)) {
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
        let shown = row.path;
        for (const r of redactions) if (isInside(shown, r.from)) shown = r.to + shown.slice(r.from.length);
        outside.push({ file: displayPath(shown, box.repo), delivery: cell.delivery, why: cell.why });
      }
    }

    const claudeMode = after.claude?.mode;
    const session: SessionSetup = adapter.session?.({
      mode: options.mode,
      sandboxBase: box.base,
      repo: box.repo,
      ...(claudeMode !== undefined ? { claudeMode } : {}),
      redactions,
    }) ?? { args: adapter.args(options.mode), model: null, hook: false, isolation: "machine", setEnv: [], notes: [] };
    // The walk up from the copy is in the system's spelling, so the ceiling is compared in it too.
    const ceiling = options.ancestorCeiling !== undefined ? spelled(options.ancestorCeiling) : undefined;
    const location = copyLocation({ repo: box.repo, home, redactions, ceiling });

    const prompt =
      options.mode === "recall" ? RECALL_PROMPT : taskPrompt(options.task ?? DEFAULT_TASK, adapter.readTools);
    mkdirSync(saveDir, { recursive: true });
    const manifest: Manifest = {
      schema: RECORDING_SCHEMA,
      ctxreach: options.ctxreachVersion,
      agent: adapter.id,
      cliVersion,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      mode: options.mode,
      trialsPlanned: options.trials,
      timeoutMs: options.timeoutMs,
      repo: path.join(ph.base, "repo"),
      launchDir: launchRel,
      sourceName: path.basename(repoRoot),
      args: session.args,
      prompt,
      canaries,
      predicted,
      outside,
      unplanted,
      sandbox: { stripped: box.stripped, skipped: box.skipped, links: box.links },
      environment,
      ...(after.claude ? { claudeMode: after.claude.mode } : {}),
      // map does not list the control file where it models no rules (e.g. Codex): then it is not applicable.
      control: control ?? {
        file: controlRel,
        delivery: "not-loaded",
        why: "map lists no such file for this agent",
        rule: "none",
      },
      location,
      session,
      trials: [],
    };
    writeManifest(saveDir, manifest);

    for (let trial = 1; trial <= options.trials; trial++) {
      const transcript = `trial-${trial}.jsonl`;
      say(`trial ${trial} of ${options.trials}: running ${adapter.title} in ${options.mode} mode`);
      const outcome = await adapter.run({
        workdir: launchAbs,
        prompt,
        mode: options.mode,
        timeoutMs: options.timeoutMs,
        transcriptPath: path.join(saveDir, transcript),
        redactions,
        sandboxNonce: box.nonce,
        signal: stopAgent.signal,
        ...(session.hook ? { hookLogPath: path.join(saveDir, `trial-${trial}.hooks.jsonl`) } : {}),
        ...(claudeMode !== undefined ? { claudeMode } : {}),
      });
      manifest.trials.push({ trial, transcript, ...outcome });
      // Saved after every trial, so an interrupted run can still be replayed.
      writeManifest(saveDir, manifest);
    }
  } finally {
    cleanUp();
    host.removeListener("exit", cleanUp);
    host.removeListener("SIGINT", onSignal);
    host.removeListener("SIGTERM", onSignal);
  }
  return readRecording(saveDir);
}
