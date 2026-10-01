// The registry block of study/PREREG.md (section 12): the pre-registered
// frame queries, sample sizes, thresholds, hypotheses and cells, as JSON in
// a fenced block whose info string is `json prereg-registry`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREREG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "PREREG.md");

/** The registry block of a PREREG.md text, parsed. Throws when there is none. */
export function readRegistry(text) {
  const m = /```json prereg-registry\r?\n([\s\S]*?)\r?\n```/.exec(text);
  if (!m) throw new Error("PREREG.md has no ```json prereg-registry block");
  return JSON.parse(m[1]);
}

/** The registry of the PREREG.md in this checkout. */
export function loadRegistry(file = PREREG_FILE) {
  return readRegistry(readFileSync(file, "utf8"));
}
