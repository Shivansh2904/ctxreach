// The registry block of study/PREREG.md (section 12): the pre-registered
// frame queries, sample sizes, thresholds, hypotheses and cells, as JSON in
// a fenced block whose info string is `json prereg-registry`; and the values
// filled at tag time, as JSON in a block whose info string is
// `json prereg-stamps`. Study runs read both from the tagged copy, and refuse
// while the working copy differs from it above the Deviations heading.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PREREG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "PREREG.md");

function block(text, info) {
  const m = new RegExp("```json " + info + "\\r?\\n([\\s\\S]*?)\\r?\\n```").exec(text);
  if (!m) throw new Error(`PREREG.md has no \`\`\`json ${info} block`);
  return JSON.parse(m[1]);
}

/** The registry block of a PREREG.md text, parsed. Throws when there is none. */
export function readRegistry(text) {
  return block(text, "prereg-registry");
}

/** The registry of the PREREG.md in this checkout. */
export function loadRegistry(file = PREREG_FILE) {
  return readRegistry(readFileSync(file, "utf8"));
}

/** The stamps block as written: every key, its value or its `{{stamp:<key>}}` placeholder. */
export function readStampsBlock(text) {
  return block(text, "prereg-stamps");
}

/** The values stamped at tag time, by key; a key still holding its placeholder is left out. */
export function readStamps(text) {
  return Object.fromEntries(
    Object.entries(readStampsBlock(text)).filter(
      ([, v]) => typeof v === "string" && v !== "" && !v.includes("{{stamp:"),
    ),
  );
}

/** The heading below which deviations are appended. */
export const DEVIATIONS_HEADING = "## Deviations";

/**
 * Why the working PREREG.md is not the tagged one with deviations appended:
 * nothing above the Deviations heading may change after the tag, and what
 * the tagged file holds below it is never edited in place. Line endings are
 * compared as LF. Returns a list of problems (empty when fine).
 */
export function appendOnlyProblems(tagged, working, tag = "prereg-v1") {
  const lf = (t) => t.replace(/\r\n/g, "\n");
  const a = lf(tagged);
  const b = lf(working);
  const al = a.split("\n");
  const heading = al.indexOf(DEVIATIONS_HEADING);
  if (heading < 0) return [`${tag}: study/PREREG.md has no "${DEVIATIONS_HEADING}" heading`];
  if (b.startsWith(a)) return [];
  const bl = b.split("\n");
  let i = 0;
  while (i < al.length && al[i] === bl[i]) i++;
  // The tagged text's last line can be a prefix of the working one's (text appended to it); that is an edit too.
  return [
    i <= heading
      ? `line ${i + 1} differs from ${tag}: nothing above the Deviations heading changes after the tag`
      : `line ${i + 1}, in the Deviations section as ${tag} holds it, differs: deviations are appended, never edited in place`,
  ];
}
