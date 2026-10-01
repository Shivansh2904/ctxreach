import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- plain JavaScript script without type declarations
import * as evidence from "../scripts/evidence.mjs";
import { claudeAdapter } from "../src/agents/claude/adapter.js";
import { readRecording } from "../src/probe/recording.js";
import { scoreRecording } from "../src/probe/score.js";
import { tempDir } from "./helpers/fixture.js";

const {
  countCells,
  flips,
  loadAll,
  missingEntries,
  orphanEntries,
  plantOccurrences,
  PLANTS,
  readmeViolations,
  readResults,
  renderEvidenceMd,
  replayMismatches,
  rulesDocIds,
  validateRegistry,
} = evidence;

// Replaying the eight recordings takes a few seconds; more on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORDED = "test/recorded";

/**
 * Ids that branch v1/map-rules adds to docs/rules.md. Their entries are in
 * docs/evidence.json already, so merging that branch loses nothing. Once
 * they are in docs/rules.md, the test below fails: delete them from here.
 */
const PENDING = [
  "claude.external-import-headless",
  "claude.home-ancestor",
  "claude.link-as-text",
  "codex.home-is-root",
];

interface Cell {
  rule: string;
  delivery: string;
  needsApproval: boolean;
  verdict: string;
}
interface Replay {
  cells: Cell[];
  usable: number;
  agent: string;
  version: string;
  os: string;
  date: string;
  fault: boolean;
}

/** `probe --replay`'s scorer, reduced to what the registry counts. */
function replayCanary(dir: string): Replay {
  const r = scoreRecording(readRecording(dir), claudeAdapter());
  return {
    cells: r.cells
      .filter((c) => !c.decoy)
      .map((c) => ({
        rule: c.predicted.rule,
        delivery: c.predicted.delivery,
        needsApproval: c.predicted.needsApproval === true,
        verdict: c.verdict,
      })),
    usable: r.trials.filter((t) => t.status === "usable").length,
    agent: r.manifest.agent,
    version: r.manifest.cliVersion,
    os: r.manifest.os.platform,
    date: r.manifest.startedAt.slice(0, 10),
    fault: r.instrument.fault,
  };
}

/** Every probe recording in the repository: a directory under test/recorded with a manifest.json. */
function canaryRecordings(): string[] {
  return readdirSync(path.join(ROOT, RECORDED))
    .filter((d) => existsSync(path.join(ROOT, RECORDED, d, "manifest.json")))
    .map((d) => `${RECORDED}/${d}`);
}

// Render and capture recordings get their replayer when the oracle lane's `verify --replay` is merged.
const REPLAYERS = { canary: { replay: replayCanary, all: canaryRecordings } };

const { doc, registry, problems } = loadAll(ROOT);
const ids = [...new Set([...doc.rules, ...doc.findings])].sort();

/** A deep copy of the registry with `change` applied to one entry. */
function withEntry(rule: string, change: (e: Record<string, unknown>) => void) {
  const copy = JSON.parse(JSON.stringify(registry));
  const e = copy.entries.find((x: { rule: string }) => x.rule === rule);
  if (!e) throw new Error(`no entry ${rule}`);
  change(e);
  return copy;
}

describe("docs/evidence.json", () => {
  it("parses, and every entry claims no more than its kind of evidence allows", () => {
    expect(problems).toEqual([]);
    expect(registry.entries.length).toBeGreaterThanOrEqual(ids.length);
  });

  it("reads 27 rule ids and 20 finding codes from docs/rules.md (the reader can find them)", () => {
    // If docs/rules.md gains ids, raise these; a reader that found none would pass the checks below vacuously.
    expect(doc.rules.length).toBeGreaterThanOrEqual(27);
    expect(doc.findings.length).toBeGreaterThanOrEqual(20);
    expect(doc.rules).toContain("codex.budget");
    expect(doc.findings).toContain("claude.agents-shadowed");
  });

  it("stays compatible with the shape branch v1/map-rules reads (rule, status, agent, date, confidence)", () => {
    for (const e of registry.entries) {
      expect(typeof e.rule).toBe("string");
      expect(["documented", "source", "observed", "contradicted"]).toContain(e.status);
      if (e.status === "observed" || e.status === "contradicted") {
        expect(typeof e.version).toBe("string");
        expect(e.n).toBeGreaterThan(0);
      }
    }
  });
});

