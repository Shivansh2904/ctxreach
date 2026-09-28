import { describe, expect, it } from "vitest";
import { decodeLossy, headings, isBlankRust, lineAndColumn, splitsCodepoint } from "../src/util/text.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("isBlankRust", () => {
  it("matches Rust's trim: whitespace is blank, a byte-order mark is not", () => {
    expect(isBlankRust("")).toBe(true);
    expect(isBlankRust(" \t\r\n 　")).toBe(true);
    expect(isBlankRust("﻿")).toBe(false);
    expect(isBlankRust(" x ")).toBe(false);
  });
});

describe("decodeLossy", () => {
  it("keeps a leading byte-order mark and replaces a split character", () => {
    expect(decodeLossy(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe("﻿a");
    expect(decodeLossy(bytes("a€").subarray(0, 2))).toBe("a�");
  });
});

describe("splitsCodepoint", () => {
  it("is true only inside a multi-byte character", () => {
    const b = bytes("a€b"); // 61 e2 82 ac 62
    expect([0, 1, 2, 3, 4, 5].map((i) => splitsCodepoint(b, i))).toEqual([false, false, true, true, false, false]);
  });
});

describe("lineAndColumn", () => {
  it("counts lines and byte columns from 1", () => {
    const b = bytes("ab\ncd\n");
    expect(lineAndColumn(b, 0)).toEqual({ line: 1, column: 1 });
    expect(lineAndColumn(b, 4)).toEqual({ line: 2, column: 2 });
  });
});

describe("headings", () => {
  it("finds ATX headings with byte offsets and skips fenced code", () => {
    const text = "# Title\n\n```md\n# not a heading\n```\n\n## Money €\n~~~\n## also not\n~~~\n### Last ###\n";
    const found = headings(bytes(text));
    expect(found.map((h) => [h.level, h.text])).toEqual([
      [1, "Title"],
      [2, "Money €"],
      [3, "Last"],
    ]);
    expect(found[1]?.offset).toBe(text.indexOf("## Money"));
    // Offsets after a multi-byte character are byte offsets, not string indexes.
    expect(found[2]?.offset).toBe(bytes(text.slice(0, text.indexOf("### Last"))).length);
  });
});
