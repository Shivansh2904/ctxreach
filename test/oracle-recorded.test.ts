import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readVerifyRecording } from "../src/oracle/recording.js";
import type { VerifyResult } from "../src/oracle/score.js";
import { agrees, scoreVerify } from "../src/oracle/verify.js";
import { verifyJson, VerifyJson } from "../src/report/verify.js";

// Real runs of `ctxreach verify` recorded on 2026-09-30 (commands and
// isolation in test/recorded/verify/README.md): Codex 0.159.2's renderer on
// every codex fixture, and Claude Code 2.1.285 captured at the loopback
// endpoint on three claude fixtures. Replaying them needs no agent. Every
// number below is what those runs produced.
const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "recorded", "verify");
const dirs = readdirSync(RECORDED).filter((d) => !d.endsWith(".md") && d !== "codex-pilot");
const replay = (name: string): VerifyResult => scoreVerify(readVerifyRecording(path.join(RECORDED, name)));
const cells = (r: VerifyResult) =>
  r.score.cells.map((c) => `${c.file} ${c.position}: ${c.seen}/${c.usable} ${c.decoy ? "control" : c.verdict}`);

// The planted battery: two renders per launch. The planted pass and the two unplanted runs are checked separately.
const CODEX = dirs.filter(
  (d) => d.startsWith("codex-") && d !== "codex-planted-over-cap-root" && !d.endsWith("-unplanted"),
);
const CLAUDE = dirs.filter((d) => d.startsWith("claude-"));

describe("replaying the recorded Codex renders (0.159.2, Windows, 2026-09-30)", () => {
  it("has one recording per launch of the 14 codex fixtures", () => {
    expect(CODEX).toHaveLength(22);
    expect(CODEX.filter((d) => d.endsWith("-packages-api"))).toHaveLength(8);
  });

  it.each(CODEX)("%s: byte-exact, two identical renders, every cell as map predicted", (name) => {
    const r = replay(name);
    expect(r.manifest).toMatchObject({ agent: "codex", instrument: "render", cliVersion: "0.159.2", trialsPlanned: 2 });
    expect(r.manifest.os.platform).toBe("win32");
    // `-c features.hooks=false` was accepted by 0.159.2 in every launch.
    expect(r.manifest.codex?.hooksFlag).toBe("accepted");
    expect(r.manifest.codex?.overrides).toEqual(["features.hooks=false"]);
    expect(r.manifest.trials.map((t) => t.exitCode)).toEqual([0, 0]);
    expect(
      r.manifest.trials.every((t) => t.warnings.some((w) => w.includes("Refusing to create helper binaries"))),
    ).toBe(true);
    expect(r.score.trials.map((t) => t.status)).toEqual(["usable", "usable"]);
    expect(r.score.instrument).toMatchObject({
      fault: false,
      reasons: [],
      control: { seen: 2, usable: 2 },
      decoy: { seen: 0, usable: 2 },
    });
    expect(r.segments.length).toBeGreaterThan(0);
    expect(r.segments.map((s) => s.verdict)).toEqual(r.segments.map(() => "EXACT"));
    expect(r.whole).toBe(true);
    expect(r.score.agreement.agree).toBe(r.score.agreement.decided);
    expect(agrees(r)).toBe(true);
    VerifyJson.parse(verifyJson(r));
  });

  it("scores the 22 launches as 22 of 22 agreeing", () => {
    const agreeing = CODEX.filter((d) => agrees(replay(d)));
    expect(`${agreeing.length}/${CODEX.length}`).toBe("22/22");
  });

  it("reproduces the pilot's numbers: 32,768 of the 40 KiB root file, 538 of the starved package file, U+FFFD at the cut", () => {
    const over = replay("codex-over-cap-root");
    expect(over.segments.map((s) => [s.file, s.observedBytes, s.bytes])).toEqual([["AGENTS.md", 32768, 41022]]);
    const starved = replay("codex-root-starves-nested-packages-api");
    expect(starved.segments.map((s) => [s.file, s.observedBytes, s.predictedBytes])).toEqual([
      ["AGENTS.md", 32230, 32230],
      ["packages/api/AGENTS.md", 538, 538],
    ]);
    // Planting adds a 31-byte head line, so in the copy the cut at 32768 no longer splits the character the
    // fixture was built to split, and the render ends cleanly at 32,768 bytes. The split-character case
    // (U+FFFD in place of the partial character) is covered by the pilot render, codex-pilot/api.render.json,
    // in test/oracle-codex-render.test.ts.
    const utf8 = replay("codex-utf8-cut-root");
    expect(utf8.segments[0]).toMatchObject({ verdict: "EXACT", predictedBytes: 32768, observedBytes: 32768 });
    const render = readFileSync(path.join(RECORDED, "codex-utf8-cut-root", "trial-1.render.json"), "utf8");
    expect(render).not.toContain("\u{FFFD}");
    const empty = replay("codex-empty-override-packages-api");
    expect(empty.segments.map((s) => [s.file, s.status, s.observedBytes])).toEqual([
      ["AGENTS.md", "loaded", 185],
      // Planted, the whitespace-only override holds two token lines and is no longer empty: both sides read it.
      // The empty-slot trap itself is exercised unplanted (codex-empty-override-packages-api-unplanted, below).
      ["packages/api/AGENTS.override.md", "loaded", 68],
    ]);
  });

  it("the planted-fault pass disagrees: map given 30,000 bytes against Codex's 32,768", () => {
    const r = replay("codex-planted-over-cap-root");
    expect(r.manifest.codex?.mapMaxBytes).toBe(30000);
    expect(r.score.instrument.fault).toBe(false);
    expect(r.segments[0]).toMatchObject({
      verdict: "OFF BY",
      offBy: 2768,
      predictedBytes: 30000,
      observedBytes: 32768,
    });
    expect(agrees(r)).toBe(false);
  });
});

