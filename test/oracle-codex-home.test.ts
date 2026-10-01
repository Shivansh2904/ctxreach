import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCodexHome, readCodexToml } from "../src/agents/codex/config.js";
import {
  assertThrowawayHome,
  instructionLines,
  prepareProjectConfig,
  seedCodexHome,
} from "../src/oracle/codex-home.js";
import { SafetyError } from "../src/probe/types.js";
import { materialise, tempDir } from "./helpers/fixture.js";

/** A user Codex home with everything a real one can hold, so the whitelist has something to leave out. */
function userHome(dir: string, extraConfig = ""): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-live-NEVER-COPIED" }));
  writeFileSync(path.join(dir, "AGENTS.md"), "# Global\nCTXR-g1000001 be brief\n");
  writeFileSync(
    path.join(dir, "config.toml"),
    [
      'model = "gpt-5.5"',
      "project_doc_max_bytes = 65536",
      'project_doc_fallback_filenames = ["INSTRUCTIONS.md", "notes.md"]',
      'project_root_markers = [".git", ".hg"]',
      "[model_providers.corp]",
      'base_url = "https://corp.example/v1"',
      'env_key = "CORP_KEY"',
      "[mcp_servers.filesystem]",
      'command = "npx"',
      "[hooks]",
      'SessionStart = [{ command = "echo hi" }]',
      extraConfig,
    ].join("\n") + "\n",
  );
  return dir;
}

describe("seeding the throwaway CODEX_HOME", () => {
  it("takes the global file and the three instruction keys, and nothing else", () => {
    const from = userHome(path.join(tempDir("user-codex"), ".codex"));
    const home = path.join(tempDir("box"), "codex-home");
    const seeded = seedCodexHome(home, {
      from,
      sourceRoot: "/src",
      sourceLaunch: "/src",
      copyRoot: "/copy",
      copyLaunch: "/copy",
    });
    expect(seeded).toEqual({
      home,
      from,
      keys: ["project_doc_max_bytes", "project_doc_fallback_filenames", "project_root_markers"],
      globalFiles: ["AGENTS.md"],
      trust: "unknown",
      trustFrom: "not set",
    });
    expect(readdirSync(home).sort()).toEqual(["AGENTS.md", "config.toml"]);
    const config = readFileSync(path.join(home, "config.toml"), "utf8");
    expect(config).toBe(
      'project_doc_max_bytes = 65536\nproject_doc_fallback_filenames = ["INSTRUCTIONS.md", "notes.md"]\nproject_root_markers = [".git", ".hg"]\n',
    );
    for (const never of ["auth", "sk-live", "model_providers", "mcp_servers", "hooks", "corp"])
      expect(config).not.toContain(never);
    expect(readCodexToml(path.join(home, "config.toml"))?.project_doc_max_bytes).toBe(65536);
  });

  it("mirrors the source repository's trust level to the copy's path, at the key the user's config used", () => {
    const src = tempDir("source");
    const launch = path.join(src, "packages", "api");
    mkdirSync(launch, { recursive: true });
    const byRoot = userHome(
      path.join(tempDir("user-root"), ".codex"),
      `[projects.${JSON.stringify(src)}]\ntrust_level = "trusted"\n`,
    );
    const copyRoot = path.join(tempDir("copy"), "repo");
    const copyLaunch = path.join(copyRoot, "packages", "api");
    const a = seedCodexHome(path.join(tempDir("box"), "codex-home"), {
      from: byRoot,
      sourceRoot: src,
      sourceLaunch: launch,
      copyRoot,
      copyLaunch,
    });
    expect(a.trust).toBe("trusted");
    expect(a.trustFrom).toBe(path.join(byRoot, "config.toml"));
    const written = readCodexToml(path.join(a.home, "config.toml"));
    expect(written?.projects).toEqual({ [copyRoot]: { trust_level: "trusted" } });

    const byLaunch = userHome(
      path.join(tempDir("user-launch"), ".codex"),
      `[projects.${JSON.stringify(launch)}]\ntrust_level = "untrusted"\n`,
    );
    const b = seedCodexHome(path.join(tempDir("box"), "codex-home"), {
      from: byLaunch,
      sourceRoot: src,
      sourceLaunch: launch,
      copyRoot,
      copyLaunch,
    });
    expect(b.trust).toBe("untrusted");
    expect(readCodexToml(path.join(b.home, "config.toml"))?.projects).toEqual({
      [copyLaunch]: { trust_level: "untrusted" },
    });

    const other = userHome(
      path.join(tempDir("user-other"), ".codex"),
      `[projects."/somewhere/else"]\ntrust_level = "trusted"\n`,
    );
    const c = seedCodexHome(path.join(tempDir("box"), "codex-home"), {
      from: other,
      sourceRoot: src,
      sourceLaunch: launch,
      copyRoot,
      copyLaunch,
    });
    expect(c.trust).toBe("unknown");
    expect(readCodexToml(path.join(c.home, "config.toml"))?.projects).toBeUndefined();
  });

  it("writes a given trust level for the copy's root instead", () => {
    const seeded = seedCodexHome(path.join(tempDir("box"), "codex-home"), {
      sourceRoot: "/src",
      sourceLaunch: "/src",
      copyRoot: "/copy",
      copyLaunch: "/copy",
      trustOverride: "untrusted",
    });
    expect(seeded).toMatchObject({ trust: "untrusted", trustFrom: "override", keys: [], globalFiles: [] });
    expect(readCodexToml(path.join(seeded.home, "config.toml"))?.projects).toEqual({
      "/copy": { trust_level: "untrusted" },
    });
  });

  it("seeds nothing when clean, and refuses a home that already exists", () => {
    const home = path.join(tempDir("box"), "codex-home");
    const seeded = seedCodexHome(home, {
      sourceRoot: "/src",
      sourceLaunch: "/src",
      copyRoot: "/copy",
      copyLaunch: "/copy",
    });
    expect(seeded).toEqual({ home, keys: [], globalFiles: [], trust: "unknown", trustFrom: "not set" });
    expect(readdirSync(home)).toEqual([]);
    expect(() =>
      seedCodexHome(home, { sourceRoot: "/src", sourceLaunch: "/src", copyRoot: "/copy", copyLaunch: "/copy" }),
    ).toThrow(SafetyError);
  });

  it("copies a home that has no config at all without complaint", () => {
    const from = tempDir("bare-home");
    const seeded = seedCodexHome(path.join(tempDir("box"), "codex-home"), {
      from,
      sourceRoot: "/s",
      sourceLaunch: "/s",
      copyRoot: "/c",
      copyLaunch: "/c",
    });
    expect(seeded.keys).toEqual([]);
    expect(existsSync(path.join(seeded.home, "config.toml"))).toBe(false);
  });
});

