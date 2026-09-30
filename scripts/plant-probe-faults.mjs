// Plants one fault at a time in the probe's code and checks that a test notices.
//
// Each plant below breaks one thing the probe relies on: the classifier
// ignoring tool calls, the decoy check switched off, recall mode left with
// tools, the sandbox keeping hooks or copying links as links, and so on. For
// each plant, the test suite runs once with that plant applied: a Vite
// transform replaces one exact piece of source text while the tests run. The
// files on disk are not changed. A plant counts as caught when at least one
// test fails, and fails again when its file is re-run with the same plant (so
// a timeout on a busy machine is not mistaken for a catch).
//
// The script checks its own instrument: the unplanted suite must pass, and
// each plant's text must occur exactly once in its file and be replaced in
// the run (a plant that matches nothing would prove nothing).
//
// Usage: node scripts/plant-probe-faults.mjs [plant-name ...]
// Exit status: 0 when every plant is caught, 1 when any is not, 2 when the
// instrument itself fails.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), "..");
const MARK = "PLANT-RESULT ";

/** Each plant: a name, the file, the exact text to find (once), and what replaces it. */
export const PLANTS = [
  {
    name: "classifier-ignores-tool-calls",
    file: "src/probe/classify.ts",
    find: 'if (item.kind !== "tool-use") return;',
    replace: "return;",
  },
  {
    name: "classifier-ignores-tool-output",
    file: "src/probe/classify.ts",
    find: 'item.kind === "tool-result" && item.text.includes(c.token)',
    replace: "false",
  },
  {
    name: "classifier-never-contaminated",
    file: "src/probe/classify.ts",
    find: "const contaminated = contaminatedBy.length > 0;",
    replace: "const contaminated = false;",
  },
  {
    name: "classifier-allows-token-searches",
    file: "src/probe/classify.ts",
    find: "calls.some((c) => c.searchesTokens)",
    replace: "false",
  },
  {
    name: "dir-read-counts-any-path",
    file: "src/probe/classify.ts",
    find: "const dirRead = calls.some((call) => call.reads.some(inScope));",
    replace: "const dirRead = calls.some((call) => call.paths.some(inScope));",
  },
  {
    name: "no-decoy-check",
    file: "src/probe/score.ts",
    find: "if (decoyEchoed > 0)",
    replace: "if (false)",
  },
  {
    name: "decoy-check-counts-a-read-decoy",
    file: "src/probe/score.ts",
    find: 'decoys.some((d) => cls.observations[d.token]?.seen === "preloaded")',
    replace: 'decoys.some((d) => (cls.observations[d.token]?.seen ?? "not-seen") !== "not-seen")',
  },
  {
    name: "unstarted-trial-is-a-fault",
    file: "src/probe/score.ts",
    find: "if (!started && failures.length)",
    replace: "if (false)",
  },
  {
    name: "unmodelled-rows-counted",
    file: "src/probe/compare.ts",
    find: 'if (expectation === "not-modelled") return "not-modelled";',
    replace: "",
  },
  {
    name: "no-tools-offered-check",
    file: "src/probe/score.ts",
    find: "if (extra.length)",
    replace: "if (false)",
  },
  {
    name: "no-working-directory-check",
    file: "src/probe/score.ts",
    find: "!p.same(transcript.cwd, launchAbs)",
    replace: "false",
  },
  {
    name: "parser-accepts-any-shape",
    file: "src/agents/claude/events.ts",
    find: "if (!r.success) throw new TranscriptError",
    replace: "if (false) throw new TranscriptError",
  },
  {
    name: "parser-drops-tool-results",
    file: "src/agents/claude/events.ts",
    find: 'if (block.type === "tool_result") {',
    replace: "if (false) {",
  },
  {
    name: "parser-hides-unknown-events",
    file: "src/agents/claude/events.ts",
    find: "if (!IGNORED.has(head.type)) count(out.events.unknown, head.type);",
    replace: "",
  },
  {
    name: "redaction-keeps-user-lists",
    file: "src/agents/claude/events.ts",
    find: 'for (const key of ["slash_commands", "skills", "agents"]) {',
    replace: "for (const key of [] as string[]) {",
  },
  {
    name: "recall-mode-keeps-a-tool",
    file: "src/agents/claude/adapter.ts",
    find: '[...common, "--tools", ""]',
    replace: '[...common, "--tools", "Read"]',
  },
  {
    name: "parent-session-env-kept",
    file: "src/agents/claude/adapter.ts",
    find: ".filter(([k]) => !SESSION_VARS.test(k))",
    replace: ".filter(() => true)",
  },
  {
    name: "agent-runs-outside-sandbox",
    file: "src/agents/claude/adapter.ts",
    find: "sandboxOf(request.workdir)",
    replace: '({ base: request.workdir, repo: request.workdir, source: "" })',
  },
  {
    name: "no-timeout",
    file: "src/agents/claude/adapter.ts",
    find: "child.kill();",
    replace: "",
  },
  {
    name: "sandbox-keeps-hooks-and-mcp",
    file: "src/probe/sandbox.ts",
    find: "for (const item of STRIP) {",
    replace: "for (const item of [] as string[]) {",
  },
  {
    name: "sandbox-copies-git",
    file: "src/probe/sandbox.ts",
    find: "if (SKIP_NAMES.has(entry.name)) {",
    replace: "if (false) {",
  },
  {
    // What the sandbox did before links were handled: cpSync with verbatimSymlinks.
    name: "sandbox-copies-links-verbatim",
    file: "src/probe/sandbox.ts",
    find: "if (st.isSymbolicLink()) copyLink(state, fromEntry, toEntry, chain);",
    replace:
      'if (st.isSymbolicLink()) process.getBuiltinModule("node:fs").symlinkSync(process.getBuiltinModule("node:fs").readlinkSync(fromEntry), toEntry, process.platform === "win32" ? "junction" : undefined);',
  },
  {
    name: "sandbox-follows-links-outside",
    file: "src/probe/sandbox.ts",
    find: "if (!isInside(target, state.src)) {",
    replace: "if (false) {",
  },
  {
    name: "strip-removes-through-links",
    file: "src/probe/sandbox.ts",
    find: "if (!isInside(realpathSync(path.dirname(target)), repoReal))",
    replace: "if (false)",
  },
  {
    name: "sandbox-copies-home",
    file: "src/probe/sandbox.ts",
    find: "if (isInsideReal(home, source))",
    replace: "if (false)",
  },
  {
    name: "sandbox-check-accepts-any-directory",
    file: "src/probe/sandbox.ts",
    find: "if (!isInside(real, repo)) throw new SafetyError",
    replace: "if (false) throw new SafetyError",
  },
  {
    name: "sandbox-check-accepts-any-place",
    file: "src/probe/sandbox.ts",
    find: "assertSandboxPlace(cursor);",
    replace: "",
  },
  {
    name: "verdict-lenient-on-launch",
    file: "src/probe/compare.ts",
    find: 'return pre === n ? "confirmed" : "missed";',
    replace: 'return pre > 0 ? "confirmed" : "missed";',
  },
  {
    name: "verdict-ignores-directory-reads",
    file: "src/probe/compare.ts",
    find: "const chances = trials.filter((t) => t.dirRead);",
    replace: "const chances = trials;",
  },
  {
    name: "expectation-ignores-cut",
    file: "src/probe/compare.ts",
    find: "canary.offset + TOKEN_LENGTH <= predicted.cutAt",
    replace: "true",
  },
  {
    name: "sandbox-not-removed",
    file: "src/probe/probe.ts",
    find: "if (sandbox) removeSandbox(sandbox);",
    replace: "",
  },
  {
    name: "records-inside-the-repository",
    file: "src/probe/probe.ts",
    find: "if (isInside(saveDir, repoRoot))",
    replace: "if (false)",
  },
  {
    name: "no-decoy-planted",
    file: "src/probe/probe.ts",
    find: "canaries.push(...plantDecoy(box.repo, launchRel, tokens));",
    replace: "",
  },
  {
    name: "scoped-rules-not-marked",
    file: "src/probe/canary.ts",
    find: "const scoped = isScopedRule(rel, original) ? { scoped: true } : {};",
    replace: "const scoped = {};",
  },
];

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

