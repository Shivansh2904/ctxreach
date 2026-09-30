import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A test that runs git with the inherited environment can act on the real
// repository: under `git rebase --exec`, GIT_DIR points at it, and a `git init`
// there once set core.bare = true on the working clone.
describe("tests that run git", () => {
  it("always pass an explicit env, so GIT_DIR from the caller cannot reach the real repository", () => {
    const dir = path.join(__dirname);
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(path.join(dir, f), "utf8");
      for (const m of text.matchAll(/execFileSync\(\s*"git"[^;]*;/g)) {
        if (!/\benv\b/.test(m[0])) offenders.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
