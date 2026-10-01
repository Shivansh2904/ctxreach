import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

// A live run copies a repository and starts two sessions, each with its own recorder.
vi.setConfig({ testTimeout: 120_000 });
import { registerVerify } from "../src/cli/commands/verify.js";
import { DUMMY_API_KEY, parseCaptureBody, reduceCaptureBody } from "../src/oracle/claude-capture.js";
import { readVerifyRecording } from "../src/oracle/recording.js";
import { agrees, runVerify, scoreVerify, type VerifyOptions } from "../src/oracle/verify.js";
import { OracleError } from "../src/oracle/types.js";
import { SANDBOX_PREFIX } from "../src/probe/sandbox.js";
import { renderVerify, VerifyJson, verifyJson } from "../src/report/verify.js";
import { materialise, tempDir, type Materialised } from "./helpers/fixture.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "helpers", "fake-capture-client.mjs");
const RECORDED = path.join(HERE, "recorded", "verify");
const MARKER = "ctxreach-fake-capture-marker.json";
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

interface Options {
  behaviour?: string;
  fx?: Materialised;
  trials?: number;
  claude?: Partial<NonNullable<VerifyOptions["claude"]>>;
}

async function verify(name: string, from: string, options: Options = {}) {
  const fx = options.fx ?? materialise(name);
  const tmp = tempDir("verify-tmp");
  const save = path.join(tempDir("verify-save"), "run");
  const recording = await runVerify({
    agent: "claude",
    repoRoot: fx.repo,
    launchDir: fx.at(from),
    trials: options.trials ?? 2,
    timeoutMs: 30_000,
    saveDir: save,
    ctxreachVersion: "0.0.0-test",
    tmpRoot: tmp,
    env: { ...process.env, FAKE_CAPTURE_BEHAVIOUR: options.behaviour ?? "ok", FAKE_CAPTURE_CEILING: tmp },
    claude: { bin: process.execPath, prefixArgs: [FAKE], model: "fake-model-pin", ...options.claude },
  });
  return { fx, tmp, save, recording, result: scoreVerify(recording) };
}

const cells = (r: ReturnType<typeof scoreVerify>) =>
  r.score.cells.map((c) => `${c.file} ${c.position}: ${c.seen}/${c.usable} ${c.decoy ? "control" : c.verdict}`);