describe("where the throwaway may be", () => {
  it("must be inside the sandbox and never the user's home or Codex home", () => {
    const box = tempDir("box");
    expect(() => assertThrowawayHome(path.join(box, "codex-home"), box)).not.toThrow();
    expect(() => assertThrowawayHome(os.homedir(), box)).toThrow(/refusing to use/);
    expect(() => assertThrowawayHome(defaultCodexHome(), box)).toThrow(/refusing to use/);
    expect(() => assertThrowawayHome(path.dirname(os.homedir()), box)).toThrow(/contains/);
    expect(() => assertThrowawayHome(tempDir("elsewhere"), box)).toThrow(/not inside the sandbox/);
  });
});

describe("writing the project config layers back into the copy", () => {
  it("keeps only the three instruction keys of each .codex/config.toml on the root-to-launch path", () => {
    const fx = materialise("codex-project-config");
    // A second layer at the launch directory, with things that must not reach the copy.
    const launch = fx.at("packages/api");
    mkdirSync(path.join(launch, ".codex"), { recursive: true });
    writeFileSync(
      path.join(launch, ".codex", "config.toml"),
      'project_doc_fallback_filenames = ["notes.md"]\n[mcp_servers.x]\ncommand = "evil"\n[hooks]\nSessionStart = [{ command = "evil" }]\n',
    );
    const copy = tempDir("copy");
    mkdirSync(path.join(copy, "packages", "api"), { recursive: true });
    const layers = prepareProjectConfig(copy, fx.repo, launch, fx.codexHome);
    expect(layers).toEqual([
      { file: ".codex/config.toml", keys: ["project_doc_max_bytes"] },
      { file: "packages/api/.codex/config.toml", keys: ["project_doc_fallback_filenames"] },
    ]);
    expect(readFileSync(path.join(copy, ".codex", "config.toml"), "utf8")).toBe("project_doc_max_bytes = 65536\n");
    const nested = readFileSync(path.join(copy, "packages", "api", ".codex", "config.toml"), "utf8");
    expect(nested).toBe('project_doc_fallback_filenames = ["notes.md"]\n');
    expect(nested).not.toContain("evil");
  });

  it("writes nothing for a layer without instruction keys, and skips a .codex that is the Codex home itself", () => {
    const fx = materialise("codex-over-cap-twin");
    mkdirSync(fx.at(".codex"));
    writeFileSync(fx.at(".codex/config.toml"), '[mcp_servers.x]\ncommand = "x"\n');
    const copy = tempDir("copy");
    expect(prepareProjectConfig(copy, fx.repo, fx.repo, fx.codexHome)).toEqual([]);
    expect(existsSync(path.join(copy, ".codex"))).toBe(false);
    writeFileSync(fx.at(".codex/config.toml"), "project_doc_max_bytes = 1\n");
    // CODEX_HOME = the project's own .codex (#34193): Codex does not read it as a project layer, so neither does ctxreach.
    expect(prepareProjectConfig(copy, fx.repo, fx.repo, fx.at(".codex"))).toEqual([]);
    expect(prepareProjectConfig(copy, fx.repo, fx.repo, fx.codexHome)).toEqual([
      { file: ".codex/config.toml", keys: ["project_doc_max_bytes"] },
    ]);
  });

  it("renders the keys as TOML that Codex's own parser reads back", () => {
    const { keys, lines } = instructionLines({
      project_doc_max_bytes: 10,
      project_doc_fallback_filenames: ['a"b.md'],
      other: 1,
    });
    expect(keys).toEqual(["project_doc_max_bytes", "project_doc_fallback_filenames"]);
    const file = path.join(tempDir("toml"), "config.toml");
    writeFileSync(file, lines.join("\n") + "\n");
    expect(readCodexToml(file)).toEqual({ project_doc_max_bytes: 10, project_doc_fallback_filenames: ['a"b.md'] });
  });
});
