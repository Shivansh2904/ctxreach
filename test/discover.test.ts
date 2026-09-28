import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSurfaces } from "../src/discover/surfaces.js";
import { materialise } from "./helpers/fixture.js";

describe("discoverSurfaces", () => {
  it("lists every instruction file with its kind, owner directory and size", () => {
    const fx = materialise("codex-override-wins");
    mkdirSync(fx.at(".claude/rules/api"), { recursive: true });
    writeFileSync(fx.at(".claude/CLAUDE.md"), "# Claude\n");
    writeFileSync(fx.at(".claude/rules/api/handlers.md"), "---\npaths: src/**\n---\n# Handlers\n");
    writeFileSync(fx.at("CLAUDE.local.md"), "# Mine\n");
    writeFileSync(fx.at("packages/api/TEAM_GUIDE.md"), "# Team\n");
    mkdirSync(fx.at("node_modules/dep"), { recursive: true });
    writeFileSync(fx.at("node_modules/dep/AGENTS.md"), "# vendored\n");
    writeFileSync(fx.at(".git/AGENTS.md"), "# not a real file\n");

    const found = discoverSurfaces(fx.repo, { fallbackNames: ["TEAM_GUIDE.md"] });
    expect(found.map((s) => [s.rel, s.kind, path.relative(fx.repo, s.dir) || "."])).toEqual([
      [".claude/CLAUDE.md", ".claude/CLAUDE.md", "."],
      [".claude/rules/api/handlers.md", ".claude/rules", "."],
      ["AGENTS.md", "AGENTS.md", "."],
      ["CLAUDE.local.md", "CLAUDE.local.md", "."],
      ["packages/api/AGENTS.md", "AGENTS.md", path.join("packages", "api")],
      ["packages/api/AGENTS.override.md", "AGENTS.override.md", path.join("packages", "api")],
      ["packages/api/TEAM_GUIDE.md", "fallback", path.join("packages", "api")],
    ]);
    expect(found.find((s) => s.rel === "AGENTS.md")?.bytes).toBe(123);
  });

  it("matches names exactly, so agents.md is not AGENTS.md", () => {
    const fx = materialise("codex-nested-below-cwd-twin");
    writeFileSync(fx.at("packages/api/agents.md"), "# lower case\n");
    expect(discoverSurfaces(fx.repo).map((s) => s.rel)).toEqual(["AGENTS.md"]);
  });

  it("does not follow a symlinked directory", (ctx) => {
    const fx = materialise("codex-nested-below-cwd-twin");
    try {
      symlinkSync(fx.repo, fx.at("packages/loop"), "junction");
    } catch {
      ctx.skip();
    }
    expect(discoverSurfaces(fx.repo).map((s) => s.rel)).toEqual(["AGENTS.md"]);
  });
});
