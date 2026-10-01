// Reconstruct a files-only skeleton of one public repo at a pinned commit:
// only instruction files and agent config, at their paths, plus a .git marker.
// Read-only toward GitHub (GET only). usage: node recon.mjs owner/repo sha outDir
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [slug, sha, out] = process.argv.slice(2);
const INSTR =
  /(^|\/)(AGENTS\.md|AGENTS\.override\.md|CLAUDE\.md|CLAUDE\.local\.md)$|(^|\/)\.claude\/CLAUDE\.md$|(^|\/)\.claude\/rules\/.+\.md$|(^|\/)\.claude\/AGENTS\.md$|(^|\/)\.codex\/config\.toml$|(^|\/)\.claude\/settings(\.local)?\.json$/;
const tree = JSON.parse(
  execFileSync("gh", ["api", `repos/${slug}/git/trees/${sha}?recursive=1`], { maxBuffer: 256 * 1024 * 1024 }).toString(),
);
if (tree.truncated) console.error("TRUNCATED tree");
const hits = tree.tree.filter((e) => (e.type === "blob" || e.mode === "120000") && INSTR.test(e.path));
mkdirSync(path.join(out, ".git"), { recursive: true });
const rows = [];
for (const e of hits) {
  const url = `https://raw.githubusercontent.com/${slug}/${sha}/${e.path.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(out, ...e.path.split("/"));
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  rows.push({ path: e.path, mode: e.mode, size: e.size, fetched: buf.length, status: res.status });
}
console.log(JSON.stringify({ slug, sha, entries: tree.tree.length, truncated: tree.truncated, files: rows }, null, 1));
