// Writes the large instruction files used by the fixture repositories.
//
// The byte-budget traps need files of exact sizes (for example a cut that
// lands inside a multi-byte character), which is easier to get right with a
// script than by hand. The output is committed; test/fixtures.test.ts runs
// this generator in memory and checks the committed files still match it.
//
// Usage: node scripts/gen-fixtures.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SENTENCES = [
  "Keep changes small and focused on one concern.",
  "Run the unit tests for the package you touched before you push.",
  "Prefer named exports; default exports make renames harder to follow.",
  "Log with the shared logger, never with console.log in library code.",
  "Validate every external input at the boundary and reject unknown fields.",
  "Write the migration and its rollback in the same change.",
  "Keep public function signatures stable; add an option instead of a new positional argument.",
  "Document any new environment variable in docs/configuration.md.",
];

/** Markdown of exactly `size` bytes: a title, numbered sections, and bullet rules. */
export function filler(size, title, topic) {
  // Each line is followed by "\n", so the file size is the sum of (line + 1).
  const lines = [`# ${title}`];
  let total = Buffer.byteLength(lines[0]) + 1;
  let section = 0;
  let rule = 0;
  const push = (line) => {
    lines.push(line);
    total += Buffer.byteLength(line) + 1;
  };
  for (;;) {
    const next = rule % 6 === 0 ? [``, `## ${topic} ${++section}`, ``] : [];
    const bullet = `- ${topic} rule ${section}.${(rule % 6) + 1}: ${SENTENCES[rule % SENTENCES.length]}`;
    const need = [...next, bullet].reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
    if (total + need > size - 40) break;
    for (const l of next) push(l);
    push(bullet);
    rule++;
  }
  // Pad the last line so the file is exactly `size` bytes.
  const pad = size - total - 1;
  const padLine = ("- Notes: " + "see the section above. ".repeat(10)).slice(0, pad);
  if (Buffer.byteLength(padLine) !== pad) throw new Error("pad is not ASCII");
  push(padLine);
  const text = lines.join("\n") + "\n";
  if (Buffer.byteLength(text) !== size) throw new Error(`filler: wanted ${size}, got ${Buffer.byteLength(text)}`);
  return text;
}

const KIB = 1024;

/** Every generated file, keyed by its path from the repository root. */
export function fixtureFiles() {
  const euroLine = "€ amounts are stored as integer cents; never use floats for money.\n";
  const tail = "\n## Money\n\n" + euroLine + "- Round only when displaying a value.\n";
  return {
    // A root file over the default 32 KiB budget.
    "test/fixtures/codex-over-cap/repo/AGENTS.md": filler(40 * KIB, "Repository guidelines", "General"),
    "test/fixtures/codex-over-cap-twin/repo/AGENTS.md": filler(30 * KIB, "Repository guidelines", "General"),

    // A root file that leaves only 600 bytes of the shared budget for the package file.
    "test/fixtures/codex-root-starves-nested/repo/AGENTS.md": filler(
      32 * KIB - 600,
      "Repository guidelines",
      "General",
    ),
    "test/fixtures/codex-root-starves-nested-twin/repo/AGENTS.md": filler(20 * KIB, "Repository guidelines", "General"),

    // Byte 32767 is the first byte of a three-byte character, so a cut at
    // 32768 splits it. The twin moves the character two bytes earlier so the
    // cut lands on a character boundary.
    "test/fixtures/codex-utf8-cut/repo/AGENTS.md":
      filler(32 * KIB - 1, "Repository guidelines", "General") + euroLine + tail,
    "test/fixtures/codex-utf8-cut-twin/repo/AGENTS.md":
      filler(32 * KIB - 3, "Repository guidelines", "General") + euroLine + tail,

    // Over the default budget, under the 64 KiB the project config asks for.
    "test/fixtures/codex-project-config/repo/AGENTS.md": filler(40 * KIB, "Repository guidelines", "General"),
    "test/fixtures/codex-project-config-twin/repo/AGENTS.md": filler(40 * KIB, "Repository guidelines", "General"),

    // The example monorepo in the README: a root file over the default budget.
    "examples/demo-monorepo/AGENTS.md": filler(40 * KIB, "Repository guidelines", "General"),
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = path.join(here, "..");
  for (const [rel, content] of Object.entries(fixtureFiles())) {
    const file = path.join(base, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
    console.log(`${rel} (${Buffer.byteLength(content)} bytes)`);
  }
}
