// Generates the write-up from a template and the results page's data, and
// fills the other templates the same way (talk/slides.md,
// site/readme-first-screen.md). It runs the results page's own render core
// (the <script id="ctxr-core"> in site/index.html) in node:vm, so the page
// and the write-up cannot print different numbers, and no number is typed
// into a template: each {{slot}} names a value the core reads from the data
// (test/site.test.ts fails on any digit outside a slot).
//
// Usage: node scripts/writeup.mjs [--data site/data] [--template site/writeup.template.md]
//          [--format md|html] [--out <file>] [--traced]
// --traced marks every number with the file and JSON pointer it came from
// (for checking, never for publishing). Without --out, prints to stdout.
// Exit status: 0 when written, 2 for a usage problem or a template slot the core does not know.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), "..");

/** The page's render core, run in a fresh context. */
export function loadCore(root = ROOT) {
  const html = readFileSync(path.join(root, "site", "index.html"), "utf8");
  const m = /<script id="ctxr-core">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('site/index.html has no <script id="ctxr-core">');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(m[1], sandbox, { filename: "site/index.html#ctxr-core" });
  if (!sandbox.ctxrCore) throw new Error("the core script did not define ctxrCore");
  return sandbox.ctxrCore;
}

/** The data files the page itself would fetch from `dir`, by the same names. */
export function loadData(dir, core) {
  const files = {};
  const read = (name) => {
    const p = path.join(dir, ...name.split("/"));
    if (existsSync(p)) files[name] = JSON.parse(readFileSync(p, "utf8"));
  };
  for (const name of [core.RESULTS, core.CELLS, core.PROV]) read(name);
  const indexFile = path.join(dir, "conformance", "latest", "index.json");
  let conf = core.CONFORMANCE_FILES;
  if (existsSync(indexFile)) {
    const index = JSON.parse(readFileSync(indexFile, "utf8"));
    if (Array.isArray(index.files))
      conf = index.files
        .filter((f) => /^[A-Za-z0-9._-]+\.json$/.test(f) && f !== "index.json")
        .map((f) => `conformance/latest/${f}`);
  }
  for (const name of conf) read(name);
  return { files };
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/** Markdown to HTML for the subset the templates use: headings, paragraphs, quotes, bullet lists, fenced code. */
export function mdToHtml(md) {
  const out = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  let para = [];
  let list = null;
  let quote = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para = [];
    if (list) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    list = null;
    if (quote.length) out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
    quote = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      flush();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (/^- /.test(line)) {
      if (para.length || quote.length) {
        const keep = list;
        list = null;
        flush();
        list = keep;
      }
      (list ??= []).push(line.slice(2));
    } else if (/^ {2,}\S/.test(line) && list) {
      list[list.length - 1] += " " + line.trim();
    } else if (/^> ?/.test(line)) {
      quote.push(line.replace(/^> ?/, ""));
    } else if (!line.trim()) {
      flush();
    } else {
      if (list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return out.join("\n");
}

const BANNERS = {
  sample:
    "**SAMPLE DATA, NOT RESULTS.** Every number below comes from made-up files that exist to test the generator. Nothing here was measured.",
  pilot:
    "**PILOT DATA.** These numbers come from a pilot run, made before or outside the registered study. They test nothing that was registered.",
};

/** Words in a Markdown text (code blocks included), for the write-up's length limit. */
export function wordCount(md) {
  return md.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
}

const CSS = `:root{--paper:#f4f6f3;--ink:#18211e;--muted:#56625e;--rule:#d6dcd7;--accent:#1d5a86;--sample:#a3275f;--sample-soft:#f8e2ec;color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--paper:#101614;--ink:#e3e9e6;--muted:#9ba8a3;--rule:#2b3532;--accent:#86bbe2;--sample:#f27fb6;--sample-soft:#351a28;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#101614;--ink:#e3e9e6;--muted:#9ba8a3;--rule:#2b3532;--accent:#86bbe2;--sample:#f27fb6;--sample-soft:#351a28;color-scheme:dark}
body{margin:0;padding-inline:16px;padding-block:2rem 3rem;background:var(--paper);color:var(--ink);font:1.0625rem/1.65 "Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif}
main{max-width:68ch;margin-inline:auto}
h1,h2{font-family:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;line-height:1.25;text-wrap:balance}
h1{font-size:2rem}h2{font-size:1.4rem;margin-top:2rem}
a{color:var(--accent)}code,pre{font-family:ui-monospace,"Cascadia Mono","SF Mono",Menlo,Consolas,monospace;font-size:.9em}
pre{overflow-x:auto;padding:.75rem;border:1px solid var(--rule);border-radius:6px}
blockquote{margin:0 0 1.5rem;padding:.75rem 1rem;border:2px solid var(--sample);background:var(--sample-soft)}
blockquote strong{color:var(--sample)}`;

/** Render one template. Returns the text and whether the data was sample, pilot or study. */
export function render({
  root = ROOT,
  template = path.join(root, "site", "writeup.template.md"),
  dataDir = path.join(root, "site", "data"),
  format = "md",
  traced = false,
} = {}) {
  const core = loadCore(root);
  const data = loadData(dataDir, core);
  const { text, state } = core.renderTemplate(readFileSync(template, "utf8"), data, traced ? "traced" : "plain");
  const banner = state.sample ? BANNERS.sample : state.pilot ? BANNERS.pilot : "";
  const md = (banner ? `> ${banner}\n\n` : "") + text.replace(/^\n+/, "");
  if (format === "md") return { text: md, state, words: wordCount(text) };
  if (format !== "html") throw new Error(`--format must be md or html, not ${format}`);
  const title = (/^# (.*)$/m.exec(text)?.[1] ?? "ctxreach write-up").replace(/[`*]/g, "");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${mdToHtml(md)}
</main>
</body>
</html>
`;
  return { text: html, state, words: wordCount(text) };
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const out = render({
      template: opt("--template") ? path.resolve(opt("--template")) : undefined,
      dataDir: opt("--data") ? path.resolve(opt("--data")) : undefined,
      format: opt("--format") ?? "md",
      traced: argv.includes("--traced"),
    });
    if (opt("--out")) {
      writeFileSync(opt("--out"), out.text);
      console.error(
        `wrote ${opt("--out")} (${out.words} words)${out.state.sample ? " from SAMPLE data: not results" : out.state.pilot ? " from PILOT data" : ""}`,
      );
    } else process.stdout.write(out.text);
    return 0;
  } catch (e) {
    console.error(e.message);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = main(process.argv.slice(2));
}
