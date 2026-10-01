import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCli } from "../src/program.js";
import { MapJson } from "../src/report/json.js";
import { ancestors } from "../src/util/fs.js";
import { materialise } from "./helpers/fixture.js";

async function ctxreach(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const cli = createCli({ stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) }, { exitOverride: true });
  await cli.program.parseAsync(["node", "ctxreach", ...args]);
  // eslint-disable-next-line no-control-regex
  const plain = stdout.replace(/\u001b\[[0-9;]*m/g, "");
  return { stdout: plain, stderr, status: cli.status };
}

describe("ctxreach map", () => {
  it("prints the chain and the cut, and exits 1 under --fail-on-warn", async () => {
    const fx = materialise("codex-root-starves-nested");
    const out = await ctxreach(
      "map",
      "--agents",
      "codex",
      "--from",
      fx.at("packages/api"),
      "--codex-home",
      fx.codexHome,
      "--fail-on-warn",
    );
    expect(out.stdout).toContain("packages/api/AGENTS.md  1152   first 600 bytes (cut at line 15)");
    expect(out.stdout).toContain('Sections that never reach Codex: "Testing", "Payments".');
    expect(out.status).toBe(1);
  });

  it("exits 0 under --fail-on-warn when there is nothing to warn about", async () => {
    const fx = materialise("codex-root-starves-nested-twin");
    const out = await ctxreach(
      "map",
      "--agents",
      "codex",
      "--from",
      fx.at("packages/api"),
      "--codex-home",
      fx.codexHome,
      "--fail-on-warn",
    );
    expect(out.stdout).toContain("No findings.");
    expect(out.status).toBe(0);
  });

  it("prints JSON that matches the published schema, with repo-relative paths", async () => {
    const fx = materialise("codex-root-starves-nested");
    const out = await ctxreach(
      "map",
      "--agents",
      "codex",
      "--from",
      fx.at("packages/api"),
      "--codex-home",
      fx.codexHome,
      "--json",
    );
    const json = MapJson.parse(JSON.parse(out.stdout));
    expect(json.launchDir).toBe("packages/api");
    expect(json.codex?.chain.map((e) => [e.path, e.status, e.keptBytes])).toEqual([
      ["AGENTS.md", "loaded", 32168],
      ["packages/api/AGENTS.md", "cut", 600],
    ]);
    expect(json.findings.map((f) => [f.code, f.path])).toEqual([["codex.cut", "packages/api/AGENTS.md"]]);
  });

  it("applies --codex-max-bytes over every config file", async () => {
    const fx = materialise("codex-root-starves-nested");
    const out = await ctxreach(
      "map",
      "--agents",
      "codex",
      "--from",
      fx.at("packages/api"),
      "--codex-home",
      fx.codexHome,
      "--json",
      "--codex-max-bytes",
      "65536",
    );
    const json = MapJson.parse(JSON.parse(out.stdout));
    expect(json.codex?.chain.map((e) => e.status)).toEqual(["loaded", "loaded"]);
    expect(json.codex?.settings.find((s) => s.key === "project_doc_max_bytes")).toEqual({
      key: "project_doc_max_bytes",
      value: 65536,
      from: "override",
    });
  });

  it("reports a broken Codex config on stderr and exits 2", async () => {
    const fx = materialise("codex-over-cap-twin");
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(path.join(fx.codexHome, "config.toml"), "project_doc_max_bytes = [\n");
    const out = await ctxreach("map", "--agents", "codex", "--from", fx.repo, "--codex-home", fx.codexHome);
    expect(out.status).toBe(2);
    expect(out.stderr).toMatch(/config\.toml: not valid TOML/);
    expect(out.stdout).toBe("");
  });

  it("models both agents by default and passes the Claude Code options through", async () => {
    const fx = materialise("claude-local-shadows-agents");
    // The CLI walks up to the filesystem root like Claude Code does, so a
    // CLAUDE.md above the temp directory would change this test's answer.
    // Fail with a clear message rather than a confusing diff.
    const above = ancestors(path.dirname(fx.base)).flatMap((d) =>
      ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]
        .map((n) => path.join(d, n))
        .filter((p) => existsSync(p)),
    );
    expect(above, "instruction files above the temp directory").toEqual([]);

    const out = await ctxreach("map", "--from", fx.repo, "--codex-home", fx.codexHome, "--claude-home", fx.claudeHome);
    expect(out.stdout).toMatch(/AGENTS\.md\s+launch\s+no: switched off by CLAUDE\.local\.md/);
    expect(out.stdout).toMatch(/CLAUDE\.local\.md\s+no: not a Codex instruction file\s+launch/);

    const both = await ctxreach(
      "map",
      "--from",
      fx.repo,
      "--codex-home",
      fx.codexHome,
      "--claude-home",
      fx.claudeHome,
      "--claude-mode",
      "claude-md-and-agents-md",
      "--claude-version",
      "2.1.280",
      "--json",
    );
    const json = MapJson.parse(JSON.parse(both.stdout));
    expect(json.claude?.mode).toBe("claude-md-and-agents-md");
    expect(json.claude?.version).toBe("2.1.280");
    expect(json.matrix.find((m) => m.path === "AGENTS.md")?.claude?.delivery).toBe("launch");
  });

  it("exits 2 when --from does not exist", async () => {
    const fx = materialise("codex-over-cap-twin");
    const missing = path.join(fx.repo, "packages", "nope");
    const out = await ctxreach("map", "--from", missing, "--codex-home", fx.codexHome, "--claude-home", fx.claudeHome);
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(`ctxreach: --from ${missing} does not exist\n`);
    expect(out.stdout).toBe("");
  });

  it("exits 2 when --from is a file", async () => {
    const fx = materialise("codex-over-cap-twin");
    const file = fx.at("AGENTS.md");
    const out = await ctxreach("map", "--from", file, "--codex-home", fx.codexHome, "--claude-home", fx.claudeHome);
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(`ctxreach: --from ${file} is a file, not a directory\n`);
    expect(out.stdout).toBe("");
  });

  it("exits 2 when --repo does not exist", async () => {
    const fx = materialise("codex-over-cap-twin");
    const missing = path.join(fx.base, "elsewhere");
    const out = await ctxreach("map", "--from", fx.repo, "--repo", missing, "--codex-home", fx.codexHome);
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(`ctxreach: --repo ${missing} does not exist\n`);
    expect(out.stdout).toBe("");
  });

  it("exits 2 when --from is outside --repo", async () => {
    const fx = materialise("codex-root-starves-nested");
    const out = await ctxreach(
      "map",
      "--from",
      fx.home,
      "--repo",
      fx.repo,
      "--codex-home",
      fx.codexHome,
      "--claude-home",
      fx.claudeHome,
    );
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(`ctxreach: --from ${fx.home} is outside --repo ${fx.repo}\n`);
    expect(out.stdout).toBe("");
  });

  it("names the resolved path when a relative --from does not exist", async () => {
    const out = await ctxreach("map", "--from", "no-such-dir-for-ctxreach");
    expect(out.status).toBe(2);
    expect(out.stderr).toBe(
      `ctxreach: --from no-such-dir-for-ctxreach does not exist (resolved to ${path.resolve("no-such-dir-for-ctxreach")})\n`,
    );
  });

  it("rejects a malformed --claude-version", async () => {
    await expect(ctxreach("map", "--claude-version", "latest")).rejects.toThrow(/must look like 2\.1\.280/);
  });

  it("rejects an unknown agent", async () => {
    await expect(ctxreach("map", "--agents", "codex,gemini")).rejects.toThrow(/unknown agent "gemini"/);
  });
});

describe("ctxreach verify (registered by createCli)", () => {
  const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "recorded", "verify");

  it("replays a Codex render through the CLI: exit 0 on agreement, JSON with schema ctxreach.verify/v1", async () => {
    const dir = path.join(RECORDED, "codex-root-starves-nested-packages-api");
    const out = await ctxreach("verify", "--agent", "codex", "--replay", dir, "--json");
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    const json = JSON.parse(out.stdout) as { schema: string; agent: string };
    expect(json).toMatchObject({ schema: "ctxreach.verify/v1", agent: "codex" });
  });

  it("exits 1 on the planted-fault recording, and 2 when the recording is of another agent", async () => {
    const planted = await ctxreach(
      "verify",
      "--agent",
      "codex",
      "--replay",
      path.join(RECORDED, "codex-planted-over-cap-root"),
    );
    expect(planted.status).toBe(1);
    const wrong = await ctxreach("verify", "--agent", "claude", "--replay", path.join(RECORDED, "codex-over-cap-root"));
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toMatch(/is a codex recording; pass --agent codex/);
  });
});
