// Make (or remove) the scratch home for cell B2. The main session runs this,
// once, before the B2 warm-up; the build lane never did.
//
// It creates C:/ctxr-home (a stand-in home folder: the B2 arms run Claude Code
// with USERPROFILE and HOME pointed here and CLAUDE_CONFIG_DIR unset, so its
// .claude folder plays ~/.claude) and C:/ctxr-out (a folder outside that
// home, for arm A2's copy). It writes a marker file so run-cells.mjs can tell
// a folder this script made from anything else, and it refuses to touch the
// real home folder, anything inside it, or a folder that exists without its
// marker. The home's .claude/CLAUDE.md is written per trial by the harness and
// removed after each trial; this script writes no instruction file.
//
// Usage:
//   node study/behavioural/setup-b2-home.mjs --yes [--home C:/ctxr-home] [--outside C:/ctxr-out]
//   node study/behavioural/setup-b2-home.mjs --remove --yes [same folders]

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MARKER = ".ctxr-home-marker";

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Why `dir` must not be used as a scratch folder, or undefined. */
export function refusal(dir, realHome = os.homedir()) {
  if (inside(dir, realHome) || inside(realHome, dir))
    return `${dir} is, holds, or is inside the real home folder ${realHome}`;
  if (existsSync(dir) && readdirSync(dir).length && !existsSync(path.join(dir, MARKER)))
    return `${dir} exists, is not empty, and was not made by this script`;
  return undefined;
}

export function setup({ home, outside, realHome = os.homedir() }) {
  for (const d of [home, outside]) {
    const why = refusal(d, realHome);
    if (why) throw new Error(`refusing: ${why}`);
  }
  for (const d of [home, outside]) {
    mkdirSync(path.join(d, "tmp"), { recursive: true });
    writeFileSync(path.join(d, MARKER), "made by study/behavioural/setup-b2-home.mjs for cell B2\n");
  }
  mkdirSync(path.join(home, ".claude"), { recursive: true });
  return { home, outside };
}

export function remove({ home, outside, realHome = os.homedir() }) {
  for (const d of [home, outside]) {
    if (!existsSync(d)) continue;
    if (!existsSync(path.join(d, MARKER))) throw new Error(`refusing to remove ${d}: no ${MARKER}`);
    const why = refusal(d, realHome);
    if (why) throw new Error(`refusing: ${why}`);
    rmSync(d, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, d) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : d;
  };
  const home = path.resolve(opt("--home", "C:/ctxr-home"));
  const outside = path.resolve(opt("--outside", "C:/ctxr-out"));
  if (!args.includes("--yes")) {
    console.error(
      `would ${args.includes("--remove") ? "remove" : "create"} ${home} and ${outside}; pass --yes to do it`,
    );
    process.exit(2);
  }
  try {
    if (args.includes("--remove")) remove({ home, outside });
    else setup({ home, outside });
    console.log(`${args.includes("--remove") ? "removed" : "ready"}: ${home}, ${outside}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
