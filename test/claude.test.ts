import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EvidenceRegistry, evidenceLabel, resolveClaude, type ClaudeResult } from "../src/agents/claude/resolve.js";
import { importTokens } from "../src/agents/claude/imports.js";
import { compareVersions } from "../src/agents/claude/settings.js";
import { materialise, type Materialised } from "./helpers/fixture.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(fx: Materialised, from = ".", extra: Partial<Parameters<typeof resolveClaude>[0]> = {}): ClaudeResult {
  return resolveClaude({
    launchDir: fx.at(from),
    scanRoot: fx.repo,
    claudeHome: fx.claudeHome,
    ceiling: fx.base,
    ...extra,
  });
}

const codes = (r: ClaudeResult) => r.findings.map((f) => f.code);
const relTo = (fx: Materialised) => (p: string) => path.relative(fx.repo, p).split(path.sep).join("/");
function deliveries(fx: Materialised, r: ClaudeResult): Record<string, string> {
  const rel = relTo(fx);
  return Object.fromEntries(r.files.map((f) => [rel(f.path), f.delivery]));
}

describe("trap: a personal CLAUDE.local.md switches AGENTS.md off", () => {
  it("reports that AGENTS.md no longer reaches Claude Code", () => {
    const fx = materialise("claude-local-shadows-agents");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.local.md": "launch", "AGENTS.md": "not-loaded" });
    expect(r.agentsMd.read).toBe(false);
    expect(codes(r)).toEqual(["claude.agents-shadowed"]);
    expect(r.findings[0]?.message).toContain("the personal CLAUDE.local.md switches AGENTS.md off");
  });

  it("twin: without CLAUDE.local.md, AGENTS.md is read at launch", () => {
    const fx = materialise("claude-local-shadows-agents-twin");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({ "AGENTS.md": "launch" });
    expect(r.findings).toEqual([]);
  });

  it("reads both when Project instructions is claude-md-and-agents-md", () => {
    const fx = materialise("claude-local-shadows-agents");
    const r = run(fx, ".", { mode: "claude-md-and-agents-md" });
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.local.md": "launch", "AGENTS.md": "launch" });
    expect(r.findings).toEqual([]);
  });
});

/** The fixture's repository cloned under its home directory, as every repository in a Windows profile is. */
function cloneUnderHome(fx: Materialised): string {
  const clone = path.join(fx.home, "code", "app");
  cpSync(fx.repo, clone, { recursive: true });
  return clone;
}

function runIn(fx: Materialised, repo: string, from = ".", extra: Partial<Parameters<typeof resolveClaude>[0]> = {}) {
  return resolveClaude({
    launchDir: path.join(repo, ...from.split("/")),
    scanRoot: repo,
    claudeHome: fx.claudeHome,
    ceiling: fx.base,
    ...extra,
  });
}

/** The label docs/evidence.json gives a rule, worked out here without the resolver's code. */
function registryLabel(rule: string): string {
  const doc = JSON.parse(readFileSync(path.join(ROOT, "docs", "evidence.json"), "utf8")) as {
    entries: { rule: string; status: string; version?: string; k?: number; n?: number }[];
  };
  const e = doc.entries.find((x) => x.rule === rule);
  if (!e) throw new Error(`no registry entry for ${rule}`);
  if (e.status === "source" || e.status === "documented") return e.status;
  return `${e.status}@${e.version}${e.k !== undefined ? ` ${e.k}/${e.n}` : ""}`;
}

