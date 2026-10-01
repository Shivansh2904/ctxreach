// The results site, the write-up and the launch material.
//
// The rule these tests hold: no number is typed into the page or a template.
// Every digit the page shows sits in an element that names the data file and
// JSON pointer it came from (data-src) and the format it was printed in
// (data-fmt); the test re-reads that value and re-formats it with its own
// formatters (written here from the format list, not imported from the page),
// so a hand-typed number, a wrong field or a formatter that drifts all fail.
// Digits that are part of an identifier (K1, H1b, v1, sha256,
// owner/repo#123) are allowed in prose; nothing else is.
//
// CTXR_SITE_ROOT points every file read at another copy of the repository's
// site files: scripts/plant-site-faults.mjs plants one fault per copy and
// checks that a test here fails.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterAll, describe, expect, it } from "vitest";
import { createCli } from "../src/program.js";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = process.env.CTXR_SITE_ROOT ? path.resolve(process.env.CTXR_SITE_ROOT) : REPO;
const SAMPLE = path.join(ROOT, "test", "site-sample", "data");
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(label: string): string {
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), `ctxreach-site-${label}-`)));
  tmpDirs.push(d);
  return d;
}

type Files = Record<string, unknown>;
interface Core {
  RESULTS: string;
  CELLS: string;
  PROV: string;
  CONFORMANCE_FILES: string[];
  SECTION_ORDER: string[];
  renderSite(data: { files: Files }): { html: string; state: { sample: boolean; pilot: boolean; none: boolean } };
  renderTemplate(template: string, data: { files: Files }, mode: string): { text: string; state: { sample: boolean } };
}

const indexHtml = () => readFileSync(path.join(ROOT, "site", "index.html"), "utf8");

function loadCore(): Core {
  const m = /<script id="ctxr-core">([\s\S]*?)<\/script>/.exec(indexHtml());
  if (!m) throw new Error("no ctxr-core script");
  const sandbox: { ctxrCore?: Core } = {};
  vm.createContext(sandbox);
  vm.runInContext(m[1]!, sandbox);
  return sandbox.ctxrCore!;
}

function loadDir(dir: string): Files {
  const files: Files = {};
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.name.endsWith(".json")) files[r] = JSON.parse(readFileSync(path.join(d, e.name), "utf8"));
    }
  };
  walk(dir, "");
  return files;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ---- the independent formatters ---------------------------------------------

