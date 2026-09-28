import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { plantFile, TokenSource } from "../src/probe/canary.js";
import { createSandbox, removeSandbox, sandboxOf, SANDBOX_PREFIX } from "../src/probe/sandbox.js";
import { SafetyError } from "../src/probe/types.js";
import { materialise, tempDir } from "./helpers/fixture.js";

describe("the sandbox", () => {
  it("copies the repository without .git or node_modules, gives it a fresh git, and removes itself", () => {
    const fx = materialise("claude-local-shadows-agents");
    mkdirSync(fx.at("node_modules/pkg"), { recursive: true });
    writeFileSync(fx.at("node_modules/pkg/CLAUDE.md"), "x");
    writeFileSync(fx.at(".git/config"), "[core]\n\tfsmonitor = evil\n");
    const tmp = tempDir("sandboxes");
    const box = createSandbox(fx.repo, { tmpRoot: tmp });
    expect(path.basename(box.base).startsWith(SANDBOX_PREFIX)).toBe(true);
    expect(box.skipped.sort()).toEqual([".git", "node_modules"]);
    expect(existsSync(path.join(box.repo, "node_modules"))).toBe(false);
    expect(readFileSync(path.join(box.repo, ".git", "config"), "utf8")).not.toContain("fsmonitor");
    expect(existsSync(path.join(box.repo, ".git", "hooks"))).toBe(false);
    expect(readdirSync(box.repo).sort()).toEqual([".git", "AGENTS.md", "CLAUDE.local.md"]);
    expect(sandboxOf(box.repo).repo).toBe(box.repo);
    removeSandbox(box);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("keeps planting inside the copy: the marker file beside it cannot be planted", () => {
    const fx = materialise("claude-local-shadows-agents");
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      expect(() => plantFile(box.repo, "../ctxreach-sandbox.json", new TokenSource())).toThrow(SafetyError);
      plantFile(box.repo, "AGENTS.md", new TokenSource());
      expect(readFileSync(fx.at("AGENTS.md"), "utf8")).not.toContain("CTXR-");
    } finally {
      removeSandbox(box);
    }
  });

  it("refuses to copy the home directory, a filesystem root, or into the repository itself", () => {
    expect(() => createSandbox(os.homedir())).toThrow(SafetyError);
    expect(() => createSandbox(path.parse(process.cwd()).root)).toThrow(SafetyError);
    const fx = materialise("claude-local-shadows-agents");
    mkdirSync(fx.at("tmp"));
    expect(() => createSandbox(fx.repo, { tmpRoot: fx.at("tmp") })).toThrow(SafetyError);
  });

  it("refuses a repository over the size limit and leaves nothing behind", () => {
    const fx = materialise("claude-local-shadows-agents");
    const tmp = tempDir("sandboxes");
    expect(() => createSandbox(fx.repo, { tmpRoot: tmp, limits: { maxFiles: 1, maxBytes: 1e9 } })).toThrow(
      /more than 1 files/,
    );
    expect(readdirSync(tmp)).toEqual([]);
  });

  it("says a directory is not in a sandbox, and refuses to delete one that is not", () => {
    const plain = tempDir("plain");
    expect(() => sandboxOf(plain)).toThrow(SafetyError);
    expect(() => removeSandbox({ base: plain })).toThrow(SafetyError);
    expect(existsSync(plain)).toBe(true);
  });
});