describe("trap: ~/.claude/CLAUDE.md switches AGENTS.md off for a repository under home", () => {
  it("reports the personal file as an ancestor that switches AGENTS.md off, with its evidence label", () => {
    const fx = materialise("claude-home-ancestor");
    const repo = cloneUnderHome(fx);
    const r = runIn(fx, repo);
    const personal = path.join(fx.claudeHome, "CLAUDE.md");
    expect(r.files.map((f) => [f.path, f.kind, f.delivery])).toEqual([
      [personal, "user", "launch"],
      [path.join(repo, "AGENTS.md"), "AGENTS.md", "not-loaded"],
    ]);
    expect(r.files[0]?.why).toBe("user file, and an ancestor's .claude/CLAUDE.md here");
    expect(r.shadowers).toEqual([personal]);
    expect(r.agentsMd.read).toBe(false);
    expect(codes(r)).toEqual(["claude.agents-shadowed", "claude.home-ancestor"]);
    const finding = r.findings[1];
    expect(finding?.path).toBe(personal);
    expect(finding?.message).toContain("~/.claude/CLAUDE.md, your personal file, switches AGENTS.md off here");
    expect(finding?.message).toContain(`[evidence: ${registryLabel("claude.home-ancestor")}]`);
  });

  it("reads AGENTS.md when the same repository is cloned outside home", () => {
    const fx = materialise("claude-home-ancestor");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({ "../home/.claude/CLAUDE.md": "launch", "AGENTS.md": "launch" });
    expect(r.files[0]?.why).toBe("user file");
    expect(r.findings).toEqual([]);
  });

  it("twin: the same preferences as a rule in ~/.claude/rules/ leave AGENTS.md on", () => {
    const fx = materialise("claude-home-ancestor-twin");
    const repo = cloneUnderHome(fx);
    const r = runIn(fx, repo);
    expect(r.files.map((f) => [path.basename(f.path), f.kind, f.delivery])).toEqual([
      ["personal.md", "user-rule", "launch"],
      ["AGENTS.md", "AGENTS.md", "launch"],
    ]);
    expect(r.shadowers).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it("does not blame the personal file when the repository has a CLAUDE.md of its own", () => {
    const fx = materialise("claude-home-ancestor");
    const repo = cloneUnderHome(fx);
    writeFileSync(path.join(repo, "CLAUDE.md"), "# Team notes\n");
    const r = runIn(fx, repo);
    expect(r.shadowers).toHaveLength(2);
    expect(codes(r)).toEqual(["claude.agents-shadowed"]);
  });

  it("reports any CLAUDE.md-family file above the repository, not only the personal one", () => {
    const fx = materialise("claude-local-shadows-agents-twin");
    writeFileSync(path.join(fx.base, "CLAUDE.md"), "# A file above the repository\n");
    const r = run(fx);
    expect(r.shadowers).toEqual([path.join(fx.base, "CLAUDE.md")]);
    expect(deliveries(fx, r)["AGENTS.md"]).toBe("not-loaded");
    expect(codes(r)).toEqual(["claude.agents-shadowed", "claude.home-ancestor"]);
    expect(r.findings[1]?.message).toMatch(/\/CLAUDE\.md is above the repository and switches AGENTS\.md off for it/);
  });

  it("says nothing when no AGENTS.md is lost", () => {
    const fx = materialise("claude-home-ancestor");
    const repo = cloneUnderHome(fx);
    const r = runIn(fx, repo, ".", { mode: "claude-md-and-agents-md" });
    expect(r.files.map((f) => f.delivery)).toEqual(["launch", "launch"]);
    expect(r.findings).toEqual([]);
  });
});

describe("evidence labels", () => {
  it("shows the registry's status, and the version and count once a run backs it", () => {
    const at = (entry: Record<string, unknown>) =>
      evidenceLabel("x.rule", EvidenceRegistry.parse({ entries: [{ rule: "x.rule", ...entry }] }));
    expect(at({ status: "source" })).toBe("source");
    expect(at({ status: "documented" })).toBe("documented");
    expect(at({ status: "observed", version: "2.1.285", k: 10, n: 10 })).toBe("observed@2.1.285 10/10");
    expect(at({ status: "contradicted", version: "2.1.285" })).toBe("contradicted@2.1.285");
    expect(() => at({ status: "observed" })).toThrow(/names no version/);
    expect(() => evidenceLabel("x.missing", { entries: [] })).toThrow(/no entry for x\.missing/);
  });

  it("parses docs/evidence.json and has an entry for every label map shows", () => {
    expect(
      EvidenceRegistry.safeParse(JSON.parse(readFileSync(path.join(ROOT, "docs", "evidence.json"), "utf8"))).success,
    ).toBe(true);
    expect(evidenceLabel("claude.home-ancestor")).toBe(registryLabel("claude.home-ancestor"));
  });
});

describe("trap: a root CLAUDE.md switches off a package's AGENTS.md", () => {
  it("does not read packages/api/AGENTS.md when launched in packages/api", () => {
    const fx = materialise("claude-root-shadows-package");
    const r = run(fx, "packages/api");
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.md": "launch", "packages/api/AGENTS.md": "not-loaded" });
    expect(r.shadowers).toEqual([fx.at("CLAUDE.md")]);
    expect(codes(r)).toEqual(["claude.agents-shadowed"]);
    expect(r.findings[0]?.message).toContain("switched off by CLAUDE.md");
  });

  it("does not blame the shadowing for a sibling package's AGENTS.md", () => {
    // packages/web is outside the launch directory's tree, so Claude would
    // not load its AGENTS.md even without the root CLAUDE.md.
    const fx = materialise("claude-root-shadows-package");
    mkdirSync(fx.at("packages/web"));
    writeFileSync(fx.at("packages/web/AGENTS.md"), "# Web\n\n- Use the design tokens.\n");
    const r = run(fx, "packages/api");
    expect(deliveries(fx, r)["packages/web/AGENTS.md"]).toBe("not-loaded");
    expect(r.findings.map((f) => [f.code, relTo(fx)(f.path ?? "")])).toEqual([
      ["claude.agents-shadowed", "packages/api/AGENTS.md"],
    ]);
  });

  it("twin: with AGENTS.md at the root instead, both AGENTS.md files are read", () => {
    const fx = materialise("claude-root-shadows-package-twin");
    const r = run(fx, "packages/api");
    expect(deliveries(fx, r)).toEqual({ "AGENTS.md": "launch", "packages/api/AGENTS.md": "launch" });
    expect(r.findings).toEqual([]);
  });

  it("twin launched at the root: the package's AGENTS.md loads on read", () => {
    const fx = materialise("claude-root-shadows-package-twin");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({ "AGENTS.md": "launch", "packages/api/AGENTS.md": "on-read" });
    expect(codes(r)).toEqual(["claude.nested"]);
  });
});

describe("trap: CLAUDE.md names AGENTS.md in words instead of importing it", () => {
  it("reports both the shadowing and the missing import", () => {
    const fx = materialise("claude-words-not-import");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.md": "launch", "AGENTS.md": "not-loaded" });
    expect(codes(r)).toEqual(["claude.agents-shadowed", "claude.words-not-import"]);
    expect(r.findings[1]?.path).toBe(fx.at("CLAUDE.md"));
    expect(r.findings[1]?.message).not.toContain("code block");
  });

  it("twin: an @AGENTS.md import delivers AGENTS.md at launch", () => {
    const fx = materialise("claude-words-not-import-twin");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.md": "launch", "AGENTS.md": "import" });
    expect(r.files.find((f) => f.kind === "import")?.importedBy).toBe(fx.at("CLAUDE.md"));
    expect(r.findings).toEqual([]);
  });
});

describe("trap: @AGENTS.md inside a fenced code block", () => {
  it("is not an import, and the finding says why", () => {
    const fx = materialise("claude-import-in-code-block");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.md": "launch", "AGENTS.md": "not-loaded" });
    expect(codes(r)).toEqual(["claude.agents-shadowed", "claude.words-not-import"]);
    expect(r.findings[1]?.message).toContain("an @AGENTS.md inside a code block or code span is not an import");
  });

  it("twin: a real import outside the block still works", () => {
    const fx = materialise("claude-import-in-code-block-twin");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.md": "launch", "AGENTS.md": "import" });
    expect(r.findings).toEqual([]);
  });
});

describe("trap: an import chain five hops deep", () => {
  it("stops after four hops", () => {
    const fx = materialise("claude-import-too-deep");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({
      "CLAUDE.md": "launch",
      "docs/one.md": "import",
      "docs/two.md": "import",
      "docs/three.md": "import",
      "docs/four.md": "import",
      "docs/five.md": "not-loaded",
    });
    expect(r.files.find((f) => f.path.endsWith("five.md"))?.depth).toBe(5);
    expect(codes(r)).toEqual(["claude.import-too-deep"]);
  });

  it("twin: a chain four hops deep arrives in full", () => {
    const fx = materialise("claude-import-too-deep-twin");
    const r = run(fx);
    expect(Object.values(deliveries(fx, r))).toEqual(["launch", "import", "import", "import", "import"]);
    expect(r.findings).toEqual([]);
  });
});

describe("trap: an import that resolves outside the launch directory", () => {
  it("needs a one-time approval when launched in a package", () => {
    const fx = materialise("claude-import-outside-launch");
    const r = run(fx, "packages/api");
    const imported = r.files.find((f) => f.kind === "import");
    expect(imported?.path).toBe(fx.at("docs/testing.md"));
    expect(imported?.needsApproval).toBe(true);
    expect(codes(r)).toEqual(["claude.external-import"]);
  });

  it("twin: launched at the root, the same import loads without asking", () => {
    const fx = materialise("claude-import-outside-launch-twin");
    const r = run(fx);
    expect(r.files.find((f) => f.kind === "import")?.needsApproval).toBeUndefined();
    expect(r.findings).toEqual([]);
  });

  it("does not ask about imports in the user's own CLAUDE.md", () => {
    const fx = materialise("claude-import-outside-launch-twin");
    mkdirSync(fx.claudeHome, { recursive: true });
    writeFileSync(path.join(fx.claudeHome, "CLAUDE.md"), "# Me\n\n@~/notes.md\n");
    writeFileSync(path.join(fx.home, "notes.md"), "- Prefer short answers.\n");
    const r = run(fx);
    expect(r.files[0]?.kind).toBe("user");
    expect(r.files[1]).toMatchObject({ path: path.join(fx.home, "notes.md"), delivery: "import" });
    expect(r.files[1]?.needsApproval).toBeUndefined();
    expect(r.findings).toEqual([]);
  });
});

describe("trap: Project instructions set in project settings", () => {
  it("is ignored, and ctxreach says so", () => {
    const fx = materialise("claude-mode-in-project-settings");
    const r = run(fx);
    expect(r.mode).toBe("claude-md-or-agents-md");
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.md": "launch", "AGENTS.md": "not-loaded" });
    expect(codes(r)).toEqual(["claude.mode-in-project-settings", "claude.agents-shadowed"]);
  });

  it("twin: the same setting in ~/.claude/settings.json takes effect", () => {
    const fx = materialise("claude-mode-in-project-settings-twin");
    const r = run(fx);
    expect(r.mode).toBe("claude-md-and-agents-md");
    expect(r.modeFrom).toBe(path.join(fx.claudeHome, "settings.json"));
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.md": "launch", "AGENTS.md": "launch" });
    expect(r.findings).toEqual([]);
  });
});

describe("other Claude Code rules", () => {
  it("loads a subdirectory's CLAUDE.md on read, and never reads Codex-only files", () => {
    const fx = materialise("codex-override-wins");
    writeFileSync(fx.at("packages/api/CLAUDE.md"), "# API notes\n");
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({
      "AGENTS.md": "launch",
      "packages/api/AGENTS.md": "not-loaded",
      "packages/api/AGENTS.override.md": "not-loaded",
      "packages/api/CLAUDE.md": "on-read",
    });
    const own = r.files.find((f) => f.path === fx.at("packages/api/AGENTS.md"));
    expect(own?.why).toBe("packages/api/ has its own CLAUDE.md");
    expect(r.files.find((f) => f.kind === "AGENTS.override.md")?.rule).toBe("claude.agents-never");
  });

  it("reads project rules without paths at launch and with paths on read", () => {
    const fx = materialise("claude-local-shadows-agents-twin");
    mkdirSync(fx.at(".claude/rules"), { recursive: true });
    writeFileSync(fx.at(".claude/rules/style.md"), "# Style\n");
    writeFileSync(fx.at(".claude/rules/api.md"), '---\npaths:\n  - "src/api/**"\n---\n# API\n');
    const r = run(fx);
    expect(deliveries(fx, r)).toMatchObject({ ".claude/rules/api.md": "on-read", ".claude/rules/style.md": "launch" });
    expect(deliveries(fx, r)["AGENTS.md"]).toBe("launch");
  });

  it("applies the version gates", () => {
    const fx = materialise("claude-local-shadows-agents-twin");
    const old = run(fx, ".", { version: "2.1.276" });
    expect(deliveries(fx, old)["AGENTS.md"]).toBe("not-loaded");
    expect(codes(old)).toEqual(["claude.version-no-agents"]);
    const mid = run(fx, ".", { version: "2.1.280" });
    expect(deliveries(fx, mid)["AGENTS.md"]).toBe("launch");
    expect(codes(mid)).toEqual(["claude.version-some-sessions"]);
    expect(codes(run(fx, ".", { version: "2.1.281" }))).toEqual([]);
  });

  it("treats a CLAUDE.md symlinked to AGENTS.md as one file", (ctx) => {
    const fx = materialise("claude-local-shadows-agents-twin");
    try {
      symlinkSync("AGENTS.md", fx.at("CLAUDE.md"), "file");
    } catch {
      ctx.skip();
    }
    const r = run(fx);
    expect(deliveries(fx, r)).toEqual({ "CLAUDE.md": "launch", "AGENTS.md": "launch" });
    expect(r.files.find((f) => f.kind === "AGENTS.md")?.rule).toBe("claude.symlink");
    expect(r.findings).toEqual([]);
  });

  it("skips a file over 4 MiB", () => {
    const fx = materialise("claude-local-shadows-agents-twin");
    writeFileSync(fx.at("AGENTS.md"), "- rule\n".repeat(600_000));
    const r = run(fx);
    expect(deliveries(fx, r)["AGENTS.md"]).toBe("not-loaded");
    expect(codes(r)).toEqual(["claude.too-large"]);
  });
});

describe("import syntax", () => {
  it("skips code spans and fences and needs whitespace before @", () => {
    const text = "See @README and `@not-this` and me@example.com.\n```\n@nor-this\n```\n- @docs/a.md, then @b.md.\n";
    expect(importTokens(text)).toEqual(["README", "docs/a.md,", "b.md."]);
  });
});

describe("compareVersions", () => {
  it("compares numerically", () => {
    expect(compareVersions("2.1.100", "2.1.99")).toBeGreaterThan(0);
    expect(compareVersions("2.1.277", "2.1.277")).toBe(0);
    expect(compareVersions("2.0.9", "2.1.0")).toBeLessThan(0);
  });
});

describe("reading ~/.claude/settings.json", () => {
  it("ignores other plugins' configs, whatever their shape", () => {
    const fx = materialise("claude-local-shadows-agents");
    mkdirSync(fx.claudeHome, { recursive: true });
    writeFileSync(
      path.join(fx.claudeHome, "settings.json"),
      JSON.stringify({
        pluginConfigs: {
          "some-plugin@market": { options: "not an object" },
          "agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } },
        },
      }),
    );
    expect(run(fx).mode).toBe("claude-md-and-agents-md");
  });

  it("fails loudly on an unknown Project instructions value", () => {
    const fx = materialise("claude-local-shadows-agents");
    mkdirSync(fx.claudeHome, { recursive: true });
    writeFileSync(
      path.join(fx.claudeHome, "settings.json"),
      JSON.stringify({ pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "both" } } } }),
    );
    expect(() => run(fx)).toThrow(/instructionFiles/);
  });
});
