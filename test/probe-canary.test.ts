import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { headOffset, isScopedRule, plantDecoy, plantFile, plantText, TokenSource } from "../src/probe/canary.js";
import { SafetyError } from "../src/probe/types.js";
import { materialise, tempDir } from "./helpers/fixture.js";

/** A token source that counts up, so tests know which token goes where. */
function counting(): TokenSource {
  let n = 0;
  return new TokenSource((bytes) => {
    const b = Buffer.alloc(bytes);
    b.writeUInt32BE(++n);
    return b;
  });
}

describe("planting tokens", () => {
  it("puts one token on the first line and one on the last, and says exactly where", () => {
    const original = Buffer.from("# Title\n\n- rule\n");
    const out = plantText(original, "CTXR-00000001", "CTXR-00000002");
    const text = out.bytes.toString("utf8");
    expect(text).toBe("ctxreach canary CTXR-00000001\n\n# Title\n\n- rule\n\nctxreach canary CTXR-00000002\n");
    expect(out.bytes.subarray(out.head, out.head + 13).toString()).toBe("CTXR-00000001");
    expect(out.bytes.subarray(out.tail, out.tail + 13).toString()).toBe("CTXR-00000002");
  });

  it("keeps a byte-order mark and YAML front matter first, and handles a file without a final newline", () => {
    const fm = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("---\npaths:\n  - src/**\n---\n# R\n- x")]);
    expect(headOffset(fm)).toBe(3 + "---\npaths:\n  - src/**\n---\n".length);
    const out = plantText(fm, "CTXR-00000001", "CTXR-00000002");
    const text = out.bytes.toString("utf8");
    expect(text.startsWith("﻿---\npaths:")).toBe(true);
    expect(text.endsWith("- x\n\nctxreach canary CTXR-00000002\n")).toBe(true);
    expect(out.bytes.subarray(out.head, out.head + 13).toString()).toBe("CTXR-00000001");
    expect(out.bytes.subarray(out.tail, out.tail + 13).toString()).toBe("CTXR-00000002");
  });

  it("notes whether a rule file declares paths, from the file itself", () => {
    const scoped = Buffer.from("---\npaths:\n  - a/**\n---\n# R\n");
    expect(isScopedRule(".claude/rules/a.md", scoped)).toBe(true);
    expect(isScopedRule("packages/x/.claude/rules/sub/a.md", scoped)).toBe(true);
    expect(isScopedRule(".claude/rules/a.md", Buffer.from("# R\n"))).toBe(false);
    expect(isScopedRule("docs/a.md", scoped)).toBe(false);
  });

  it("marks the canaries of a rule file that declares paths, when it plants them", () => {
    const fx = materialise("claude-local-shadows-agents");
    mkdirSync(fx.at(".claude/rules"), { recursive: true });
    writeFileSync(fx.at(".claude/rules/api.md"), "---\npaths:\n  - api/**\n---\n# API\n");
    writeFileSync(fx.at(".claude/rules/style.md"), "# Style\n");
    const tokens = counting();
    expect(plantFile(fx.repo, ".claude/rules/api.md", tokens).map((c) => c.scoped)).toEqual([true, true]);
    expect(plantFile(fx.repo, ".claude/rules/style.md", tokens).map((c) => c.scoped)).toEqual([undefined, undefined]);
  });

  it("draws distinct random tokens of the documented form", () => {
    const tokens = new TokenSource();
    const drawn = Array.from({ length: 200 }, () => tokens.next());
    expect(new Set(drawn).size).toBe(200);
    for (const t of drawn) expect(t).toMatch(/^CTXR-[0-9a-f]{8}$/);
    // A repeated draw is skipped rather than reused.
    let calls = 0;
    const stuck = new TokenSource(() => Buffer.from(calls++ < 2 ? [0, 0, 0, 1] : [0, 0, 0, 2]));
    expect([stuck.next(), stuck.next()]).toEqual(["CTXR-00000001", "CTXR-00000002"]);
  });

  it("plants files and a decoy, and refuses to write through a symlink or outside the copy", () => {
    const fx = materialise("claude-local-shadows-agents");
    const tokens = counting();
    const planted = plantFile(fx.repo, "AGENTS.md", tokens);
    expect(planted.map((c) => [c.token, c.position])).toEqual([
      ["CTXR-00000001", "head"],
      ["CTXR-00000002", "tail"],
    ]);
    const bytes = readFileSync(fx.at("AGENTS.md"));
    for (const c of planted) expect(bytes.subarray(c.offset, c.offset + 13).toString()).toBe(c.token);
    const decoy = plantDecoy(fx.repo, ".", tokens);
    expect(decoy.every((c) => c.decoy && c.file === "ctxreach-decoy.md")).toBe(true);
    expect(() => plantDecoy(fx.repo, ".", tokens)).toThrow(); // never overwrites an existing file

    const outside = path.join(tempDir("outside"), "x.md");
    writeFileSync(outside, "x");
    let linked = true;
    try {
      symlinkSync(outside, fx.at("link.md"));
    } catch {
      linked = false; // No symlink permission (Windows without developer mode).
    }
    if (linked) expect(() => plantFile(fx.repo, "link.md", tokens)).toThrow(SafetyError);
    writeFileSync(path.join(fx.base, "beside.md"), "y");
    expect(() => plantFile(fx.repo, "../beside.md", tokens)).toThrow(SafetyError);
    expect(readFileSync(outside, "utf8")).toBe("x");
    expect(readFileSync(path.join(fx.base, "beside.md"), "utf8")).toBe("y");
  });
});
