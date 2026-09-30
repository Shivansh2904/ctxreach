import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  annotationsFor,
  escapeData,
  escapeProperty,
  launchDirsFor,
  mergeAnnotations,
  runAction,
  workflowCommand,
  type ActionResult,
} from "../src/report/annotations.js";
import { map } from "../src/map/map.js";
import { MapJson, toJson } from "../src/report/json.js";
import { renderSummary } from "../src/report/markdown.js";
import { materialise, tempDir, type Materialised } from "./helpers/fixture.js";
// @ts-expect-error -- plain JavaScript script without type declarations
import { knownCodes } from "../scripts/bundle-action.mjs";

/** The finding codes the bundle carries (docs/rules.md's Findings table). */
const KNOWN_CODES: readonly string[] = knownCodes();

// These tests copy repositories and start processes; on a busy machine that takes more than the default 5 s.
vi.setConfig({ testTimeout: 60_000 });

// No test here may read the real home. map falls back to this process's home (and CODEX_HOME) when it
// is given none, so point them at an empty directory for every test; withHome() below points them at a
// fixture's home instead.
const EMPTY_HOME = tempDir("empty-home");
beforeEach(() => {
  vi.stubEnv("HOME", EMPTY_HOME);
  vi.stubEnv("USERPROFILE", EMPTY_HOME);
  vi.stubEnv("CODEX_HOME", path.join(EMPTY_HOME, ".codex"));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "action", "dist", "ctxreach.cjs");

/**
 * What `ctxreach map --json` prints from a launch directory of a fixture (the same toJson, round-tripped
 * through JSON and its schema), with the fixture's own homes and nothing above the fixture: the walk
 * for Claude Code's ancestor files stops at the fixture, so no file of the real home is read.
 */
async function mapJson(fx: Materialised, from = "."): Promise<MapJson> {
  const result = map({
    launchDir: fx.at(from),
    repoRoot: fx.repo,
    codex: { home: fx.codexHome },
    claude: { home: fx.claudeHome, ceiling: fx.base },
  });
  return MapJson.parse(JSON.parse(JSON.stringify(toJson(result, "0.0.0-test"))));
}

/** The 1-based line holding byte `offset` of a file, counted here without ctxreach's code. */
function lineOfByte(file: string, offset: number): number {
  const bytes = readFileSync(file);
  let line = 1;
  for (let i = 0; i < offset; i++) if (bytes[i] === 0x0a) line++;
  return line;
}

const commands = (json: MapJson) => annotationsFor(json).map((a) => workflowCommand(a));

describe("annotations from map --json", () => {
  it("trap codex-over-cap: one warning at the exact line where Codex stops reading", async () => {
    const fx = materialise("codex-over-cap");
    const line = lineOfByte(fx.at("AGENTS.md"), 32768);
    const out = commands(await mapJson(fx));
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only).toMatch(
      new RegExp(
        `^::warning file=AGENTS\\.md,line=${line},title=ctxreach%3A Codex stops reading here \\(codex\\.cut\\)::`,
      ),
    );
    expect(only).toContain("Codex stops reading here (byte 32768 of the chain)");
    expect(only).toMatch(/Launched from: the root\.$/);
  });

  it("twin codex-over-cap-twin: no annotation", async () => {
    const fx = materialise("codex-over-cap-twin");
    expect(commands(await mapJson(fx))).toEqual([]);
  });

  it("a cut that splits a character is one annotation that says so", async () => {
    const fx = materialise("codex-utf8-cut");
    const out = commands(await mapJson(fx));
    expect(out).toHaveLength(1);
    // The title names both codes; a comma in a property is escaped as %2C.
    expect(out[0]).toContain("(codex.cut%2C codex.mid-codepoint)");
    expect(out[0]).toContain("Codex sees U+FFFD");
    expect(out[0]).toContain(`line=${lineOfByte(fx.at("AGENTS.md"), 32768)},`);
  });

  it("the demo monorepo gives the two annotations the plan names", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const out = commands(await mapJson(fx, "packages/api"));
    expect(out).toContainEqual(
      expect.stringMatching(
        /^::warning file=AGENTS\.md,line=547,.*::Codex stops reading here \(byte 32768 of the chain\)/,
      ),
    );
    expect(out).toContainEqual(
      expect.stringMatching(
        /^::warning file=CLAUDE\.local\.md,title=ctxreach%3A Switches AGENTS\.md off for Claude Code \(claude\.agents-shadowed\)::This file switches AGENTS\.md off for Claude Code: AGENTS\.md, packages\/api\/AGENTS\.md do not reach it\./,
      ),
    );
    // The package file the budget never reaches.
    expect(out).toContainEqual(
      expect.stringMatching(/^::warning file=packages\/api\/AGENTS\.md,line=1,.*codex\.no-budget/),
    );
  });

  it("a CLAUDE.md in a package's own directory is the file that switches its AGENTS.md off", async () => {
    const fx = materialise("claude-root-shadows-package-twin");
    writeFileSync(fx.at("packages/api/CLAUDE.md"), "# api\n");
    const json = await mapJson(fx);
    expect(json.claude?.agentsMd.read).toBe(true);
    const out = annotationsFor(json).filter((a) => a.codes.includes("claude.agents-shadowed"));
    expect(out.map((a) => [a.file, a.subjects])).toEqual([["packages/api/CLAUDE.md", ["packages/api/AGENTS.md"]]]);
  });

  it("the same warning from several launch directories is one annotation naming them all", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const merged = mergeAnnotations([
      annotationsFor(await mapJson(fx, ".")),
      annotationsFor(await mapJson(fx, "packages/api")),
    ]);
    const cut = merged.filter((a) => a.codes.includes("codex.cut"));
    expect(cut.map((a) => [a.file, a.line, a.from])).toEqual([["AGENTS.md", 547, [".", "packages/api"]]]);
    const off = merged.filter((a) => a.codes.includes("claude.agents-shadowed"));
    expect(off.map((a) => [a.file, a.from, a.subjects])).toEqual([
      ["CLAUDE.local.md", [".", "packages/api"], ["AGENTS.md", "packages/api/AGENTS.md", "packages/web/AGENTS.md"]],
    ]);
    expect(off[0]?.message).toContain("packages/web/AGENTS.md do not reach it");
    expect(workflowCommand(off[0]!)).toMatch(/Launched from: the root, packages\/api\.$/);
  });
});

