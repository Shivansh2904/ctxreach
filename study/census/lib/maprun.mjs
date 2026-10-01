// Runs `ctxreach map --json` for one launch directory, the way a user would,
// as a fresh machine: empty Codex and Claude Code homes, default settings,
// a pinned Claude Code version to model.
//
// The census calls map in this process (`inProcessMapRunner`): the built
// library's `map` and `toJson`, which dist/index.js re-exports from the same
// chunk dist/cli.js imports them from, called as the CLI's map command calls
// them. Spawning the CLI once per launch directory (`spawnMapRunner`) cost
// about 2.3 s a directory on the pilot machine, almost all of it starting
// node; it stays as the reference the in-process runner is checked against
// (K2's baseline over every K1 fixture, and `crossCheckedRunner` during the
// census).

import { execFileSync, spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The arguments after `ctxreach`. */
export function mapArgs({ launchDir, repoRoot, codexHome, claudeHome, claudeVersion }) {
  return [
    "map",
    "--json",
    "--from",
    launchDir,
    "--repo",
    repoRoot,
    "--codex-home",
    codexHome,
    "--claude-home",
    claudeHome,
    ...(claudeVersion ? ["--claude-version", claudeVersion] : []),
  ];
}

/**
 * A runner that spawns `node <cliPath> map --json ...` and parses its output.
 * Resolves to `{ json }` or `{ error }`; never rejects.
 */
export function spawnMapRunner(cliPath, { timeoutMs = 60_000 } = {}) {
  return (opts) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [cliPath, ...mapArgs(opts)], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1" },
      });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return resolve({ error: `map exited ${code}: ${err.trim().slice(0, 300)}` });
        try {
          resolve({ json: JSON.parse(out) });
        } catch (e) {
          resolve({ error: `map printed invalid JSON: ${e.message}` });
        }
      });
      child.on("error", (e) => resolve({ error: `could not run map: ${e.message}` }));
    });
}

/** A directory option the CLI would refuse (src/program.ts, UsageError). */
class UsageError extends Error {}

/** src/program.ts `existingDir`: resolve a directory option, or say why it cannot be used. */
function existingDir(flag, given) {
  const resolved = path.resolve(given);
  const where = resolved === given ? "" : ` (resolved to ${resolved})`;
  let isDir;
  try {
    isDir = statSync(resolved).isDirectory();
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR")
      throw new UsageError(`${flag} ${given} does not exist${where}`);
    throw new UsageError(`${flag} ${given} cannot be read${where}: ${err.message}`);
  }
  if (!isDir) throw new UsageError(`${flag} ${given} is a file, not a directory${where}`);
  return resolved;
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * `ctxreach map --json` in this process. `lib` holds `map`, `toJson` and
 * `ConfigError` (the built library, or src in tests); `version` is the one
 * the CLI prints. The steps are the map command's (src/program.ts): check
 * both directories, call `map` with the same options, print the JSON as the
 * CLI prints it and parse it back. A failure comes back in the spawned
 * runner's words ("map exited 2: ctxreach: <message>"); anything the CLI
 * would crash on comes back as "map threw: <message>".
 */
export function inProcessMapRunner({ lib, version }) {
  if (typeof lib?.map !== "function" || typeof lib?.toJson !== "function")
    throw new Error("inProcessMapRunner needs the library's map and toJson");
  if (!version) throw new Error("inProcessMapRunner needs the version the CLI prints");
  return async ({ launchDir, repoRoot, codexHome, claudeHome, claudeVersion }) => {
    try {
      const from = existingDir("--from", launchDir);
      const repo = existingDir("--repo", repoRoot);
      if (!inside(from, repo)) throw new UsageError(`--from ${from} is outside --repo ${repo}`);
      const result = lib.map({
        launchDir: from,
        repoRoot: repo,
        agents: ["codex", "claude"],
        codex: { home: path.resolve(codexHome) },
        claude: { home: path.resolve(claudeHome), ...(claudeVersion ? { version: claudeVersion } : {}) },
      });
      return { json: JSON.parse(JSON.stringify(lib.toJson(result, version), null, 2) + "\n") };
    } catch (e) {
      if (e instanceof UsageError || (lib.ConfigError && e instanceof lib.ConfigError))
        return { error: `map exited 2: ${`ctxreach: ${e.message}`.trim().slice(0, 300)}` };
      return { error: `map threw: ${e?.message ?? e}` };
    }
  };
}

/**
 * The in-process runner over a build: `map`, `toJson` and `ConfigError`
 * from `<distDir>/index.js`, and the version from `<distDir>/cli.js --version`
 * (the one spawn this runner needs).
 */
export async function inProcessMapRunnerFromDist(distDir) {
  const lib = await import(pathToFileURL(path.join(path.resolve(distDir), "index.js")).href);
  const version = execFileSync(process.execPath, [path.join(distDir, "cli.js"), "--version"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return inProcessMapRunner({ lib, version });
}

/**
 * A runner that also asks `reference` (the spawned CLI) for the calls `pick`
 * selects and compares the two answers. A difference becomes an error, which
 * the census records as a fault on the row; `stats` counts the calls checked,
 * those that agreed, and where they differed.
 */
export function crossCheckedRunner(primary, reference, { pick, stats }) {
  return async (opts) => {
    const mine = await primary(opts);
    if (!pick(opts)) return mine;
    const theirs = await reference(opts);
    stats.checked++;
    if (JSON.stringify(mine) === JSON.stringify(theirs)) {
      stats.agreed++;
      return mine;
    }
    stats.differ.push(opts.launchDir);
    return { error: `in-process map and the CLI disagree at ${opts.launchDir}` };
  };
}