describe("replaying the recorded unplanted Codex renders (bytes only, 0.159.2, 2026-09-30)", () => {
  it("a whitespace-only AGENTS.override.md takes its directory's slot: 0 of 6 bytes, and the AGENTS.md beside it is never read (codex.empty-skip, first live observation on this fixture)", () => {
    const r = replay("codex-empty-override-packages-api-unplanted");
    expect(r.manifest.planted).toBe(false);
    expect(r.manifest.canaries.map((c) => c.decoy)).toEqual([true, true]);
    expect(r.segments.map((s) => [s.file, s.status, s.observedBytes, s.bytes, s.verdict])).toEqual([
      ["AGENTS.md", "loaded", 123, 123, "EXACT"],
      ["packages/api/AGENTS.override.md", "empty", 0, 6, "EXACT"],
    ]);
    expect(r.whole).toBe(true);
    expect(r.score.instrument).toMatchObject({
      fault: false,
      control: { seen: 1, usable: 1 },
      decoy: { seen: 0, usable: 1 },
    });
    expect(r.score.warnings.join("\n")).toContain("No tokens were planted");
    expect(agrees(r)).toBe(true);
  });

  it("a cut inside a three-byte character delivers U+FFFD in its place: 32,770 decoded bytes for 32,768 kept (codex.cut)", () => {
    const r = replay("codex-utf8-cut-root-unplanted");
    expect(r.segments).toEqual([
      { file: "AGENTS.md", status: "cut", bytes: 32954, predictedBytes: 32768, observedBytes: 32770, verdict: "EXACT" },
    ]);
    const render = readFileSync(path.join(RECORDED, "codex-utf8-cut-root-unplanted", "trial-1.render.json"), "utf8");
    expect(render).toContain("\u{FFFD}\\n</INSTRUCTIONS>");
    expect(agrees(r)).toBe(true);
  });
});

