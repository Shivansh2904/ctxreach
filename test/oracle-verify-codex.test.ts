import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

// A live run copies a repository and renders twice; the battery does so 22 times.
vi.setConfig({ testTimeout: 240_000 });
import { registerVerify } from "../src/cli/commands/verify.js";
import { readVerifyRecording } from "../src/oracle/recording.js";
import { agrees, runVerify, scoreVerify, type VerifyOptions } from "../src/oracle/verify.js";
import { SANDBOX_PREFIX } from "../src/probe/sandbox.js";
import { VerifyJson } from "../src/report/verify.js";
import { materialise, tempDir, type Materialised } from "./helpers/fixture.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "helpers", "fake-codex.mjs");
const FIXTURES = path.join(HERE, "fixtures");

function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(path.relative(dir, p) + "\0").update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

interface Options {
  behaviour?: string;
  fx?: Materialised;
  trials?: number;
  codex?: VerifyOptions["codex"];
}

async function verify(name: string, from: string, options: Options = {}) {
  const fx = options.fx ?? materialise(name);
  const tmp = tempDir("verify-tmp");
  const save = path.join(tempDir("verify-save"), "run");
  const before = treeHash(fx.repo);
  const recording = await runVerify({
    agent: "codex",
    repoRoot: fx.repo,
    launchDir: fx.at(from),
    trials: options.trials ?? 2,
    timeoutMs: 30_000,
    saveDir: save,
    ctxreachVersion: "0.0.0-test",
    tmpRoot: tmp,
    env: { ...process.env, FAKE_CODEX_BEHAVIOUR: options.behaviour ?? "ok" },
    codex: { bin: FAKE, userHome: fx.codexHome, ...options.codex },
  });
  return { fx, tmp, save, recording, result: scoreVerify(recording), before, after: treeHash(fx.repo) };
}

const cells = (r: ReturnType<typeof scoreVerify>) =>
  r.score.cells.map((c) => `${c.file} ${c.position}: ${c.seen}/${c.usable} ${c.decoy ? "control" : c.verdict}`);