describe("check 1: every rule id and finding code in docs/rules.md has an entry", () => {
  it("has no id without an entry", () => {
    expect(missingEntries(ids, registry)).toEqual([]);
  });

  it("trap: an id added to docs/rules.md with no entry is reported", () => {
    const planted = readFileSync(path.join(ROOT, "docs", "rules.md"), "utf8").replace(
      "| `codex.root` |",
      "| `codex.brand-new` | A new rule. | Docs. |\n| `codex.root` |",
    );
    const plantedIds = rulesDocIds(planted);
    expect(plantedIds.rules).toContain("codex.brand-new");
    expect(missingEntries([...plantedIds.rules, ...plantedIds.findings], registry)).toEqual(["codex.brand-new"]);
  });

  it("has no entry for an id docs/rules.md does not list, except the ids pending from v1/map-rules", () => {
    // Once v1/map-rules is merged, these ids are in docs/rules.md, this list is empty, and PENDING can go.
    const pending = PENDING.filter((id) => !ids.includes(id));
    expect(orphanEntries(ids, registry).sort()).toEqual(pending);
  });

  it("trap: an entry whose id docs/rules.md no longer lists (a renamed rule) is reported", () => {
    const renamed = ids.filter((id: string) => id !== "codex.root");
    expect(orphanEntries(renamed, registry)).toContain("codex.root");
  });
});

describe("check 2: every observed or contradicted entry replays to its fraction", () => {
  it("replays every recorded entry to its stated k/n, trials, version, OS and date", () => {
    const recorded = registry.entries.filter(
      (e: { status: string }) => e.status === "observed" || e.status === "contradicted",
    );
    // The seven entries the eight probe recordings back today; a reader that found none would pass vacuously.
    expect(recorded.length).toBeGreaterThanOrEqual(7);
    expect(replayMismatches(registry, REPLAYERS, ROOT)).toEqual([]);
  });

  it("claude.agents-default: 30 of 30 cells over 18 usable trials, counted here from the scorer", () => {
    const e = registry.entries.find((x: { rule: string }) => x.rule === "claude.agents-default");
    const runs = e.recording.map((d: string) => replayCanary(path.join(ROOT, d)));
    expect(countCells(runs, e)).toEqual({ k: 30, n: 30, trials: 18 });
    expect(`${e.status}@${e.version} ${e.k}/${e.n}`).toBe("observed@2.1.280 30/30");
  });

  it("trap: a stated fraction the recordings do not give is reported", () => {
    const planted = withEntry("claude.ancestors", (e) => (e.k = e.n = 15));
    expect(replayMismatches(planted, REPLAYERS, ROOT)).toContainEqual(
      "claude.ancestors: the recordings replay to 14/14, the entry says 15/15",
    );
  });

  it("trap: leaving out a run that disagrees is reported", () => {
    const planted = withEntry("claude.imports", (e) => {
      e.recording = ["test/recorded/nested-recall", "test/recorded/nested-task"];
      e.k = 4;
      e.n = 4;
      e.trials = 5;
      e.status = "observed";
    });
    const found = replayMismatches(planted, REPLAYERS, ROOT);
    expect(found).toContain(
      "claude.imports: test/recorded/ancestor-imports-recall has cells this entry counts but is not listed",
    );
    expect(found).toContain(
      "claude.imports: test/recorded/nested-api-recall has cells this entry counts but is not listed",
    );
  });

  it("trap: a version the recordings are not from is reported", () => {
    const planted = withEntry("claude.rules", (e) => {
      e.version = "2.1.285";
      e.confidence = "canary@2.1.285";
    });
    expect(replayMismatches(planted, REPLAYERS, ROOT)).toContainEqual(
      expect.stringMatching(
        /^claude\.rules: test\/recorded\/nested-recall is claude 2\.1\.280 on win32, the entry says claude 2\.1\.285/,
      ),
    );
  });

  it("trap: a recording that does not exist, and an instrument with no replayer, are reported", () => {
    const missing = withEntry("claude.subdirs", (e) => (e.recording = ["test/recorded/no-such-run"]));
    expect(replayMismatches(missing, REPLAYERS, ROOT)).toContain(
      "claude.subdirs: recording test/recorded/no-such-run does not exist",
    );
    const render = withEntry("claude.subdirs", (e) => (e.instrument = "render"));
    expect(replayMismatches(render, REPLAYERS, ROOT)).toContain(
      "claude.subdirs: no replayer for render recordings on this branch",
    );
  });

  it("trap: observed with a disagreeing cell, or run fields on a documented entry, fail validation", () => {
    const observedButNot = withEntry("claude.imports", (e) => (e.status = "observed"));
    expect(validateRegistry(observedButNot).problems).toContainEqual(
      expect.stringMatching(/^claude\.imports: observed needs every decided cell to agree/),
    );
    const counted = withEntry("claude.words", (e) => {
      e.k = 1;
      e.n = 1;
    });
    expect(validateRegistry(counted).problems).toContainEqual(
      expect.stringMatching(/^claude\.words: documented with run fields \(k, n\)/),
    );
    const sourceless = withEntry("codex.walk", (e) => (e.confidence = "docs@2026-09-28"));
    expect(validateRegistry(sourceless).problems).toContain(
      "codex.walk: source needs confidence source@<commit>, not docs@2026-09-28",
    );
  });
});

