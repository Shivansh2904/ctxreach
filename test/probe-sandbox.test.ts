import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { plantFile, TokenSource } from "../src/probe/canary.js";
import { createSandbox, removeSandbox, sandboxOf, SANDBOX_PREFIX, stripTree } from "../src/probe/sandbox.js";
import { SafetyError } from "../src/probe/types.js";
import { materialise, tempDir } from "./helpers/fixture.js";

/** A link to a directory: a junction on Windows, which needs no Developer Mode. */
function dirLink(target: string, at: string): void {
  symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
}

/** File symlinks need Developer Mode or admin rights on Windows; Linux and macOS always allow them. */
const fileLinksWork = (() => {
  const dir = tempDir("file-link-check");
  try {
    writeFileSync(path.join(dir, "target"), "x");
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  }
})();

/** Every file and link under `dir`, with its content, so a test can show nothing changed. */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const st = lstatSync(p);
      h.update(path.relative(dir, p) + "\0");
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(readFileSync(p));
      else h.update("(link)");
    }
  };
  walk(dir);
  return h.digest("hex");
}

/** Paths under `dir` that are links (symlinks or junctions), found with lstat. */
function linksUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out.push(path.relative(dir, p));
      else if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

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

  it("refuses to copy the home directory, and says that is why", () => {
    // The temporary directory given here does not exist and is outside the
    // home directory, so no other check can refuse first (on Windows the
    // system temp directory is inside the home directory, which another
    // check would also refuse). Only the home check produces this error, and
    // nothing is ever copied.
    const home = os.homedir();
    const nowhere = path.join(path.parse(home).root, `ctxreach-no-such-dir-${process.pid}`);
    expect(existsSync(nowhere)).toBe(false);
    expect(() => createSandbox(home, { tmpRoot: nowhere })).toThrow(SafetyError);
    expect(() => createSandbox(home, { tmpRoot: nowhere })).toThrow(/home directory/);
    expect(existsSync(nowhere)).toBe(false);
  });

  it("refuses to copy a filesystem root, or into the repository itself", () => {
    expect(() => createSandbox(path.parse(process.cwd()).root)).toThrow(SafetyError);
    const fx = materialise("claude-local-shadows-agents");
    mkdirSync(fx.at("tmp"));
    expect(() => createSandbox(fx.repo, { tmpRoot: fx.at("tmp") })).toThrow(SafetyError);
  });

  it("refuses a temporary directory outside the system temp directory, and makes nothing there", () => {
    const fx = materialise("claude-local-shadows-agents");
    const outside = tempDir("not-system-tmp");
    // Seen from a system temp directory elsewhere, `outside` is not inside it.
    vi.spyOn(os, "tmpdir").mockReturnValue(tempDir("system-tmp"));
    try {
      expect(() => createSandbox(fx.repo, { tmpRoot: outside })).toThrow(/outside the system temp directory/);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses a repository over the size limit and leaves nothing behind", () => {
    const fx = materialise("claude-local-shadows-agents");
    const tmp = tempDir("sandboxes");
    expect(() => createSandbox(fx.repo, { tmpRoot: tmp, limits: { maxFiles: 1, maxBytes: 1e9 } })).toThrow(
      /more than 1 files/,
    );
    expect(readdirSync(tmp)).toEqual([]);
  });

  describe.runIf(process.platform === "win32")("another spelling of the same directory (Windows)", () => {
    /** `C:\x` as `\\?\C:\x`. */
    const longForm = (p: string) => `\\\\?\\${p}`;
    /** `C:\x` as `\\host\C$\x`, the drive's administrative share. */
    const adminShare = (host: string, p: string) => `\\\\${host}\\${p.slice(0, 1)}$${p.slice(2)}`;
    const shareWorks = (host: string) => {
      try {
        return statSync(adminShare(host, os.homedir())).isDirectory();
      } catch {
        return false;
      }
    };
    // Nothing is copied: this directory does not exist, so a check that
    // missed would fail at the next step, not copy the home directory.
    const nowhere = path.join(path.parse(os.homedir()).root, `ctxreach-no-such-dir-${process.pid}`);

    it("refuses the home directory, and a directory above it, spelled \\\\?\\C:\\...", () => {
      expect(existsSync(nowhere)).toBe(false);
      for (const dir of [os.homedir(), path.dirname(os.homedir())])
        expect(() => createSandbox(longForm(dir), { tmpRoot: nowhere })).toThrow(/home directory/);
    });

    for (const host of ["localhost", "127.0.0.1"])
      it.skipIf(!shareWorks(host))(`refuses the home directory through the share \\\\${host}\\C$`, () => {
        expect(() => createSandbox(adminShare(host, os.homedir()), { tmpRoot: nowhere })).toThrow(/home directory/);
      });

    it("refuses a temporary directory inside the repository when the repository is spelled another way", () => {
      const fx = materialise("claude-local-shadows-agents");
      mkdirSync(fx.at("tmp"));
      const spellings = [longForm(fx.repo), ...(shareWorks("localhost") ? [adminShare("localhost", fx.repo)] : [])];
      for (const spelled of spellings) {
        // Small limits: a check that missed would copy the copy into itself.
        expect(() =>
          createSandbox(spelled, { tmpRoot: fx.at("tmp"), limits: { maxFiles: 50, maxBytes: 1e6 } }),
        ).toThrow(/inside the repository being copied/);
        expect(readdirSync(fx.at("tmp"))).toEqual([]);
      }
    });

    it("finds a sandbox that overlaps the repository its marker names in another spelling", () => {
      const outer = tempDir("overlap");
      const base = path.join(outer, `${SANDBOX_PREFIX}forged`);
      mkdirSync(path.join(base, "repo"), { recursive: true });
      writeFileSync(
        path.join(base, "ctxreach-sandbox.json"),
        JSON.stringify({ tool: "ctxreach", base, source: longForm(outer) }),
      );
      expect(() => sandboxOf(path.join(base, "repo"))).toThrow(/overlaps the repository/);
    });
  });

  it("says a directory is not in a sandbox, and refuses to delete one that is not", () => {
    const plain = tempDir("plain");
    expect(() => sandboxOf(plain)).toThrow(SafetyError);
    expect(() => removeSandbox({ base: plain })).toThrow(SafetyError);
    expect(existsSync(plain)).toBe(true);
  });
});

