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
import { map } from "../src/map/map.js";
import { renderTerminal } from "../src/report/terminal.js";

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
/** The page shell's style sheets, which also style everything the core renders into it. */
const shellCss = () => [...indexHtml().matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).join("\n");

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
/**
 * Attributes a reader never sees: addresses, names for code and the trace
 * itself. Every other attribute is checked like text (title, alt, aria-*,
 * data-*, value, ...), and so is any attribute the CSS prints with attr().
 */
const NOT_SHOWN = new Set([
  "href",
  "src",
  "id",
  "class",
  "style",
  "data-src",
  "data-fmt",
  "colspan",
  "rowspan",
  "scope",
  "lang",
  "charset",
  "rel",
  "type",
  "role",
  "name",
  "property",
  "content",
  "http-equiv",
  "for",
  "headers",
  "target",
  "aria-labelledby",
  "aria-describedby",
  "aria-controls",
  "aria-live",
  "aria-hidden",
]);
const SHOWN_META = /^(?:description|keywords|author|application-name|og:.*|twitter:.*)$/;

/** Every attribute of a start tag, whatever its quoting. */
export function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = tag.replace(/^<[^\s/>]+/, "").replace(/\/?>$/, "");
  for (const a of body.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))
    attrs[a[1]!.toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
  return attrs;
}

const cssUnescape = (s: string) =>
  s
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\\n/g, "")
    .replace(/\\(.)/g, "$1");

/**
 * What CSS can print on the page: the strings in `content`, `quotes` and
 * `list-style(-type)` values (escapes decoded), the attributes `attr()` prints,
 * and whether `counter()` or `counters()` prints a number of its own.
 */
export function cssPrinted(css: string): { strings: string[]; attrs: string[]; counters: string[] } {
  const out = { strings: [] as string[], attrs: [] as string[], counters: [] as string[] };
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const value = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^;}"'])*/.source;
  const decl = new RegExp(`(?:^|[{;\\s])(content|quotes|list-style-type|list-style)\\s*:(${value})`, "gi");
  for (const d of clean.matchAll(decl)) {
    for (const s of d[2]!.matchAll(/"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'/g))
      out.strings.push(cssUnescape(s[1] ?? s[2] ?? ""));
    for (const a of d[2]!.matchAll(/\battr\(\s*([^\s,)]+)/gi)) out.attrs.push(a[1]!.toLowerCase());
  }
  for (const c of clean.matchAll(/\bcounters?\([^)]*\)/gi)) out.counters.push(c[0]);
  return out;
}

/**
 * Walk HTML (as this page writes it) and report every problem: digits outside
 * a traced span, in an attribute a reader can see, or printed by CSS
 * (generated content, attr(), counters), and traced spans whose text is not
 * the formatted value at their source. `css` adds the style sheets that will
 * apply to this HTML (the page shell's, for HTML the core renders into it).
 */