describe("check 3: README.md names no rule or finding whose status is not observed", () => {
  const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");

  it("the README passes", () => {
    expect(readmeViolations(readme, ids, registry)).toEqual([]);
  });

  it("the README's two mentions of unobserved rules are the ones that say they are not measured", () => {
    // The check lets a sentence name an unobserved rule only to say it is not measured.
    expect(readme).toMatch(/rule\s+`claude\.hook-blind`\)\s+is\s+not\s+measured/);
    expect(readme).toMatch(/rule\s+`claude\.symlink`\s+\(the\s+content\s+delivered\s+once\)\s+is\s+not\s+measured/);
  });

  it("trap: a trap named by a documented rule is reported, with its line", () => {
    const planted = readme.replace(
      "## Three ways instructions silently fail to arrive\n",
      "## Three ways instructions silently fail to arrive\n\nA CLAUDE.md that only mentions AGENTS.md hides it (rule `claude.words`).\n",
    );
    const found = readmeViolations(planted, ids, registry);
    expect(found.map((v: { id: string; status: string }) => [v.id, v.status])).toEqual([
      ["claude.words", "documented"],
    ]);
    expect(found[0].sentence).toBe("A CLAUDE.md that only mentions AGENTS.md hides it (rule `claude.words`).");
  });

  it("trap: a finding code of a contradicted rule, and an id with no entry, are reported", () => {
    const planted = `${readme}\n- Codex cuts the file (\`codex.cut\`), and \`claude.imports\` loads imports; see \`claude.nope\`.\n`;
    const found = readmeViolations(planted, [...ids, "claude.nope"], registry).map(
      (v: { id: string; status: string }) => `${v.id} ${v.status}`,
    );
    expect(found).toEqual(["codex.cut source", "claude.imports contradicted", "claude.nope no entry"]);
  });

  it("twin: an observed rule may be named", () => {
    const planted = `${readme}\nA personal CLAUDE.local.md switches AGENTS.md off (\`claude.agents-default\`, observed 30/30).\n`;
    expect(readmeViolations(planted, ids, registry)).toEqual([]);
  });

  it("a sentence that does not say it is not measured gets no pass from another sentence that does", () => {
    const planted = `${readme}\nThe symlink rule is not measured. The words rule, \`claude.words\`, hides AGENTS.md.\n`;
    expect(readmeViolations(planted, ids, registry).map((v: { id: string }) => v.id)).toEqual(["claude.words"]);
  });
});