const group = (x: number) => String(Math.trunc(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
type Rec = Record<string, unknown> & { k: number; n: number; p: number; lo: number; hi: number };
const EXPECT: Record<string, (v: unknown) => string> = {
  int: (v) => group(v as number),
  text: (v) => String(v),
  date: (v) => String(v).slice(0, 10),
  datetime: (v) => `${String(v).slice(0, 10)} ${String(v).slice(11, 16)} UTC`,
  pct: (v) => pct(v as number),
  frac: (v) => `${group((v as Rec).k)}/${group((v as Rec).n)}`,
  wilson: (v) => {
    const w = v as Rec;
    return w.n === 0
      ? `${group(w.k)}/${group(w.n)} (no eligible units)`
      : `${group(w.k)}/${group(w.n)} (${pct(w.p)}, [${pct(w.lo)}, ${pct(w.hi)}])`;
  },
  arm: (v) => {
    const w = v as Rec;
    return w.n === 0 ? `${group(w.k)}/${group(w.n)}` : `${group(w.k)}/${group(w.n)} [${pct(w.lo)}, ${pct(w.hi)}]`;
  },
  absent: (v) => `${group((v as Rec).n - (v as Rec).k)}/${group((v as Rec).n)}`,
  sha12: (v) => String(v).slice(0, 12),
  len: (v) => group((v as unknown[]).length),
  agree: (v) => {
    const cells = v as { verdict: string }[];
    const agree = cells.filter((c) => ["confirmed", "discovered"].includes(c.verdict)).length;
    const decided = cells.filter((c) => ["confirmed", "discovered", "missed", "extra"].includes(c.verdict)).length;
    return `${group(agree)}/${group(decided)}`;
  },
  bytes: (v) => {
    const all = Object.values(v as Record<string, { verdict: string }>);
    return `${group(all.filter((b) => b.verdict === "EXACT").length)}/${group(all.length)}`;
  },
};

function resolve(files: Files, src: string): { value: unknown; last: string; file: string } {
  const at = src.indexOf("#");
  const file = src.slice(0, at);
  const segs = src
    .slice(at + 1)
    .split("/")
    .slice(1)
    .filter((s, _i, a) => !(a.length === 1 && s === ""))
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (!(file in files)) throw new Error(`${src}: no such data file`);
  let v: unknown = files[file];
  for (const s of segs) {
    if (v === null || typeof v !== "object" || !(s in (v as object))) throw new Error(`${src}: no such field`);
    v = (v as Record<string, unknown>)[s];
  }
  return { value: v, last: segs.at(-1) ?? "", file };
}

function expected(files: Files, src: string, fmt: string): string {
  const { value, last, file } = resolve(files, src);
  if (fmt === "key") return last;
  if (fmt === "file") return file;
  const f = EXPECT[fmt];
  if (!f) throw new Error(`${src}: unknown format ${fmt}`);
  return f(value);
}

/** Digit runs that are not part of an identifier (K1, H1b, v1, sha256, SHA-256, owner/repo#123). */
export function untracedDigits(text: string): string[] {
  const masked = text
    .replace(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/g, (m) => m.replace(/\d/g, "x"))
    .replace(/\b(?:SHA-256|UTF-8)\b/g, "x");
  const bad: string[] = [];
  for (const m of masked.matchAll(/\d+/g)) {
    const before = masked[m.index! - 1] ?? "";
    if (/[A-Za-z_]/.test(before)) continue;
    bad.push(masked.slice(Math.max(0, m.index! - 20), m.index! + m[0].length + 20).replace(/\s+/g, " "));
  }
  return bad;
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const VOID = new Set(["br", "meta", "link", "img", "hr", "input", "source", "wbr"]);
const TEXT_ATTRS = ["title", "alt", "aria-label", "placeholder", "value"];

/**
 * Walk HTML (as this page writes it) and report every problem: digits outside
 * a traced span or in a text-bearing attribute, and traced spans whose text
 * is not the formatted value at their source.
 */
export function traceHtml(html: string, files: Files): { problems: string[]; traced: number } {
  const problems: string[] = [];
  let traced = 0;
  const stack: { tag: string; src?: string; fmt?: string; text: string }[] = [];
  const inSkipped = () => stack.some((e) => e.tag === "script" || e.tag === "style");
  // Script and style bodies are not rendered text, and their own "<" would confuse the walk.
  html = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  for (const m of html.matchAll(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g)) {
    const tok = m[0];
    if (tok.startsWith("<!--")) continue;
    if (tok.startsWith("</")) {
      const tag = tok.slice(2, -1).trim().toLowerCase();
      while (stack.length) {
        const e = stack.pop()!;
        if (e.src !== undefined) {
          traced++;
          let want: string;
          try {
            want = expected(files, e.src, e.fmt ?? "");
          } catch (err) {
            problems.push((err as Error).message);
            continue;
          }
          if (e.text !== want) problems.push(`${e.src} (${e.fmt}) shows "${e.text}", the data gives "${want}"`);
        }
        if (e.tag === tag) break;
      }
      continue;
    }
    if (tok.startsWith("<")) {
      const tm = /^<([a-zA-Z0-9]+)/.exec(tok);
      if (!tm) continue;
      const tag = tm[1]!.toLowerCase();
      const attrs: Record<string, string> = {};
      for (const a of tok.matchAll(/([a-zA-Z-:]+)="([^"]*)"/g)) attrs[a[1]!.toLowerCase()] = decode(a[2]!);
      if (!inSkipped()) {
        for (const name of TEXT_ATTRS)
          if (attrs[name] !== undefined)
            for (const d of untracedDigits(attrs[name]!)) problems.push(`untraced number in ${tag}[${name}]: ${d}`);
        if (
          tag === "meta" &&
          attrs.content !== undefined &&
          (attrs.name === "description" || attrs.property?.startsWith("og:"))
        )
          for (const d of untracedDigits(attrs.content)) problems.push(`untraced number in meta content: ${d}`);
      }
      if (stack.some((e) => e.src !== undefined) && !inSkipped())
        problems.push(`an element inside a traced span: ${tok.slice(0, 60)}`);
      if (VOID.has(tag) || tok.endsWith("/>")) continue;
      stack.push({ tag, src: attrs["data-src"], fmt: attrs["data-fmt"], text: "" });
      continue;
    }
    if (inSkipped()) continue;
    const text = decode(tok);
    const span = [...stack].reverse().find((e) => e.src !== undefined);
    if (span) span.text += text;
    else for (const d of untracedDigits(text)) problems.push(`untraced number: ${d}`);
  }
  return { problems, traced };
}

/** The same check for traced Markdown (writeup.mjs --traced): markers are ⟦src|fmt⟧text⟦/⟧. */
export function traceMarkdown(md: string, files: Files): { problems: string[]; traced: number } {
  const problems: string[] = [];
  let traced = 0;
  const rest = md.replace(/⟦([^|⟧]+)\|([a-z0-9]+)⟧([\s\S]*?)⟦\/⟧/g, (_m, src, fmt, text) => {
    traced++;
    try {
      const want = expected(files, src, fmt);
      if (text !== want) problems.push(`${src} (${fmt}) shows "${text}", the data gives "${want}"`);
    } catch (err) {
      problems.push((err as Error).message);
    }
    return " ";
  });
  if (/[⟦⟧]/.test(rest)) problems.push("a broken trace marker");
  for (const d of untracedDigits(rest)) problems.push(`untraced number: ${d}`);
  return { problems, traced };
}

const sampleFiles = () => loadDir(SAMPLE);
const core = loadCore();

/** The sample relabelled as study data, so the banner logic can be checked both ways. */
function asStudy(files: Files): Files {
  const f = clone(files) as Record<string, Record<string, unknown>>;
  f["results.json"]!.label = "study";
  f["cells-results.json"]!.dryRun = false;
  f["provenance.json"]!.label = "study";
  for (const k of Object.keys(f))
    if (k.startsWith("conformance/")) for (const r of f[k]!.records as Record<string, unknown>[]) r.version = "1.2.3";
  return f;
}

function idsInOrder(html: string): string[] {
  return [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]!);
}

describe("the results page shell", () => {
  it("has no number typed into it outside its scripts and styles", () => {
    const { problems } = traceHtml(indexHtml(), {});
    expect(problems).toEqual([]);
  });

  it("loads nothing from another site: no external script, stylesheet, font or import", () => {
    const html = indexHtml();
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+rel="?stylesheet/i);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
    const boot = /<script id="ctxr-boot">([\s\S]*?)<\/script>/.exec(html)![1]!;
    expect([...boot.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]!.trim())).toEqual(['"data/" + name']);
  });

  it("defines its colours as tokens for light, dark and an explicit theme, and fits a phone", () => {
    const html = indexHtml();
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1/);
    expect(style).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*:root:not\(\[data-theme="light"\]\)/);
    expect(style).toMatch(/:root\[data-theme="dark"\]\s*{/);
    expect(style).toMatch(/body\s*{[^}]*background: var\(--paper\)/);
    expect(style).toMatch(/\.table-wrap\s*{[^}]*overflow-x: auto/);
    // A grid item's min-width defaults to its content: without this a wide table widens the whole page on a phone.
    expect(style).toMatch(/section > \*,\s*article > \*,\s*details > \*\s*{\s*min-width: 0;/);
    expect(style).toMatch(/padding-inline: 16px/);
  });
});

describe("the results page, rendered from the sample data", () => {
  const files = sampleFiles();
  const { html, state } = core.renderSite({ files });

  it("prints every number from a data field, in the format it names", () => {
    const { problems, traced } = traceHtml(html, files);
    expect(problems).toEqual([]);
    // The check read real spans: the sample has hundreds of figures.
    expect(traced).toBeGreaterThan(300);
  });

  it("would notice a typed number, a wrong value and a wrong field", () => {
    const typed = traceHtml(html.replace("</section>", "<p>in 12 runs</p></section>"), files).problems;
    expect(typed.some((p) => p.includes("untraced number") && p.includes("12"))).toBe(true);
    const span = /<span class="n" data-src="results\.json#\/outcomes\/0" data-fmt="wilson">([^<]+)<\/span>/.exec(html)!;
    const altered = html.replace(
      span[0],
      span[0].replace(
        span[1]!,
        span[1]!.replace(/\d/, (d) => String((+d + 1) % 10)),
      ),
    );
    expect(traceHtml(altered, files).problems.some((p) => p.includes("results.json#/outcomes/0"))).toBe(true);
    const moved = html.replace(span[0], span[0].replace("outcomes/0", "outcomes/1"));
    expect(traceHtml(moved, files).problems.length).toBeGreaterThan(0);
  });

  it("says the data is a sample, at the top, when any file is sample, a dry run or unlabelled", () => {
    expect(state.sample).toBe(true);
    expect(html.startsWith('<div class="banner banner-sample" role="note" id="data-banner">')).toBe(true);
    expect(html).toContain("SAMPLE DATA, NOT RESULTS.");
    const study = asStudy(files);
    const clean = core.renderSite({ files: study });
    expect(clean.state.sample).toBe(false);
    expect(clean.html).not.toContain("data-banner");
    for (const [file, mutate] of [
      ["results.json", (r: Record<string, unknown>) => delete r.label],
      ["cells-results.json", (r: Record<string, unknown>) => (r.dryRun = true)],
      ["provenance.json", (r: Record<string, unknown>) => (r.label = "sample")],
    ] as const) {
      const one = clone(study) as Record<string, Record<string, unknown>>;
      mutate(one[file]!);
      const out = core.renderSite({ files: one });
      expect(out.html, file).toContain("SAMPLE DATA, NOT RESULTS.");
      expect(traceHtml(out.html, one).problems).toEqual([]);
    }
    const pilot = clone(study) as Record<string, Record<string, unknown>>;
    pilot["results.json"]!.label = "pilot";
    expect(core.renderSite({ files: pilot }).html).toContain("PILOT DATA.");
  });

  it("puts the instrument checks before every result they support", () => {
    const order = idsInOrder(html);
    expect(order).toEqual(core.SECTION_ORDER);
    expect(order.indexOf("checks")).toBeLessThan(order.indexOf("matrix"));
    expect(order.indexOf("checks")).toBeLessThan(order.indexOf("census"));
    expect(order.indexOf("checks")).toBeLessThan(order.indexOf("prereg-vs-found"));
  });

  it("gives every finding a unique permalink anchor", () => {
    const findings = [...html.matchAll(/<(\w+) class="[^"]*\bfinding\b[^"]*" id="([^"]+)"/g)].map((m) => m[2]!);
    expect(new Set(findings).size).toBe(findings.length);
    for (const id of findings) expect(html, id).toContain(`<a class="anchor" href="#${id}"`);
    for (const id of [
      "headline-sentence",
      "h1",
      "h1b",
      "h2",
      "h3-pairs",
      "h3-repos",
      "k1",
      "k2",
      "k3",
      "k4",
      "k5",
      "k6",
      "k7",
      "k8",
      "k9",
      "k10",
      "cell-b2",
      "cell-b2-a1-agents",
      "s-main-o1-content",
      "s-imp-o2",
      "frame-s-main",
      "conf-codex-codex-over-cap-root",
    ])
      expect(findings, id).toContain(id);
  });

  it("fills the registered headline from the registered outcomes and cell arms", () => {
    const sentence = /<p class="lede finding" id="headline-sentence">([\s\S]*?)<\/p>/.exec(html)![1]!;
    const srcs = [...sentence.matchAll(/data-src="([^"]+)" data-fmt="([^"]+)"/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(srcs.map(([, f]) => f)).toEqual(["wilson", "frac", "absent", "absent"]);
    const at = (src: string) => resolve(files, src).value as Record<string, unknown>;
    expect(at(srcs[0]![0])).toMatchObject({ id: "O1-content", frame: "S-main", variant: "raw" });
    expect(at(srcs[1]![0])).toMatchObject({ id: "P1-pairs", frame: "S-main", variant: "raw" });
    expect(srcs[2]![0]).toMatch(/^cells-results\.json#\/results\/\d+\/arms\/A1\/observe\/agents$/);
    expect(srcs[3]![0]).toMatch(/^cells-results\.json#\/results\/\d+\/arms\/A2\/observe\/agents$/);
    expect(resolve(files, srcs[2]![0].replace(/\/arms.*/, "")).value).toMatchObject({ cell: "B2" });
    expect(sentence).toContain("depending only on where the repository lives");
    // Not confirmed: the fractions stay, the claim goes, the verdict is printed.
    const f = clone(files) as Record<string, { results: { cell: string; verdict: string }[] }>;
    f["cells-results.json"]!.results.find((r) => r.cell === "B2")!.verdict = "inconclusive";
    const other = core.renderSite({ files: f as Files }).html;
    const s2 = /id="headline-sentence">([\s\S]*?)<\/p>/.exec(other)![1]!;
    expect(s2).not.toContain("depending only on where the repository lives");
    expect(s2).toContain("cell B2: inconclusive");
  });

  it("names no repository, though the data lists some", () => {
    const names = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          if (k === "repo" && typeof x === "string" && x.includes("/")) names.add(x);
          walk(x);
        }
    };
    walk(files["results.json"]);
    expect(names.size).toBeGreaterThan(0);
    for (const n of names) expect(html).not.toContain(n);
  });

  it("puts every table in its own horizontal scroller", () => {
    const tables = [...html.matchAll(/<table>/g)].length;
    const wrapped = [...html.matchAll(/<div class="table-wrap"><table>/g)].length;
    expect(tables).toBeGreaterThan(5);
    expect(wrapped).toBe(tables);
  });
});

describe("the results page with no data yet", () => {
  it("shows no number, no banner, and says the study has not run", () => {
    const { html, state } = core.renderSite({ files: {} });
    expect(state.none).toBe(true);
    expect(traceHtml(html, {}).problems).toEqual([]);
    expect(html).not.toContain("data-banner");
    expect(html).toContain("No study results are published yet");
    expect(html).toContain("k/n (x%, [lo, hi])");
  });
});

describe("site/data", () => {
  it("never holds sample, dry-run or fake data", () => {
    const dir = path.join(ROOT, "site", "data");
    if (!existsSync(dir)) return;
    const files = loadDir(dir);
    const state = core.renderSite({ files }).state;
    expect(state.sample).toBe(false);
  });

  it("the sample is labelled as a sample in every file", () => {
    const files = sampleFiles() as Record<string, Record<string, unknown>>;
    expect(files["results.json"]!.label).toBe("sample");
    expect(files["cells-results.json"]!.dryRun).toBe(true);
    expect(files["provenance.json"]!.label).toBe("sample");
    const conf = Object.keys(files).filter((k) => k.startsWith("conformance/"));
    expect(conf.length).toBeGreaterThan(0);
    for (const k of conf)
      for (const r of files[k]!.records as { version: string }[]) expect(r.version, k).toMatch(/sample/);
  });

  it("the sample has the study's own schemas", () => {
    const files = sampleFiles() as Record<string, Record<string, unknown>>;
    expect(Object.keys(files["results.json"]!)).toEqual([
      "schema",
      "label",
      "generatedAt",
      "inputs",
      "frames",
      "hypotheses",
      "outcomes",
      "checks",
      "wording",
    ]);
    expect(files["results.json"]!.schema).toBe("ctxreach.study-results/v1");
    expect(files["cells-results.json"]!.schema).toBe("ctxreach.study-cell-results/v1");
    expect(files["provenance.json"]!.schema).toBe("ctxreach.site-provenance/v1");
    for (const k of Object.keys(files).filter((x) => x.startsWith("conformance/")))
      expect(files[k]!.schema).toBe("ctxreach.conformance/v1");
  });

  const study = path.join(ROOT, "study", "census", "analyze.mjs");
  it.skipIf(!existsSync(study))(
    "the sample is what the study's own analysis makes of the invented rows today",
    async () => {
      const out = tmp("sample");
      const { makeSample } = await import(
        pathToFileURL(path.join(ROOT, "test", "site-sample", "make-sample.mjs")).href
      );
      await makeSample({ study: ROOT, out });
      const now = loadDir(out) as Record<string, Record<string, unknown>>;
      const kept = sampleFiles() as Record<string, Record<string, unknown>>;
      const strip = (r: Record<string, unknown>) => ({ ...r, generatedAt: null });
      expect(strip(now["results.json"]!)).toEqual(strip(kept["results.json"]!));
      expect((now["cells-results.json"]!.results as unknown[]).length).toBe(
        (kept["cells-results.json"]!.results as unknown[]).length,
      );
      expect(now["cells-results.json"]!.results).toEqual(kept["cells-results.json"]!.results);
    },
    120_000,
  );
});

describe("the write-up and the other templates", () => {
  const writeupModule = () => import(pathToFileURL(path.join(ROOT, "scripts", "writeup.mjs")).href);
  const files = sampleFiles();

  it("prints every number in the write-up from a data field, and stays under a thousand words", async () => {
    const { render } = await writeupModule();
    const traced = render({ root: ROOT, dataDir: SAMPLE, format: "md", traced: true });
    const { problems, traced: count } = traceMarkdown(traced.text, files);
    expect(problems).toEqual([]);
    expect(count).toBeGreaterThan(20);
    expect(traced.words).toBeLessThan(1000);
    expect(traced.text).toContain("SAMPLE DATA, NOT RESULTS.");
  });

  it("the published forms carry the same numbers as the traced one, and nothing else", async () => {
    const { render } = await writeupModule();
    const traced = render({ root: ROOT, dataDir: SAMPLE, format: "md", traced: true }).text as string;
    const plain = render({ root: ROOT, dataDir: SAMPLE, format: "md" }).text as string;
    const html = render({ root: ROOT, dataDir: SAMPLE, format: "html" }).text as string;
    const unmark = traced.replace(/⟦[^⟧]*⟧/g, "");
    expect(plain).toBe(unmark);
    const body = /<main>([\s\S]*)<\/main>/.exec(html)![1]!;
    const digits = (s: string) => [...s.matchAll(/\d+/g)].map((m) => m[0]).sort();
    expect(digits(decode(body.replace(/<[^>]+>/g, " ")))).toEqual(digits(plain));
    expect(html).toContain("SAMPLE DATA, NOT RESULTS.");
  });

  for (const rel of ["site/writeup.template.md", "talk/slides.md", "site/readme-first-screen.md"]) {
    it(`${rel}: types no number outside a slot, and every slot exists`, async () => {
      const text = readFileSync(path.join(ROOT, rel), "utf8");
      const body = text.replace(/<!--[\s\S]*?-->/g, "").replace(/\{\{\s*[A-Za-z0-9]+\s*\}\}/g, " ");
      expect(untracedDigits(body)).toEqual([]);
      const { render } = await writeupModule();
      const out = render({ root: ROOT, template: path.join(ROOT, rel), dataDir: SAMPLE, format: "md", traced: true });
      expect(traceMarkdown(out.text, files).problems).toEqual([]);
    });
  }

  it("the talk and the workshop type no result: no fraction or percentage outside a slot", () => {
    const docs = ["talk", "workshop"].flatMap((d) =>
      readdirSync(path.join(ROOT, d))
        .filter((f) => f.endsWith(".md"))
        .map((f) => `${d}/${f}`),
    );
    expect(docs.length).toBeGreaterThanOrEqual(5);
    for (const rel of docs) {
      const body = readFileSync(path.join(ROOT, rel), "utf8")
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/\{\{\s*[A-Za-z0-9]+\s*\}\}/g, " ");
      const shaped = [...body.matchAll(/\d+\s*\/\s*\d+|\d+(?:\.\d+)?\s*%/g)].map((m) => m[0]);
      expect(shaped, rel).toEqual([]);
    }
  });

  it("an unknown slot is an error, not a blank", async () => {
    const { render } = await writeupModule();
    const dir = tmp("tpl");
    const t = path.join(dir, "t.md");
    writeFileSync(t, "# {{title}}\n\n{{noSuchSlot}}\n");
    expect(() => render({ root: ROOT, template: t, dataDir: SAMPLE })).toThrow(/noSuchSlot/);
  });
});

describe("the README demo cast", () => {
  const castFile = path.join(ROOT, "docs", "demo.cast");
  const sidecar = JSON.parse(readFileSync(`${castFile}.json`, "utf8"));
  const cast = readFileSync(castFile, "utf8");
  const lines = cast.split("\n").filter(Boolean);

  it("is asciicast v2 and labels itself in its title and its first typed line", async () => {
    const header = JSON.parse(lines[0]!);
    expect(header).toMatchObject({ version: 2, width: 120 });
    expect(header.title).toContain(sidecar.label);
    expect(sidecar.label).toBe(
      `typing simulated, output verbatim from ctxreach ${sidecar.ctxreach.version} (${sidecar.ctxreach.commit}) on ${sidecar.date}`,
    );
    const events = lines.slice(1).map((l) => JSON.parse(l) as [number, string, string]);
    const typed = events
      .slice(
        0,
        events.findIndex((e) => e[2] === "\r\n"),
      )
      .map((e) => e[2])
      .join("");
    expect(typed).toBe(`$ # ${sidecar.label}`);
    for (let i = 1; i < events.length; i++) expect(events[i]![0]).toBeGreaterThanOrEqual(events[i - 1]![0]);
  });

  it("shows exactly the output make-cast.mjs captured", async () => {
    const { outputOfCast } = await import(pathToFileURL(path.join(ROOT, "scripts", "make-cast.mjs")).href);
    const out = outputOfCast(cast) as string;
    expect(createHash("sha256").update(out).digest("hex")).toBe(sidecar.outputSha256);
  });

  it("is still what this build of map prints for the demo (else: re-run node scripts/make-cast.mjs)", async () => {
    const { outputOfCast } = await import(pathToFileURL(path.join(ROOT, "scripts", "make-cast.mjs")).href);
    // eslint-disable-next-line no-control-regex
    const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r\n/g, "\n");
    const home = tmp("cast");
    cpSync(path.join(ROOT, "examples", "demo-monorepo"), path.join(home, "demo"), { recursive: true });
    mkdirSync(path.join(home, "demo", ".git"));
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME };
    let stdout = "";
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      delete process.env.CODEX_HOME;
      const cli = createCli({ stdout: (t) => (stdout += t), stderr: () => {} }, { exitOverride: true });
      await cli.program.parseAsync(["node", "ctxreach", "map", "--from", path.join(home, "demo", "packages", "api")]);
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    expect(strip(stdout)).toBe(strip(outputOfCast(cast)));
  });
});

