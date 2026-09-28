import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JavaScript script without type declarations
import { fixtureFiles } from "../scripts/gen-fixtures.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("generated files", () => {
  const files = Object.entries(fixtureFiles() as Record<string, string>);
  it.each(files)("%s matches scripts/gen-fixtures.mjs byte for byte", (rel, content) => {
    const onDisk = readFileSync(path.join(ROOT, rel));
    expect(onDisk.equals(Buffer.from(content, "utf8"))).toBe(true);
  });
});