describe("links in the repository", () => {
  it("never follows a link out of the repository: a linked .claude outside it is left exactly as it was", () => {
    const fx = materialise("claude-local-shadows-agents");
    const outside = tempDir("linked-claude");
    mkdirSync(path.join(outside, "skills", "deploy"), { recursive: true });
    writeFileSync(path.join(outside, "settings.json"), '{"hooks":{}}');
    writeFileSync(path.join(outside, "skills", "deploy", "SKILL.md"), "# deploy");
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    dirLink(outside, fx.at(".claude"));
    const before = treeHash(outside);

    let box: ReturnType<typeof createSandbox> | undefined;
    try {
      box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    } finally {
      // Checked even when createSandbox throws.
      expect(treeHash(outside)).toBe(before);
    }
    try {
      expect(linksUnder(box.repo)).toEqual([]);
      expect(existsSync(path.join(box.repo, ".claude"))).toBe(false);
      expect(box.skipped).toContain(".claude (a link to outside the repository)");
      expect(box.links).toEqual([".claude: not copied (a link to outside the repository)"]);
    } finally {
      removeSandbox(box);
    }
    expect(treeHash(outside)).toBe(before);
  });

  it("copies a link to a directory inside the repository as a directory, and leaves out a link that loops", () => {
    const fx = materialise("claude-local-shadows-agents");
    mkdirSync(fx.at("docs/guides"), { recursive: true });
    writeFileSync(fx.at("docs/guides/testing.md"), "# Testing\n");
    mkdirSync(fx.at("packages/api"), { recursive: true });
    dirLink(fx.at("docs"), fx.at("packages/api/docs"));
    dirLink(fx.repo, fx.at("packages/api/root"));
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      expect(linksUnder(box.repo)).toEqual([]);
      expect(lstatSync(path.join(box.repo, "packages", "api", "docs")).isDirectory()).toBe(true);
      expect(readFileSync(path.join(box.repo, "packages", "api", "docs", "guides", "testing.md"), "utf8")).toBe(
        "# Testing\n",
      );
      expect(existsSync(path.join(box.repo, "packages", "api", "root"))).toBe(false);
      expect(box.skipped).toContain("packages/api/root (a link to a directory that contains it)");
      expect([...box.links].sort()).toEqual([
        "packages/api/docs: copied as a directory (a link to docs)",
        "packages/api/root: not copied (a link to a directory that contains it)",
      ]);
    } finally {
      removeSandbox(box);
    }
  });

  it("leaves out a link to nothing, and says so", () => {
    const fx = materialise("claude-local-shadows-agents");
    const gone = tempDir("gone");
    dirLink(gone, fx.at("dangling"));
    rmSync(gone, { recursive: true });
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      expect(linksUnder(box.repo)).toEqual([]);
      expect(existsSync(path.join(box.repo, "dangling"))).toBe(false);
      expect(box.skipped).toContain("dangling (a link to nothing)");
    } finally {
      removeSandbox(box);
    }
  });

  it.runIf(fileLinksWork)("copies CLAUDE.md -> AGENTS.md as a regular file with the same content", () => {
    const fx = materialise("claude-local-shadows-agents");
    symlinkSync("AGENTS.md", fx.at("CLAUDE.md"), "file");
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      const copied = path.join(box.repo, "CLAUDE.md");
      expect(lstatSync(copied).isSymbolicLink()).toBe(false);
      expect(lstatSync(copied).isFile()).toBe(true);
      expect(readFileSync(copied, "utf8")).toBe(readFileSync(fx.at("AGENTS.md"), "utf8"));
      expect(box.links).toEqual(["CLAUDE.md: copied as a file (a link to AGENTS.md)"]);
      expect(linksUnder(box.repo)).toEqual([]);
    } finally {
      removeSandbox(box);
    }
  });

  it("refuses to remove anything reached through a link, even if one were in the copy", () => {
    // A real copy that a fault left a link in.
    const fx = materialise("claude-local-shadows-agents");
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    const outside = tempDir("strip-outside");
    writeFileSync(path.join(outside, "settings.json"), "{}");
    mkdirSync(path.join(outside, "skills"));
    writeFileSync(path.join(outside, "keep.txt"), "keep");
    dirLink(outside, path.join(box.repo, ".claude"));
    const before = treeHash(outside);
    try {
      expect(() => stripTree({ repo: box.repo, stripped: [] })).toThrow(/a link leads it outside/);
      expect(treeHash(outside)).toBe(before);
    } finally {
      rmSync(path.join(box.repo, ".claude"));
      removeSandbox(box);
    }
  });
});

