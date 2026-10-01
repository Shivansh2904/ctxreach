// Disables each finding in turn, and breaks each rule that raises no finding
// of its own, and checks that a test notices.
//
// For every finding code in src/, the test suite is run once with that one
// finding removed: while the tests run, a Vite transform makes the Codex and
// Claude Code resolvers drop any finding with that code. Then, for every
// plant in PLANTS below, the suite is run once with that plant applied: the
// transform replaces one exact piece of source text (a rule's condition, the
// evidence label's lookup). The files on disk are not changed. A code or plant
// counts as caught when at least one test outside test/rules-doc.test.ts
// fails, and fails again when its file is re-run with the same plant (so a
// timeout on a busy machine is not mistaken for a catch).
// test/rules-doc.test.ts is left out because it checks the rules doc against
// map's output, so it can notice a missing finding without any behaviour test
// doing so.
//
// The script also checks its own instrument: the unplanted suite must pass,
// the code transform must apply to both resolvers, the list of codes must
// match the Findings table in docs/rules.md, each code run reports how many
// findings it actually dropped (a code no test ever produces shows 0
// dropped), and each plant's text must occur exactly once in its file and be
// replaced in the run.
//
// Usage: node scripts/plant-faults.mjs [code-or-plant ...]
// Exit status: 0 when every code and plant is caught, 1 when any is not, 2
// when the instrument itself fails.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), "..");
const RESOLVERS = ["src/agents/codex/resolve.ts", "src/agents/claude/resolve.ts"];
const DECLARATION = "const findings: Finding[] = [];";
const BOOKKEEPING = "test/rules-doc.test.ts";
const MARK = "PLANT-RESULT ";

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

const RESOLVE = "src/agents/claude/resolve.ts";
const APPROVALS = "src/agents/claude/approvals.ts";

/**
 * Faults in rules that raise no finding of their own, or that a dropped
 * finding would not show: each a name, the file, the exact text to find
 * (once), and what replaces it.
 */
export const PLANTS = [
  {
    name: "home-exemption-restored",
    file: RESOLVE,
    find: "CLAUDE_NAMES.filter((n) => isFileNamed(dir, n))",
    replace:
      'CLAUDE_NAMES.filter((n) => !(n === ".claude/CLAUDE.md" && samePath(dir, homeDir)) && isFileNamed(dir, n))',
  },
  {
    name: "home-ancestor-blames-any-shadower",
    file: RESOLVE,
    find: "aboveRepo.length === shadowers.length",
    replace: "true",
  },
  {
    name: "evidence-label-not-from-registry",
    file: RESOLVE,
    find: "const entry = from.entries.find((e) => e.rule === rule);",
    replace: 'const entry = { rule, status: "observed" as const, version: "2.1.285", k: 1, n: 1 };',
  },
  {
    name: "external-imports-always-load",
    file: RESOLVE,
    find: "if (external && !approvalFor().approved) {",
    replace: "if (false) {",
  },
  {
    name: "approval-key-ignored",
    file: APPROVALS,
    find: "const approved = entry.data[APPROVAL_KEY] === true;",
    replace: "const approved = true;",
  },
  {
    name: "approval-keyed-by-linked-worktree",
    file: APPROVALS,
    find: "return path.dirname(path.dirname(path.dirname(gitdir)));",
    replace: "return d;",
  },
  {
    name: "blocked-import-listed-twice",
    file: RESOLVE,
    find: "} else if (blocked.has(real(file))) {",
    replace: "} else if (false) {",
  },
  {
    name: "imported-agents-left-switched-off",
    file: RESOLVE,
    find: "supersede(target);",
    replace: "",
  },
  {
    name: "words-ignores-the-import",
    file: RESOLVE,
    find: "if (importsAgents(f.path, text)) continue;",
    replace: "",
  },
  {
    name: "tree-lists-a-file-twice",
    file: RESOLVE,
    find: "if (listed.has(real(s.path))) continue;",
    replace: "",
  },
  {
    name: "link-as-text-target-unchecked",
    file: RESOLVE,
    find: "return statSync(target).isFile() ? { text, target } : undefined;",
    replace: "return { text, target };",
  },
  {
    name: "same-text-dedup-off",
    file: RESOLVE,
    find: "if (agentsSupported) dedupeByText();",
    replace: "",
  },
  {
    name: "same-text-untrimmed",
    file: RESOLVE,
    find: 't = readFileSync(p, "utf8").trim();',
    replace: 't = readFileSync(p, "utf8");',
  },
  {
    name: "ancestor-rules-unmodelled",
    file: RESOLVE,
    find: '} else if (s.kind === ".claude/rules" && atOrAbove && modelAncestorRules) {',
    replace: "} else if (false) {",
  },
  {
    name: "rules-above-repo-skipped",
    file: RESOLVE,
    find: "if (!listed.has(real(file))) add(ruleRow(file, size(file), true));",
    replace: "",
  },
];

