import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JavaScript script without type declarations
import { occurrences, PLANTS } from "../scripts/plant-probe-faults.mjs";

describe("scripts/plant-probe-faults.mjs", () => {
  it("has a plant for every part of the probe it claims to check", () => {
    const files = new Set((PLANTS as { file: string }[]).map((p) => p.file));
    expect([...files].sort()).toEqual([
      "src/agents/claude/adapter.ts",
      "src/agents/claude/events.ts",
      "src/probe/canary.ts",
      "src/probe/classify.ts",
      "src/probe/compare.ts",
      "src/probe/probe.ts",
      "src/probe/sandbox.ts",
      "src/probe/score.ts",
    ]);
  });

  it("finds each plant's text exactly once, so no plant silently changes nothing", () => {
    for (const o of occurrences() as { name: string; count: number }[]) expect([o.name, o.count]).toEqual([o.name, 1]);
  });
});
