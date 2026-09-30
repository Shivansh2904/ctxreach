import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodex, type CodexResult } from "../src/agents/codex/resolve.js";
import { decodeLossy } from "../src/util/text.js";
import { materialise, type Materialised } from "./helpers/fixture.js";

function run(fx: Materialised, from = ".", extra: Partial<Parameters<typeof resolveCodex>[0]> = {}): CodexResult {
  return resolveCodex({ launchDir: fx.at(from), codexHome: fx.codexHome, scanRoot: fx.repo, ...extra });
}

const codes = (r: CodexResult) => r.findings.map((f) => f.code);
const names = (r: CodexResult) =>
  r.chain.map((e) => path.relative(r.settings.projectRoot, e.path).split(path.sep).join("/"));

describe("trap: a root file over the default budget", () => {
  it("is cut at byte 32768 and the lost sections are named", () => {
    const r = run(materialise("codex-over-cap"));
    expect(r.chain).toHaveLength(1);
    const [entry] = r.chain;
    expect(entry?.status).toBe("cut");
    expect(entry?.bytes).toBe(40960);
    expect(entry?.keptBytes).toBe(32768);
    expect(entry?.cut?.at).toBe(32768);
    expect(entry?.cut?.midCodepoint).toBe(false);
    expect(entry?.cut?.cutSection).toMatch(/^General \d+$/);
    expect(entry?.cut?.lostSections.length).toBeGreaterThan(0);
    expect(entry?.cut?.lostSections.at(-1)).toBe("General 76");
    expect(codes(r)).toEqual(["codex.cut"]);
    expect(r.budget).toEqual({ limit: 32768, used: 32768, left: 0 });
  });

  it("twin: a 30 KiB root file loads in full and nothing is reported", () => {
    const r = run(materialise("codex-over-cap-twin"));
    expect(r.chain[0]?.status).toBe("loaded");
    expect(r.chain[0]?.keptBytes).toBe(30720);
    expect(r.findings).toEqual([]);
  });
});

describe("trap: the root file uses up the shared budget before the package file", () => {
  it("cuts the package file at the 600 bytes the root left", () => {
    const r = run(materialise("codex-root-starves-nested"), "packages/api");
    expect(names(r)).toEqual(["AGENTS.md", "packages/api/AGENTS.md"]);
    expect(r.chain[0]?.status).toBe("loaded");
    const nested = r.chain[1];
    expect(nested?.status).toBe("cut");
    expect(nested?.budgetBefore).toBe(600);
    expect(nested?.cut?.at).toBe(600);
    expect(nested?.cut?.cutSection).toBe("Error handling");
    expect(nested?.cut?.lostSections).toEqual(["Testing", "Payments"]);
    const finding = r.findings.find((f) => f.code === "codex.cut");
    expect(finding?.message).toContain("Only 600 of the 32768-byte budget was left");
    expect(finding?.message).toContain('"Payments"');
  });

  it("twin: a 20 KiB root leaves room and the package file loads in full", () => {
    const r = run(materialise("codex-root-starves-nested-twin"), "packages/api");
    expect(r.chain.map((e) => e.status)).toEqual(["loaded", "loaded"]);
    expect(r.findings).toEqual([]);
  });

  it("drops a later file entirely once the budget is at zero", () => {
    const fx = materialise("codex-root-starves-nested");
    const r = run(fx, "packages/api", { maxBytesOverride: 32168 });
    expect(r.chain.map((e) => e.status)).toEqual(["loaded", "no-budget"]);
    expect(codes(r)).toEqual(["codex.no-budget"]);
  });
});

describe("trap: the cut splits a multi-byte character", () => {
  it("reports that Codex sees U+FFFD at the cut", () => {
    const fx = materialise("codex-utf8-cut");
    const r = run(fx);
    expect(r.chain[0]?.cut?.at).toBe(32768);
    expect(r.chain[0]?.cut?.midCodepoint).toBe(true);
    expect(codes(r)).toEqual(["codex.cut", "codex.mid-codepoint"]);
    // What Codex keeps really does end in a replacement character.
    const bytes = readFileSync(fx.at("AGENTS.md"));
    expect(decodeLossy(bytes.subarray(0, 32768)).endsWith("�")).toBe(true);
  });

  it("twin: a cut on a character boundary is reported as a cut only", () => {
    const fx = materialise("codex-utf8-cut-twin");
    const r = run(fx);
    expect(r.chain[0]?.cut?.midCodepoint).toBe(false);
    expect(codes(r)).toEqual(["codex.cut"]);
    const bytes = readFileSync(fx.at("AGENTS.md"));
    expect(decodeLossy(bytes.subarray(0, 32768)).endsWith("€")).toBe(true);
  });
});