describe("verify --agent claude with a stand-in claude (no Claude Code installed)", () => {
  it("captures what a CLAUDE.local.md session delivers: the local file, not AGENTS.md (the trap and its twin)", async () => {
    const trap = await verify("claude-local-shadows-agents", ".");
    expect(trap.result.score.instrument).toMatchObject({
      fault: false,
      reasons: [],
      control: { seen: 2, usable: 2 },
      decoy: { seen: 0, usable: 2 },
    });
    expect(cells(trap.result)).toEqual([
      "AGENTS.md head: 0/2 confirmed",
      "AGENTS.md tail: 0/2 confirmed",
      "CLAUDE.local.md head: 2/2 confirmed",
      "CLAUDE.local.md tail: 2/2 confirmed",
      "ctxreach-decoy.md head: 0/2 control",
      "ctxreach-decoy.md tail: 0/2 control",
    ]);
    expect(trap.result.score.agreement).toMatchObject({ agree: 4, decided: 4, cells: 4 });
    expect(trap.result.delivered.map((d) => [path.basename(d.path), d.label])).toEqual([
      ["CLAUDE.local.md", "project instructions, checked into the codebase"],
    ]);
    expect(agrees(trap.result)).toBe(true);
    expect(trap.recording.manifest).toMatchObject({
      instrument: "capture",
      cliVersion: "2.1.285",
      claude: { model: "fake-model-pin", mode: "claude-md-or-agents-md" },
    });
    expect(trap.recording.manifest.claude?.configDir).toMatch(/ctxreach-probe[\\/]claude-config$/);
    expect(trap.recording.manifest.args).toEqual(expect.arrayContaining(["--model", "fake-model-pin", "--tools", ""]));

    const twin = await verify("claude-local-shadows-agents-twin", ".");
    expect(cells(twin.result).slice(0, 2)).toEqual(["AGENTS.md head: 2/2 confirmed", "AGENTS.md tail: 2/2 confirmed"]);
    expect(agrees(twin.result)).toBe(true);
  });

  it("captures an ancestor's CLAUDE.md from a package directory, which switches the package's AGENTS.md off", async () => {
    const { result } = await verify("claude-root-shadows-package", "packages/api");
    expect(cells(result)).toEqual([
      "CLAUDE.md head: 2/2 confirmed",
      "CLAUDE.md tail: 2/2 confirmed",
      "packages/api/AGENTS.md head: 0/2 confirmed",
      "packages/api/AGENTS.md tail: 0/2 confirmed",
      "packages/api/ctxreach-decoy.md head: 0/2 control",
      "packages/api/ctxreach-decoy.md tail: 0/2 control",
    ]);
    expect(agrees(result)).toBe(true);
  });

  it("shows the documented headless gap: an import from outside the launch directory is predicted loaded but not delivered", async () => {
    const { result } = await verify("claude-import-outside-launch", "packages/api");
    expect(result.score.instrument.fault).toBe(false);
    expect(result.score.cells.filter((c) => c.file === "docs/testing.md").map((c) => c.verdict)).toEqual([
      "missed",
      "missed",
    ]);
    expect(result.score.cells.filter((c) => c.file === "CLAUDE.md").map((c) => c.verdict)).toEqual([
      "confirmed",
      "confirmed",
    ]);
    expect(agrees(result)).toBe(false);
  });

  it("saves each request reduced to what ctxreach scores: the prompt and the instruction files whole, the agent's own text as digests", async () => {
    const { save, recording, result } = await verify("claude-root-shadows-package", "packages/api");
    const prompt = recording.manifest.prompt;
    for (const name of ["trial-1.capture.jsonl", "trial-2.capture.jsonl"]) {
      const capture = readFileSync(path.join(save, name), "utf8");
      // The stand-in's own text: its system prompt, its preamble, its environment and git status blocks.
      for (const own of ["You are a fake.", "The stand-in's preamble", "# Environment (stand-in)", "git status."])
        expect(capture, `${name}: ${own}`).not.toContain(own);
      const posts = capture
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { method: string; body: string })
        .filter((r) => r.method === "POST");
      expect(posts).toHaveLength(1);
      const body = posts[0]?.body ?? "";
      expect(reduceCaptureBody(body, prompt), `${name} is its own reduction`).toBe(body);
      const saved = JSON.parse(body) as { system: unknown[]; messages: { role: string; content: unknown[] }[] };
      expect(saved.system).toEqual([expect.objectContaining({ kind: "text", bytes: "You are a fake.".length })]);
      expect(saved.messages[0]?.content.at(-1)).toEqual({ type: "text", text: prompt });
      expect(saved.messages[1]?.content).toEqual([expect.objectContaining({ kind: "text", cwd: expect.any(String) })]);
      const parsed = parseCaptureBody(body);
      expect(parsed.files.map((f) => path.basename(f.path))).toEqual(["CLAUDE.md"]);
      expect(parsed.files[0]?.text).toContain(result.score.cells[0]?.token ?? "?");
    }
  });

  it("never records a credential value, the session id or the account metadata, and never touches the real config directory", async () => {
    const { save } = await verify("claude-local-shadows-agents", ".");
    const capture = readFileSync(path.join(save, "trial-1.capture.jsonl"), "utf8");
    expect(capture).not.toContain(DUMMY_API_KEY);
    expect(capture).not.toContain("never-record-me");
    expect(capture).not.toContain("fake-session-id");
    expect(capture).not.toContain("fake-device-id");
    expect(capture).not.toContain("Git user: Fake User");
    const post = capture
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { method: string; headers: Record<string, string>; body: string })
      .find((r) => r.method === "POST");
    expect(post?.headers["x-api-key"]).toBe("<redacted>");
    expect(post?.headers.authorization).toBe("<redacted>");
    expect(post?.headers["x-claude-code-session-id"]).toBe("(removed by ctxreach)");
    // The git status block is saved only as a digest, and the digest is of the text with the name removed.
    expect(post?.body).not.toContain("Git user");
    expect(post?.body).toContain(
      sha256(
        "<system-reminder>\nThe stand-in's git status.\nCurrent branch: master\nGit user: (removed by ctxreach)\n</system-reminder>\n",
      ),
    );
    // The copy's real path, in path or slug form, is gone from both files.
    const stdout = readFileSync(path.join(save, "trial-1.stdout.jsonl"), "utf8");
    expect(capture + stdout).not.toContain(SANDBOX_PREFIX);
    expect(capture + stdout).not.toContain(os.tmpdir().replace(/[^A-Za-z0-9]/g, "-"));
    expect(stdout).toContain('"claude_code_version":"2.1.285"');
    // The stand-in writes a marker into whatever config directory it is given: it was the throwaway, never the real one.
    expect(existsSync(path.join(os.homedir(), ".claude", MARKER))).toBe(false);
    expect(existsSync(path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), MARKER))).toBe(
      false,
    );
  });

  it("voids the run when AGENTS.md support is off, the model is not the pin, the decoy is delivered, the prompt's token is missing, or the cwd is wrong", async () => {
    const plugin = await verify("claude-local-shadows-agents-twin", ".", { behaviour: "no-plugin" });
    expect(plugin.result.score.instrument.fault).toBe(true);
    expect(plugin.result.score.instrument.reasons.join("\n")).toMatch(
      /system\/init lists no agents-md@builtin plugin \(telemetry@builtin\)/,
    );

    const model = await verify("claude-local-shadows-agents-twin", ".", { behaviour: "wrong-model" });
    expect(model.result.score.instrument.reasons.join("\n")).toMatch(
      /system\/init reports model some-other-model, not the pinned fake-model-pin/,
    );

    const decoy = await verify("claude-local-shadows-agents-twin", ".", { behaviour: "echo-decoy" });
    expect(decoy.result.score.instrument.reasons.join("\n")).toMatch(/the decoy, which no rule loads, was delivered/);

    const control = await verify("claude-local-shadows-agents-twin", ".", { behaviour: "drop-control" });
    expect(control.result.score.instrument.reasons.join("\n")).toMatch(
      /the must-appear token CTXR-[0-9a-f]{8} from the prompt is not in the output/,
    );

    const cwd = await verify("claude-root-shadows-package", "packages/api", { behaviour: "wrong-cwd" });
    expect(cwd.result.score.instrument.reasons.join("\n")).toMatch(/ran in .*, not the launch directory/);
  });

  it("counts a session that sent no request as failed, not as a fault", async () => {
    const { result } = await verify("claude-local-shadows-agents-twin", ".", { behaviour: "no-request", trials: 1 });
    expect(result.score.trials.map((t) => [t.status, t.reasons[0]])).toEqual([
      ["failed", "no request reached the recorder"],
    ]);
    expect(result.score.instrument.fault).toBe(false);
    expect(result.score.cells.every((c) => c.usable === 0 && c.verdict === "no-data")).toBe(true);
  });

  it("refuses a Claude Code older than 2.1.281, and a run without a model pin", async () => {
    await expect(verify("claude-local-shadows-agents-twin", ".", { behaviour: "old-version" })).rejects.toThrow(
      /2\.1\.280 sends CLAUDE\.md only/,
    );
    await expect(verify("claude-local-shadows-agents-twin", ".", { claude: { model: "" } })).rejects.toThrow(
      OracleError,
    );
  });

  it("disagrees when map is given the wrong Project instructions mode (the planted-fault pass, K8)", async () => {
    const { result } = await verify("claude-local-shadows-agents-twin", ".", { claude: { mapMode: "claude-md" } });
    expect(result.score.instrument.fault).toBe(false);
    expect(result.score.cells.filter((c) => c.file === "AGENTS.md").map((c) => c.verdict)).toEqual(["extra", "extra"]);
    expect(agrees(result)).toBe(false);
    expect(result.manifest.claude).toMatchObject({ mapMode: "claude-md", mode: "claude-md-or-agents-md" });
  });

  it("passes a --settings file through, and models the Project instructions mode it sets", async () => {
    const settings = path.join(tempDir("settings"), "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } },
      }),
    );
    const { result, recording } = await verify("claude-local-shadows-agents", ".", {
      claude: { settingsFile: settings },
    });
    expect(recording.manifest.args.slice(-2)).toEqual(["--settings", settings]);
    expect(recording.manifest.claude?.mode).toBe("claude-md-and-agents-md");
    expect(cells(result).slice(0, 4)).toEqual([
      "AGENTS.md head: 2/2 confirmed",
      "AGENTS.md tail: 2/2 confirmed",
      "CLAUDE.local.md head: 2/2 confirmed",
      "CLAUDE.local.md tail: 2/2 confirmed",
    ]);
    expect(agrees(result)).toBe(true);
  });

  it("runs with a scratch home for the $HOME cells, never the real one", async () => {
    const home = tempDir("scratch-home");
    mkdirSync(path.join(home, ".claude"));
    writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "Scratch user file CTXR-0000f00d\n");
    const { result, recording } = await verify("claude-local-shadows-agents-twin", ".", { claude: { home } });
    expect(recording.manifest.claude?.home).toBeDefined();
    expect(recording.manifest.claude?.configDir).toBeUndefined();
    expect(recording.manifest.notes.some((n) => n.includes("scratch home"))).toBe(true);
    expect(result.delivered.map((d) => d.label)).toEqual([
      "user's private global instructions for all projects",
      "project instructions, checked into the codebase",
    ]);
    expect(existsSync(path.join(home, ".claude", MARKER))).toBe(true);
    expect(existsSync(path.join(os.homedir(), ".claude", MARKER))).toBe(false);
    // The user file is outside the copy: listed, not scored.
    expect(recording.manifest.outside.map((o) => o.delivery)).toEqual(["launch"]);
    await expect(verify("claude-local-shadows-agents-twin", ".", { claude: { home: os.homedir() } })).rejects.toThrow(
      /real home directory/,
    );
    await expect(
      verify("claude-local-shadows-agents-twin", ".", { claude: { home: path.dirname(os.homedir()) } }),
    ).rejects.toThrow(/real home directory/);
  });

  it("replays to the same result, and the report carries the scope lines", async () => {
    const live = await verify("claude-root-shadows-package", "packages/api");
    const replayed = scoreVerify(readVerifyRecording(live.save));
    expect(replayed.score).toEqual(live.result.score);
    expect(replayed.delivered).toEqual(live.result.delivered);
    const text = renderVerify(replayed, { color: false });
    expect(text).toContain(
      "ctxreach verify  Claude Code 2.1.285, capture (loopback endpoint), launch dir packages/api  (repo)",
    );
    expect(text).toContain(
      "Delivery to the model endpoint (custom base URL) by Claude Code 2.1.285; the request was answered 400 and no model ran.",
    );
    expect(text).toMatch(/model\s+fake-model-pin \(pinned, asserted from system\/init\)/);
    expect(text).toContain("Agreement with map: 4 of 4 decided cells agree (CONFIRMED 4); 4 cells in all.");
    expect(VerifyJson.parse(verifyJson(replayed)).delivered.map((d) => path.basename(d.path))).toEqual(["CLAUDE.md"]);
  });
});

