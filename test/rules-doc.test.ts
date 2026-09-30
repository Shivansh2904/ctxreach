import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { map } from "../src/map/map.js";
import { materialise } from "./helpers/fixture.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(path.join(ROOT, "docs", "rules.md"), "utf8");

/** First-column ids of the rule tables in docs/rules.md (the Findings table comes after them). */
const rulesPart = doc.split("\n## Findings")[0] ?? "";
const documented = new Set(
  [...rulesPart.matchAll(/^\| `((?:codex|claude)\.[a-z-]+)` \|/gm)].map((m) => m[1] as string),
);

// Run map over every fixture from its root and from packages/api, and
// collect the rule ids and finding codes it actually produces. Checking the
// output rather than grepping the source catches ids built at runtime.
function produced() {
  const rules = new Set<string>();
  const codes = new Map<string, string>();
  const names = readdirSync(path.join(ROOT, "test", "fixtures"));
  for (const name of names) {
    const fx = materialise(name);
    for (const from of [".", "packages/api"]) {
      if (!existsSync(fx.at(from))) continue;
      const r = map({
        launchDir: fx.at(from),
        codex: { home: fx.codexHome },
        claude: { home: fx.claudeHome, ceiling: fx.base },
      });
      for (const f of r.findings) {
        rules.add(f.rule);
        codes.set(f.code, f.severity);
      }
      for (const row of r.matrix) for (const cell of Object.values(row.cells)) rules.add(cell.rule);
    }
  }
  return { rules, codes, fixtures: names.length };
}

// Documented rules that no committed fixture produces as a finding or a
// matrix cell, and why. Adding a rule to docs/rules.md means either adding a
// fixture for it or adding it here with a reason.
const UNEXERCISED = [
  // Recorded for the planned probe; map does not use them.
  "claude.bare",
  "claude.hook-blind",
  // Modelled, but never the reason for a finding or a cell.
  "codex.fallback-names",
  "codex.join",
  // Exercised by unit tests in claude.test.ts and codex.test.ts that build
  // the case at test time (a symlink, a file over 4 MiB, a user config with
  // trust levels, a repository cloned under the fake home directory, a given
  // version).
  "claude.home-ancestor",
  "claude.size",
  "claude.version",
  "codex.global",
  "codex.root",
  "codex.untrusted",
  "codex.zero",
].sort();

describe("docs/rules.md", () => {
  const { rules, codes, fixtures } = produced();

  it("has a fixture that exercises every documented rule, apart from a known few", () => {
    expect(fixtures).toBeGreaterThan(0);
    const unexercised = [...documented].filter((id) => !rules.has(id)).sort();
    expect(unexercised).toEqual(UNEXERCISED);
  });

  it("documents every rule id that map produces", () => {
    expect([...rules].filter((id) => !documented.has(id))).toEqual([]);
  });

  it("lists every finding code with the severity map gives it", () => {
    const missing = [...codes].filter(([code, severity]) => !doc.includes(`| \`${code}\` | ${severity} |`));
    expect(missing).toEqual([]);
  });
});
