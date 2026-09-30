import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The workflows call scripts/conformance.mjs, which the oracle lane owns. A
 * call with a flag the script does not accept fails only on GitHub, at night,
 * so each call is checked here against the flags the script's own text
 * accepts: read from scripts/conformance.mjs when it is in the tree, else
 * from test/workflows/conformance-args.json (read from the script's text on
 * branch v1/oracle).
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = path.join(ROOT, ".github", "workflows");
const SCRIPT = path.join(ROOT, "scripts", "conformance.mjs");

interface Accepted {
  /** Agents the script has an oracle for (`--agents` values). */
  agents: string[];
  /** Each flag, and whether it takes a value. */
  flags: Record<string, "value" | "switch">;
  /** Flags the script refuses to run without, per agent. */
  requires: Record<string, string[]>;
}

const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, "test", "workflows", "conformance-args.json"), "utf8"),
) as Accepted & {
  excerpt: string[];
};

/** What the script's text accepts: its parseArgs branches, its PLANTED agents, and the flags main requires per agent. */
function acceptedBy(text: string): Accepted {
  const body = /export function parseArgs\(argv\) \{([\s\S]*?)\n\}/.exec(text)?.[1];
  if (!body) throw new Error("no parseArgs in the script");
  const flags: Accepted["flags"] = {};
  const fieldOf: Record<string, string> = {};
  const branches = [...body.matchAll(/if \(a === "(--[\w-]+)"\)/g)];
  branches.forEach((m, i) => {
    const flag = m[1]!;
    const branch = body.slice(m.index + m[0].length, branches[i + 1]?.index ?? body.length);
    flags[flag] = /\bnext\(\)/.test(branch) ? "value" : "switch";
    const field = /opts\.(\w+) =/.exec(branch)?.[1];
    if (field) fieldOf[field] = flag;
  });
  const planted = /export const PLANTED = \{([\s\S]*?)\n\};/.exec(text)?.[1];
  if (!planted) throw new Error("no PLANTED in the script");
  const agents = [...planted.matchAll(/^\s*(\w+): \{/gm)].map((m) => m[1]!);
  const requires: Accepted["requires"] = {};
  for (const m of text.matchAll(/opts\.agents\.includes\("(\w+)"\) && !opts\.(\w+)/g)) {
    const flag = fieldOf[m[2]!];
    if (!flag) throw new Error(`main requires opts.${m[2]}, which no flag sets`);
    (requires[m[1]!] ??= []).push(flag);
  }
  return { agents, flags, requires };
}

const ACCEPTED: Accepted = existsSync(SCRIPT) ? acceptedBy(readFileSync(SCRIPT, "utf8")) : FIXTURE;

interface Job {
  name: string;
  /** The job-level `if:`, as written. */
  if?: string;
  /** The shell text of each `run:` step. */
  runs: string[];
}

/** The jobs of a workflow, with their `if:` and `run:` text (a deliberately small reader for these files). */
function readJobs(yml: string): Job[] {
  const lines = yml.split(/\r?\n/);
  const jobs: Job[] = [];
  let job: Job | undefined;
  for (let i = lines.indexOf("jobs:") + 1; i > 0 && i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\S/.test(line)) break;
    const name = /^ {2}([\w-]+):\s*$/.exec(line);
    if (name) {
      job = { name: name[1]!, runs: [] };
      jobs.push(job);
      continue;
    }
    if (!job) continue;
    const cond = /^ {4}if: (.*)$/.exec(line);
    if (cond) {
      job.if = cond[1]!.trim();
      continue;
    }
    const run = /^( *)(- )?run: ?(.*)$/.exec(line);
    if (!run) continue;
    const keyColumn = run[1]!.length + (run[2] ? 2 : 0);
    if (/^[|>][-+]?$/.test(run[3]!.trim())) {
      const block: string[] = [];
      while (i + 1 < lines.length && (lines[i + 1]!.trim() === "" || /^ */.exec(lines[i + 1]!)![0].length > keyColumn))
        block.push(lines[++i]!.trim());
      job.runs.push(block.join("\n"));
    } else job.runs.push(run[3]!.trim());
  }
  return jobs;
}

/** Shell words of one command line, quotes removed, up to the first ;, & or | outside quotes. */
function words(line: string): string[] {
  const out: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else word = (word ?? "") + ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= "";
    } else if (/[\s;&|]/.test(ch)) {
      if (word !== undefined) out.push(word);
      word = undefined;
      if (!/\s/.test(ch)) break;
    } else word = (word ?? "") + ch;
  }
  if (word !== undefined) out.push(word);
  return out;
}

interface Invocation {
  workflow: string;
  job: string;
  args: string[];
}

/** Every `node scripts/conformance.mjs ...` in a workflow's run steps, with its arguments. */
function invocations(workflow: string, yml: string): Invocation[] {
  const out: Invocation[] = [];
  for (const job of readJobs(yml))
    for (const run of job.runs)
      for (const line of run.replace(/\\\n/g, " ").split("\n")) {
        if (line.trimStart().startsWith("#")) continue;
        const w = words(line);
        const at = w.findIndex((x, i) => x === "scripts/conformance.mjs" && w[i - 1] === "node");
        if (at >= 0) out.push({ workflow, job: job.name, args: w.slice(at + 1) });
      }
  return out;
}