describe("replaying the pilot captures of 2026-09-30 (Claude Code 2.1.285, hand-planted tokens)", () => {
  it("A: an ancestor .claude/CLAUDE.md above the git root switched AGENTS.md off; 6 of 6 cells as predicted", () => {
    const r = scoreVerify(readVerifyRecording(path.join(RECORDED, "capture-pilot-A")));
    expect(cells(r)).toEqual([
      "../.claude/CLAUDE.md head: 1/1 confirmed",
      "AGENTS.md head: 0/1 confirmed",
      "AGENTS.md tail: 0/1 confirmed",
      ".claude/rules/style.md head: 1/1 confirmed",
      "packages/api/AGENTS.md head: 0/1 confirmed",
      "docs/decoy.md head: 0/1 control",
    ]);
    expect(r.score.instrument).toMatchObject({
      fault: false,
      control: { seen: 1, usable: 1 },
      decoy: { seen: 0, usable: 1 },
    });
    expect(r.score.agreement).toMatchObject({ agree: 5, decided: 5, cells: 5 });
    expect(r.score.warnings.join("\n")).toContain("no session stream was recorded");
    expect(r.manifest.notes[0]).toContain("Pilot recording");
  });

  it("B: without the ancestor file, AGENTS.md arrived and the nested one did not; 5 of 5 cells as predicted", () => {
    const r = scoreVerify(readVerifyRecording(path.join(RECORDED, "capture-pilot-B")));
    expect(cells(r)).toEqual([
      "AGENTS.md head: 1/1 confirmed",
      "AGENTS.md tail: 1/1 confirmed",
      ".claude/rules/style.md head: 1/1 confirmed",
      "packages/api/AGENTS.md head: 0/1 confirmed",
      "docs/decoy.md head: 0/1 control",
    ]);
    expect(r.score.agreement).toMatchObject({ agree: 4, decided: 4, cells: 4 });
    expect(agrees(r)).toBe(true);
  });
});

