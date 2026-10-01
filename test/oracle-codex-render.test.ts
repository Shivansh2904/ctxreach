import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  blockSegments,
  CHAIN_JOIN,
  expectedBody,
  HELPER_BINARIES_WARNING,
  parseRender,
  PROJECT_DOC_SEPARATOR,
  renderCodex,
  renderEnv,
  resolveCodexBin,
  type Renderer,
  type RenderRequest,
} from "../src/oracle/codex-render.js";
import { RenderShapeError, type ChainPiece } from "../src/oracle/types.js";
import { decodeLossy } from "../src/util/text.js";
import { tempDir } from "./helpers/fixture.js";

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "recorded", "verify", "codex-pilot");
const render = (name: string) => readFileSync(path.join(RECORDED, `${name}.render.json`), "utf8");

/**
 * The pilot's fixture (tools-scratch/cx/gen.mjs, 2026-09-30), rebuilt here
 * byte for byte: a 30,000-byte root AGENTS.md and a 4,019-byte
 * packages/api/AGENTS.md with a three-byte character straddling byte 2,768.
 * The recorded renders were made from these exact files, so the predicted
 * pieces below can be checked against real Codex 0.159.2 output.
 */
function pilotFiles(): { root: Buffer; api: Buffer } {
  const head = "# Root\nCTXR-c0000001\n";
  const tail = "\nCTXR-c0000002\n";
  let filler = "";
  let i = 0;
  while (Buffer.byteLength(head + filler + tail) < 30000) filler += `line ${i++} filler text for the budget test.\n`;
  let root = head + filler;
  root = root.slice(0, 30000 - Buffer.byteLength(tail)) + tail;
  const ah = "# API\nCTXR-c0000003\n";
  let api = ah;
  while (Buffer.byteLength(api) < 1500) api += "api rule text. ";
  api += "\nCTXR-c0000004\n";
  while (Buffer.byteLength(api) < 2767) api += "x";
  api = Buffer.from(api).subarray(0, 2767).toString("utf8") + "日本\n";
  while (Buffer.byteLength(api) < 4000) api += "more api text. ";
  api += "\nCTXR-c0000009\n";
  return { root: Buffer.from(root), api: Buffer.from(api) };
}

function piece(file: string, buf: Buffer, keptBytes: number, status: ChainPiece["status"] = "loaded"): ChainPiece {
  return {
    file,
    bytes: buf.length,
    keptBytes,
    status,
    text: keptBytes > 0 ? decodeLossy(buf.subarray(0, keptBytes)) : "",
    head: decodeLossy(buf.subarray(0, 64)),
  };
}

describe("parsing codex debug prompt-input renders (Codex 0.159.2, recorded 2026-09-30)", () => {
  it("finds the AGENTS block by its content_item_kinds tag, its header cwd and the session cwd", () => {
    const p = parseRender(render("api"));
    expect(p.items).toBe(5);
    expect(p.kinds[3]).toEqual(["agents_md.instructions", "environments.environment_context"]);
    expect(p.headerCwd).toBe("C:\\ctxreach-probe\\repo\\packages\\api");
    expect(p.environmentCwd).toBe(p.headerCwd);
    expect(p.lastUserText).toBe("x");
    expect(p.body?.startsWith("# Root\nCTXR-c0000001\n")).toBe(true);
    expect(p.body?.endsWith("�")).toBe(true);
  });

  it("gives no body when Codex rendered no AGENTS block (an untrusted project), and still the session cwd", () => {
    const p = parseRender(render("untrusted-toml"));
    expect(p.body).toBeUndefined();
    expect(p.headerCwd).toBeUndefined();
    expect(p.kinds.some((k) => k.includes("agents_md.instructions"))).toBe(false);
    expect(p.environmentCwd).toBe("C:\\ctxreach-probe\\repo\\packages\\api");
  });

  it("fails with the JSON path when the shape is not the known one", () => {
    expect(() => parseRender("not json")).toThrow(RenderShapeError);
    expect(() => parseRender("[]")).toThrow(/^\$: /);
    const noKinds = JSON.stringify([{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }]);
    expect(() => parseRender(noKinds)).toThrow(/content_item_kinds: no item carries environments\.environment_context/);
    const items = JSON.parse(render("api")) as { content: { text: string }[] }[];
    (items[3] as { content: { text: string }[] }).content[0]!.text = "not the header";
    expect(() => parseRender(JSON.stringify(items))).toThrow(
      /^\$\[3\]\.content: the item tagged agents_md\.instructions/,
    );
    const bad = JSON.parse(render("api")) as { content: { text: string }[] }[];
    (bad[3] as { content: { text: string }[] }).content[0]!.text =
      "# AGENTS.md instructions for x\n\n<INSTRUCTIONS>\nno closing tag";
    expect(() => parseRender(JSON.stringify(bad))).toThrow(/^\$\[3\]\.content\[\*\]\.text: the AGENTS block/);
  });
});

