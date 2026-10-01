/**
 * No file in the repository holds the agents' own prompt text.
 *
 * The oracles see each agent's whole prompt: Codex's developer items in a
 * render, Claude Code's system prompt and context blocks in a capture.
 * That text is not ctxreach's to publish, so a recording keeps only what
 * the scorer reads (test/oracle-render-saved.test.ts,
 * test/oracle-capture-saved.test.ts). This test reads every recording, and
 * every source, test, script and document beside them, for phrases taken
 * from what the agents sent (test/helpers/vendor-text.ts holds them as
 * hashes), so a recording saved whole, or a phrase quoted in a comment,
 * fails here.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  phraseHash,
  stringsOf,
  textsOfFile,
  VENDOR_PHRASES,
  vendorPhrasesIn,
  words,
  type VendorPhrase,
} from "./helpers/vendor-text.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => !SKIP.has(name))
    .sort()
    .flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const FILES = [
  ...["src", "test", "scripts", "docs", "examples"].flatMap((d) => walk(path.join(ROOT, d))),
  ...readdirSync(ROOT)
    .filter((n) => n.endsWith(".md"))
    .map((n) => path.join(ROOT, n)),
].map(rel);
const RECORDINGS = FILES.filter((f) => f.startsWith("test/recorded/"));

function hits(file: string): string[] {
  const content = readFileSync(path.join(ROOT, file), "utf8");
  const found = new Set(textsOfFile(file, content).flatMap((t) => vendorPhrasesIn(t)));
  return [...found].map((p) => `${file}: a phrase of ${p.source}`);
}

describe("the agents' own prompt text is in no file", () => {
  it("reads every recording: the Codex renders, the Claude Code captures and session streams, the manifests", () => {
    expect(RECORDINGS.filter((f) => f.endsWith(".render.json")).length).toBe(51);
    expect(RECORDINGS.filter((f) => f.endsWith(".capture.jsonl")).length).toBe(5);
    expect(RECORDINGS.filter((f) => f.endsWith(".stdout.jsonl")).length).toBeGreaterThanOrEqual(3);
    expect(RECORDINGS.filter((f) => f.endsWith("manifest.json")).length).toBeGreaterThanOrEqual(30);
  });

  it("no recording holds a phrase of Codex's or Claude Code's prompt", () => {
    expect(RECORDINGS.flatMap(hits)).toEqual([]);
  });

  it("no source, test, script or document holds one either", () => {
    const others = FILES.filter((f) => !f.startsWith("test/recorded/"));
    expect(others.length).toBeGreaterThan(50);
    expect(others.flatMap(hits)).toEqual([]);
  });
});

describe("the phrase finder", () => {
  // A phrase of ctxreach's own, written backwards here so that this file does not hold it.
  const own = "kcehc-fles rotceted esarhp hcaerxtc".split("").reverse().join("");
  const probe: VendorPhrase = { source: "a test phrase", first: "ctxreach", words: 5, sha256: phraseHash(own) };

  it("keeps each phrase as a hash of its words, with the first word in the clear", () => {
    expect(VENDOR_PHRASES.length).toBeGreaterThanOrEqual(15);
    for (const p of VENDOR_PHRASES) {
      expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(words(p.first)).toEqual([p.first]);
      expect(p.words).toBeGreaterThanOrEqual(3);
    }
    expect(new Set(VENDOR_PHRASES.map((p) => p.sha256)).size).toBe(VENDOR_PHRASES.length);
    expect(words(own)).toEqual(["ctxreach", "phrase", "detector", "self", "check"]);
  });

  it("finds a phrase whatever its case, punctuation and line breaks, and not when a word differs", () => {
    expect(vendorPhrasesIn(`Before. CTXREACH phrase\n  detector (self-check)! After.`, [probe])).toEqual([probe]);
    expect(vendorPhrasesIn("ctxreach phrase detector self", [probe])).toEqual([]);
    expect(vendorPhrasesIn("ctxreach phrase detectors self check", [probe])).toEqual([]);
  });

  it("finds it inside a JSON string inside a JSON line, as a capture's body holds the request", () => {
    const body = JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: `x\n${own}\ny` }] }] });
    const line = JSON.stringify({ method: "POST", body });
    const texts = textsOfFile("trial-1.capture.jsonl", `${line}\n`);
    expect(texts.flatMap((t) => vendorPhrasesIn(t, [probe]))).toEqual([probe]);
    expect(stringsOf({ a: [{ b: "c" }] })).toEqual(["a", "b", "c"]);
  });

  it("finds it in a source file written inside a string literal with escapes", () => {
    const source = `const text = "<tag>\\n${own.replace(/ /g, "\\n")}\\n";`;
    expect(textsOfFile("x.ts", source).flatMap((t) => vendorPhrasesIn(t, [probe]))).toEqual([probe]);
  });
});
