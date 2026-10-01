// Plants one fault at a time in the oracle's code and checks that a test notices.
//
// Each plant below breaks one thing `ctxreach verify` relies on: the cut
// ignored when predicting a Codex chain, the wrong join between files, the
// user's own CODEX_HOME used instead of the throwaway, trust not mirrored,
// the decoy or the must-appear token no longer checked, a 9-character token
// pattern (the fault V10 found), the capture endpoint bound anywhere,
// credential headers kept, the model pin dropped, the agents-md plugin no
// longer asserted, the identical-renders check off, a render or a capture
// saved whole (the agent's own prompt text with it), and so on. For each
// plant, the oracle tests (test/oracle-*.test.ts, or the whole suite with
// --all) run once with that plant applied: a Vite transform replaces one
// exact piece of source text while the tests run. The files on disk are not
// changed. A plant counts as caught when at least one test fails, and fails
// again when its file is re-run with the same plant (so a timeout on a busy
// machine is not mistaken for a catch).
//
// The script checks its own instrument: the unplanted tests must pass, and
// each plant's text must occur exactly once in its file and be replaced in
// the run (a plant that matches nothing would prove nothing).
//
// Usage: node scripts/plant-oracle-faults.mjs [--all] [plant-name ...]
// Exit status: 0 when every plant is caught, 1 when any is not, 2 when the
// instrument itself fails.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), "..");
const MARK = "PLANT-RESULT ";