describe("the block, split into map's chain files", () => {
  const { root, api } = pilotFiles();

  it("rebuilds the pilot fixture exactly (a control for the tests below)", () => {
    expect(root.length).toBe(30000);
    expect(api.length).toBe(4019);
    expect(api.indexOf("CTXR-c0000004")).toBeGreaterThan(0);
    // Byte 2,768 is the first byte of a three-byte character.
    expect(api[2767]).toBe(0xe6);
  });

  it("is EXACT for every file of a real render: a 30,000-byte root, a blank-line join, and a cut inside a character", () => {
    const p = parseRender(render("api"));
    const pieces = [piece("AGENTS.md", root, 30000), piece("packages/api/AGENTS.md", api, 2768, "cut")];
    const { segments, whole } = blockSegments(p.body, pieces);
    expect(whole).toBe(true);
    expect(segments.map((s) => [s.file, s.verdict, s.observedBytes, s.predictedBytes])).toEqual([
      ["AGENTS.md", "EXACT", 30000, 30000],
      // Decoded bytes: the split character became U+FFFD (3 bytes) in place of 1 byte.
      ["packages/api/AGENTS.md", "EXACT", 2770, 2768],
    ]);
    expect(expectedBody(pieces)).toBe(p.body);
    expect(p.body?.slice(30000, 30002)).toBe(CHAIN_JOIN);
  });

  it("joins the global file to the chain with the project-doc separator (CODEX_HOME = the project root, #34193)", () => {
    const p = parseRender(render("home-is-root"));
    const pieces = [
      piece("$CODEX_HOME/AGENTS.md", root, 30000, "global"),
      piece("AGENTS.md", root, 30000),
      piece("packages/api/AGENTS.md", api, 2768, "cut"),
    ];
    const { segments, whole } = blockSegments(p.body, pieces);
    expect(whole).toBe(true);
    expect(segments.map((s) => s.verdict)).toEqual(["EXACT", "EXACT", "EXACT"]);
    expect(p.body?.slice(30000, 30000 + PROJECT_DOC_SEPARATOR.length)).toBe(PROJECT_DOC_SEPARATOR);
  });

  it("reports OFF BY +n when the render holds more of a file than map predicted (the planted-fault pass)", () => {
    const p = parseRender(render("api"));
    const { segments, whole } = blockSegments(p.body, [
      piece("AGENTS.md", root, 29000, "cut"),
      piece("packages/api/AGENTS.md", api, 2768, "cut"),
    ]);
    expect(whole).toBe(false);
    expect(segments[0]).toMatchObject({
      file: "AGENTS.md",
      verdict: "OFF BY",
      offBy: 1000,
      observedBytes: 30000,
      predictedBytes: 29000,
    });
    expect(segments[1]).toMatchObject({ file: "packages/api/AGENTS.md", verdict: "EXACT" });
  });

  it("reports MISSING for a predicted file the render does not hold, and EXTRA for one predicted absent that it does", () => {
    const p = parseRender(render("api"));
    const tools = Buffer.from("# Tools\nCTXR-c0000006\nkeep the tools tidy\n");
    const missing = blockSegments(p.body, [
      piece("AGENTS.md", root, 30000),
      piece("packages/api/AGENTS.md", api, 2768, "cut"),
      piece("tools/AGENTS.md", tools, tools.length),
    ]);
    expect(missing.segments.map((s) => s.verdict)).toEqual(["EXACT", "EXACT", "MISSING"]);
    const extra = blockSegments(p.body, [
      piece("AGENTS.md", root, 30000),
      piece("packages/api/AGENTS.md", api, 0, "no-budget"),
    ]);
    expect(extra.segments.map((s) => [s.verdict, s.observedBytes])).toEqual([
      ["EXACT", 30000],
      ["EXTRA", 2770],
    ]);
    // An untrusted render holds nothing: every predicted file is MISSING, and a chain predicted empty is EXACT.
    const none = parseRender(render("untrusted-toml"));
    expect(blockSegments(none.body, [piece("AGENTS.md", root, 30000)]).segments[0]?.verdict).toBe("MISSING");
    expect(blockSegments(none.body, [piece("AGENTS.md", root, 0, "no-budget")]).segments[0]?.verdict).toBe("EXACT");
    expect(blockSegments(none.body, [])).toEqual({ segments: [], whole: true });
  });

  it("flags text that map predicted for no file", () => {
    const p = parseRender(render("api"));
    const { segments } = blockSegments(p.body, [piece("AGENTS.md", root, 30000)]);
    expect(segments.map((s) => s.verdict)).toEqual(["EXACT", "EXTRA"]);
    expect(segments[1]?.file).toBe("(text map predicted for no file)");
  });

  it("notes where a file of the right length differs (a token replaced)", () => {
    const p = parseRender(render("api"));
    const changed = Buffer.from(root.toString("utf8").replace("CTXR-c0000002", "CTXR-deadbeef"));
    const { segments } = blockSegments(p.body, [
      piece("AGENTS.md", changed, 30000),
      piece("packages/api/AGENTS.md", api, 2768, "cut"),
    ]);
    expect(segments[0]).toMatchObject({ verdict: "OFF BY", offBy: 0 });
    expect(segments[0]?.note).toMatch(/^differs after 299\d\d bytes$/);
  });
});

