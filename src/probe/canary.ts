/**
 * Plant random tokens in the temporary copy's instruction files.
 *
 * Each file gets one token on its first line (after a UTF-8 byte-order mark
 * and YAML front matter, which must stay first) and one on its last line.
 * The tokens are plain text, not HTML comments, because Claude Code strips
 * HTML comments from instruction files.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalPath, isInside } from "../util/fs.js";
import { SafetyError, type Canary } from "./types.js";

/** File name of the decoy: a Markdown file in the launch directory that no documented rule loads. */
export const DECOY_NAME = "ctxreach-decoy.md";

export type RandomSource = (bytes: number) => Uint8Array;

export class TokenSource {
  private readonly used = new Set<string>();
  constructor(private readonly random: RandomSource = randomBytes) {}

  next(): string {
    for (;;) {
      const token = "CTXR-" + Buffer.from(this.random(4)).toString("hex");
      if (!this.used.has(token)) {
        this.used.add(token);
        return token;
      }
    }
  }
}

const LABEL = "ctxreach canary ";
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Byte offset where the head token goes: after a BOM and a closed YAML front matter block, if any. */
export function headOffset(bytes: Buffer): number {
  let start = bytes.subarray(0, 3).equals(BOM) ? 3 : 0;
  const text = bytes.subarray(start).toString("utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (m) start += Buffer.byteLength(m[0]);
  return start;
}

/** The planted version of a file's bytes, and where each token landed. */
export function plantText(bytes: Buffer, head: string, tail: string): { bytes: Buffer; head: number; tail: number } {
  const at = headOffset(bytes);
  const headLine = Buffer.from(`${LABEL}${head}\n\n`);
  const before = bytes.subarray(0, at);
  const after = bytes.subarray(at);
  const needsNewline = after.length > 0 && after[after.length - 1] !== 0x0a;
  const tailLine = Buffer.from(`${needsNewline ? "\n" : ""}\n${LABEL}${tail}\n`);
  const out = Buffer.concat([before, headLine, after, tailLine]);
  const headAt = at + Buffer.byteLength(LABEL);
  const tailAt = before.length + headLine.length + after.length + tailLine.length - 1 - Buffer.byteLength(tail);
  return { bytes: out, head: headAt, tail: tailAt };
}

/** Refuse to write anywhere but a regular file inside the copy (never through a symlink), whatever the spellings. */
function assertPlantable(file: string, repo: string): void {
  const st = lstatSync(file);
  if (!st.isFile()) throw new SafetyError(`refusing to plant in ${file}: not a regular file`);
  if (!isInside(canonicalPath(file), canonicalPath(repo)))
    throw new SafetyError(`refusing to plant in ${file}: outside the temporary copy`);
}

/** A rule file whose front matter declares `paths` (see `Canary.scoped`). */
export function isScopedRule(rel: string, bytes: Buffer): boolean {
  if (!/(^|\/)\.claude\/rules\//.test(rel)) return false;
  const text = bytes.subarray(bytes.subarray(0, 3).equals(BOM) ? 3 : 0).toString("utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m?.[1] !== undefined && /^paths\s*:/m.test(m[1]);
}

/** Plant a head and a tail token in `rel` (relative to `repo`). */
export function plantFile(repo: string, rel: string, tokens: TokenSource): Canary[] {
  const file = path.join(repo, ...rel.split("/"));
  assertPlantable(file, repo);
  const head = tokens.next();
  const tail = tokens.next();
  const original = readFileSync(file);
  const scoped = isScopedRule(rel, original) ? { scoped: true } : {};
  const planted = plantText(original, head, tail);
  writeFileSync(file, planted.bytes);
  return [
    { token: head, file: rel, position: "head", offset: planted.head, ...scoped },
    { token: tail, file: rel, position: "tail", offset: planted.tail, ...scoped },
  ];
}

/** Write the decoy into `relDir` of the copy. Its text reads like an instruction file on purpose. */
export function plantDecoy(repo: string, relDir: string, tokens: TokenSource): Canary[] {
  const rel = relDir === "." ? DECOY_NAME : `${relDir}/${DECOY_NAME}`;
  const file = path.join(repo, ...rel.split("/"));
  const body = "# Contributor notes\n\n- Keep functions short.\n- Prefer early returns.\n";
  writeFileSync(file, body, { flag: "wx" });
  return plantFile(repo, rel, tokens).map((c) => ({ ...c, decoy: true }));
}
