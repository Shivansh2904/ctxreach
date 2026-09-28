import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JavaScript script without type declarations
import { occurrences, PLANTS, run } from "../scripts/plant-probe-faults.mjs";

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

  it("deletes what a planted run leaves in the temp directory, and nothing anyone else made there", () => {
    let concurrent = "";
    let leaked = "";
    // Stands in for the child process that runs the suite with a plant.
    const spawn = (_exe: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      // Another process (another test run, a real probe) makes an entry while the plant runs...
      concurrent = mkdtempSync(path.join(os.tmpdir(), "ctxreach-concurrent-"));
      // ...and the planted run leaves one behind in the temp directory it was given.
      const tmp = options.env?.TMPDIR ?? options.env?.TEMP ?? os.tmpdir();
      leaked = mkdtempSync(path.join(tmp, "ctxreach-leaked-"));
      const result = { name: null, total: 1, failed: [], broken: [], applied: false };
      return { status: 0, stdout: `\nPLANT-RESULT ${JSON.stringify(result)}\n`, stderr: "" };
    };
    try {
      const r = (run as (name: null, files: undefined, spawn: unknown) => { total: number })(null, undefined, spawn);
      expect(r.total).toBe(1);
      expect(existsSync(leaked)).toBe(false);
      expect(existsSync(concurrent)).toBe(true);
    } finally {
      if (concurrent) rmSync(concurrent, { recursive: true, force: true });
      if (leaked) rmSync(leaked, { recursive: true, force: true });
    }
  });
});