/** Each plant: a name, the file, the exact text to find (once), and what replaces it. */
export const PLANTS = [
  {
    name: "cut-ignored",
    file: "src/oracle/verify.ts",
    find: 'text: entry.keptBytes > 0 ? decodeLossy(bytes.subarray(0, entry.keptBytes)) : "",',
    replace: 'text: entry.keptBytes > 0 ? decodeLossy(bytes) : "",',
  },
  {
    name: "wrong-separator",
    file: "src/oracle/codex-render.ts",
    find: 'export const CHAIN_JOIN = "\\n\\n";',
    replace: 'export const CHAIN_JOIN = "\\n";',
  },
  {
    name: "codex-home-is-user-home",
    file: "src/oracle/verify.ts",
    find: 'const codexHome = path.join(box.base, "codex-home");',
    replace: "const codexHome = defaultCodexHome();",
  },
  {
    name: "trust-mirroring-off",
    file: "src/oracle/codex-home.ts",
    find: 'if (found.trust !== "unknown") {',
    replace: "if (false) {",
  },
  {
    name: "decoy-check-off",
    file: "src/oracle/score.ts",
    find: "if (decoySeen.length) reasons.push(",
    replace: "if (false) reasons.push(",
  },
  {
    name: "control-check-off",
    file: "src/oracle/score.ts",
    find: "if (!controlSeen)",
    replace: "if (false)",
  },
  {
    name: "token-pattern-9-chars",
    file: "src/oracle/score.ts",
    find: "export const TOKEN_PATTERN = /^CTXR-[0-9a-f]{8}$/i;",
    replace: "export const TOKEN_PATTERN = /^CTXR-[0-9a-f]{9}$/i;",
  },
  {
    name: "cwd-check-off",
    file: "src/oracle/score.ts",
    find: "else if (!p.same(e.cwd, launchAbs))",
    replace: "else if (false)",
  },
  {
    name: "capture-binds-any-host",
    file: "src/oracle/capture.ts",
    find: "if (!LOOPBACK_HOSTS.has(host))",
    replace: "if (false)",
  },
  {
    name: "credential-headers-kept",
    file: "src/oracle/capture.ts",
    find: "REDACT_HEADERS.has(name.toLowerCase()) || CREDENTIAL_NAME.test(name) ? REDACTED : text",
    replace: "text",
  },
  {
    name: "model-pin-missing",
    file: "src/oracle/claude-capture.ts",
    find: '"--model",\n    model,\n',
    replace: "",
  },
  {
    name: "plugin-assert-removed",
    file: "src/oracle/verify.ts",
    find: "if (!hasAgentsMdPlugin(init))",
    replace: "if (false)",
  },
  {
    name: "identical-render-check-off",
    file: "src/oracle/verify.ts",
    find: "if (firstBody !== undefined && body !== firstBody)",
    replace: "if (false)",
  },
  {
    name: "render-saved-whole",
    file: "src/oracle/verify.ts",
    find: "renderAsSaved(out.stdout, redactions)",
    replace: "out.stdout",
  },
  {
    name: "render-reduction-off",
    file: "src/oracle/codex-render.ts",
    find: "if (!Array.isArray(value)) return digestOf(UNTAGGED_KIND, value);",
    replace: "return value;",
  },
  {
    name: "codex-items-kept-whole",
    file: "src/oracle/codex-render.ts",
    find: "const whole = kind === AGENTS_KIND || kind === USER_KIND;",
    replace: "const whole = kind !== undefined;",
  },
  {
    name: "environment-cwd-dropped",
    file: "src/oracle/codex-render.ts",
    find: 'if (typeof text === "string" && text.includes(ENVIRONMENT_TAG)) out.cwd = cwdIn(text) ?? null;',
    replace: "",
  },
  {
    name: "capture-saved-whole",
    file: "src/oracle/verify.ts",
    find: "save: (r) => captureRecordAsSaved(r, redactions, prompt),",
    replace: "save: (r) => r,",
  },
  {
    name: "capture-reduction-off",
    file: "src/oracle/claude-capture.ts",
    find: "export function reduceCaptureBody(body: string, prompt?: string): string {",
    replace:
      "export function reduceCaptureBody(body: string, prompt?: string): string {\n  if (prompt !== undefined || prompt === undefined) return body;",
  },
  {
    name: "capture-blocks-kept-whole",
    file: "src/oracle/claude-capture.ts",
    find: 'if (typeof b?.text === "string" && b.text === prompt)',
    replace: 'if (typeof b?.text === "string")',
  },
  {
    name: "capture-files-dropped",
    file: "src/oracle/claude-capture.ts",
    find: "  if (piece.files.length) out.files = piece.files;",
    replace: "",
  },
  {
    name: "capture-tokens-dropped",
    file: "src/oracle/claude-capture.ts",
    find: "  if (tokens.length) out.tokens = tokens;",
    replace: "",
  },
  {
    name: "capture-cwd-dropped",
    file: "src/oracle/claude-capture.ts",
    find: "  if (piece.cwd !== undefined) out.cwd = piece.cwd;",
    replace: "",
  },
  {
    name: "saved-files-unread",
    file: "src/oracle/claude-capture.ts",
    find: "  const files = d.files ?? [];",
    replace: "  const files: DeliveredFile[] = [];",
  },
  {
    name: "version-gate-off",
    file: "src/oracle/claude-capture.ts",
    find: "if (compareVersions(version, CAPTURE_MIN_VERSION) < 0)",
    replace: "if (false)",
  },
  {
    name: "throwaway-home-anywhere",
    file: "src/oracle/codex-home.ts",
    find: "if (!isInsideReal(resolved, sandboxBase))",
    replace: "if (false)",
  },
  {
    name: "kill-switch-ignored",
    file: "src/oracle/claude-capture.ts",
    find: "const on = KILL_SWITCHES.filter((k) => truthy(env[k]));",
    replace: "const on = [];",
  },
];

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

/** The oracle's own test files, which every plant must be caught by. */
export function oracleTests() {
  return readdirSync(path.join(ROOT, "test"))
    .filter((n) => n.startsWith("oracle-") && n.endsWith(".test.ts"))
    .map((n) => `test/${n}`);
}

/** How many times each plant's text occurs in its file. */
export function occurrences() {
  return PLANTS.map((p) => ({
    name: p.name,
    count: readFileSync(path.join(ROOT, p.file), "utf8").split(p.find).length - 1,
  }));
}