export function traceHtml(html: string, files: Files, css = ""): { problems: string[]; traced: number } {
  const problems: string[] = [];
  let traced = 0;
  const stack: { tag: string; src?: string; fmt?: string; text: string }[] = [];
  const inSkipped = () => stack.some((e) => e.tag === "script" || e.tag === "style");
  const sheets = [css, ...[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!)];
  const printedAttrs = new Set<string>();
  const checkCss = (where: string, text: string) => {
    const printed = cssPrinted(text);
    for (const s of printed.strings)
      for (const d of untracedDigits(s)) problems.push(`untraced number in ${where} generated content: ${d}`);
    for (const c of printed.counters) problems.push(`untraced number in ${where}: ${c} prints a count of its own`);
    for (const a of printed.attrs) printedAttrs.add(a);
  };
  for (const sheet of sheets) checkCss("CSS", sheet);
  // Script and style bodies are not rendered text, and their own "<" would confuse the walk.
  html = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  for (const t of html.matchAll(/<[a-zA-Z][^>]*>/g)) {
    const style = attributes(t[0]).style;
    if (style !== undefined) checkCss("a style attribute's", style);
  }
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
      const attrs = attributes(tok);
      if (!inSkipped()) {
        for (const [name, value] of Object.entries(attrs))
          if (!NOT_SHOWN.has(name) || printedAttrs.has(name))
            for (const d of untracedDigits(value)) problems.push(`untraced number in ${tag}[${name}]: ${d}`);
        if (tag === "meta" && attrs.content !== undefined && SHOWN_META.test(attrs.name ?? attrs.property ?? ""))
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

/** An address on another site: any http(s), ws(s) or ftp URL, or a protocol-relative one. */
const OFFSITE = /^\s*(?:(?:https?|wss?|ftp):)?\/\//i;
/** Attributes the browser fetches on its own, without a click. */
const FETCHED = new Set(["src", "srcset", "imagesrcset", "poster", "data", "background", "lowsrc", "dynsrc"]);
const FETCHED_HREF = new Set(["link", "image", "use", "feimage", "script", "base"]);

/**
 * Everything in HTML that would make the browser ask another site for
 * something as the page loads: src, srcset and their kin, link, base and SVG
 * hrefs, CSS url() and @import (in style elements and style attributes) and
 * a meta refresh. A plain link (<a href>) is not fetched until it is clicked.
 */
export function externalRequests(html: string): string[] {
  const found: string[] = [];
  const css = (where: string, text: string) => {
    for (const m of text.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)|@import\s+(["'])([^"']*)\3/gi)) {
      const url = m[2] ?? m[4] ?? "";
      if (OFFSITE.test(url)) found.push(`${where}: ${url}`);
    }
  };
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) css("style", m[1]!);
  const tags = html.replace(/<(script|style)\b([^>]*)>[\s\S]*?<\/\1>/gi, "<$1$2>");
  for (const t of tags.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g)) {
    const tag = t[1]!.toLowerCase();
    const attrs = attributes(t[0]);
    for (const [name, value] of Object.entries(attrs)) {
      const urls = /srcset$/.test(name) ? value.split(",").map((s) => s.trim().split(/\s+/)[0]!) : [value];
      const fetched = FETCHED.has(name) || ((name === "href" || name === "xlink:href") && FETCHED_HREF.has(tag));
      if (fetched) for (const u of urls) if (OFFSITE.test(u)) found.push(`${tag}[${name}]: ${u}`);
    }
    if (attrs.style !== undefined) css(`${tag}[style]`, attrs.style);
    if (
      tag === "meta" &&
      /refresh/i.test(attrs["http-equiv"] ?? "") &&
      /url\s*=\s*['"]?\s*(?:[a-z]+:)?\/\//i.test(attrs.content ?? "")
    )
      found.push(`meta refresh: ${attrs.content}`);
  }
  return found;
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
  it("has no number typed into it: not in its text, its attributes or what its CSS prints", () => {
    const { problems } = traceHtml(indexHtml(), {});
    expect(problems).toEqual([]);
  });

  it("loads nothing from another site: no external script, stylesheet, font or import", () => {
    const html = indexHtml();
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+rel="?stylesheet/i);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
    expect(externalRequests(html)).toEqual([]);
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
    const { problems, traced } = traceHtml(html, files, shellCss());
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
    // Numbers that never sit in the text: CSS generated content (escapes too), attr(), counters, any attribute.
    // (On a page of its own, so that only the planted number can be caught.)
    const caught = (extra: string, css = "") =>
      traceHtml(`<section><p class="lede">No figure here.</p>${extra}</section>`, {}, css).problems;
    expect(caught('<style>.lede::after { content: " (n = 1,100)"; }</style>')).not.toEqual([]);
    expect(caught("", String.raw`.lede::after { content: "\31 2 runs"; }`)).not.toEqual([]);
    expect(caught("", "li::marker { content: counter(list-item); }")).not.toEqual([]);
    expect(caught('<a href="runs/12">x</a>')).toEqual([]);
    expect(caught('<a href="runs/12">x</a>', "a::after { content: attr(href); }")).not.toEqual([]);
    expect(caught("<p data-note='in 12 runs'>x</p>")).not.toEqual([]);
    expect(caught('<p style="list-style-type: &quot;12 &quot;">x</p>')).not.toEqual([]);
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
      ...Object.keys(study)
        .filter((k) => k.startsWith("conformance/"))
        .flatMap((k) => [
          [k, (r: Record<string, unknown>) => ((r.records as Record<string, unknown>[])[0]!.version = "0.0.0-sample")],
          [k, (r: Record<string, unknown>) => ((r.records as Record<string, unknown>[])[0]!.version = "1.2.3-fake")],
        ]),
    ] as [string, (r: Record<string, unknown>) => unknown][]) {
      const one = clone(study) as Record<string, Record<string, unknown>>;
      mutate(one[file]!);
      const out = core.renderSite({ files: one });
      expect(out.html, file).toContain("SAMPLE DATA, NOT RESULTS.");
      expect(traceHtml(out.html, one, shellCss()).problems).toEqual([]);
    }
    const pilot = clone(study) as Record<string, Record<string, unknown>>;
    pilot["results.json"]!.label = "pilot";
    expect(core.renderSite({ files: pilot }).html).toContain("PILOT DATA.");
  });

  it("asks no other site for anything as it loads: no image, frame, script, stylesheet or font", () => {
    for (const [what, data] of [
      ["sample", files],
      ["study-labelled", asStudy(files)],
      ["no data", {}],
    ] as const)
      expect(externalRequests(core.renderSite({ files: data }).html), what).toEqual([]);
    // The check itself: each of these would be a request to another site.
    for (const planted of [
      '<img alt="" src="https://example.com/p.gif">',
      '<img alt="" srcset="a.png 1x, //example.com/b.png 2x">',
      "<iframe src='https://example.com/'></iframe>",
      '<link rel="preload" href="https://example.com/f.woff2">',
      '<p style="background: url(https://example.com/bg.png)">x</p>',
      '<style>@import "https://example.com/x.css";</style>',
      '<svg><use href="https://example.com/s.svg#i"/></svg>',
    ])
      expect(externalRequests(html + planted), planted).not.toEqual([]);
    expect(externalRequests('<a href="https://example.com/">a link is not fetched</a>')).toEqual([]);
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
    expect(traceHtml(html, {}, shellCss()).problems).toEqual([]);
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
    // Outside <main> a reader sees only the <title>: the write-up's own first heading, with nothing added.
    const h1 = /^# (.*)$/m.exec(plain)![1]!.replace(/[`*]/g, "");
    expect(decode(/<title>([\s\S]*?)<\/title>/.exec(html)![1]!)).toBe(h1);
    const rest = html.replace(/<main>[\s\S]*<\/main>/, "").replace(/<title>[\s\S]*?<\/title>/, "");
    expect(traceHtml(rest, {}).problems).toEqual([]);
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

describe("names, links and issue numbers in the site, the talk and the workshop", () => {
  // Every one was checked against the source itself on 2026-10-01: the arXiv
  // abstract pages' citation_author and citation_title, the post's own page,
  // `gh api` for each issue and the repository, and the GitHub Pages docs for
  // the site address. A new link, issue or credited author fails here until
  // it is checked the same way and added.
  const LINKS = new Set([
    "https://github.com/Shivansh2904/ctxreach", // git remote get-url origin; public (gh api repos/...)
    "https://github.com/Shivansh2904/ctxreach/blob/main/study/PREREG.md", // main:study/PREREG.md (not pushed on 2026-10-01)
    "https://shivansh2904.github.io/ctxreach/", // Pages' project-site address, <owner>.github.io/<repo> (main's pages.yml)
    "https://blog.szypowi.cz/p/claude-code-reads-agents.md-only-when-telemetry-is-on/",
    "https://github.com/openai/codex/issues/13386",
    "https://github.com/anthropics/claude-code/issues/80580",
    "https://arxiv.org/abs/2602.14690",
    "https://arxiv.org/abs/2605.08435",
    "https://arxiv.org/abs/2602.11988",
    "https://www.augmentcode.com/blog/how-to-write-good-agents-dot-md-files",
    "https://code.claude.com/docs/en/memory",
    "https://learn.chatgpt.com/guides/best-practices",
  ]);
  const ISSUES = new Set(["openai/codex#13386", "openai/codex#41499", "anthropics/claude-code#80580"]);
  /** Credited authors, as the source lists them: the post's author, and each paper's first author. */
  const AUTHORS: Record<string, string> = {
    Szypowicz: "P.", // Przemysław Szypowicz (the post's GitHub and LinkedIn links)
    Galster: "M.", // Matthias Galster, first author of arXiv 2602.14690 and 2605.08435
    Gloaguen: "T.", // Thibaud Gloaguen, first author of arXiv 2602.11988
  };
  const docs = () =>
    [
      "site/index.html",
      ...["site", "talk", "workshop"].flatMap((d) =>
        readdirSync(path.join(ROOT, d))
          .filter((f) => f.endsWith(".md"))
          .map((f) => `${d}/${f}`),
      ),
    ].map((rel) => [rel, readFileSync(path.join(ROOT, rel), "utf8")] as const);

  it("links only to sources checked by hand, and credits each author by the initial the source gives", () => {
    const problems: string[] = [];
    for (const [rel, text] of docs()) {
      for (const m of text.matchAll(/https?:\/\/[^\s"'<>`)\]]+/g)) {
        const url = m[0].replace(/[.,;:]+$/, "");
        if (!LINKS.has(url)) problems.push(`${rel}: unchecked link ${url}`);
      }
      for (const m of text.matchAll(/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+/g))
        if (!ISSUES.has(m[0])) problems.push(`${rel}: unchecked issue ${m[0]}`);
      for (const m of text.matchAll(/(?<![A-Za-z])([A-Z]\.)\s+([A-Z][\p{Ll}-]+)/gu)) {
        const want = AUTHORS[m[2]!];
        if (want === undefined) problems.push(`${rel}: unchecked author ${m[0]}`);
        else if (m[1] !== want) problems.push(`${rel}: ${m[0]}, the source gives ${want} ${m[2]}`);
      }
      for (const surname of Object.keys(AUTHORS))
        for (const m of text.matchAll(new RegExp(`(?<![\\p{L}.])([\\p{L}.]*)\\s*${surname}\\b`, "gu")))
          if (m[1] !== AUTHORS[surname]) problems.push(`${rel}: "${m[0]}" without the initial ${AUTHORS[surname]}`);
    }
    expect(problems).toEqual([]);
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
    // The copy is <scratch>/home/demo. <scratch> holds instruction files of its own, standing in for
    // whatever sits above the temp folder on the machine running this (a ~/.claude/CLAUDE.md above
    // %TEMP%, say). map is told where its upward walk stops and which homes to read, so nothing above
    // the copy can change its answer; the planted files make sure of it on every run.
    const scratch = tmp("cast");
    for (const rel of ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"]) {
      const file = path.join(scratch, ...rel.split("/"));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "Planted above the demo copy: map must not read this.\n");
    }
    const home = path.join(scratch, "home");
    cpSync(path.join(ROOT, "examples", "demo-monorepo"), path.join(home, "demo"), { recursive: true });
    mkdirSync(path.join(home, "demo", ".git"));
    // HOME and USERPROFILE only decide how paths print (the cast shows ~/demo); nothing is read through them.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    let stdout: string;
    try {
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      stdout = renderTerminal(
        map({
          launchDir: path.join(home, "demo", "packages", "api"),
          codex: { home: path.join(home, ".codex") },
          claude: { home: path.join(home, ".claude"), homeDir: home, ceiling: home },
        }),
      );
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