describe("replaying the recorded Claude Code captures (2.1.285, Windows, 2026-09-30)", () => {
  it("has the three recordings", () => {
    expect(CLAUDE.sort()).toEqual([
      "claude-local-shadows-agents-root",
      "claude-local-shadows-agents-twin-root",
      "claude-root-shadows-package-packages-api",
    ]);
  });

  it.each(CLAUDE)("%s: the session was isolated, pinned and asserted", (name) => {
    const r = replay(name);
    expect(r.manifest).toMatchObject({
      agent: "claude",
      instrument: "capture",
      cliVersion: "2.1.285",
      claude: { model: "claude-opus-5-5", mode: "claude-md-or-agents-md" },
    });
    expect(r.manifest.claude?.configDir).toMatch(/^C:\\ctxreach-probe\\claude-config$/);
    // Recorded from inside a Claude Code session, whose variables were removed; the list is sorted and has no repeats.
    expect(r.manifest.claude?.removedEnv).toContain("CLAUDECODE");
    expect(r.manifest.claude?.removedEnv).toEqual([...new Set(r.manifest.claude?.removedEnv)].sort());
    expect(r.manifest.args).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5", "--tools", ""]));
    expect(r.score.trials.map((t) => t.status)).toEqual(["usable"]);
    expect(r.score.instrument).toMatchObject({
      fault: false,
      reasons: [],
      control: { seen: 1, usable: 1 },
      decoy: { seen: 0, usable: 1 },
    });
    const capture = readFileSync(path.join(RECORDED, name, "trial-1.capture.jsonl"), "utf8");
    expect(capture).toContain('"x-api-key":"<redacted>"');
    expect(capture).toContain('"user-agent":"claude-cli/2.1.285 (external, sdk-cli)"');
    expect(capture).not.toMatch(/ctxr-dummy|device_id|account_uuid/);
    VerifyJson.parse(verifyJson(r));
  });

  it("CLAUDE.local.md switches AGENTS.md off: the local file was delivered, AGENTS.md was not (4 of 4 cells)", () => {
    const r = replay("claude-local-shadows-agents-root");
    expect(cells(r)).toEqual([
      "AGENTS.md head: 0/1 confirmed",
      "AGENTS.md tail: 0/1 confirmed",
      "CLAUDE.local.md head: 1/1 confirmed",
      "CLAUDE.local.md tail: 1/1 confirmed",
      "ctxreach-decoy.md head: 0/1 control",
      "ctxreach-decoy.md tail: 0/1 control",
    ]);
    expect(r.delivered.map((d) => [path.basename(d.path), d.label])).toEqual([
      ["CLAUDE.local.md", "user's private project instructions, not checked in"],
    ]);
    expect(r.score.agreement).toMatchObject({ agree: 4, decided: 4, cells: 4 });
  });

  it("its twin: with no CLAUDE.md-family file, AGENTS.md was delivered whole (2 of 2 cells)", () => {
    const r = replay("claude-local-shadows-agents-twin-root");
    expect(cells(r)).toEqual([
      "AGENTS.md head: 1/1 confirmed",
      "AGENTS.md tail: 1/1 confirmed",
      "ctxreach-decoy.md head: 0/1 control",
      "ctxreach-decoy.md tail: 0/1 control",
    ]);
    expect(r.delivered.map((d) => [path.basename(d.path), d.label])).toEqual([
      ["AGENTS.md", "project instructions, checked into the codebase"],
    ]);
  });

  it("a root CLAUDE.md, launched in packages/api, was delivered and switched the package's AGENTS.md off (4 of 4 cells)", () => {
    const r = replay("claude-root-shadows-package-packages-api");
    expect(cells(r)).toEqual([
      "CLAUDE.md head: 1/1 confirmed",
      "CLAUDE.md tail: 1/1 confirmed",
      "packages/api/AGENTS.md head: 0/1 confirmed",
      "packages/api/AGENTS.md tail: 0/1 confirmed",
      "packages/api/ctxreach-decoy.md head: 0/1 control",
      "packages/api/ctxreach-decoy.md tail: 0/1 control",
    ]);
    expect(r.delivered.map((d) => path.basename(d.path))).toEqual(["CLAUDE.md"]);
  });
});