describe("the verify command for Claude Code", () => {
  async function cli(env: NodeJS.ProcessEnv, ...args: string[]) {
    let stdout = "";
    let stderr = "";
    let status = -1;
    const program = new Command().exitOverride();
    program.configureOutput({ writeOut: (t) => (stdout += t), writeErr: (t) => (stderr += t) });
    registerVerify(program, {
      io: { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
      setStatus: (s) => (status = s),
      version: "0.0.0-test",
      claude: { bin: process.execPath, prefixArgs: [FAKE] },
      env,
    });
    await program.parseAsync(["node", "ctxreach", "verify", "--agent", "claude", ...args]);
    return { stdout, stderr, status };
  }

  it("needs --model, and otherwise runs, records and exits 0 on agreement", async () => {
    const fx = materialise("claude-local-shadows-agents");
    const tmp = tempDir("cli-tmp");
    const env = { ...process.env, FAKE_CAPTURE_CEILING: tmp, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
    const save = path.join(tempDir("cli-save"), "run");
    const noModel = await cli(env, "--repo", fx.repo, "--from", fx.repo, "--save", save);
    expect(noModel.status).toBe(2);
    expect(noModel.stderr).toBe(
      "ctxreach: verify --agent claude needs --model <pin>: the model is asserted from system/init\n",
    );
    expect(existsSync(save)).toBe(false);
    const out = await cli(
      env,
      "--repo",
      fx.repo,
      "--from",
      fx.repo,
      "--model",
      "fake-model-pin",
      "--save",
      save,
      "--json",
    );
    expect(out.status, out.stderr).toBe(0);
    const json = VerifyJson.parse(JSON.parse(out.stdout));
    expect(json.agreement).toMatchObject({ agree: 4, decided: 4 });
    expect(json.delivered.map((d) => path.basename(d.path))).toEqual(["CLAUDE.local.md"]);
    expect(readdirSync(save).sort()).toEqual([
      "manifest.json",
      "trial-1.capture.jsonl",
      "trial-1.stdout.jsonl",
      "trial-2.capture.jsonl",
      "trial-2.stdout.jsonl",
    ]);
  });

  it("refuses to replay a codex recording as claude", async () => {
    const out = await cli(process.env, "--replay", path.join(RECORDED, "codex-pilot"));
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/has no manifest\.json/);
  });
});