describe("docs/evidence.md", () => {
  it("is what node scripts/evidence.mjs writes from docs/evidence.json", () => {
    const committed = readFileSync(path.join(ROOT, "docs", "evidence.md"), "utf8");
    expect(committed).toBe(renderEvidenceMd(registry, doc));
  });

  it("has one row per entry and a column for Claude Code 2.1.280 on win32", () => {
    const md = renderEvidenceMd(registry, doc);
    for (const e of registry.entries) expect(md).toContain(`| \`${e.rule}\` |`);
    expect(md).toContain("| Id | Kind | Status | Basis | claude 2.1.280 win32 |");
    expect(md).toContain("| `claude.imports` | rule | contradicted | docs@2026-09-28 | contradicted 6/10 |");
    expect(md).toContain("| `codex.cut` | rule + finding | source | source@c0d2694 | |");
  });

  it("--check exits 0 on the committed file and 1 on a stale copy", () => {
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(ROOT, "scripts", "evidence.mjs"), "--check", ...args], {
        cwd: ROOT,
        encoding: "utf8",
      });
    expect(run().status).toBe(0);
    const stale = path.join(tempDir("evidence-md"), "evidence.md");
    writeFileSync(stale, renderEvidenceMd(registry, doc).replace("observed 30/30", "observed 31/31"));
    const r = run("--against", stale);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/is stale: run node scripts\/evidence\.mjs/);
  });
});

describe("conformance flips (the nightly workflow's check)", () => {
  const record = (fixture: string, verdict: string, version = "0.159.2") => ({
    fixture,
    launchDir: ".",
    agent: "codex",
    version,
    os: "linux",
    date: "2026-10-01",
    predicted: "",
    observed: "",
    verdict,
    instrument: "render",
  });

  it("trap: a cell whose verdict changed on a new release is a flip", () => {
    const before = [record("codex-over-cap", "EXACT"), record("codex-utf8-cut", "EXACT")];
    const after = [record("codex-over-cap", "OFF BY 12", "0.160.0"), record("codex-utf8-cut", "EXACT", "0.160.0")];
    const r = flips(before, after);
    expect(r.changed.map((c: { after: { fixture: string } }) => c.after.fixture)).toEqual(["codex-over-cap"]);
  });

  it("twin: the same verdicts on a new version are no flip; added and removed cells are listed apart", () => {
    const before = [record("codex-over-cap", "EXACT"), record("gone", "EXACT")];
    const after = [record("codex-over-cap", "EXACT", "0.160.0"), record("new", "EXACT", "0.160.0")];
    const r = flips(before, after);
    expect(r.changed).toEqual([]);
    expect(r.added.map((x: { fixture: string }) => x.fixture)).toEqual(["new"]);
    expect(r.removed.map((x: { fixture: string }) => x.fixture)).toEqual(["gone"]);
  });

  it("reads an array or { records }, and refuses a record without a verdict", () => {
    expect(readResults({ records: [record("a", "EXACT")] })).toHaveLength(1);
    expect(() => readResults([{ fixture: "a" }])).toThrow(/record 0/);
  });

  it("the command exits 1 on a flip and 0 without one", () => {
    const dir = tempDir("flips");
    const write = (name: string, data: unknown) => {
      const f = path.join(dir, name);
      writeFileSync(f, JSON.stringify(data));
      return f;
    };
    const old = write("old.json", [record("codex-over-cap", "EXACT")]);
    const same = write("same.json", [record("codex-over-cap", "EXACT", "0.160.0")]);
    const flipped = write("flipped.json", [record("codex-over-cap", "OFF BY 1", "0.160.0")]);
    const run = (current: string) =>
      spawnSync(
        process.execPath,
        [
          path.join(ROOT, "scripts", "evidence.mjs"),
          "flips",
          "--previous",
          old,
          "--current",
          current,
          "--column",
          "latest",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
    expect(run(same).status).toBe(0);
    const r = run(flipped);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      "| codex (render) | linux | codex-over-cap | . | EXACT (0.159.2) | OFF BY 1 (0.160.0) |",
    );
  });
});

describe("scripts/evidence.mjs plant", () => {
  it("each plant's text occurs exactly once, so each plant can apply", () => {
    expect(plantOccurrences().filter((o: { count: number }) => o.count !== 1)).toEqual([]);
    expect(PLANTS.length).toBeGreaterThanOrEqual(10);
  });
});