describe("finding and running codex", () => {
  it("runs a JavaScript launcher with the current node, and takes CTXREACH_CODEX_BIN", () => {
    const js = path.join(tempDir("codex-bin"), "codex.js");
    expect(resolveCodexBin(js, {})).toEqual({ command: process.execPath, args: [js], shown: js });
    expect(resolveCodexBin(undefined, { CTXREACH_CODEX_BIN: js, PATH: "" })?.args).toEqual([js]);
    expect(resolveCodexBin(undefined, { PATH: tempDir("empty-bin") })).toBeUndefined();
    const exe = path.join(tempDir("codex-exe"), "codex-cli");
    expect(resolveCodexBin(exe, {})).toEqual({ command: exe, args: [], shown: exe });
  });

  it("gives a render an environment with no API key and every proxy pointed at a closed port", () => {
    const env = renderEnv(
      {
        PATH: "/bin",
        OPENAI_API_KEY: "sk-live",
        CODEX_API_KEY: "x",
        HTTPS_PROXY: "http://corp",
        CODEX_HOME: "/home/u/.codex",
      },
      "/tmp/box/codex-home",
    );
    expect(env).toEqual({
      PATH: "/bin",
      CODEX_HOME: "/tmp/box/codex-home",
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: "",
    });
  });

  it("passes -c features.hooks=false, and drops it when Codex rejects the override", () => {
    const calls: RenderRequest[] = [];
    const rejecting: Renderer = (request) => {
      calls.push(request);
      const rejected = request.overrides.includes("features.hooks=false");
      return {
        stdout: rejected ? "" : "[]",
        stderr: rejected ? "error: unknown feature `hooks`\n" : `${HELPER_BINARIES_WARNING} under temporary dir\n`,
        exitCode: rejected ? 1 : 0,
        durationMs: 1,
      };
    };
    const bin = { command: "codex", args: [], shown: "codex" };
    const out = renderCodex({ bin, cwd: ".", env: {}, prompt: "p", timeoutMs: 1000 }, rejecting);
    expect(calls.map((c) => c.overrides)).toEqual([["features.hooks=false"], []]);
    expect(out.hooksFlag).toBe("rejected");
    expect(out.overrides).toEqual([]);
    expect(out.warnings).toEqual([`${HELPER_BINARIES_WARNING} under temporary dir`]);
    expect(calls.every((c) => c.prompt === "p")).toBe(true);

    const accepting: Renderer = () => ({ stdout: "[]", stderr: "", exitCode: 0, durationMs: 1 });
    expect(renderCodex({ bin, cwd: ".", env: {}, prompt: "p", timeoutMs: 1000 }, accepting)).toMatchObject({
      hooksFlag: "accepted",
      overrides: ["features.hooks=false"],
    });
  });
});
