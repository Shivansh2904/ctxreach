// Breaks the results site, the write-up and the launch material one way at a
// time, and checks that test/site.test.ts notices each break.
//
// Each plant gets its own copy of the files the site tests read (site/,
// test/site-sample/, talk/, workshop/, the demo cast, the site scripts and
// examples/demo-monorepo) in a new temporary folder, changes one thing in the
// copy, and runs test/site.test.ts with CTXR_SITE_ROOT pointing at it. Nothing
// in the repository is changed. A plant counts as caught when the run fails
// AND the test named for it is among the failures (a failure elsewhere would
// mean the plant broke something else, which proves nothing about the check).
//
// The instrument checks itself first: the unplanted copy must pass every
// test, and each plant's edit must change the copy (a plant whose search text
// is missing is reported as broken, not as caught). On a full run it also
// requires every test the baseline passes to be the named target of at least
// one plant, or to be listed in UNPLANTED with the reason no plant can reach
// it: a check nothing here has ever broken counts against the run.
//
// The sample-drift plant needs the study's code (study/census/analyze.mjs);
// it runs when this repository has it, or with --study <dir holding study/>.
//
// Usage: node scripts/plant-site-faults.mjs [--study <dir>] [plant ...]
// Exit status: 0 when every plant is caught (and, on a full run, every test
// has a plant), 1 when a plant is not caught or a test has none, 2 when the
// instrument fails (the baseline does not pass, or a plant cannot be applied).

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), "..");
const COPY = [
  "site",
  "test/site-sample",
  "talk",
  "workshop",
  "docs/demo.cast",
  "docs/demo.cast.json",
  "scripts/writeup.mjs",
  "scripts/site-data.mjs",
  "scripts/make-cast.mjs",
  "examples/demo-monorepo",
];

/** Replace `from` with `to` in a copied file; throws when `from` is not there, so a stale plant cannot pass as caught. */
function edit(root, rel, from, to) {
  const file = path.join(root, ...rel.split("/"));
  const text = readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`plant cannot apply: ${rel} has no ${JSON.stringify(from.slice(0, 60))}`);
  writeFileSync(
    file,
    text.replace(from, () => to),
  );
}

/**
 * Tests no plant here can reach, and why. Every other test in
 * test/site.test.ts must be the named target of at least one plant, or the
 * run fails: a check nothing has ever broken is a check nobody has seen fail.
 */
export const UNPLANTED = {
  "would notice a typed number, a wrong value and a wrong field":
    "it checks the checker: it plants its own faults into the page it renders, so a fault in the page cannot reach it",
};

const INDEX = "site/index.html";

