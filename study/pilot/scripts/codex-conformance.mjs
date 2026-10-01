// Read-only toward the ctxreach clone: copies fixtures into scratch, runs `ctxreach map --json`
// and `codex debug prompt-input` (empty or fixture CODEX_HOME, proxies dead), compares bodies byte for byte.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
const TS = process.argv[2], CLONE = "<home>/ctxreach";
const CX = path.join(TS, "codex", "node_modules", "@openai", "codex", "bin", "codex.js");
const dead = "http://127.0.0.1:9";
const env = { ...process.env, HTTPS_PROXY: dead, HTTP_PROXY: dead, ALL_PROXY: dead, NO_PROXY: "", OPENAI_API_KEY: "", CODEX_API_KEY: "" };
const out = [];
const names = readdirSync(path.join(CLONE, "test", "fixtures")).filter((n) => n.startsWith("codex-")).concat(process.argv.slice(3));
for (const name of names) {
  const src = path.join(CLONE, "test", "fixtures", name);
  const base = path.join(TS, "conf", name);
  rmSync(base, { recursive: true, force: true });
  cpSync(path.join(src, "repo"), path.join(base, "repo"), { recursive: true });
  mkdirSync(path.join(base, "repo", ".git"), { recursive: true });
  const home = path.join(base, "codexhome");
  if (existsSync(path.join(src, "home", ".codex"))) cpSync(path.join(src, "home", ".codex"), home, { recursive: true });
  else mkdirSync(home, { recursive: true });
  for (const from of [".", "packages/api"]) {
    const launch = path.join(base, "repo", from);
    if (!existsSync(launch)) continue;
    const m = spawnSync(process.execPath, [path.join(CLONE, "dist", "cli.js"), "map", "--from", launch, "--agents", "codex", "--codex-home", home, "--json"], { encoding: "utf8" });
    const mj = JSON.parse(m.stdout);
    const pieces = [];
    for (const e of mj.codex.chain) {
      if (e.keptBytes === 0) continue;
      const abs = path.isAbsolute(e.path) ? e.path : path.join(mj.repoRoot ?? path.join(base, "repo"), e.path);
      const bytes = readFileSync(abs).subarray(0, e.keptBytes);
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (text.trim() !== "") pieces.push(text);
    }
    const predicted = pieces.join("\n\n");
    const r = spawnSync(process.execPath, [CX, "debug", "prompt-input", "x"], { cwd: launch, env: { ...env, CODEX_HOME: home }, encoding: "utf8", timeout: 60000 });
    let delivered = null, status = "no-block";
    if (r.status !== 0) status = `codex exit ${r.status}: ${r.stderr.slice(0, 200)}`;
    else {
      const items = JSON.parse(r.stdout);
      const blocks = items.filter((i) => i.role === "user").flatMap((i) => i.content).filter((c) => c.type === "input_text" && c.text.startsWith("# AGENTS.md instructions"));
      if (blocks.length) {
        const mm = /<INSTRUCTIONS>\n([\s\S]*)\n<\/INSTRUCTIONS>/.exec(blocks[0].text);
        delivered = mm ? mm[1] : blocks[0].text;
      }
      if (delivered === null) status = predicted === "" ? "AGREE (both empty)" : "DISAGREE (codex sent no AGENTS block)";
      else if (delivered === predicted) status = "AGREE (byte-exact)";
      else if (delivered.trimEnd() === predicted.trimEnd()) status = "AGREE (modulo trailing whitespace)";
      else status = `DISAGREE predicted ${Buffer.byteLength(predicted)}B delivered ${Buffer.byteLength(delivered)}B`;
    }
    const line = `${name.padEnd(34)} from ${from.padEnd(13)} map: ${mj.codex.chain.map((e) => `${e.path}=${e.keptBytes}/${e.bytes}`).join(", ") || "(none)"} | ${status}`;
    console.log(line);
    out.push(line);
  }
}