describe("trap: AGENTS.override.md hides AGENTS.md in the same directory", () => {
  it("reads the override and reports the shadowed file", () => {
    const fx = materialise("codex-override-wins");
    const r = run(fx, "packages/api");
    expect(names(r)).toEqual(["AGENTS.md", "packages/api/AGENTS.override.md"]);
    expect(r.chain[1]?.shadowed).toEqual([fx.at("packages/api/AGENTS.md")]);
    expect(codes(r)).toEqual(["codex.shadowed"]);
  });

  it("twin: with no override, AGENTS.md is read and nothing is reported", () => {
    const r = run(materialise("codex-override-wins-twin"), "packages/api");
    expect(names(r)).toEqual(["AGENTS.md", "packages/api/AGENTS.md"]);
    expect(r.findings).toEqual([]);
  });
});

describe("trap: an empty AGENTS.override.md still takes the directory's slot", () => {
  it("reports that the directory gives Codex nothing", () => {
    const fx = materialise("codex-empty-override");
    const r = run(fx, "packages/api");
    expect(r.chain[1]?.name).toBe("AGENTS.override.md");
    expect(r.chain[1]?.status).toBe("empty");
    expect(r.chain[1]?.keptBytes).toBe(0);
    const finding = r.findings.find((f) => f.code === "codex.empty-override");
    expect(finding?.path).toBe(fx.at("packages/api/AGENTS.md"));
    expect(finding?.severity).toBe("warn");
    expect(codes(r)).toEqual(["codex.empty-override"]);
    // The empty file uses no budget.
    expect(r.budget.used).toBe(r.chain[0]?.keptBytes);
  });

  it("twin: an override with content is an ordinary override", () => {
    const r = run(materialise("codex-empty-override-twin"), "packages/api");
    expect(r.chain[1]?.status).toBe("loaded");
    expect(codes(r)).toEqual(["codex.shadowed"]);
  });
});

describe("a whitespace-only AGENTS.md with no other file in its directory", () => {
  it("is skipped, uses no budget, and is reported as info", () => {
    const fx = materialise("codex-override-wins-twin");
    writeFileSync(fx.at("packages/api/AGENTS.md"), " \n\t\n");
    const r = run(fx, "packages/api");
    expect(r.chain[1]?.status).toBe("empty");
    expect(r.chain[1]?.keptBytes).toBe(0);
    expect(r.budget.used).toBe(r.chain[0]?.keptBytes);
    expect(r.findings).toEqual([
      {
        code: "codex.empty",
        severity: "info",
        agent: "codex",
        rule: "codex.empty-skip",
        path: fx.at("packages/api/AGENTS.md"),
        message: "packages/api/AGENTS.md is empty after trimming whitespace, so Codex skips it.",
      },
    ]);
  });
});

describe("trap: an AGENTS.md below the launch directory", () => {
  it("is not preloaded when Codex starts at the root", () => {
    const fx = materialise("codex-nested-below-cwd");
    const r = run(fx);
    expect(names(r)).toEqual(["AGENTS.md"]);
    expect(r.below.map((s) => s.path)).toEqual([fx.at("packages/api/AGENTS.md")]);
    expect(codes(r)).toEqual(["codex.nested"]);
  });

  it("is preloaded when Codex starts in its directory", () => {
    const r = run(materialise("codex-nested-below-cwd"), "packages/api");
    expect(names(r)).toEqual(["AGENTS.md", "packages/api/AGENTS.md"]);
    expect(r.findings).toEqual([]);
  });

  it("twin: with no nested file, starting at the root reports nothing", () => {
    const r = run(materialise("codex-nested-below-cwd-twin"));
    expect(r.below).toEqual([]);
    expect(r.findings).toEqual([]);
  });
});