describe("workflow command escaping", () => {
  it("escapes %, CR and LF in the message, and also : and , in properties", () => {
    expect(escapeData("100% done\r\nnext")).toBe("100%25 done%0D%0Anext");
    expect(escapeProperty("a:b,c%")).toBe("a%3Ab%2Cc%25");
    const line = workflowCommand({
      file: "dir,x/AGENTS:1.md",
      line: 3,
      codes: ["codex.cut"],
      title: "t",
      message: "a\nb 5%",
      from: ["."],
    });
    expect(line).toBe(
      "::warning file=dir%2Cx/AGENTS%3A1.md,line=3,title=ctxreach%3A t (codex.cut)::a%0Ab 5%25 Launched from: the root.",
    );
    // One command per line, whatever the message held.
    expect(line.split("\n")).toHaveLength(1);
  });
});

describe("the job summary", () => {
  it("has the matrix of each launch directory, warnings first", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const runs = [await mapJson(fx, "."), await mapJson(fx, "packages/api")];
    const md = renderSummary(runs, { version: "9.9.9", scanned: ".", annotations: 3 });
    expect(md).toContain("Predicted by ctxreach 9.9.9 from each agent's documented loading rules");
    expect(md).toContain("No agent was run.");
    expect(md).toContain(
      "| `AGENTS.md` | launch, cut at byte 32768 (line 547) | no: switched off by CLAUDE.local.md |",
    );
    expect(md).toContain("| `packages/api/AGENTS.md` | no: budget used up by earlier files |");
    expect(md.indexOf("### From `.`")).toBeLessThan(md.indexOf("### From `packages/api`"));
    expect(md).toContain("2 launch directories, 10 warnings in all, 3 annotations");
  });

  it("leaves out sections past the size limit, and says how many", async () => {
    const fx = materialise("demo-monorepo", { example: true });
    const runs = [await mapJson(fx, "."), await mapJson(fx, "packages/api")];
    const whole = renderSummary(runs, { version: "1", scanned: ".", annotations: 0 });
    const cut = renderSummary(runs, { version: "1", scanned: ".", annotations: 0, limit: whole.length - 10 });
    expect(cut).toContain("1 more launch directory is left out");
    expect(cut).not.toContain("### From `packages/api`");
  });

  it("trap: counts the limit in bytes, so a section in CJK that fits in characters is still left out", async () => {
    const fx = materialise("codex-over-cap-twin");
    const root = await mapJson(fx);
    const cjk: MapJson = JSON.parse(JSON.stringify(root));
    cjk.launchDir = "包";
    cjk.matrix[0]!.path = "文档/".repeat(200) + "AGENTS.md";
    const whole = renderSummary([root, cjk], { version: "1", scanned: ".", annotations: 0 });
    const size = Buffer.byteLength(whole, "utf8");
    // Counted in characters, the whole summary would fit under a limit 10 bytes short of its size.
    expect(whole.length).toBeLessThan(size - 10);
    const cut = renderSummary([root, cjk], { version: "1", scanned: ".", annotations: 0, limit: size - 10 });
    expect(cut).toContain("1 more launch directory is left out");
    expect(cut).not.toContain("### From `包`");
  });

  it("twin: a CJK summary exactly at the limit is whole", async () => {
    const fx = materialise("codex-over-cap-twin");
    const root = await mapJson(fx);
    const cjk: MapJson = JSON.parse(JSON.stringify(root));
    cjk.launchDir = "包";
    cjk.matrix[0]!.path = "文档/".repeat(200) + "AGENTS.md";
    const whole = renderSummary([root, cjk], { version: "1", scanned: ".", annotations: 0 });
    const exact = renderSummary([root, cjk], {
      version: "1",
      scanned: ".",
      annotations: 0,
      limit: Buffer.byteLength(whole, "utf8"),
    });
    expect(exact).toBe(whole);
    expect(exact).not.toContain("left out");
  });

  it("escapes a | in a table cell", async () => {
    const fx = materialise("codex-over-cap-twin");
    const json = await mapJson(fx);
    json.matrix[0]!.path = "a|b.md";
    expect(renderSummary([json], { version: "1", scanned: ".", annotations: 0 })).toContain("| `a\\|b.md` |");
  });
});

