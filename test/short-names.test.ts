/**
 * Windows spells a directory two ways: its long name and, on most volumes, a
 * short (8.3) name such as `CTXREA~1`. GitHub's Windows runners give the
 * system temp directory in the short spelling (`C:\Users\RUNNER~1\...`); a
 * junction keeps the spelling it was made with; and `realpathSync` keeps a
 * short name where `realpathSync.native` expands it. These tests give the
 * sandbox every path in the short spelling and expect the same answers as
 * for the long one: a link target inside the repository is inside it, the
 * marker names the directory it is in, every refusal has its own reason, and
 * what is stored or returned is the long spelling. They skip, and say why,
 * on a volume that gives directories no short name.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { claudeAdapter, findClaude } from "../src/agents/claude/adapter.js";
import {
  assertReadyToRun,
  createSandbox,
  removeSandbox,
  sandboxOf,
  SANDBOX_PREFIX,
  stripTree,
} from "../src/probe/sandbox.js";
import { canonicalPath, samePath } from "../src/util/fs.js";
import { materialise, tempDir } from "./helpers/fixture.js";

const win32 = process.platform === "win32";

/** The short (8.3) spelling of an existing directory, from cmd's `%~sI`, or undefined when the volume gives it none. */
function shortSpelling(dir: string): string | undefined {
  const cmd = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const r = spawnSync(cmd, ["/d", "/c", `for %I in ("${dir}") do @echo %~sI`], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
  const out = (r.stdout ?? "").trim();
  if (r.status !== 0 || !out || samePath(out, dir) || !existsSync(out)) return undefined;
  return out;
}

/** A stand-in for the system temp directory, and its short spelling (`...\CTXREA~1`). */
const systemTmp = win32 ? tempDir("system-tmp") : undefined;
const shortTmp = systemTmp ? shortSpelling(systemTmp) : undefined;

describe.runIf(win32)("the system temp directory spelled by its short (8.3) name (Windows)", () => {
  /** The short spelling, or the test is skipped with the reason. */
  function short(ctx: TestContext): string {
    if (!shortTmp) ctx.skip(`8.3 names are disabled on this volume: ${systemTmp} has no short name`);
    return shortTmp;
  }

  beforeEach((ctx) => {
    // As on GitHub's Windows runners, where TEMP is C:\Users\RUNNER~1\AppData\Local\Temp.
    vi.spyOn(os, "tmpdir").mockReturnValue(short(ctx));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A repository under the short-spelled temp directory, so every path to it is spelled short. */
  function repoSpelledShort(tmp: string) {
    const fx = materialise("claude-local-shadows-agents");
    expect(fx.repo.startsWith(tmp)).toBe(true);
    return fx;
  }

  /** A sandbox's copy, spelled through the short name of the temp directory. */
  function copySpelledShort(tmp: string, repo: string): string {
    expect(repo).toBe(canonicalPath(repo));
    const spelled = path.join(tmp, path.relative(canonicalPath(tmp), repo));
    expect(spelled).not.toBe(repo);
    expect(existsSync(spelled)).toBe(true);
    return spelled;
  }

  it("copies a link to a directory inside the repository as a directory, and stores the copy's long name", (ctx) => {
    const tmp = short(ctx);
    const fx = repoSpelledShort(tmp);
    mkdirSync(fx.at("docs"));
    writeFileSync(fx.at("docs/guide.md"), "# Guide\n");
    // A junction made with the short spelling keeps it: its target reads back as `...\CTXREA~1\...\docs`.
    symlinkSync(fx.at("docs"), fx.at("linked"), "junction");
    const box = createSandbox(fx.repo, { tmpRoot: tmp });
    try {
      expect(box.links).toEqual(["linked: copied as a directory (a link to docs)"]);
      expect(readFileSync(path.join(box.repo, "linked", "guide.md"), "utf8")).toBe("# Guide\n");
      // Returned and stored in the long spelling.
      expect(box.base).toBe(canonicalPath(box.base));
      expect(box.base).not.toContain("~");
      expect(box.source).toBe(canonicalPath(fx.repo));
      const marker = JSON.parse(readFileSync(path.join(box.base, "ctxreach-sandbox.json"), "utf8")) as object;
      expect(marker).toMatchObject({ base: box.base, source: box.source });
    } finally {
      removeSandbox(box);
    }
  });

  it("finds, checks, strips and removes the sandbox by the short spelling of its copy", (ctx) => {
    const tmp = short(ctx);
    const fx = repoSpelledShort(tmp);
    const box = createSandbox(fx.repo, { tmpRoot: tmp });
    const copy = copySpelledShort(tmp, box.repo);
    try {
      expect(sandboxOf(copy)).toEqual({
        base: box.base,
        repo: box.repo,
        source: box.source,
        finished: true,
        nonce: box.nonce,
      });
      expect(() => assertReadyToRun(sandboxOf(copy), box.nonce, copy)).not.toThrow();
      writeFileSync(path.join(copy, ".mcp.json"), "{}");
      const again = { repo: copy, stripped: [] as string[] };
      stripTree(again);
      expect(again.stripped).toEqual([".mcp.json"]);
      expect(existsSync(path.join(box.repo, ".mcp.json"))).toBe(false);
    } finally {
      removeSandbox({ base: path.dirname(copy) });
      expect(existsSync(box.base)).toBe(false);
    }
  });

  it("refuses a forged sandbox for its own reason, whatever spelling its marker names it in", (ctx) => {
    const tmp = short(ctx);
    const fx = repoSpelledShort(tmp);
    // As tests elsewhere forge one: a marker that names its directory as spelled, here short.
    const forge = (parent: string, name: string) => {
      const base = path.join(parent, name);
      mkdirSync(path.join(base, "repo", ".git"), { recursive: true });
      writeFileSync(
        path.join(base, "ctxreach-sandbox.json"),
        JSON.stringify({ tool: "ctxreach", base, source: fx.repo }),
      );
      return path.join(base, "repo");
    };
    const forged = tempDir("forged");
    expect(forged.startsWith(tmp)).toBe(true);
    expect(() => sandboxOf(forge(forged, "not-a-sandbox"))).toThrow(/not named like a ctxreach sandbox/);
    const unfinished = forge(forged, `${SANDBOX_PREFIX}unfinished`);
    expect(() => assertReadyToRun(sandboxOf(unfinished), "0".repeat(32), unfinished)).toThrow(/never finished/);
    // Seen from a system temp directory elsewhere, the forged sandbox is outside it.
    vi.spyOn(os, "tmpdir").mockReturnValue(tempDir("other-tmp"));
    expect(() => sandboxOf(unfinished)).toThrow(/not inside the system temp directory/);
    expect(() => removeSandbox({ base: path.dirname(unfinished) })).toThrow(/not inside the system temp directory/);
    expect(existsSync(unfinished)).toBe(true);
  });

  it("finds a sandbox that overlaps the repository its marker names, one spelled short and the other long", (ctx) => {
    const tmp = short(ctx);
    const outer = tempDir("overlap");
    expect(outer.startsWith(tmp)).toBe(true);
    const base = path.join(outer, `${SANDBOX_PREFIX}forged`);
    mkdirSync(path.join(base, "repo"), { recursive: true });
    writeFileSync(
      path.join(base, "ctxreach-sandbox.json"),
      JSON.stringify({ tool: "ctxreach", base, source: canonicalPath(outer) }),
    );
    expect(() => sandboxOf(path.join(base, "repo"))).toThrow(/overlaps the repository/);
  });

  it("finds claude in a PATH directory spelled short, and refuses one inside the copy however the copy is spelled", async (ctx) => {
    const tmp = short(ctx);
    const bin = tempDir("bin");
    expect(bin.startsWith(tmp)).toBe(true);
    writeFileSync(path.join(bin, "claude.exe"), "");
    // As spelled on PATH.
    expect(findClaude({ PATH: bin })).toBe(path.join(bin, "claude.exe"));

    const fx = repoSpelledShort(tmp);
    const box = createSandbox(fx.repo, { tmpRoot: tmp });
    const copy = copySpelledShort(tmp, box.repo);
    try {
      writeFileSync(path.join(copy, "claude.exe"), "");
      const claudeHome = tempDir("claude-home");
      const agent = claudeAdapter({ bin: path.join(copy, "claude.exe"), claudeHome, env: { ...process.env } });
      await expect(
        agent.run({
          workdir: copy,
          prompt: "list the tokens",
          mode: "recall",
          timeoutMs: 1000,
          transcriptPath: path.join(tempDir("transcript"), "t.jsonl"),
          redactions: [],
          sandboxNonce: box.nonce,
        }),
      ).rejects.toThrow(/inside the temporary copy of the repository/);
      expect(existsSync(path.join(claudeHome, "projects"))).toBe(false);
    } finally {
      removeSandbox(box);
    }
  });
});