describe("trap: a project .codex/config.toml raises the budget", () => {
  it("is ignored while the project is not trusted, and ctxreach says so", () => {
    const fx = materialise("codex-project-config");
    const r = run(fx);
    expect(r.settings.trust).toBe("unknown");
    expect(r.settings.maxBytes).toBe(32768);
    expect(r.chain[0]?.status).toBe("cut");
    expect(codes(r)).toEqual(["codex.project-config-ignored", "codex.cut"]);
  });

  it("applies once the project is trusted", () => {
    const fx = materialise("codex-project-config");
    const r = run(fx, ".", { trustOverride: "trusted" });
    expect(r.settings.maxBytes).toBe(65536);
    expect(r.settings.sources.find((s) => s.key === "project_doc_max_bytes")?.from).toBe(
      path.join(fx.repo, ".codex", "config.toml"),
    );
    expect(r.chain[0]?.status).toBe("loaded");
    expect(r.findings).toEqual([]);
  });

  it("reads trust from [projects] in the user's config", () => {
    const fx = materialise("codex-project-config");
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(
      path.join(fx.codexHome, "config.toml"),
      `[projects.${JSON.stringify(fx.repo)}]\ntrust_level = "trusted"\n`,
    );
    const r = run(fx);
    expect(r.settings.trust).toBe("trusted");
    expect(r.settings.maxBytes).toBe(65536);
  });

  it("twin: the same budget set in the user's config applies without trust", () => {
    const fx = materialise("codex-project-config-twin");
    const r = run(fx);
    expect(r.settings.maxBytes).toBe(65536);
    expect(r.settings.sources.find((s) => s.key === "project_doc_max_bytes")?.from).toBe(
      path.join(fx.codexHome, "config.toml"),
    );
    expect(r.chain[0]?.status).toBe("loaded");
    expect(r.findings).toEqual([]);
  });
});

describe("trap: CODEX_HOME is the repository itself", () => {
  it("reads the root AGENTS.md twice, as the global file and as the project's", () => {
    const fx = materialise("codex-home-is-root");
    const r = run(fx, ".", { codexHome: fx.repo });
    expect(r.global?.path).toBe(fx.at("AGENTS.md"));
    expect(names(r)).toEqual(["AGENTS.md"]);
    expect(r.chain[0]?.status).toBe("loaded");
    expect(codes(r)).toEqual(["codex.home-is-root", "codex.nested"]);
    expect(r.findings[0]).toMatchObject({ path: fx.at("AGENTS.md"), rule: "codex.home-is-root", severity: "warn" });
    expect(r.findings[0]?.message).toBe(
      "Codex home (CODEX_HOME) is the project root, so Codex reads AGENTS.md twice: once as the global instructions file and once as that directory's project file. The model gets its text twice. Point CODEX_HOME at a directory outside the project.",
    );
    // The global copy is not charged to the budget; the project copy is.
    expect(r.budget.used).toBe(r.chain[0]?.bytes);
  });

  it("still reads the root file twice from a package", () => {
    const fx = materialise("codex-home-is-root");
    const r = run(fx, "packages/api", { codexHome: fx.repo });
    expect(names(r)).toEqual(["AGENTS.md", "packages/api/AGENTS.md"]);
    expect(codes(r)).toEqual(["codex.home-is-root"]);
  });

  it("names the directory when CODEX_HOME is a package on the chain, and the cut of the second copy", () => {
    const fx = materialise("codex-home-is-root");
    // Room for the root file and 30 bytes of the package's.
    const budget = readFileSync(fx.at("AGENTS.md")).length + 30;
    const r = run(fx, "packages/api", { codexHome: fx.at("packages/api"), maxBytesOverride: budget });
    expect(r.global?.path).toBe(fx.at("packages/api/AGENTS.md"));
    const [finding] = r.findings.filter((f) => f.code === "codex.home-is-root");
    expect(finding?.path).toBe(fx.at("packages/api/AGENTS.md"));
    expect(finding?.message).toContain(
      "Codex home (CODEX_HOME) is packages/api/, so Codex reads packages/api/AGENTS.md twice",
    );
    expect(finding?.message).toContain("(the second copy cut at byte 30)");
  });

  it("says nothing when the file there is empty, since neither copy adds text", () => {
    const fx = materialise("codex-home-is-root");
    writeFileSync(fx.at("AGENTS.md"), "  \n");
    const r = run(fx, "packages/api", { codexHome: fx.repo });
    expect(r.global).toBeUndefined();
    expect(codes(r)).toEqual(["codex.empty"]);
  });

  it("twin: Codex home outside the repository has its own file, and each file is read once", () => {
    const fx = materialise("codex-home-is-root-twin");
    const r = run(fx);
    expect(r.global?.path).toBe(path.join(fx.codexHome, "AGENTS.md"));
    expect(names(r)).toEqual(["AGENTS.md"]);
    expect(codes(r)).toEqual(["codex.nested"]);
    const fromApi = run(fx, "packages/api");
    expect(fromApi.findings).toEqual([]);
  });
});