/** What is wrong with one call, against what the script accepts. */
function problems(call: Invocation, accepted: Accepted): string[] {
  const where = `${call.workflow} job ${call.job}`;
  const out: string[] = [];
  const given = new Map<string, string | true>();
  for (let i = 0; i < call.args.length; i++) {
    const flag = call.args[i]!;
    const kind = accepted.flags[flag];
    if (!kind) {
      out.push(`${where}: ${flag} is not a flag scripts/conformance.mjs accepts`);
      continue;
    }
    if (kind === "switch") {
      given.set(flag, true);
      continue;
    }
    const value = call.args[i + 1];
    if (value === undefined || value === "" || value.startsWith("--")) out.push(`${where}: ${flag} needs a value`);
    else {
      given.set(flag, value);
      i++;
    }
  }
  const agents = given.get("--agents");
  if (typeof agents !== "string") {
    out.push(`${where}: no --agents, so the column depends on the script's default`);
    return out;
  }
  for (const agent of agents.split(",").filter(Boolean)) {
    if (!accepted.agents.includes(agent)) out.push(`${where}: --agents names ${agent}, which has no oracle`);
    for (const flag of accepted.requires[agent] ?? [])
      if (typeof given.get(flag) !== "string") out.push(`${where}: --agents ${agent} needs ${flag}`);
  }
  if (agents !== call.job) out.push(`${where}: runs --agents ${agents}, not the job's own column (${call.job})`);
  return out;
}

const workflowFiles = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
const ALL_CALLS = workflowFiles.flatMap((f) => invocations(f, readFileSync(path.join(WORKFLOWS, f), "utf8")));

describe("the flags scripts/conformance.mjs accepts", () => {
  it("test/workflows/conformance-args.json lists exactly what its verbatim excerpt of the script accepts", () => {
    const { agents, flags, requires } = FIXTURE;
    expect(acceptedBy(FIXTURE.excerpt.join("\n"))).toEqual({ agents, flags, requires });
  });

  it.runIf(existsSync(SCRIPT))("scripts/conformance.mjs, now in the tree, accepts what the fixture lists", () => {
    const { agents, flags, requires } = FIXTURE;
    expect(acceptedBy(readFileSync(SCRIPT, "utf8"))).toEqual({ agents, flags, requires });
  });
});

describe("every workflow call of scripts/conformance.mjs", () => {
  it("there is one per column: codex and claude in conformance.yml", () => {
    expect(ALL_CALLS.map((c) => `${c.workflow}:${c.job}`).sort()).toEqual([
      "conformance.yml:claude",
      "conformance.yml:codex",
    ]);
  });

  it("passes only flags the script accepts, each with its value, and what the script requires per agent", () => {
    expect(ALL_CALLS.flatMap((c) => problems(c, ACCEPTED))).toEqual([]);
  });

  it("the Claude Code column pins a model", () => {
    const claude = ALL_CALLS.find((c) => c.job === "claude")!;
    const model = claude.args[claude.args.indexOf("--model") + 1];
    expect(model).toBe("claude-opus-5-5");
  });

  it("the check fails on a wrong call (the old --agent, a claude run with no --model, an unknown agent)", () => {
    const wrong = [
      { workflow: "w.yml", job: "codex", args: ["--agent", "codex", "--out", "$OUT"] },
      { workflow: "w.yml", job: "claude", args: ["--agents", "claude", "--out", "$OUT"] },
      { workflow: "w.yml", job: "gemini", args: ["--agents", "gemini", "--model"] },
    ];
    expect(wrong.map((c) => problems(c, FIXTURE))).toEqual([
      [
        "w.yml job codex: --agent is not a flag scripts/conformance.mjs accepts",
        "w.yml job codex: codex is not a flag scripts/conformance.mjs accepts",
        "w.yml job codex: no --agents, so the column depends on the script's default",
      ],
      ["w.yml job claude: --agents claude needs --model"],
      ["w.yml job gemini: --model needs a value", "w.yml job gemini: --agents names gemini, which has no oracle"],
    ]);
  });

  it("reads a call written over several lines, in quotes, before a ;", () => {
    const yml = [
      "jobs:",
      "  claude:",
      "    steps:",
      "      - run: |",
      "          # node scripts/conformance.mjs --agent claude",
      "          node scripts/conformance.mjs --agents claude \\",
      "            --model 'claude-opus-5-5' --out \"$OUT\"; echo done",
    ].join("\n");
    expect(invocations("w.yml", yml)).toEqual([
      { workflow: "w.yml", job: "claude", args: ["--agents", "claude", "--model", "claude-opus-5-5", "--out", "$OUT"] },
    ]);
  });
});

describe("conformance.yml", () => {
  const jobs = readJobs(readFileSync(path.join(WORKFLOWS, "conformance.yml"), "utf8"));

  it("runs the Claude Code column only when CTXREACH_CONFORMANCE is on, so it is off by default, also by hand", () => {
    const claude = jobs.find((j) => j.name === "claude");
    const terms = (claude?.if ?? "").split("&&").map((t) => t.trim());
    expect(terms).toContain("vars.CTXREACH_CONFORMANCE == 'on'");
    expect(claude?.if).not.toContain("||");
  });

  it("still runs the Codex columns by hand without the variable", () => {
    expect(jobs.find((j) => j.name === "plan")?.if).toBe(
      "github.event_name == 'workflow_dispatch' || vars.CTXREACH_CONFORMANCE == 'on'",
    );
    expect(jobs.find((j) => j.name === "codex")?.if).toBeUndefined();
  });
});