/** How many times each plant's text occurs in its file. */
export function occurrences() {
  return PLANTS.map((p) => ({
    name: p.name,
    count: readFileSync(path.join(ROOT, p.file), "utf8").split(p.find).length - 1,
  }));
}

/** Child process: run the suite (or `files`) once with `name` planted, or nothing for the baseline. */
async function child({ name, files }) {
  const { startVitest } = await import("vitest/node");
  const plant = PLANTS.find((p) => p.name === name);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "ctxreach-plant-"));
  const log = path.join(tmp, "applied.log");
  writeFileSync(log, "");
  const plugin = {
    name: "ctxreach-plant-probe-fault",
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
 * Run the suite once in a child process (`spawn` is replaceable for tests).
 * The child gets a temporary directory of its own (TMPDIR, TMP and TEMP),
 * which is deleted afterwards: a plant that breaks cleanup leaves its
 * directories there, and nothing another process made in the system temp
 * directory is touched.
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

function main(requested) {
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

  const base = run(null);
  if (base.total === 0 || base.failed.length || base.broken.length) {
    console.error(`The suite does not pass without a plant (${base.failed.length} of ${base.total} failed):`);
    for (const f of [...base.broken, ...base.failed.map((f) => `${label(f)} (${f.why})`)]) console.error(`  ${f}`);
    return 2;
  }
  console.log(`baseline: 0 of ${base.total} tests fail with nothing planted`);

  let uncaught = 0;
  let instrument = 0;
  const width = Math.max(...targets.map((p) => p.name.length));
  for (const plant of targets) {
    const r = run(plant.name);
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