describe("other Codex rules", () => {
  it("loads no project files for a project marked untrusted", () => {
    const fx = materialise("codex-override-wins-twin");
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(
      path.join(fx.codexHome, "config.toml"),
      `[projects.${JSON.stringify(fx.repo)}]\ntrust_level = "untrusted"\n`,
    );
    const r = run(fx, "packages/api");
    expect(r.settings.trust).toBe("untrusted");
    expect(r.chain).toEqual([]);
    expect(codes(r)).toEqual(["codex.untrusted"]);
  });

  it("searches only the launch directory when there is no root marker", () => {
    const r = run(materialise("codex-override-wins-twin", { git: false }), "packages/api");
    expect(r.settings.rootFound).toBe(false);
    expect(r.chain.map((e) => e.name)).toEqual(["AGENTS.md"]);
    expect(r.chain[0]?.dir).toBe(r.launchDir);
    expect(codes(r)).toEqual(["codex.no-root"]);
  });

  it("honours project_root_markers from the user's config", () => {
    const fx = materialise("codex-override-wins-twin", { git: false });
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(path.join(fx.codexHome, "config.toml"), `project_root_markers = ["pnpm-workspace.yaml"]\n`);
    writeFileSync(fx.at("pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    const r = run(fx, "packages/api");
    expect(r.settings.projectRoot).toBe(fx.repo);
    expect(r.chain).toHaveLength(2);
  });

  it("treats project_doc_max_bytes = 0 as off", () => {
    const r = run(materialise("codex-override-wins-twin"), "packages/api", { maxBytesOverride: 0 });
    expect(r.chain).toEqual([]);
    expect(codes(r)).toEqual(["codex.zero-budget"]);
  });

  it("uses fallback names only where AGENTS.md is missing, and drops names with a path", () => {
    const fx = materialise("codex-nested-below-cwd-twin");
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(
      path.join(fx.codexHome, "config.toml"),
      `project_doc_fallback_filenames = ["TEAM_GUIDE.md", "docs/GUIDE.md", "TEAM_GUIDE.md"]\n`,
    );
    writeFileSync(fx.at("TEAM_GUIDE.md"), "# Team guide\n\n- Root fallback.\n");
    writeFileSync(fx.at("packages/api/TEAM_GUIDE.md"), "# API team guide\n\n- Package fallback.\n");
    const r = run(fx, "packages/api");
    expect(r.settings.fallbackNames).toEqual(["TEAM_GUIDE.md"]);
    expect(names(r)).toEqual(["AGENTS.md", "packages/api/TEAM_GUIDE.md"]);
    expect(r.chain[0]?.shadowed).toEqual([fx.at("TEAM_GUIDE.md")]);
  });

  it("takes the first non-empty global file and does not charge it to the budget", () => {
    const fx = materialise("codex-over-cap-twin");
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(path.join(fx.codexHome, "AGENTS.override.md"), "   \n");
    writeFileSync(path.join(fx.codexHome, "AGENTS.md"), "# Global\n\n- Prefer small commits.\n".repeat(200));
    const r = run(fx);
    expect(r.global?.path).toBe(path.join(fx.codexHome, "AGENTS.md"));
    expect(r.global?.skippedEmpty).toEqual([path.join(fx.codexHome, "AGENTS.override.md")]);
    expect(r.budget.used).toBe(30720);
  });

  it("does not count a byte-order mark as whitespace", () => {
    const fx = materialise("codex-nested-below-cwd-twin");
    writeFileSync(fx.at("AGENTS.md"), "﻿\n");
    const r = run(fx);
    expect(r.chain[0]?.status).toBe("loaded");
    expect(r.chain[0]?.keptBytes).toBe(4);
  });

  it("fails loudly on a config value of the wrong type", () => {
    const fx = materialise("codex-over-cap-twin");
    mkdirSync(fx.codexHome, { recursive: true });
    writeFileSync(path.join(fx.codexHome, "config.toml"), `project_doc_max_bytes = "64k"\n`);
    expect(() => run(fx)).toThrow(/project_doc_max_bytes/);
  });
});
