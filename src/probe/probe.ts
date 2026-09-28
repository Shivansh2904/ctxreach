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
import { displayPath, isInside } from "../util/fs.js";
import { plantDecoy, plantFile, TokenSource, type RandomSource } from "./canary.js";
import { readRecording, RECORDING_SCHEMA, writeManifest, type Manifest, type Recording } from "./recording.js";
import { createSandbox, removeSandbox, type Sandbox } from "./sandbox.js";
import { SafetyError, type AgentAdapter, type Canary, type ProbeMode, type Redaction } from "./types.js";

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
}

function relPosix(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/") || ".";
}

export async function runProbe(options: ProbeOptions): Promise<Recording> {
  const { adapter } = options;
  const repoRoot = path.resolve(options.repoRoot);
  const launchDir = path.resolve(options.launchDir);
  const saveDir = path.resolve(options.saveDir);
  if (!isInside(launchDir, repoRoot)) throw new SafetyError(`${launchDir} is outside the repository ${repoRoot}`);
  if (isInside(saveDir, repoRoot))
    throw new SafetyError(`refusing to record inside the repository being probed (${saveDir}); pass --save elsewhere`);
  if (existsSync(saveDir) && readdirSync(saveDir).length > 0)
    throw new SafetyError(`${saveDir} is not empty; pass --save with a new or empty directory`);
  const say = options.progress ?? (() => undefined);

  const cliVersion = await adapter.version();
  const environment = adapter.environment();
  const launchRel = relPosix(repoRoot, launchDir);

  let sandbox: Sandbox | undefined;
  const cleanUp = () => {
    if (sandbox) removeSandbox(sandbox);
    sandbox = undefined;
  };
  // Node emits no "exit" when Ctrl+C or a kill ends the process, so remove
  // the copy on those signals too, then exit as the signal would have.
  const onSignal = (signal: NodeJS.Signals) => {
    cleanUp();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("exit", cleanUp);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    sandbox = createSandbox(repoRoot, options.tmpRoot !== undefined ? { tmpRoot: options.tmpRoot } : {});
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
      const st = lstatSync(row.path, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isSymbolicLink()) {
        unplanted.push({ file: rel, why: "a symlink; its target is planted if it is in the copy" });
        continue;
      }
      if (!st.isFile()) continue;
      canaries.push(...plantFile(box.repo, rel, tokens));
    }
    canaries.push(...plantDecoy(box.repo, launchRel, tokens));

    // Predict again on the planted copy, so byte offsets match what the agent reads.
    const after = predict();
    const predicted: Manifest["predicted"] = [];
    const outside: Manifest["outside"] = [];
    const ph = placeholders();
    const redactions: Redaction[] = [
      { from: box.base, to: ph.base },
      { from: os.homedir(), to: ph.home },
    ];
    for (const row of after.matrix) {
      const cell = row.cells[adapter.id];
      if (!cell) continue;
      if (isInside(row.path, box.repo)) {
        predicted.push({
          file: relPosix(box.repo, row.path),
          delivery: cell.delivery,
          why: cell.why,
          rule: cell.rule,
          ...(cell.cut ? { cutAt: cell.cut.at } : {}),
          ...(cell.needsApproval ? { needsApproval: true } : {}),
        });
      } else if (cell.delivery !== "not-loaded") {
        let shown = row.path;
        for (const r of redactions) if (isInside(shown, r.from)) shown = r.to + shown.slice(r.from.length);
        outside.push({ file: displayPath(shown, box.repo), delivery: cell.delivery, why: cell.why });
      }
    }

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
      args: adapter.args(options.mode),
      prompt,
      canaries,
      predicted,
      outside,
      unplanted,
      sandbox: { stripped: box.stripped, skipped: box.skipped },
      environment,
      ...(after.claude ? { claudeMode: after.claude.mode } : {}),
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
      });
      manifest.trials.push({ trial, transcript, ...outcome });
      // Saved after every trial, so an interrupted run can still be replayed.
      writeManifest(saveDir, manifest);
    }
  } finally {
    cleanUp();
    process.removeListener("exit", cleanUp);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  return readRecording(saveDir);
}