/** Child process: run the tests (or `files`) once with `name` planted, or nothing for the baseline. */
async function child({ name, files }) {
  const { startVitest } = await import("vitest/node");
  const plant = PLANTS.find((p) => p.name === name);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ctxreach-plant-"));
  const log = path.join(tmp, "applied.log");
  writeFileSync(log, "");
  const plugin = {
    name: "ctxreach-plant-oracle-fault",
    enforce: "pre",
    transform(source, id) {
      if (!plant || rel(id.split("?")[0]) !== plant.file) return null;
      if (source.split(plant.find).length !== 2) throw new Error(`${plant.file}: expected "${plant.find}" once`);
      writeFileSync(log, "applied");
      return source.replace(plant.find, plant.replace);
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
    plant ? { plugins: [plugin] } : {},
  );
  const applied = readFileSync(log, "utf8") === "applied";
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`\n${MARK}${JSON.stringify({ name, total, failed, broken, applied })}\n`);
  process.exit(0);
}

/**
 * Run the tests once in a child process (`spawn` is replaceable for tests).
 * The child gets a temporary directory of its own, deleted afterwards, so a
 * plant that breaks cleanup leaves nothing in the system temp directory.
 */
export function run(name, files, spawn = spawnSync) {
  const own = mkdtempSync(path.join(os.tmpdir(), "ctxreach-plant-run-"));
  let res;
  try {
    res = spawn(process.execPath, [SELF, "--child", JSON.stringify({ name, files })], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, TMPDIR: own, TMP: own, TEMP: own },
    });
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
  const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith(MARK));
  if (!line) {
    process.stderr.write(res.stdout ?? "");
    process.stderr.write(res.stderr ?? "");
    throw new Error(`the run for ${name ?? "the baseline"} printed no result (exit ${res.status})`);
  }
  return JSON.parse(line.slice(MARK.length));
}

const label = (f) => `${f.file} > ${f.name}`;

function main(argv) {
  const all = argv.includes("--all");
  const requested = argv.filter((a) => a !== "--all");
  const unknown = requested.filter((n) => !PLANTS.some((p) => p.name === n));
  if (unknown.length) {
    console.error(`Unknown plant: ${unknown.join(", ")}`);
    return 2;
  }
  const missing = occurrences().filter((o) => o.count !== 1);
  if (missing.length) {
    console.error("Each plant's text must occur exactly once in its file:");
    for (const m of missing) console.error(`  ${m.name}: found ${m.count} times`);
    return 2;
  }
  const targets = requested.length ? PLANTS.filter((p) => requested.includes(p.name)) : PLANTS;
  const files = all ? undefined : oracleTests();

  const base = run(null, files);
  if (base.total === 0 || base.failed.length || base.broken.length) {
    console.error(`The tests do not pass without a plant (${base.failed.length} of ${base.total} failed):`);
    for (const f of [...base.broken, ...base.failed.map((f) => `${label(f)} (${f.why})`)]) console.error(`  ${f}`);
    return 2;
  }
  console.log(`baseline: 0 of ${base.total} tests fail with nothing planted (${all ? "whole suite" : "oracle tests"})`);

  let uncaught = 0;
  let instrument = 0;
  const width = Math.max(...targets.map((p) => p.name.length));
  for (const plant of targets) {
    const r = run(plant.name, files);
    let verdict;
    if (!r.applied || r.broken.length) {
      instrument++;
      verdict = `INSTRUMENT: ${r.applied ? r.broken.join("; ") : "the plant was never applied (no test loads the file)"}`;
    } else if (r.failed.length === 0) {
      uncaught++;
      verdict = "NOT CAUGHT: no test failed";
    } else {
      const again = run(plant.name, [...new Set(r.failed.map((f) => f.file))]);
      const repeated = new Set(again.failed.map(label));
      const caught = r.failed.filter((f) => repeated.has(label(f)));
      if (caught.length) {
        verdict = `caught by ${caught.length} of ${r.total} tests, e.g. ${label(caught[0])}`;
      } else {
        uncaught++;
        verdict = `NOT CAUGHT: ${r.failed.length} tests failed once but not on a second run`;
      }
    }
    console.log(`${plant.name.padEnd(width)}  ${verdict}`);
  }
  console.log(`\n${targets.length - uncaught - instrument} of ${targets.length} planted faults caught by a test`);
  return instrument ? 2 : uncaught ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  if (process.argv[2] === "--child") {
    await child(JSON.parse(process.argv[3] ?? "{}"));
  } else {
    process.exitCode = main(process.argv.slice(2));
  }
}