/** Run the Action in this process, as action.yml would, and collect what it printed and wrote. */
function action(env: Record<string, string>, cwd = ROOT) {
  const out = tempDir("action-out");
  const files = { output: path.join(out, "output"), summary: path.join(out, "summary.md") };
  writeFileSync(files.output, "");
  writeFileSync(files.summary, "");
  let stdout = "";
  let stderr = "";
  const result: ActionResult = runAction({
    env: { RUNNER_TEMP: out, GITHUB_OUTPUT: files.output, GITHUB_STEP_SUMMARY: files.summary, ...env },
    cwd,
    version: "0.0.0-test",
    knownCodes: KNOWN_CODES,
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
  });
  const outputs = Object.fromEntries(
    readFileSync(files.output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return { ...result, stdout, stderr, outputs, summary: readFileSync(files.summary, "utf8") };
}

const warningLines = (stdout: string) => stdout.split("\n").filter((l) => l.startsWith("::warning"));

describe("the Action (runAction)", () => {
  it("auto launch dirs: the scanned directory and every directory holding an instruction file", () => {
    const fx = materialise("demo-monorepo", { example: true });
    mkdirSync(fx.at("tools/.claude"), { recursive: true });
    writeFileSync(fx.at("tools/.claude/CLAUDE.md"), "# tools\n");
    const rel = launchDirsFor(fx.repo, "auto").map((d) => path.relative(fx.repo, d).split(path.sep).join("/") || ".");
    expect(rel).toEqual([".", "packages/api", "packages/web", "tools"]);
  });

  it("trap: at least one annotation, the outputs set, and the step passes under fail-on none", () => {
    const fx = materialise("codex-over-cap");
    const r = action({ INPUT_PATH: fx.repo });
    expect(r.status).toBe(0);
    expect(warningLines(r.stdout).length).toBeGreaterThanOrEqual(1);
    expect(r.outputs.annotations).toBe(String(warningLines(r.stdout).length));
    expect(r.outputs["launch-dirs"]).toBe("1");
    expect(r.summary).toContain("## ctxreach map");
    const saved = JSON.parse(readFileSync(r.outputs.json!, "utf8")) as { runs: unknown[] };
    expect(saved.runs.map((x) => MapJson.parse(x).launchDir)).toEqual(["."]);
  });

  it("twin: no annotation, and fail-on warn still passes", () => {
    const fx = materialise("codex-over-cap-twin");
    const r = action({ INPUT_PATH: fx.repo, INPUT_FAIL_ON: "warn" });
    expect(warningLines(r.stdout)).toEqual([]);
    expect(r.outputs.annotations).toBe("0");
    expect(r.status).toBe(0);
  });

  it("fail-on warn fails the trap; fail-on with codes fails only on those codes", () => {
    const fx = materialise("codex-over-cap");
    expect(action({ INPUT_PATH: fx.repo, INPUT_FAIL_ON: "warn" }).status).toBe(1);
    expect(action({ INPUT_PATH: fx.repo, INPUT_FAIL_ON: "codex.cut" }).status).toBe(1);
    expect(action({ INPUT_PATH: fx.repo, INPUT_FAIL_ON: "claude.agents-shadowed,codex.no-budget" }).status).toBe(0);
  });

  /**
   * Point this process's home (and CODEX_HOME) at a fixture's home for the rest of the test (afterEach
   * undoes it), so code that fell back to the default homes would read the fixture's personal
   * configuration, never the real ~/.codex or ~/.claude. map reads process.env, not the env the Action
   * is given.
   */
  function withHome<T>(fx: Materialised, body: () => T): T {
    vi.stubEnv("HOME", fx.home);
    vi.stubEnv("USERPROFILE", fx.home);
    vi.stubEnv("CODEX_HOME", fx.codexHome);
    return body();
  }

  it("models no personal Codex configuration, whatever the runner's home holds", () => {
    // The fixture's ~/.codex/config.toml sets project_doc_max_bytes = 65536.
    const fx = materialise("codex-project-config-twin");
    withHome(fx, () => {
      // Twin: the default home, as map resolves it here, does hold that budget, so a fallback would show.
      expect(map({ launchDir: fx.repo, repoRoot: fx.repo, agents: ["codex"] }).codex?.budget.limit).toBe(65536);
      const run = action({ INPUT_PATH: fx.repo }).runs[0]!;
      expect(run.codex?.settings.every((x) => x.from === "default")).toBe(true);
      expect(run.codex?.budget.limit).toBe(32768);
    });
  });

  it("models no personal Claude Code configuration, whatever the runner's home holds", () => {
    // The fixture's ~/.claude/settings.json sets Project instructions to claude-md-and-agents-md.
    const fx = materialise("claude-mode-in-project-settings-twin");
    withHome(fx, () => {
      // Twin: the default home, as map resolves it here, does hold that setting.
      expect(
        map({ launchDir: fx.repo, repoRoot: fx.repo, agents: ["claude"], claude: { ceiling: fx.base } }).claude?.mode,
      ).toBe("claude-md-and-agents-md");
      const run = action({ INPUT_PATH: fx.repo }).runs[0]!;
      expect([run.claude?.mode, run.claude?.modeFrom]).toEqual(["claude-md-or-agents-md", "default"]);
      expect(run.findings.map((f) => f.code)).toContain("claude.agents-shadowed");
    });
  });

  it("only the agents asked for", () => {
    const fx = materialise("codex-over-cap");
    const r = action({ INPUT_PATH: fx.repo, INPUT_AGENTS: "claude" });
    expect(r.runs[0]?.codex).toBeUndefined();
    expect(warningLines(r.stdout)).toEqual([]);
  });

  it("explicit launch dirs, relative to path", () => {
    const fx = materialise("demo-monorepo", { example: true });
    const r = action({ INPUT_PATH: fx.repo, INPUT_LAUNCH_DIRS: "packages/api\n" });
    expect(r.runs.map((x) => x.launchDir)).toEqual(["packages/api"]);
  });

  it.each([
    [{ INPUT_AGENTS: "gemini" }, /unknown agent "gemini"/],
    [{ INPUT_FAIL_ON: "sometimes" }, /fail-on: "sometimes"/],
    [{ INPUT_FAIL_ON: "codex.cut,codex.cuts" }, /fail-on: "codex\.cuts" is not a finding code ctxreach reports/],
    [{ INPUT_LAUNCH_DIRS: ".." }, /launch-dirs: \.\. is outside/],
    [{ INPUT_LAUNCH_DIRS: "nope" }, /launch-dirs: nope is not a directory/],
    [{ INPUT_PATH: "no/such/dir" }, /path no\/such\/dir is not a directory/],
  ])("an input error exits 2 with an ::error line: %o", (env, message) => {
    const fx = materialise("codex-over-cap");
    const r = action({ INPUT_PATH: fx.repo, ...env }, fx.base);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/^::error title=ctxreach::/);
    expect(r.stdout).toMatch(message);
  });

  it("names files relative to the workspace when the scanned directory is inside it", () => {
    const fx = materialise("codex-over-cap");
    const r = action({ INPUT_PATH: "repo", GITHUB_WORKSPACE: fx.base }, fx.base);
    expect(warningLines(r.stdout)[0]).toMatch(/^::warning file=repo\/AGENTS\.md,line=\d+,/);
  });
});

// ---------------------------------------------------------------------------
// action.yml and its committed bundle, run the way GitHub runs them.

const ACTION_YML = readFileSync(path.join(ROOT, "action.yml"), "utf8");

/** The inputs action.yml declares, with their defaults (a deliberately small reader for this one file). */
function declaredInputs(): Map<string, string> {
  const block = ACTION_YML.split(/^inputs:\n/m)[1]?.split(/^\S/m)[0] ?? "";
  const inputs = new Map<string, string>();
  let current: string | undefined;
  for (const line of block.split("\n")) {
    const name = /^ {2}([a-z-]+):$/.exec(line);
    if (name) current = name[1];
    const def = /^ {4}default: (.*)$/.exec(line);
    if (def && current) inputs.set(current, def[1]!.replace(/^"(.*)"$/, "$1"));
  }
  return inputs;
}

/** The env block of the composite step: variable name -> input name. */
function stepEnv(): Map<string, string> {
  return new Map(
    [...ACTION_YML.matchAll(/^ {8}(INPUT_[A-Z_]+): \$\{\{ inputs\.([a-z-]+) \}\}$/gm)].map((m) => [m[1]!, m[2]!]),
  );
}

/** Run the committed bundle with exactly the environment action.yml's step gives it. */
function composite(inputs: Record<string, string>, workspace: string) {
  const values = new Map(declaredInputs());
  for (const [k, v] of Object.entries(inputs)) values.set(k, v);
  const out = tempDir("composite");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    SYSTEMROOT: process.env.SYSTEMROOT ?? "",
    // An empty home, so the bundle could not read the real one even if it fell back to it.
    HOME: EMPTY_HOME,
    USERPROFILE: EMPTY_HOME,
    GITHUB_WORKSPACE: workspace,
    GITHUB_ACTION_PATH: ROOT,
    RUNNER_TEMP: out,
    GITHUB_OUTPUT: path.join(out, "output"),
    GITHUB_STEP_SUMMARY: path.join(out, "summary.md"),
  };
  for (const [variable, input] of stepEnv()) env[variable] = values.get(input) ?? "";
  writeFileSync(env.GITHUB_OUTPUT!, "");
  writeFileSync(env.GITHUB_STEP_SUMMARY!, "");
  const run = /^ {6}run: node "\$\{\{ github\.action_path \}\}\/(action\/dist\/ctxreach\.cjs)"$/m.exec(ACTION_YML);
  expect(run, "action.yml's step runs the bundle").not.toBeNull();
  const p = spawnSync(process.execPath, [path.join(ROOT, run![1]!)], { cwd: workspace, env, encoding: "utf8" });
  return {
    status: p.status,
    stdout: p.stdout,
    stderr: p.stderr,
    output: readFileSync(env.GITHUB_OUTPUT!, "utf8"),
    summary: readFileSync(env.GITHUB_STEP_SUMMARY!, "utf8"),
  };
}