export const PLANTS = [
  {
    id: "shell-typed-number",
    expect: /has no number typed into it/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        "<h1>Same repo, different instructions</h1>",
        "<h1>Same repo, different instructions, in 1,100 repositories</h1>",
      ),
  },
  {
    id: "css-generated-number",
    expect: /has no number typed into it/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        "      .lede .n {\n",
        '      .lede::after {\n        content: " (n = 1,100 repositories)";\n      }\n      .lede .n {\n',
      ),
  },
  {
    id: "css-prints-an-attribute",
    expect: /prints every number from a data field/,
    // colspan is never shown, until the CSS prints it.
    apply: (r) =>
      edit(
        r,
        INDEX,
        "      tr.group th {\n",
        '      tr.group th::after {\n        content: " of " attr(colspan);\n      }\n      tr.group th {\n',
      ),
  },
  {
    id: "core-typed-number",
    expect: /prints every number from a data field/,
    apply: (r) =>
      edit(r, INDEX, '<h2 id="checks-h">Instrument checks</h2>', '<h2 id="checks-h">The 10 instrument checks</h2>'),
  },
  {
    id: "method-typed-number",
    expect: /prints every number from a data field/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        "<li><strong>An echo proves delivery, not compliance.</strong> A token",
        "<li><strong>An echo proves delivery, not compliance.</strong> In 50 billed runs, a token",
      ),
  },
  {
    id: "empty-page-typed-number",
    expect: /shows no number, no banner, and says the study has not run/,
    apply: (r) => edit(r, INDEX, 'c.t("j/m")', 'c.t("12/40")'),
  },
  {
    id: "formatter-drift",
    expect: /prints every number from a data field/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        'const pct = (x) => (x * 100).toFixed(1) + "%";',
        'const pct = (x) => (x * 100).toFixed(2) + "%";',
      ),
  },
  {
    id: "headline-wrong-variant",
    expect: /fills the registered headline/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        'const o1 = outcomeIndex(c.files, "S-main", "O1-content", "raw");',
        'const o1 = outcomeIndex(c.files, "S-main", "O1-content", "dedup");',
      ),
  },
  {
    id: "headline-keeps-claim",
    expect: /fills the registered headline/,
    apply: (r) => edit(r, INDEX, 'if (verdict === undefined || verdict === "confirmed")', "if (true)"),
  },
  {
    id: "banner-dropped",
    expect: /says the data is a sample/,
    apply: (r) => edit(r, INDEX, "            banner(c, state),\n", '            "",\n'),
  },
  {
    id: "banner-ignores-dry-run",
    expect: /says the data is a sample/,
    apply: (r) => edit(r, INDEX, "if (cells.dryRun !== false) {", 'if (cells.dryRun === "never") {'),
  },
  {
    id: "banner-ignores-sample-conformance",
    expect: /says the data is a sample/,
    apply: (r) => edit(r, INDEX, "/sample|fake/i.test(String(rec.version", "/fake/i.test(String(rec.version"),
  },
  {
    id: "offsite-image",
    expect: /asks no other site for anything as it loads/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        '<h2 id="credits-h">Credits</h2><ul class="prose">\' +',
        '<h2 id="credits-h">Credits</h2><img alt="" src="https://example.com/p.gif"><ul class="prose">\' +',
      ),
  },
  {
    id: "credit-wrong-initial",
    expect: /links only to sources checked by hand/,
    apply: (r) => edit(r, INDEX, "T. Gloaguen and colleagues", "L. Gloaguen and colleagues"),
  },
  {
    id: "unchecked-link",
    expect: /links only to sources checked by hand/,
    apply: (r) =>
      edit(
        r,
        "workshop/handout.md",
        "## Block six",
        "Further reading: https://example.com/agents-guide\n\n## Block six",
      ),
  },
  {
    id: "repository-named",
    expect: /names no repository/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        '" (listed in results.json, no repository named here)</span>"',
        '" " + k4.mismatches.map((m) => esc(m.repo)).join(", ") + "</span>"',
      ),
  },
  {
    id: "checks-after-results",
    expect: /puts the instrument checks before/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        "            sectionChecks(c),\n            sectionMatrix(c),\n            sectionCensus(c),\n",
        "            sectionMatrix(c),\n            sectionCensus(c),\n            sectionChecks(c),\n",
      ),
  },
  {
    id: "anchor-dropped",
    expect: /unique permalink anchor/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        '(h.primary ? " (primary)" : "") +\n                      anchor(id) +',
        '(h.primary ? " (primary)" : "") +',
      ),
  },
  {
    id: "table-unwrapped",
    expect: /own horizontal scroller/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        'const wrapTable = (inner) => \'<div class="table-wrap"><table>\' + inner + "</table></div>";',
        'const wrapTable = (inner) => "<table>" + inner + "</table>";',
      ),
  },
  {
    id: "phone-min-width-dropped",
    expect: /fits a phone/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        "      section > *,\n      article > *,\n      details > * {\n        min-width: 0;\n      }\n",
        "",
      ),
  },
  {
    id: "external-font",
    expect: /loads nothing from another site/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        "    <style>",
        '    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" />\n    <style>',
      ),
  },
  {
    id: "writeup-typed-number",
    expect: /writeup\.template\.md: types no number/,
    apply: (r) =>
      edit(r, "site/writeup.template.md", "## Limits\n", "## Limits\n\nIn 3 of 4 trial runs it arrived anyway.\n"),
  },
  {
    id: "writeup-too-long",
    expect: /under a thousand words/,
    apply: (r) => edit(r, "site/writeup.template.md", "## Limits\n", `## Limits\n\n${"padding ".repeat(400)}\n`),
  },
  {
    id: "writeup-html-typed-number",
    expect: /published forms carry the same numbers/,
    apply: (r) => edit(r, "scripts/writeup.mjs", "${mdToHtml(md)}", "${mdToHtml(md)}<p>Run 3 times.</p>"),
  },
  {
    id: "writeup-html-title-number",
    expect: /published forms carry the same numbers/,
    apply: (r) =>
      edit(r, "scripts/writeup.mjs", "<title>${esc(title)}</title>", "<title>${esc(title)} (2 of 3)</title>"),
  },
  {
    id: "unknown-slot-blank",
    expect: /an unknown slot is an error, not a blank/,
    apply: (r) =>
      edit(
        r,
        INDEX,
        'if (!(name in s)) throw new Error("unknown template slot {{" + name + "}}");',
        'if (!(name in s)) return "";',
      ),
  },
  {
    id: "readme-typed-number",
    expect: /readme-first-screen\.md: types no number/,
    apply: (r) => edit(r, "site/readme-first-screen.md", "## Status\n", "## Status\n\nChecked against 3 agents.\n"),
  },
  {
    id: "slides-typed-result",
    expect: /talk\/slides\.md: types no number/,
    apply: (r) => edit(r, "talk/slides.md", "## The headline\n", "## The headline\n\nAbout 23.0% of repositories.\n"),
  },
  {
    id: "workshop-typed-result",
    expect: /talk and the workshop type no result/,
    apply: (r) =>
      edit(r, "workshop/handout.md", "## Block six", "Codex cut 14/617 launches in the study.\n\n## Block six"),
  },
  {
    id: "cast-output-edited",
    expect: /shows exactly the output make-cast\.mjs captured/,
    apply: (r) => edit(r, "docs/demo.cast", "first 32768 bytes", "first 32767 bytes"),
  },
  {
    id: "cast-stale",
    expect: /is still what this build of map prints/,
    apply: async (r) => {
      edit(r, "docs/demo.cast", "first 32768 bytes", "first 32767 bytes");
      // Keep the sidecar consistent, so only the comparison with today's map can catch it.
      const { outputOfCast } = await import(
        new URL(`file:///${path.join(r, "scripts", "make-cast.mjs").replace(/\\/g, "/")}`).href
      );
      const cast = readFileSync(path.join(r, "docs", "demo.cast"), "utf8");
      const side = JSON.parse(readFileSync(path.join(r, "docs", "demo.cast.json"), "utf8"));
      side.outputSha256 = createHash("sha256").update(outputOfCast(cast)).digest("hex");
      writeFileSync(path.join(r, "docs", "demo.cast.json"), JSON.stringify(side, null, 2) + "\n");
    },
  },
  {
    id: "cast-unlabelled",
    expect: /labels itself in its title and its first typed line/,
    apply: (r) => edit(r, "docs/demo.cast", '[0.7,"o","#"]', '[0.7,"o","!"]'),
  },
  {
    id: "sample-unlabelled",
    expect: /the sample is labelled as a sample in every file/,
    apply: (r) => edit(r, "test/site-sample/data/results.json", '"label": "sample"', '"label": "study"'),
  },
  {
    id: "sample-schema-drift",
    expect: /the sample has the study's own schemas/,
    apply: (r) =>
      edit(
        r,
        "test/site-sample/data/provenance.json",
        '"schema": "ctxreach.site-provenance/v1"',
        '"schema": "ctxreach.site-provenance/v2"',
      ),
  },
  {
    id: "sample-in-site-data",
    expect: /never holds sample, dry-run or fake data/,
    apply: (r) =>
      cpSync(path.join(r, "test", "site-sample", "data"), path.join(r, "site", "data"), { recursive: true }),
  },
  {
    id: "site-data-k1-swapped",
    expect: /copies each check from the output that holds it/,
    apply: (r) =>
      edit(
        r,
        "scripts/site-data.mjs",
        "    k: json.k,\n    n: json.n,\n    knownDefects",
        "    k: json.n,\n    n: json.k,\n    knownDefects",
      ),
  },
  {
    id: "site-data-accepts-dry-run",
    expect: /refuses to call sample or dry-run inputs study data/,
    apply: (r) => edit(r, "scripts/site-data.mjs", "    if (doc.cells?.dryRun)\n", "    if (false)\n"),
  },
  {
    id: "prereg-seed-short",
    expect: /reads the pre-registration tag from git/,
    apply: (r) => edit(r, "scripts/site-data.mjs", "seed: commit.slice(0, 8)", "seed: commit.slice(0, 7)"),
  },
  {
    id: "sample-drift",
    needsStudy: true,
    expect: /what the study's own analysis makes of the invented rows/,
    apply: (r) => edit(r, "test/site-sample/data/results.json", '"excludedShare": 0.041667', '"excludedShare": 0.05'),
  },
];

