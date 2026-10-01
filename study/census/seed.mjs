// The study's seed: the first 8 hex digits of the commit the tag prereg-v1
// points to. It cannot be known before study/PREREG.md is committed, which is
// the point: nobody can pick it after seeing data. The script also checks
// that the tagged commit holds the pre-registration, with every tag-time
// value filled in (no {{stamp:...}} placeholder left), and returns the tagged
// text: study runs read the registration and its stamps from it.
//
// Usage: node study/census/seed.mjs [tag]   (default prereg-v1)

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSeed } from "./lib/prng.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The environment for git without any GIT_* variable, so git finds the
 * repository from `cwd` alone. Under `git rebase --exec` (or a hook) GIT_DIR
 * and friends point at the calling repository, and a git command meant for
 * another folder would act on that one instead.
 */
export function gitEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !/^GIT_/i.test(k)));
}

export function seedFromTag(tag = "prereg-v1", cwd = ROOT) {
  const git = (...a) =>
    execFileSync("git", a, { cwd, encoding: "utf8", env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
  let commit;
  try {
    commit = git("rev-parse", "--verify", `${tag}^{commit}`);
  } catch {
    throw new Error(
      `tag ${tag} does not exist here; the seed cannot be computed before the pre-registration is tagged`,
    );
  }
  let prereg;
  try {
    // Untrimmed: the tagged text is compared with the working copy byte for byte (lib/registry.mjs).
    prereg = execFileSync("git", ["show", `${commit}:study/PREREG.md`], {
      cwd,
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(`${tag} (${commit}) does not contain study/PREREG.md`);
  }
  // A registration whose tag-time values were never filled in is not a registration.
  const left = [...new Set([...prereg.matchAll(/\{\{stamp:([^}]+)\}\}/g)].map((m) => m[1]))];
  if (left.length)
    throw new Error(
      `${tag} (${commit}): study/PREREG.md still holds ${left.length} placeholder(s) (${left.slice(0, 3).join(", ")}); run study/prereg.mjs stamp before tagging`,
    );
  return { tag, commit, seed: commit.slice(0, 8), prereg };
}

/**
 * The seed of a draw made after the census (K5's repositories, K6's pairs):
 * for a study draw, the tag's seed (`--seed-from-tag prereg-v1`), as
 * sample.mjs and run-census.mjs take it; a typed `--seed` only for a pilot
 * draw (`--label pilot`), so a mistyped seed can never draw a study set.
 * Returns { seed, from }; throws on a typed seed for a study draw, on both or
 * neither, on another label, and when the tag gives no seed. `resolve` is
 * seedFromTag (tests pass a stand-in).
 */
export function drawSeed({ label = "study", seed, seedFromTag: tag }, resolve = seedFromTag) {
  if (label !== "study" && label !== "pilot") throw new Error(`--label study or pilot, not ${label}`);
  if (seed !== undefined && tag !== undefined)
    throw new Error("give one of --seed-from-tag and --seed (with --label pilot), not both");
  if (tag === undefined) {
    if (label === "study")
      throw new Error(
        "a study draw takes its seed from the prereg tag (--seed-from-tag prereg-v1); a typed --seed is for --label pilot only",
      );
    if (seed === undefined) throw new Error("give --seed HEX8 for a pilot draw");
    return { seed: checkSeed(seed), from: "typed (pilot)" };
  }
  const tagged = resolve(tag);
  return { seed: checkSeed(tagged.seed), from: `${tag} (${tagged.commit})` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const s = seedFromTag(process.argv[2] ?? "prereg-v1");
    console.log(`${s.tag} -> ${s.commit}; seed ${s.seed}`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