describe("scripts/site-data.mjs", () => {
  const mod = () => import(pathToFileURL(path.join(ROOT, "scripts", "site-data.mjs")).href);

  it("copies each check from the output that holds it", async () => {
    const { readK1, readK2, readK6, readTrials, readRun } = await mod();
    expect(
      readK1({ k: 38, n: 39, results: [{ name: "a" }, { name: "b", knownDefect: "awaiting L1" }], orphans: [] }),
    ).toEqual({ k: 38, n: 39, knownDefects: ["b"], orphans: 0 });
    expect(readK2("x\nK2: 16/16 planted faults caught by K1\n")).toEqual({ k: 16, n: 16 });
    expect(() => readK2("K2: all caught")).toThrow(/K2/);
    expect(readK6({ n: 30, agree: 27, claudeAgree: 29, codexAgree: 28, disagreements: [{}, {}, {}] })).toEqual({
      pairs: { k: 27, n: 30 },
      claude: { k: 29, n: 30 },
      codex: { k: 28, n: 30 },
      disagreements: 3,
    });
    const trials = [
      { warmup: true, status: "usable", reasons: [], os: "w", date: "2026-01-01T00:00:00Z" },
      {
        status: "usable",
        reasons: [],
        init: { version: "2.1.285", model: "m" },
        os: "w",
        date: "2026-01-02T00:00:00Z",
      },
      { status: "void", reasons: ["decoy seen", "model x, not the pinned m"], init: { version: "2.1.285" }, os: "w" },
      { status: "void", reasons: ["model y, not the pinned m"], os: "w", date: "2026-01-03T00:00:00Z" },
    ]
      .map((t) => JSON.stringify(t))
      .join("\n");
    expect(readTrials(trials)).toMatchObject({
      trials: 3,
      usable: 1,
      void: 2,
      voidReasons: { "decoy seen": 1, "model is not the pinned one": 2 },
      agentVersions: ["2.1.285"],
      os: ["w"],
      firstTrial: "2026-01-02T00:00:00Z",
      lastTrial: "2026-01-03T00:00:00Z",
      dryRun: false,
    });
    expect(() => readRun({ schema: "other" })).toThrow(/study-run/);
  });

  it("refuses to call sample or dry-run inputs study data", async () => {
    const { assemble } = await mod();
    const fake: Record<string, string> = {
      "run.json": JSON.stringify({ schema: "ctxreach.study-run/v1", label: "pilot", frame: "S-main", client: {} }),
      "trials.jsonl": JSON.stringify({ status: "usable", reasons: [], dryRun: true }),
    };
    const read = (f: string) => Buffer.from(fake[path.basename(f)]!);
    expect(() => assemble({ label: "study", out: "x/data/p.json", runs: ["run.json"] }, read)).toThrow(
      /labelled otherwise/,
    );
    expect(() => assemble({ label: "study", out: "x/data/p.json", runs: [], trials: "trials.jsonl" }, read)).toThrow(
      /dry run/,
    );
    const doc = assemble({ label: "pilot", out: "x/data/p.json", runs: ["run.json"] }, read);
    expect(doc.sources).toEqual([
      { arg: "--run", file: "run.json", sha256: createHash("sha256").update(fake["run.json"]!).digest("hex") },
    ]);
  });

  it("reads the pre-registration tag from git: commit, seed and the file's SHA-256", async () => {
    const { readPrereg } = await mod();
    const dir = tmp("git");
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith("GIT_"))),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    };
    const g = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8" });
    g("init", "-q", "--template=");
    mkdirSync(path.join(dir, "study"));
    writeFileSync(path.join(dir, "study", "PREREG.md"), "registered\n");
    g("add", "-A");
    g("commit", "-q", "-m", "prereg");
    g("tag", "prereg-v1");
    const commit = g("rev-parse", "HEAD").trim();
    expect(readPrereg(dir, "prereg-v1")).toEqual({
      tag: "prereg-v1",
      commit,
      seed: commit.slice(0, 8),
      preregSha256: createHash("sha256").update("registered\n").digest("hex"),
    });
  });
});
