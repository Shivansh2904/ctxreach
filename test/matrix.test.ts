import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { map, type MapResult } from "../src/map/map.js";
import { toJson } from "../src/report/json.js";
import { renderTerminal } from "../src/report/terminal.js";
import { materialise, type Materialised } from "./helpers/fixture.js";

function run(fx: Materialised, from: string): MapResult {
  return map({
    launchDir: fx.at(from),
    codex: { home: fx.codexHome },
    claude: { home: fx.claudeHome, ceiling: fx.base },
  });
}

/** The matrix as { file: [codex, claude] } with "delivery: why" cells. */
function grid(fx: Materialised, r: MapResult): Record<string, [string, string]> {
  const cell = (c?: { delivery: string; why: string }) => (c ? `${c.delivery}: ${c.why}` : "");
  return Object.fromEntries(
    r.matrix.map((row) => [
      path.relative(fx.repo, row.path).split(path.sep).join("/"),
      [cell(row.cells.codex), cell(row.cells.claude)],
    ]),
  );
}

describe("files x agents matrix on the demo monorepo", () => {
  it("launched in packages/api: neither agent receives the payments rule", () => {
    const fx = materialise("demo-monorepo", { example: true });
    const r = run(fx, "packages/api");
    expect(grid(fx, r)).toEqual({
      "AGENTS.md": ["launch-cut: cut at byte 32768 of 40960", "not-loaded: switched off by CLAUDE.local.md"],
      "CLAUDE.local.md": ["not-loaded: not a Codex instruction file", "launch: ancestor of launch dir"],
      "packages/api/AGENTS.md": [
        "not-loaded: budget used up by earlier files",
        "not-loaded: switched off by CLAUDE.local.md",
      ],
      "packages/web/AGENTS.md": [
        "not-loaded: not on the path from the project root to the launch dir",
        "not-loaded: outside the launch dir's tree",
      ],
    });
    const codes = r.findings.map((f) => `${f.agent}:${f.code}`);
    expect(codes).toEqual([
      "codex:codex.cut",
      "codex:codex.no-budget",
      "claude:claude.agents-shadowed",
      "claude:claude.agents-shadowed",
    ]);
    // The sibling package's file is out of reach for a different reason, and is not blamed on CLAUDE.local.md.
    expect(
      r.findings
        .filter((f) => f.code === "claude.agents-shadowed")
        .map((f) => path.basename(path.dirname(f.path ?? ""))),
    ).toEqual([path.basename(fx.repo), "api"]);
  });

  it("launched at the root: the package files are not preloaded by Codex and switched off for Claude", () => {
    const fx = materialise("demo-monorepo", { example: true });
    const r = run(fx, ".");
    expect(grid(fx, r)).toMatchObject({
      "AGENTS.md": ["launch-cut: cut at byte 32768 of 40960", "not-loaded: switched off by CLAUDE.local.md"],
      "packages/api/AGENTS.md": [
        "maybe: below launch dir: not preloaded",
        "not-loaded: switched off by CLAUDE.local.md",
      ],
    });
  });

  it("renders the matrix in the terminal report and in JSON", () => {
    const fx = materialise("demo-monorepo", { example: true });
    const r = run(fx, "packages/api");
    // eslint-disable-next-line no-control-regex
    const text = renderTerminal(r).replace(/\u001b\[[0-9;]*m/g, "");
    expect(text).toMatch(/AGENTS\.md\s+launch, cut at byte 32768\s+no: switched off by CLAUDE\.local\.md/);
    expect(text).toMatch(/packages\/api\/AGENTS\.md\s+no: budget used up by earlier files/);
    const json = toJson(r, "test");
    expect(json.matrix.find((m) => m.path === "packages/api/AGENTS.md")).toMatchObject({
      codex: { delivery: "not-loaded", rule: "codex.budget" },
      claude: { delivery: "not-loaded", rule: "claude.agents-default" },
    });
    expect(json.claude?.agentsMd).toEqual({ read: false, reason: "switched off by CLAUDE.local.md" });
  });
});

describe("matrix cells for files an agent's resolver never looked at", () => {
  it("marks a shadowed file below the launch directory as not preloaded, for Codex", () => {
    const fx = materialise("codex-override-wins");
    const r = run(fx, ".");
    expect(grid(fx, r)["packages/api/AGENTS.override.md"]?.[0]).toBe("maybe: below launch dir: not preloaded");
    expect(grid(fx, r)["packages/api/AGENTS.md"]?.[0]).toBe("maybe: below launch dir: not preloaded");
  });

  it("marks a file above Codex's project root as such", () => {
    const fx = materialise("codex-override-wins-twin");
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(path.join(fx.codexHome, "config.toml"), "project_root_markers = []\n");
    const r = run(fx, "packages/api");
    expect(grid(fx, r)["AGENTS.md"]?.[0]).toBe("not-loaded: above the project root");
    expect(grid(fx, r)["packages/api/AGENTS.md"]?.[0]).toBe("launch: 1152 bytes");
  });

  it("marks Codex's global file as one Claude Code does not read", () => {
    const fx = materialise("codex-override-wins-twin");
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(path.join(fx.codexHome, "AGENTS.md"), "# Global\n");
    const r = run(fx, ".");
    const global = r.matrix.find((m) => m.path === path.join(fx.codexHome, "AGENTS.md"));
    expect(global?.cells).toMatchObject({
      codex: { delivery: "launch", rule: "codex.global" },
      claude: { delivery: "not-loaded", why: "not a file Claude Code reads" },
    });
    // Files outside the repository come first, even when an in-repository
    // path would sort before "../" ("+" sorts before ".").
    mkdirSync(fx.at("+notes"));
    writeFileSync(fx.at("+notes/AGENTS.md"), "# Notes\n");
    const again = run(fx, ".");
    expect(again.matrix.map((m) => path.relative(fx.repo, m.path).split(path.sep).join("/"))).toEqual([
      "../home/.codex/AGENTS.md",
      "+notes/AGENTS.md",
      "AGENTS.md",
      "packages/api/AGENTS.md",
    ]);
  });
});