describe("stripping only a sandbox's own copy", () => {
  it("refuses a directory that is not a sandbox's copy, and removes nothing from it", () => {
    const repo = path.join(tempDir("strip"), "repo");
    mkdirSync(repo);
    writeFileSync(path.join(repo, ".mcp.json"), "{}");
    expect(() => stripTree({ repo, stripped: [] })).toThrow(/is not inside a ctxreach sandbox/);
    expect(existsSync(path.join(repo, ".mcp.json"))).toBe(true);
  });

  it("refuses a sandbox's copy reached through a link, or a directory inside it", () => {
    const fx = materialise("claude-local-shadows-agents");
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    const via = path.join(tempDir("via"), "base");
    dirLink(box.base, via);
    try {
      mkdirSync(path.join(box.repo, "sub"));
      writeFileSync(path.join(box.repo, "sub", ".mcp.json"), "{}");
      expect(() => stripTree({ repo: path.join(via, "repo"), stripped: [] })).toThrow(/is not the copy's root/);
      expect(() => stripTree({ repo: path.join(box.repo, "sub"), stripped: [] })).toThrow(/is not the copy's root/);
      expect(existsSync(path.join(box.repo, "sub", ".mcp.json"))).toBe(true);
    } finally {
      rmSync(via);
      removeSandbox(box);
    }
  });
});

/** Run git in `cwd` with no GIT_ variables, as the agent would. */
function git(cwd: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_")));
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Make `dir` a git repository, then rename its .git to `name`. */
function gitDirNamed(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--template=");
  renameSync(path.join(dir, ".git"), path.join(dir, name));
  return path.join(dir, name);
}

describe("the host's git config", () => {
  it("is not read when ctxreach gives the copy its .git", () => {
    const home = tempDir("host-home");
    writeFileSync(path.join(home, ".gitconfig"), "[init]\n\tdefaultBranch = from-host-config\n");
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("XDG_CONFIG_HOME", home);
    try {
      const fx = materialise("claude-local-shadows-agents", { git: false });
      const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
      try {
        expect(readFileSync(path.join(box.repo, ".git", "HEAD"), "utf8")).not.toContain("from-host-config");
      } finally {
        removeSandbox(box);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the repository's own git, whatever its name's case", () => {
  it("leaves out a .GIT directory, so git never runs its fsmonitor command", () => {
    const fx = materialise("claude-local-shadows-agents", { git: false });
    const marker = path.join(tempDir("fsmonitor"), "ran");
    const dotGit = gitDirNamed(fx.repo, ".GIT");
    writeFileSync(
      path.join(dotGit, "config"),
      `[core]\n\trepositoryformatversion = 0\n\tfsmonitor = "touch '${marker.split(path.sep).join("/")}'; echo"\n`,
    );
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      // What the agent's own git calls would do in the copy.
      git(box.repo, "status");
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(path.join(box.repo, ".git", "config"), "utf8")).not.toContain("fsmonitor");
      expect(box.skipped).toContain(".GIT");
      expect(readdirSync(box.repo).filter((n) => n.toLowerCase() === ".git")).toEqual([".git"]);
    } finally {
      removeSandbox(box);
    }
  });

  it("leaves out a nested pkg/.Git, and names with trailing dots or spaces, so git in pkg uses the copy's .git", () => {
    const fx = materialise("claude-local-shadows-agents");
    gitDirNamed(fx.at("pkg"), ".Git");
    mkdirSync(fx.at("other/.git."), { recursive: true });
    mkdirSync(fx.at("third/node_modules "), { recursive: true });
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes"), launchDir: "pkg" });
    try {
      const own = realpathSync.native(path.join(box.repo, ".git"));
      expect(realpathSync.native(git(path.join(box.repo, "pkg"), "rev-parse", "--absolute-git-dir"))).toBe(own);
      expect(box.skipped).toEqual(expect.arrayContaining([".git", "pkg/.Git", "other/.git.", "third/node_modules "]));
    } finally {
      removeSandbox(box);
    }
  });

  it("leaves out a .GIT file that points git init at a repository outside, which stays unchanged", () => {
    const fx = materialise("claude-local-shadows-agents", { git: false });
    const outside = tempDir("outside-repo");
    git(outside, "init", "-q", "--template=");
    writeFileSync(path.join(outside, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
    const before = treeHash(outside);
    writeFileSync(fx.at(".GIT"), `gitdir: ${path.join(outside, ".git").split(path.sep).join("/")}\n`);
    let box: ReturnType<typeof createSandbox> | undefined;
    try {
      box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    } finally {
      // Checked even when createSandbox throws.
      expect(treeHash(outside)).toBe(before);
    }
    try {
      expect(box.skipped).toContain(".GIT");
      expect(lstatSync(path.join(box.repo, ".git")).isDirectory()).toBe(true);
    } finally {
      removeSandbox(box);
    }
  });

  describe("never runs a git that the repository holds", () => {
    it.runIf(process.platform === "win32")(
      "on Windows, where a program is looked for in its working directory first (unless NoDefaultCurrentDirectoryInExePath is set)",
      () => {
        const fake = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
        const fx = materialise("claude-local-shadows-agents");
        copyFileSync(fake, fx.at("git.exe"));
        const saved = process.env.NoDefaultCurrentDirectoryInExePath;
        delete process.env.NoDefaultCurrentDirectoryInExePath;
        let box: ReturnType<typeof createSandbox> | undefined;
        try {
          // whoami.exe run as git fails, and the copy would get no .git.
          box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
          expect(lstatSync(path.join(box.repo, ".git")).isDirectory()).toBe(true);
        } finally {
          if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
          if (box) removeSandbox(box);
        }
      },
    );

    it.runIf(process.platform !== "win32")("through a relative PATH entry such as .", () => {
      const fx = materialise("claude-local-shadows-agents");
      const marker = path.join(tempDir("fake-git"), "ran");
      writeFileSync(fx.at("git"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
      const saved = process.env.PATH;
      process.env.PATH = `.${path.delimiter}${saved ?? ""}`;
      let box: ReturnType<typeof createSandbox> | undefined;
      try {
        box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
        expect(existsSync(marker)).toBe(false);
        expect(lstatSync(path.join(box.repo, ".git")).isDirectory()).toBe(true);
      } finally {
        process.env.PATH = saved;
        if (box) removeSandbox(box);
      }
    });
  });
});

describe("links that fan out", () => {
  /** fan/l0 ... fan/l9, where each level holds two links, a and b, to the next. */
  function fanOut(fx: ReturnType<typeof materialise>): void {
    for (let i = 0; i < 10; i++) mkdirSync(fx.at(`fan/l${i}`), { recursive: true });
    for (let i = 0; i < 9; i++) for (const n of ["a", "b"]) dirLink(fx.at(`fan/l${i + 1}`), fx.at(`fan/l${i}/${n}`));
  }

  function dirsUnder(dir: string): number {
    let n = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory()) {
          n++;
          walk(path.join(d, e.name));
        }
    };
    walk(dir);
    return n;
  }

  it("copies each directory at most once through a link, and says which links it left out", () => {
    const fx = materialise("claude-local-shadows-agents");
    fanOut(fx);
    const started = Date.now();
    const box = createSandbox(fx.repo, { tmpRoot: tempDir("sandboxes") });
    try {
      // Copied through every path, 10 levels of two links make 2^10 copies of the last level.
      expect(Date.now() - started).toBeLessThan(10_000);
      // The 10 levels, and at most one more copy of each through a link.
      expect(dirsUnder(path.join(box.repo, "fan"))).toBeLessThanOrEqual(20);
      // Which of a and b comes first is the order the directory lists them in.
      const dup = /^fan\/l0\/[ab] \(a duplicate target: fan\/l1, already copied through fan\/l0\/[ab]\)$/;
      expect(box.skipped.filter((s) => dup.test(s))).toHaveLength(1);
      expect(linksUnder(box.repo)).toEqual([]);
    } finally {
      removeSandbox(box);
    }
  });

  it("counts directories and links, not only files, against the limit", () => {
    const fx = materialise("claude-local-shadows-agents");
    fanOut(fx);
    const tmp = tempDir("sandboxes");
    // The fixture has 2 files, far under the limit; its directories and links are not.
    expect(() => createSandbox(fx.repo, { tmpRoot: tmp, limits: { maxFiles: 30, maxBytes: 1e9 } })).toThrow(
      /more than 30 files, directories and links/,
    );
    expect(readdirSync(tmp)).toEqual([]);
  });
});