describe("verify --agent codex with a stand-in codex (no Codex installed)", () => {
  it("agrees with map on every codex fixture, from the root and from packages/api: byte-exact, two identical renders each", async () => {
    const names = readdirSync(FIXTURES).filter((n) => n.startsWith("codex-"));
    expect(names).toHaveLength(14);
    const launches: string[] = [];
    const agreeing: string[] = [];
    for (const name of names) {
      const fx = materialise(name);
      for (const from of [".", "packages/api"]) {
        if (!existsSync(fx.at(from))) continue;
        const { result, recording } = await verify(name, from, { fx });
        launches.push(`${name} from ${from}`);
        expect(result.score.instrument, `${name} from ${from}`).toMatchObject({ fault: false, reasons: [] });
        expect(recording.manifest.trials).toHaveLength(2);
        expect(result.segments.length, `${name} from ${from}: chain files`).toBeGreaterThan(0);
        expect(result.whole, `${name} from ${from}: whole block`).toBe(true);
        if (agrees(result)) agreeing.push(`${name} from ${from}`);
        // The fixture's own home was never written to: the render used the throwaway inside the sandbox.
        expect(existsSync(path.join(fx.codexHome, "installation_id"))).toBe(false);
        expect(recording.manifest.codex?.codexHome).toMatch(
          /^C:\\ctxreach-probe\\codex-home$|^\/tmp\/ctxreach-probe\/codex-home$/,
        );
      }
    }
    expect(launches).toHaveLength(22);
    expect(agreeing, `agreeing launches: ${agreeing.length}/${launches.length}`).toEqual(launches);
  });

  it("scores the cut and the starved file exactly, and records the seeded config that made it so", async () => {
    const { result, recording } = await verify("codex-root-starves-nested", "packages/api");
    expect(result.segments.map((s) => [s.file, s.verdict, s.observedBytes, s.bytes])).toEqual([
      ["AGENTS.md", "EXACT", 32230, 32230],
      ["packages/api/AGENTS.md", "EXACT", 538, 1214],
    ]);
    expect(cells(result)).toEqual([
      "AGENTS.md head: 2/2 confirmed",
      "AGENTS.md tail: 2/2 confirmed",
      "packages/api/AGENTS.md head: 2/2 confirmed",
      // The tail token lies past the cut at 538 (the planted copy is 62 bytes longer than the fixture), so map predicts it never arrives.
      "packages/api/AGENTS.md tail: 0/2 confirmed",
      "packages/api/ctxreach-decoy.md head: 0/2 control",
      "packages/api/ctxreach-decoy.md tail: 0/2 control",
    ]);
    expect(result.score.agreement).toMatchObject({ agree: 4, decided: 4, cells: 4 });
    expect(recording.manifest.codex).toMatchObject({
      seeded: { keys: [], globalFiles: [], trust: "unknown" },
      hooksFlag: "accepted",
      overrides: ["features.hooks=false"],
    });
    expect(recording.manifest.args).toEqual(["debug", "prompt-input", "-c", "features.hooks=false"]);
    expect(recording.manifest.trials[0]?.warnings[0]).toContain("Refusing to create helper binaries");
  });

  it("applies the user's budget from the seeded home (the project-config twin), and a project's config only when trusted", async () => {
    const twin = await verify("codex-project-config-twin", ".");
    expect(twin.recording.manifest.codex?.seeded.keys).toEqual(["project_doc_max_bytes"]);
    expect(twin.result.segments[0]).toMatchObject({ verdict: "EXACT", observedBytes: 41022 });
    expect(agrees(twin.result)).toBe(true);

    // Untrusted (the default): the project's .codex/config.toml is written back but ignored by both.
    const trap = await verify("codex-project-config", ".");
    expect(trap.recording.manifest.codex?.projectConfigs).toEqual([
      { file: ".codex/config.toml", keys: ["project_doc_max_bytes"] },
    ]);
    expect(trap.result.segments[0]).toMatchObject({ verdict: "EXACT", observedBytes: 32768 });
    expect(agrees(trap.result)).toBe(true);

    // Trusted at home: the trust is mirrored to the copy, and the 64 KiB project budget applies in both.
    const fx = materialise("codex-project-config");
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(
      path.join(fx.codexHome, "config.toml"),
      `[projects.${JSON.stringify(fx.repo)}]\ntrust_level = "trusted"\n`,
    );
    const trusted = await verify("codex-project-config", ".", { fx });
    expect(trusted.recording.manifest.codex?.seeded).toMatchObject({ trust: "trusted" });
    expect(trusted.result.segments[0]).toMatchObject({ verdict: "EXACT", observedBytes: 41022 });
    expect(agrees(trusted.result)).toBe(true);

    // Marked untrusted: no project file at all, as map predicts.
    const untrusted = await verify("codex-project-config", ".", { codex: { trust: "untrusted" } });
    expect(untrusted.recording.manifest.codex?.seeded).toMatchObject({ trust: "untrusted", trustFrom: "override" });
    // Untrusted, map predicts no chain at all, so there are no bytes to compare; the token cells carry the evidence.
    expect(untrusted.result.segments).toEqual([]);
    expect(untrusted.result.whole).toBe(true);
    expect(cells(untrusted.result).slice(0, 2)).toEqual([
      "AGENTS.md head: 0/2 confirmed",
      "AGENTS.md tail: 0/2 confirmed",
    ]);
    expect(agrees(untrusted.result)).toBe(true);
  });

  it("disagrees when map is given the wrong budget (the planted-fault pass, K8)", async () => {
    const { result } = await verify("codex-over-cap", ".", { codex: { mapMaxBytes: 30000 } });
    expect(result.score.instrument.fault).toBe(false);
    expect(result.segments[0]).toMatchObject({
      file: "AGENTS.md",
      verdict: "OFF BY",
      offBy: 2768,
      predictedBytes: 30000,
      observedBytes: 32768,
    });
    expect(result.whole).toBe(false);
    expect(agrees(result)).toBe(false);
    expect(result.manifest.codex?.mapMaxBytes).toBe(30000);
  });

  it("disagrees when the renderer ignores the budget, or joins files wrongly", async () => {
    const cut = await verify("codex-over-cap", ".", { behaviour: "ignore-budget" });
    expect(cut.result.segments[0]).toMatchObject({ verdict: "OFF BY", offBy: 8254 });
    expect(agrees(cut.result)).toBe(false);
    const join = await verify("codex-root-starves-nested-twin", "packages/api", { behaviour: "wrong-separator" });
    expect(join.result.segments.map((s) => s.verdict)).not.toEqual(["EXACT", "EXACT"]);
    expect(agrees(join.result)).toBe(false);
  });

  it("voids the run when the two renders differ, when the decoy is delivered, when the prompt's token is missing, or when the render is for another directory", async () => {
    const differ = await verify("codex-over-cap-twin", ".", { behaviour: "nondeterministic" });
    expect(differ.result.score.instrument.fault).toBe(true);
    expect(differ.result.score.instrument.reasons.join("\n")).toMatch(
      /trial 2: this render differs from the first one/,
    );

    const decoy = await verify("codex-over-cap-twin", ".", { behaviour: "echo-decoy" });
    expect(decoy.result.score.instrument.reasons.join("\n")).toMatch(/the decoy, which no rule loads, was delivered/);
    expect(decoy.result.score.instrument.decoy).toEqual({ seen: 2, usable: 0 });

    const control = await verify("codex-over-cap-twin", ".", { behaviour: "no-control" });
    expect(control.result.score.instrument.reasons.join("\n")).toMatch(
      /the must-appear token CTXR-[0-9a-f]{8} from the prompt is not in the output/,
    );
    expect(control.result.score.instrument.control).toEqual({ seen: 0, usable: 0 });

    const cwd = await verify("codex-nested-below-cwd", "packages/api", { behaviour: "wrong-cwd" });
    expect(cwd.result.score.instrument.reasons.join("\n")).toMatch(/ran in .*, not the launch directory/);
  });

  it("fails with the JSON path when a render has an unknown shape, and keeps the render as evidence", async () => {
    const { result, save } = await verify("codex-over-cap-twin", ".", { behaviour: "bad-shape" });
    expect(result.score.trials.map((t) => t.status)).toEqual(["fault", "fault"]);
    expect(result.score.instrument.reasons[0]).toMatch(
      /trial 1: trial-1\.render\.json: \$\[\*\]\.internal_chat_message_metadata_passthrough\.content_item_kinds: no item carries/,
    );
    expect(existsSync(path.join(save, "trial-1.render.json"))).toBe(true);
    // Its kinds unknown, nothing in it can be told to be the AGENTS block: every item is saved as a digest.
    const saved = readFileSync(path.join(save, "trial-1.render.json"), "utf8");
    expect(saved).not.toContain("<skills_instructions>");
    expect(saved).not.toContain("# AGENTS.md instructions for");
  });

  it("saves only what it scores: the AGENTS block and the prompt whole, the stand-in's own items as digests", async () => {
    const { save, recording, result } = await verify("codex-override-wins", "packages/api");
    const saved = readFileSync(path.join(save, "trial-1.render.json"), "utf8");
    for (const own of [
      "<skills_instructions>",
      "<permissions instructions>",
      "<multi_agent_role>",
      "<shell>",
      "msg_fake",
    ])
      expect(saved).not.toContain(own);
    const items = JSON.parse(saved) as { role: string; content: Record<string, unknown>[] }[];
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const skills = "<skills_instructions>\n## Skills\n(fake)\n</skills_instructions>";
    expect(items[0]?.content[0]).toEqual({
      kind: "host_skills.instructions",
      sha256: sha(skills),
      bytes: skills.length,
    });
    // The environment context keeps its cwd, redacted like everything else.
    expect(items[3]?.content[1]).toMatchObject({
      kind: "environments.environment_context",
      cwd: path.join(recording.manifest.repo, "packages", "api"),
    });
    expect(String(items[3]?.content[0]?.text)).toMatch(/^# AGENTS\.md instructions for /);
    expect(items[4]?.content).toEqual([{ type: "input_text", text: recording.manifest.prompt }]);
    expect(agrees(result)).toBe(true);
  });

  it("retries without -c features.hooks=false when Codex rejects it, and says so", async () => {
    const { result, recording } = await verify("codex-over-cap-twin", ".", { behaviour: "reject-hooks-flag" });
    expect(recording.manifest.codex?.hooksFlag).toBe("rejected");
    expect(recording.manifest.codex?.overrides).toEqual([]);
    expect(agrees(result)).toBe(true);
  });

  it("replays to the same result, and a mutated recording fails where it was changed", async () => {
    const live = await verify("codex-root-starves-nested", "packages/api");
    const replayed = scoreVerify(readVerifyRecording(live.save));
    expect(replayed.score).toEqual(live.result.score);
    expect(replayed.segments).toEqual(live.result.segments);

    // A token swapped inside the block: the cell is MISSED and the bytes differ where it was.
    const dir = path.join(tempDir("mutated"), "run");
    cpSync(live.save, dir, { recursive: true });
    const token =
      live.recording.manifest.canaries.find((c) => c.file === "AGENTS.md" && c.position === "head")?.token ?? "";
    const file = path.join(dir, "trial-1.render.json");
    writeFileSync(file, readFileSync(file, "utf8").replace(token, "CTXR-deadbeef"));
    const mutated = scoreVerify(readVerifyRecording(dir));
    expect(mutated.score.cells.find((c) => c.token === token)?.verdict).toBe("missed");
    expect(mutated.score.instrument.reasons.join("\n")).toMatch(/trial 2: this render differs from the first one/);
    expect(mutated.score.warnings.join("\n")).toContain("CTXR-deadbeef");
    expect(agrees(mutated)).toBe(false);

    // The metadata removed from every item: the shape check names the path.
    const stripped = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[];
    for (const item of stripped) delete item.internal_chat_message_metadata_passthrough;
    writeFileSync(file, JSON.stringify(stripped));
    const shape = scoreVerify(readVerifyRecording(dir));
    expect(shape.score.instrument.reasons[0]).toMatch(
      /trial-1\.render\.json: \$\[\*\]\.internal_chat_message_metadata_passthrough/,
    );
  });

  it("leaves the repository alone and removes the copy, the throwaway home with it", async () => {
    const { before, after, tmp } = await verify("codex-empty-override", "packages/api");
    expect(after).toBe(before);
    expect(readdirSync(tmp).filter((n) => n.startsWith(SANDBOX_PREFIX))).toEqual([]);
  });

  it("refuses a launch directory outside the repository and a recording directory inside it", async () => {
    const fx = materialise("codex-over-cap-twin");
    const common = {
      agent: "codex" as const,
      trials: 1,
      timeoutMs: 1000,
      ctxreachVersion: "0",
      codex: { bin: FAKE, userHome: fx.codexHome },
    };
    await expect(
      runVerify({ ...common, repoRoot: fx.repo, launchDir: fx.home, saveDir: path.join(tempDir("s"), "run") }),
    ).rejects.toThrow(/outside the repository/);
    await expect(
      runVerify({ ...common, repoRoot: fx.repo, launchDir: fx.repo, saveDir: fx.at("run") }),
    ).rejects.toThrow(/refusing to record inside/);
  });
});

describe("verify --agent codex without planting (bytes only)", () => {
  it("keeps a whitespace-only override empty, so the slot trap is exercised, and the decoy and prompt token remain the controls", async () => {
    const fx = materialise("codex-empty-override");
    const tmp = tempDir("verify-tmp");
    const recording = await runVerify({
      agent: "codex",
      repoRoot: fx.repo,
      launchDir: fx.at("packages/api"),
      trials: 2,
      timeoutMs: 30_000,
      saveDir: path.join(tempDir("verify-save"), "run"),
      ctxreachVersion: "0.0.0-test",
      tmpRoot: tmp,
      plant: false,
      env: { ...process.env, FAKE_CODEX_BEHAVIOUR: "ok" },
      codex: { bin: FAKE, userHome: fx.codexHome },
    });
    const result = scoreVerify(recording);
    expect(recording.manifest.planted).toBe(false);
    expect(recording.manifest.canaries.every((c) => c.decoy)).toBe(true);
    expect(result.segments.map((s) => [s.file, s.status, s.observedBytes, s.verdict])).toEqual([
      ["AGENTS.md", "loaded", 123, "EXACT"],
      ["packages/api/AGENTS.override.md", "empty", 0, "EXACT"],
    ]);
    expect(result.score.instrument).toMatchObject({
      fault: false,
      control: { seen: 2, usable: 2 },
      decoy: { seen: 0, usable: 2 },
    });
    expect(result.score.warnings.join("\n")).toContain("No tokens were planted");
    expect(agrees(result)).toBe(true);
  });

  it("is refused for Claude Code, whose capture is scored by its tokens", async () => {
    const fx = materialise("claude-local-shadows-agents");
    await expect(
      runVerify({
        agent: "claude",
        repoRoot: fx.repo,
        launchDir: fx.repo,
        trials: 1,
        timeoutMs: 1000,
        saveDir: path.join(tempDir("verify-save"), "run"),
        ctxreachVersion: "0",
        plant: false,
        claude: {
          bin: process.execPath,
          prefixArgs: [path.join(HERE, "helpers", "fake-capture-client.mjs")],
          model: "m",
        },
      }),
    ).rejects.toThrow(/--no-plant is for --agent codex only/);
  });
});

async function cli(...args: string[]) {
  let stdout = "";
  let stderr = "";
  let status = -1;
  const program = new Command().exitOverride();
  program.configureOutput({ writeOut: (t) => (stdout += t), writeErr: (t) => (stderr += t) });
  registerVerify(program, {
    io: { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) },
    setStatus: (s) => (status = s),
    version: "0.0.0-test",
    env: { ...process.env, FAKE_CODEX_BEHAVIOUR: "ok" },
  });
  await program.parseAsync(["node", "ctxreach", "verify", ...args]);
  // eslint-disable-next-line no-control-regex
  return { stdout: stdout.replace(/\u001b\[[0-9;]*m/g, ""), stderr, status };
}

describe("the verify command", () => {
  it("prints the table, the bytes and the scope lines, exits 0 on agreement, 1 on the planted pass, and replays", async () => {
    const fx = materialise("codex-root-starves-nested");
    const save = path.join(tempDir("cli-save"), "run");
    const out = await cli(
      "--agent",
      "codex",
      "--repo",
      fx.repo,
      "--from",
      fx.at("packages/api"),
      "--codex-bin",
      FAKE,
      "--codex-home",
      fx.codexHome,
      "--save",
      save,
      "--no-color",
    );
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain(
      "ctxreach verify  Codex 9.9.9, render (codex debug prompt-input), launch dir packages/api  (repo)",
    );
    expect(out.stdout).toMatch(/packages\/api\/AGENTS\.md\s+kept 538 of 1,214 B \(map: 538\)\s+EXACT/);
    expect(out.stdout).toContain("Agreement with map: 4 of 4 decided cells agree (CONFIRMED 4); 4 cells in all.");
    expect(out.stdout).toContain("Bytes: 2 of 2 chain files exact; the whole block equals map's prediction.");
    expect(out.stdout).toContain(
      "Codex's model input as rendered by `codex debug prompt-input` 9.9.9. The model was not run.",
    );
    expect(out.stdout).not.toContain("\u001b[");

    const planted = await cli(
      "--agent",
      "codex",
      "--repo",
      fx.repo,
      "--from",
      fx.at("packages/api"),
      "--codex-bin",
      FAKE,
      "--codex-home",
      fx.codexHome,
      "--save",
      path.join(tempDir("cli-save"), "run"),
      "--codex-max-bytes",
      "30000",
      "--no-color",
    );
    expect(planted.status).toBe(1);
    expect(planted.stdout).toContain("OFF BY");
    expect(planted.stdout).toContain("planted");

    const replay = await cli("--agent", "codex", "--replay", save, "--json");
    expect(replay.status).toBe(0);
    const json = VerifyJson.parse(JSON.parse(replay.stdout));
    expect(json.agreement).toMatchObject({ agree: 4, decided: 4, bytesExact: 2, bytesCompared: 2 });
    expect(json.scope[0]).toContain("The model was not run");
    expect(json.segments.map((s) => s.verdict)).toEqual(["EXACT", "EXACT"]);
  });

  it("exits 3 on an instrument fault, with no agreement figure in the JSON", async () => {
    let stdout = "";
    let status = -1;
    const program = new Command().exitOverride();
    registerVerify(program, {
      io: { stdout: (t) => (stdout += t), stderr: () => undefined },
      setStatus: (s) => (status = s),
      version: "0",
      env: { ...process.env, FAKE_CODEX_BEHAVIOUR: "echo-decoy" },
    });
    const fx = materialise("codex-over-cap-twin");
    await program.parseAsync([
      "node",
      "ctxreach",
      "verify",
      "--repo",
      fx.repo,
      "--from",
      fx.repo,
      "--codex-bin",
      FAKE,
      "--codex-home",
      fx.codexHome,
      "--save",
      path.join(tempDir("cli-save"), "run"),
      "--json",
    ]);
    expect(status).toBe(3);
    expect(VerifyJson.parse(JSON.parse(stdout)).agreement).toBeNull();
  });

  it("exits 2 and says why when the codex executable cannot be found, or --from does not exist", async () => {
    const fx = materialise("codex-over-cap-twin");
    const missing = await cli(
      "--agent",
      "codex",
      "--repo",
      fx.repo,
      "--from",
      fx.repo,
      "--codex-bin",
      path.join(fx.base, "no-such-codex.js"),
      "--codex-home",
      fx.codexHome,
      "--save",
      path.join(tempDir("cli-save"), "run"),
    );
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/^ctxreach: --codex-bin .*no-such-codex\.js does not exist\n$/);
    const from = await cli("--agent", "codex", "--from", path.join(fx.repo, "nope"));
    expect(from.status).toBe(2);
    expect(from.stderr).toBe(`ctxreach: --from ${path.join(fx.repo, "nope")} does not exist\n`);
  });
});