/** How often each plant's text occurs in its file; the script refuses to run unless each is 1. */
export function occurrences() {
  return PLANTS.map((p) => ({
    name: p.name,
    count: readFileSync(path.join(ROOT, p.file), "utf8").split(p.find).length - 1,
  }));
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : [],
  );
}

/** Every finding code in src/: each quoted id on a line that starts with `code:`. */
export function sourceCodes() {
  const codes = new Set();
  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!/^\s*code:/.test(line)) continue;
      for (const m of line.matchAll(/"((?:codex|claude)\.[a-z-]+)"/g)) codes.add(m[1]);
    }
  }
  return [...codes].sort();
}

/** The codes listed in the Findings table of docs/rules.md. */
export function documentedCodes() {
  const doc = readFileSync(path.join(ROOT, "docs", "rules.md"), "utf8");
  const findings = doc.split("\n## Findings")[1] ?? "";
  return [...findings.matchAll(/^\| `((?:codex|claude)\.[a-z-]+)` \| (?:warn|info) \|/gm)].map((m) => m[1]).sort();
}

/** Child process: run the suite (or `files`) once, with `code` dropped or `plant` applied, or nothing for the baseline. */
async function child({ code, plant, files }) {
  const { startVitest } = await import("vitest/node");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ctxreach-plant-"));
  const log = path.join(tmp, "dropped.log");
  writeFileSync(log, "");
  const planted = new Set();
  const planting = PLANTS.find((p) => p.name === plant);
  const plugin = {
    name: "ctxreach-plant-fault",
    enforce: "pre",
    transform(source, id) {
      const file = rel(id.split("?")[0]);
      if (planting) {
        if (file !== planting.file) return null;
        if (source.split(planting.find).length !== 2) throw new Error(`${file}: expected "${planting.find}" once`);
        planted.add(file);
        return source.replace(planting.find, () => planting.replace);
      }
      if (!RESOLVERS.includes(file)) return null;
      if (source.split(DECLARATION).length !== 2) throw new Error(`${file}: expected exactly one "${DECLARATION}"`);
      planted.add(file);
      // Non-enumerable, so a test comparing `findings` with toEqual still sees a plain array.
      const filter =
        `{ const keep = findings.push.bind(findings);` +
        ` Object.defineProperty(findings, "push", { enumerable: false, value: (...items: Finding[]) =>` +
        ` keep(...items.filter((f) => {` +
        ` if (f.code !== ${JSON.stringify(code)}) return true;` +
        ` plantLog(${JSON.stringify(log)}, "."); return false; })) }); }`;
      return `import { appendFileSync as plantLog } from "node:fs";\n${source.replace(DECLARATION, `${DECLARATION} ${filter}`)}`;
    },
  };
  const failed = [];
  const broken = [];
  let total = 0;
  const reporter = {
    onTestRunEnd(modules, errors) {
      for (const mod of modules) {
        const file = rel(mod.moduleId);
        if (mod.errors().length) broken.push(`${file}: ${mod.errors()[0].message}`);
        for (const test of mod.children.allTests()) {
          total++;
          const result = test.result();
          if (result.state !== "failed") continue;
          failed.push({ file, name: test.fullName, why: (result.errors?.[0]?.message ?? "").split("\n")[0] });
        }
      }
      for (const e of errors) broken.push(`unhandled: ${e.message}`);
    },
  };
  await startVitest(
    "test",
    files ?? [],
    { root: ROOT, run: true, watch: false, reporters: [reporter] },
    code || plant ? { plugins: [plugin] } : {},
  );
  // The planted code writes one "." per finding it drops.
  const dropped = readFileSync(log, "utf8").length;
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(
    `\n${MARK}${JSON.stringify({ code, plant, total, failed, broken, planted: [...planted], dropped })}\n`,
  );
  process.exit(0);
}

function run(code, files, plant) {
  const res = spawnSync(process.execPath, [SELF, "--child", JSON.stringify({ code, plant, files })], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith(MARK));
  if (!line) {
    process.stderr.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    throw new Error(`the run for ${code ?? plant ?? "the baseline"} printed no result (exit ${res.status})`);
  }
  return JSON.parse(line.slice(MARK.length));
}

const label = (f) => `${f.file} > ${f.name}`;

