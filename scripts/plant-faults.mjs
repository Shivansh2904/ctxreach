// Disables each finding in turn and checks that a test notices.
//
// For every finding code in src/, the test suite is run once with that one
// finding removed: while the tests run, a Vite transform makes the Codex and
// Claude Code resolvers drop any finding with that code. The files on disk
// are not changed. A code counts as caught when at least one test outside
// test/rules-doc.test.ts fails, and fails again when its file is re-run with
// the same plant (so a timeout on a busy machine is not mistaken for a catch).
// test/rules-doc.test.ts is left out because it checks the rules doc against
// map's output, so it can notice a missing finding without any behaviour test
// doing so.
//
// The script also checks its own instrument: the unplanted suite must pass,
// the transform must apply to both resolvers, the list of codes must match
// the Findings table in docs/rules.md, and each run reports how many findings
// it actually dropped. A code no test ever produces shows 0 dropped.
//
// Usage: node scripts/plant-faults.mjs [code ...]
// Exit status: 0 when every code is caught, 1 when any is not, 2 when the
// instrument itself fails.

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

/** Child process: run the suite (or `files`) once, with `code` dropped, or nothing for the baseline. */
async function child({ code, files }) {
  const { startVitest } = await import("vitest/node");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ctxreach-plant-"));
  const log = path.join(tmp, "dropped.log");
  writeFileSync(log, "");
  const planted = new Set();
  const plugin = {
    name: "ctxreach-plant-fault",
    enforce: "pre",
    transform(source, id) {
      const file = rel(id.split("?")[0]);
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
    code ? { plugins: [plugin] } : {},
  );
  // The planted code writes one "." per finding it drops.
  const dropped = readFileSync(log, "utf8").length;
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`\n${MARK}${JSON.stringify({ code, total, failed, broken, planted: [...planted], dropped })}\n`);
  process.exit(0);
}

function run(code, files) {
  const res = spawnSync(process.execPath, [SELF, "--child", JSON.stringify({ code, files })], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith(MARK));
  if (!line) {
    process.stderr.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    throw new Error(`the run for ${code ?? "the baseline"} printed no result (exit ${res.status})`);
  }
  return JSON.parse(line.slice(MARK.length));
}

const label = (f) => `${f.file} > ${f.name}`;

function main(requested) {
  const codes = sourceCodes();
  const documented = documentedCodes();
  if (codes.join() !== documented.join()) {
    console.error("The finding codes in src/ and in docs/rules.md differ:");
    console.error(`  only in src/: ${codes.filter((c) => !documented.includes(c)).join(", ") || "none"}`);
    console.error(`  only in docs: ${documented.filter((c) => !codes.includes(c)).join(", ") || "none"}`);
    return 2;
  }
  const unknown = requested.filter((c) => !codes.includes(c));
  if (unknown.length) {
    console.error(`Unknown finding code: ${unknown.join(", ")}`);
    return 2;
  }
  const targets = requested.length ? requested : codes;

  const base = run(null);
  if (base.total === 0 || base.failed.length || base.broken.length) {
    console.error(`The suite does not pass without a plant (${base.failed.length} of ${base.total} failed):`);
    for (const f of [...base.broken, ...base.failed.map((f) => `${label(f)} (${f.why})`)]) console.error(`  ${f}`);
    return 2;
  }
  console.log(`baseline: 0 of ${base.total} tests fail with nothing planted`);

  let uncaught = 0;
  let instrument = 0;
  const width = Math.max(...targets.map((c) => c.length));
  for (const code of targets) {
    const r = run(code);
    const behaviour = r.failed.filter((f) => f.file !== BOOKKEEPING);
    const docOnly = r.failed.length - behaviour.length;
    let verdict;
    if (r.broken.length || r.planted.length !== RESOLVERS.length) {
      instrument++;
      verdict = `INSTRUMENT: planted in ${r.planted.length} of ${RESOLVERS.length} resolvers; ${r.broken.join("; ")}`;
    } else if (behaviour.length === 0) {
      uncaught++;
      verdict =
        r.dropped === 0
          ? "NOT CAUGHT: no test produces this finding"
          : `NOT CAUGHT: no behaviour test failed` + (docOnly ? ` (only ${BOOKKEEPING} did)` : "");
    } else {
      // A test that fails for an unrelated reason (a timeout on a busy machine)
      // must not count as a catch, so run the failing files again with the
      // same plant and keep only the tests that fail both times.
      const again = run(code, [...new Set(behaviour.map((f) => f.file))]);
      const repeated = new Set(again.failed.map(label));
      const caught = behaviour.filter((f) => repeated.has(label(f)));
      if (caught.length) {
        verdict = `caught by ${caught.length} of ${r.total} tests, e.g. ${label(caught[0])} (${caught[0].why})`;
      } else {
        uncaught++;
        verdict = `NOT CAUGHT: ${behaviour.length} tests failed once but not on a second run`;
      }
    }
    console.log(`${code.padEnd(width)}  dropped ${String(r.dropped).padStart(3)}  ${verdict}`);
  }
  console.log(`\n${targets.length - uncaught - instrument} of ${targets.length} finding codes caught by a test`);
  return instrument ? 2 : uncaught ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv[2] === "--child") {
    await child(JSON.parse(process.argv[3] ?? "{}"));
  } else {
    process.exitCode = main(process.argv.slice(2));
  }
}