function copyTree(study) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ctxreach-site-plant-"));
  for (const rel of COPY) {
    const from = path.join(ROOT, ...rel.split("/"));
    if (existsSync(from)) cpSync(from, path.join(dir, ...rel.split("/")), { recursive: true });
  }
  if (study) {
    cpSync(path.join(study, "study"), path.join(dir, "study"), { recursive: true });
    cpSync(path.join(ROOT, "test", "fixtures"), path.join(dir, "test", "fixtures"), { recursive: true });
  }
  return dir;
}

/** Run test/site.test.ts against `root`; returns the exit status and the failed tests' full names. */
function runTests(root) {
  const report = path.join(root, "vitest-report.json");
  const env = { ...process.env, CTXR_SITE_ROOT: root };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[k];
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "test/site.test.ts",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: ROOT, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  let failed = [];
  const passedNames = [];
  let skipped = 0;
  if (existsSync(report)) {
    const json = JSON.parse(readFileSync(report, "utf8"));
    for (const f of json.testResults ?? [])
      for (const a of f.assertionResults ?? []) {
        if (a.status === "failed") failed.push(a.fullName ?? a.title);
        else if (a.status === "passed") passedNames.push(a.fullName ?? a.title);
        else skipped++;
      }
    if (!(json.testResults ?? []).length) failed = [`(no test results: ${String(r.stderr).slice(0, 400)})`];
  } else failed = [`(no report: exit ${r.status}: ${String(r.stderr).slice(0, 400)})`];
  return { status: r.status, failed, passed: passedNames.length, passedNames, skipped };
}