/**
 * Whether a planted run was caught: some test outside the bookkeeping file
 * failed, and failed again when its file was re-run with the same plant.
 */
function verdictOf(r, rerun) {
  const behaviour = r.failed.filter((f) => f.file !== BOOKKEEPING);
  const docOnly = r.failed.length - behaviour.length;
  if (behaviour.length === 0) {
    return {
      caught: false,
      text: `NOT CAUGHT: no behaviour test failed` + (docOnly ? ` (only ${BOOKKEEPING} did)` : ""),
    };
  }
  // A test that fails for an unrelated reason (a timeout on a busy machine)
  // must not count as a catch, so run the failing files again with the
  // same plant and keep only the tests that fail both times.
  const again = rerun([...new Set(behaviour.map((f) => f.file))]);
  const repeated = new Set(again.failed.map(label));
  const caught = behaviour.filter((f) => repeated.has(label(f)));
  return caught.length
    ? {
        caught: true,
        text: `caught by ${caught.length} of ${r.total} tests, e.g. ${label(caught[0])} (${caught[0].why})`,
      }
    : { caught: false, text: `NOT CAUGHT: ${behaviour.length} tests failed once but not on a second run` };
}

function main(requested) {
  const codes = sourceCodes();
  const documented = documentedCodes();
  if (codes.join() !== documented.join()) {
    console.error("The finding codes in src/ and in docs/rules.md differ:");
    console.error(`  only in src/: ${codes.filter((c) => !documented.includes(c)).join(", ") || "none"}`);
    console.error(`  only in docs: ${documented.filter((c) => !codes.includes(c)).join(", ") || "none"}`);
    return 2;
  }
  const bad = occurrences().filter((o) => o.count !== 1);
  if (bad.length) {
    for (const o of bad) console.error(`Plant ${o.name}: its text occurs ${o.count} times, not once.`);
    return 2;
  }
  const plantNames = PLANTS.map((p) => p.name);
  const unknown = requested.filter((c) => !codes.includes(c) && !plantNames.includes(c));
  if (unknown.length) {
    console.error(`Unknown finding code or plant: ${unknown.join(", ")}`);
    return 2;
  }
  const codeTargets = requested.length ? requested.filter((c) => codes.includes(c)) : codes;
  const plantTargets = requested.length ? requested.filter((c) => plantNames.includes(c)) : plantNames;

  const base = run(null);
  if (base.total === 0 || base.failed.length || base.broken.length) {
    console.error(`The suite does not pass without a plant (${base.failed.length} of ${base.total} failed):`);
    for (const f of [...base.broken, ...base.failed.map((f) => `${label(f)} (${f.why})`)]) console.error(`  ${f}`);
    return 2;
  }
  console.log(`baseline: 0 of ${base.total} tests fail with nothing planted`);

  let uncaught = 0;
  let instrument = 0;
  const width = Math.max(...[...codeTargets, ...plantTargets].map((c) => c.length));
  let codesCaught = 0;
  for (const code of codeTargets) {
    const r = run(code);
    let text;
    if (r.broken.length || r.planted.length !== RESOLVERS.length) {
      instrument++;
      text = `INSTRUMENT: planted in ${r.planted.length} of ${RESOLVERS.length} resolvers; ${r.broken.join("; ")}`;
    } else if (r.dropped === 0) {
      uncaught++;
      text = "NOT CAUGHT: no test produces this finding";
    } else {
      const v = verdictOf(r, (files) => run(code, files));
      if (v.caught) codesCaught++;
      else uncaught++;
      text = v.text;
    }
    console.log(`${code.padEnd(width)}  dropped ${String(r.dropped).padStart(3)}  ${text}`);
  }
  if (codeTargets.length) console.log(`\n${codesCaught} of ${codeTargets.length} finding codes caught by a test\n`);

  let plantsCaught = 0;
  for (const plant of plantTargets) {
    const r = run(null, undefined, plant);
    let text;
    if (r.broken.length || r.planted.length !== 1) {
      instrument++;
      text = `INSTRUMENT: planted in ${r.planted.length} files; ${r.broken.join("; ")}`;
    } else {
      const v = verdictOf(r, (files) => run(null, files, plant));
      if (v.caught) plantsCaught++;
      else uncaught++;
      text = v.text;
    }
    console.log(`${plant.padEnd(width)}  plant        ${text}`);
  }
  if (plantTargets.length) console.log(`\n${plantsCaught} of ${plantTargets.length} plants caught by a test`);
  return instrument ? 2 : uncaught ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv[2] === "--child") {
    await child(JSON.parse(process.argv[3] ?? "{}"));
  } else {
    process.exitCode = main(process.argv.slice(2));
  }
}
