#!/usr/bin/env node
// A stand-in for the GitHub CLI in tests: it records its arguments and then
// answers the way `gh api --include` does (the status line, the headers, a
// blank line, the body; exit 1 after printing a response of 300 or more). It
// never reaches the network and reads no credential.
//
// FAKE_GH_DIR holds replies.json, a list of replies used in turn (the last
// one repeats), and receives argv.jsonl (one line per call) and count.txt.
// A reply: { status, statusText?, headers?: {Name: value}, body?: string,
//            noStdout?: true, stderr?: string, exit?: number }

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_GH_DIR;
if (!dir) {
  process.stderr.write("fake-gh: FAKE_GH_DIR is not set\n");
  process.exit(2);
}
const countFile = path.join(dir, "count.txt");
const n = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
writeFileSync(countFile, String(n + 1));
appendFileSync(path.join(dir, "argv.jsonl"), JSON.stringify({ argv: process.argv.slice(2) }) + "\n");

const replies = JSON.parse(readFileSync(path.join(dir, "replies.json"), "utf8"));
const r = replies[Math.min(n, replies.length - 1)];
if (r.noStdout) {
  if (r.stderr) process.stderr.write(r.stderr + "\n");
  process.exit(r.exit ?? 1);
}
const status = r.status ?? 200;
const statusText = r.statusText ?? (status === 200 ? "OK" : "Error");
const headers = r.headers ?? {};
let out = `HTTP/2.0 ${status} ${statusText}\n`;
for (const name of Object.keys(headers).sort()) out += `${name}: ${headers[name]}\r\n`;
out += "\r\n";
process.stdout.write(out + (r.body ?? ""), () => {
  if (status > 299) {
    process.stderr.write(`gh: ${statusText} (HTTP ${status})\n`);
    process.exitCode = r.exit ?? 1;
  } else process.exitCode = r.exit ?? 0;
});