async function main(argv) {
  const at = argv.indexOf("--study");
  const studyArg = at >= 0 ? path.resolve(argv[at + 1]) : undefined;
  const only = argv.filter((a, i) => !a.startsWith("--") && !(at >= 0 && i === at + 1));
  const study = studyArg ?? (existsSync(path.join(ROOT, "study", "census", "analyze.mjs")) ? ROOT : undefined);
  const plants = PLANTS.filter((p) => !only.length || only.includes(p.id));
  if (only.length && plants.length !== only.length) {
    console.error(`unknown plant: ${only.filter((o) => !PLANTS.some((p) => p.id === o)).join(", ")}`);
    return 2;
  }

  // Baseline: the unplanted copy (with the study code when a plant needs it) must pass everything it runs.
  const base = copyTree(plants.some((p) => p.needsStudy) ? study : undefined);
  let b;
  try {
    b = runTests(base);
    console.log(`baseline: ${b.passed} passed, ${b.failed.length} failed, ${b.skipped} skipped (exit ${b.status})`);
    if (b.status !== 0 || b.failed.length) {
      for (const f of b.failed) console.log(`  baseline failure: ${f}`);
      console.error("the unplanted copy does not pass: the instrument is broken, nothing below would mean anything");
      return 2;
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  // Every test the baseline ran must be the named target of a plant, or be listed in UNPLANTED with its reason.
  const exempt = (t) => Object.keys(UNPLANTED).some((u) => t.endsWith(u));
  const unplanted = only.length ? [] : b.passedNames.filter((t) => !exempt(t) && !PLANTS.some((p) => p.expect.test(t)));
  if (!only.length) {
    const checked = b.passedNames.filter((t) => !exempt(t)).length;
    console.log(
      `tests with a plant: ${checked - unplanted.length}/${checked} (exempt: ${b.passed - checked}, see UNPLANTED)`,
    );
    for (const t of unplanted) console.log(`NO PLANT  ${t}`);
  }

  let caught = 0;
  let missed = 0;
  let skippedPlants = 0;
  for (const plant of plants) {
    if (plant.needsStudy && !study) {
      console.log(`SKIPPED   ${plant.id}: needs the study's code (pass --study <dir>, or merge v1/study)`);
      skippedPlants++;
      continue;
    }
    const dir = copyTree(plant.needsStudy ? study : undefined);
    try {
      try {
        await plant.apply(dir);
      } catch (e) {
        console.error(`BROKEN    ${plant.id}: ${e.message}`);
        return 2;
      }
      const r = runTests(dir);
      const hit = r.failed.filter((f) => plant.expect.test(f));
      if (r.status !== 0 && hit.length) {
        caught++;
        console.log(
          `caught    ${plant.id}: ${hit[0]}${r.failed.length > hit.length ? ` (+${r.failed.length - hit.length} other)` : ""}`,
        );
      } else {
        missed++;
        console.log(`NOT CAUGHT ${plant.id}: exit ${r.status}; failed: ${r.failed.join(" | ") || "none"}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const ran = plants.length - skippedPlants;
  console.log(`\n${caught}/${ran} plants caught${skippedPlants ? `, ${skippedPlants} skipped (no study code)` : ""}`);
  return missed || unplanted.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = await main(process.argv.slice(2));
}