describe("action.yml", () => {
  it("passes every input to the step, and nothing else", () => {
    const inputs = declaredInputs();
    expect([...inputs.keys()]).toEqual(["path", "launch-dirs", "agents", "fail-on"]);
    const env = stepEnv();
    expect([...env.values()].sort()).toEqual([...inputs.keys()].sort());
    for (const [variable, input] of env) expect(variable).toBe(`INPUT_${input.toUpperCase().replace(/-/g, "_")}`);
  });

  it("maps each output to the step's output of the same name", () => {
    const outputs = [
      ...ACTION_YML.matchAll(/^ {2}([a-z-]+):\n.*\n {4}value: \$\{\{ steps\.map\.outputs\.([a-z-]+) \}\}$/gm),
    ];
    expect(outputs.map((m) => [m[1], m[2]])).toEqual([
      ["annotations", "annotations"],
      ["warnings", "warnings"],
      ["launch-dirs", "launch-dirs"],
      ["json", "json"],
    ]);
  });
});

describe("the committed bundle, run as action.yml runs it (selftest)", () => {
  it("trap: at least one annotation", () => {
    const fx = materialise("codex-over-cap");
    const r = composite({ path: "repo" }, fx.base);
    expect(r.status, r.stderr).toBe(0);
    expect(warningLines(r.stdout).length).toBeGreaterThanOrEqual(1);
    expect(r.stdout).toContain("::warning file=repo/AGENTS.md,line=");
    expect(r.output).toMatch(/^annotations=[1-9]\d*$/m);
    expect(r.summary).toContain("### From `.`");
  });

  it("twin: exactly zero annotations", () => {
    const fx = materialise("codex-over-cap-twin");
    const r = composite({ path: "repo", "fail-on": "warn" }, fx.base);
    expect(r.status, r.stderr).toBe(0);
    expect(warningLines(r.stdout)).toEqual([]);
    expect(r.output).toMatch(/^annotations=0$/m);
  });

  it("fail-on warn fails the step on the trap", () => {
    const fx = materialise("codex-over-cap");
    expect(composite({ path: "repo", "fail-on": "warn" }, fx.base).status).toBe(1);
  });

  it("carries the finding codes: a code with a typo is an input error, the real code fails the trap", () => {
    const fx = materialise("codex-over-cap");
    const typo = composite({ path: "repo", "fail-on": "codex.cuts" }, fx.base);
    expect(typo.status).toBe(2);
    expect(typo.stdout).toMatch(/^::error title=ctxreach::fail-on: "codex\.cuts" is not a finding code/);
    expect(composite({ path: "repo", "fail-on": "codex.cut" }, fx.base).status).toBe(1);
  });
});

