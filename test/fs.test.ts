import path from "node:path";
import { describe, expect, it } from "vitest";
import { displayPath, isInside } from "../src/util/fs.js";

const root = path.resolve("/tmp/demo");

describe("isInside", () => {
  it("counts the directory itself and its children as inside", () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(path.join(root, "packages", "api"), root)).toBe(true);
  });

  it("counts a child whose name starts with two dots as inside", () => {
    expect(isInside(path.join(root, "..cache"), root)).toBe(true);
  });

  it("counts the parent and siblings as outside", () => {
    expect(isInside(path.dirname(root), root)).toBe(false);
    expect(isInside(path.join(path.dirname(root), "other"), root)).toBe(false);
  });
});

describe("displayPath", () => {
  it("shows a child whose name starts with two dots relative to the base", () => {
    expect(displayPath(path.join(root, "..cache", "AGENTS.md"), root)).toBe("..cache/AGENTS.md");
  });
});
