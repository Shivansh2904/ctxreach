// Tests for the upstream drafts (study/upstream-drafts): each is listed, marked
// a draft that Shiv decides whether to post, and states its preconditions.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("upstream drafts", () => {
  it("lists every draft, and each is marked a draft with its preconditions", () => {
    const dir = path.join(ROOT, "study", "upstream-drafts");
    const readme = readFileSync(path.join(dir, "README.md"), "utf8");
    const drafts = readdirSync(dir).filter((f) => f !== "README.md");
    expect(drafts.sort()).toEqual([
      "codex-34193.md",
      "codex-41499.md",
      "gemini-order-inversion.md",
      "opencode-stacking.md",
    ]);
    for (const f of drafts) {
      const text = readFileSync(path.join(dir, f), "utf8");
      expect(readme, f).toContain(`(${f})`);
      expect(text, f).toMatch(/\(not posted\)/);
      expect(text, f).toMatch(/\*\*Status:\*\* draft\. Shiv decides/);
      expect(text, f).toMatch(/\*\*Before (posting|filing):\*\*/);
    }
    // The wording rule for #41499.
    expect(readFileSync(path.join(dir, "codex-41499.md"), "utf8")).toContain(
      "Not reproduced on Windows with Codex 0.159.2, with a key form shown to\napply.",
    );
  });
});
