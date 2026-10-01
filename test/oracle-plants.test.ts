import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JavaScript script without type declarations
import { occurrences, oracleTests, PLANTS } from "../scripts/plant-oracle-faults.mjs";

describe("scripts/plant-oracle-faults.mjs", () => {
  it("has a plant for every part of the oracle it claims to check", () => {
    const files = new Set((PLANTS as { file: string }[]).map((p) => p.file));
    expect([...files].sort()).toEqual([
      "src/oracle/capture.ts",
      "src/oracle/claude-capture.ts",
      "src/oracle/codex-home.ts",
      "src/oracle/codex-render.ts",
      "src/oracle/score.ts",
      "src/oracle/verify.ts",
    ]);
    const names = (PLANTS as { name: string }[]).map((p) => p.name);
    // The plants the plan asks for, by name.
    for (const wanted of [
      "cut-ignored",
      "wrong-separator",
      "codex-home-is-user-home",
      "trust-mirroring-off",
      "decoy-check-off",
      "token-pattern-9-chars",
      "capture-binds-any-host",
      "model-pin-missing",
      "plugin-assert-removed",
      "identical-render-check-off",
      "render-saved-whole",
      "codex-items-kept-whole",
      "capture-saved-whole",
      "capture-blocks-kept-whole",
    ])
      expect(names).toContain(wanted);
    expect(new Set(names).size).toBe(names.length);
  });

  it("finds each plant's text exactly once, so no plant silently changes nothing", () => {
    for (const o of occurrences() as { name: string; count: number }[]) expect([o.name, o.count]).toEqual([o.name, 1]);
  });

  it("runs the oracle's own tests, which every plant must be caught by", () => {
    const files = oracleTests() as string[];
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files.every((f) => /^test\/oracle-.*\.test\.ts$/.test(f))).toBe(true);
  });
});