describe("the finding codes fail-on may name", () => {
  it("are the Findings table of docs/rules.md", () => {
    const doc = readFileSync(path.join(ROOT, "docs", "rules.md"), "utf8");
    const findings = doc.split(/^## Findings$/m)[1]?.split(/^## /m)[0] ?? "";
    // Read here without the script's parser: the first column of each table row.
    const codes = [...findings.matchAll(/^\| `((?:codex|claude)\.[a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThanOrEqual(20);
    expect([...KNOWN_CODES]).toEqual([...new Set(codes)].sort());
    expect(KNOWN_CODES).toContain("codex.cut");
    expect(KNOWN_CODES).toContain("claude.agents-shadowed");
  });
});

describe("bundle freshness", () => {
  const check = (...args: string[]) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts", "bundle-action.mjs"), "--check", ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });

  it("the committed bundle matches a fresh build", () => {
    const r = check();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/matches a fresh build/);
  });

  it("a bundle one byte off fails the check, naming the byte", () => {
    const copy = path.join(tempDir("drift"), "ctxreach.cjs");
    copyFileSync(BUNDLE, copy);
    const bytes = readFileSync(copy);
    const at = Math.floor(bytes.length / 2);
    bytes[at] = bytes[at] === 0x20 ? 0x21 : 0x20;
    writeFileSync(copy, bytes);
    const r = check("--against", copy);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`differs from a fresh build at byte ${at}`);
  });
});
