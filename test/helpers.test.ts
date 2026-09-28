import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { materialise, removeMaterialised } from "./helpers/fixture.js";

describe("materialise", () => {
  it("copies a fixture into a temporary repository that removeMaterialised deletes again", () => {
    const fx = materialise("codex-over-cap-twin");
    expect(existsSync(path.join(fx.repo, ".git"))).toBe(true);
    expect(existsSync(fx.at("AGENTS.md"))).toBe(true);
    removeMaterialised();
    expect(existsSync(fx.base)).toBe(false);
  });
});
