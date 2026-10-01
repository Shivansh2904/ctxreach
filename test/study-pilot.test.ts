// Tests for the pilot artefacts kept in study/pilot (study/pilot/README.md):
// what the redaction keeps, and what it must never keep. The vendors' own
// prompt text (Claude Code's, Codex's, OpenCode's) is checked two ways, by
// checkers written here apart from redact.mjs so the redaction does not grade
// itself:
// - by shape: outside the items ctxreach scores (instruction files, its own
//   prompt, the working directory), a recorded request or render holds only
//   {kind, sha256, bytes} digests and identifiers;
// - by phrase: no file under study/ holds a phrase taken from the original
//   recordings. The phrases are listed here only as SHA-256 values, so this
//   file holds none of that text either.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as cellsLib from "../study/behavioural/lib.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as redact from "../study/pilot/redact.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pilotDir = path.join(ROOT, "study", "pilot");
const walk = (d: string, rel = ""): string[] =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`],
  );
const readPilot = (rel: string) => readFileSync(path.join(pilotDir, ...rel.split("/")), "utf8");
type Sum = { sha256: string; src: string; dst: string; flags: string[] };
const sums = (): Sum[] => redact.readSums(readPilot("SHA256SUMS-sources.txt"));

describe("pilot artefacts", () => {
  it("the echo reader finds the ancestor token in the pilot's real probe recording", () => {
    const obs = cellsLib.readObservation("echo", path.join(pilotDir, "probe-runs", "r1-ancestor"));
    expect([...obs.tokens]).toEqual(["CTXR-a17ce5a1"]);
    expect(obs.init).toMatchObject({ version: "2.1.280", model: "claude-fable-5-1" });
    expect(obs.init.plugins).toContain("agents-md@builtin");
  });

  it("the redacted copies keep no local user name, session id, UUID or credential", () => {
    const files = walk(pilotDir).filter((f) => f !== "redact.mjs");
    expect(files.length).toBeGreaterThan(50);
    const uuid = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/i;
    for (const f of files) {
      const text = readPilot(f);
      expect(text.toLowerCase().includes(path.basename(os.homedir()).toLowerCase()), f).toBe(false);
      expect(uuid.exec(text)?.[0] ?? null, f).toBe(null);
      expect(/"(x-api-key|authorization|session_id|sessionId)":"(?!REDACTED|<uuid>)/.test(text), f).toBe(false);
    }
  });

  it("the redaction replaces home paths, project-folder names and UUIDs, and its own check fails on what survives", () => {
    const home = os.homedir();
    const id = "9bbada20-d64e-4ccc-afb0-9b92236f6d1f";
    const trap = JSON.stringify({ transcript_path: path.join(home, ".claude", "projects", "x", `${id}.jsonl`) });
    const out = redact.redactPaths(trap);
    expect(out).toBe(
      JSON.stringify({ transcript_path: path.join("<home>", ".claude", "projects", "x", "<uuid>.jsonl") }),
    );
    expect(redact.leftovers(out)).toEqual([]);
    // The check can fail: the raw line, and a UUID inside an id, are both caught.
    expect(redact.leftovers(trap).length).toBeGreaterThanOrEqual(1);
    expect(redact.leftovers(`"id":"msg_01a0f2ea-22f0-7222-8aaa-b266449df084"`)).toEqual([
      "01a0f2ea-22f0-7222-8aaa-b266449df084",
    ]);
    // Clean twin: a ctxreach token and a commit id are not identifiers.
    expect(redact.leftovers("CTXR-a17ce5a1 at b13e5da7a9a43aba21858e7d68f00ee7743b37e5")).toEqual([]);
    expect(() => redact.reduce(`{"note":"${id}"}`, "x.json")).not.toThrow();
    expect(redact.reduce(`{"session_id":"${id}","uuid":"${id}"}`, "x.json")).toContain('"session_id": "REDACTED"');
  });

  it("the pilot README gives no email address", () => {
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
    expect(email.exec(readPilot("README.md"))?.[0] ?? null).toBe(null);
    expect(email.test("write to someone@example.org")).toBe(true);
  });

  it("every pilot file is listed with its source's SHA-256", () => {
    const listed = new Set<string>(sums().map((s) => s.dst));
    const own = new Set(["README.md", "SHA256SUMS-sources.txt", "redact.mjs"]);
    expect(walk(pilotDir).filter((f) => !own.has(f) && !listed.has(f))).toEqual([]);
    expect([...listed].filter((f) => !walk(pilotDir).includes(f))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// By shape.

/** A string a reduced request or render may hold outside its kept items: an identifier, never a phrase. */
const IDENT = /^[A-Za-z0-9_.:<>@/+-]{0,80}$/;
const AGENTS_KIND = "agents_md.instructions";
const USER_KIND = "user.text";
const ENV_KIND = "environments.environment_context";
const AGENTS_BLOCK = /^# AGENTS\.md instructions for [^\n]*\n\n<INSTRUCTIONS>\n[\s\S]*\n<\/INSTRUCTIONS>$/;
/** ctxreach's own prompts in the pilot runs, and the placeholder prompt of `codex debug prompt-input`. */
const CTXREACH_PROMPTS = new Set([
  "List every token that starts with CTXR- that appears in your instructions.",
  '"List every CTXR token in your instructions."',
  "List every CTXR token in your instructions.",
  "x",
]);

const keysOf = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort().join(",") : "");

/** `{kind, sha256, bytes}`, plus the fields `extra` allows (a kept `cwd`, or a kept file list). */
function digest(item: unknown, where: string, kind?: string, extra: string[] = []): string[] {
  const o = item as Record<string, unknown>;
  const keys = keysOf(o).split(",");
  const base = ["bytes", "kind", "sha256"];
  if (!base.every((k) => keys.includes(k)) || keys.some((k) => !base.includes(k) && !extra.includes(k)))
    return [`${where}: not {kind, sha256, bytes}${extra.length ? ` (+ ${extra.join(", ")})` : ""}`];
  const bad: string[] = [];
  if (kind !== undefined && o.kind !== kind) bad.push(`${where}: kind ${String(o.kind)}, expected ${kind}`);
  if (typeof o.kind !== "string" || !IDENT.test(o.kind)) bad.push(`${where}: kind is not an identifier`);
  if (!/^[0-9a-f]{64}$/.test(String(o.sha256))) bad.push(`${where}: sha256 is not 64 hex digits`);
  if (!Number.isInteger(o.bytes) || (o.bytes as number) < 0) bad.push(`${where}: bytes is not a count`);
  return bad;
}

/** `{type, text}` holding ctxreach's own prompt and nothing else. */
function prompt(item: unknown, where: string): string[] {
  const o = item as { text?: unknown };
  if (keysOf(o) !== "text,type" || typeof o.text !== "string") return [`${where}: the prompt is not {type, text}`];
  return CTXREACH_PROMPTS.has(o.text) ? [] : [`${where}: a kept text that is not ctxreach's prompt`];
}

/** `{type, text}` holding exactly one AGENTS.md block. */
function agentsBlock(item: unknown, where: string): string[] {
  const o = item as { text?: unknown };
  if (keysOf(o) !== "text,type" || typeof o.text !== "string")
    return [`${where}: the AGENTS.md block is not {type, text}`];
  return AGENTS_BLOCK.test(o.text) ? [] : [`${where}: text that is not one AGENTS.md block`];
}

/** A digest that also keeps the instruction files an agent delivered: each `{path, text}` and nothing else. */
function filesDigest(item: unknown, where: string, kind: string, extra: string[]): string[] {
  const o = item as { files?: unknown };
  const bad = digest(item, where, kind, ["files", ...extra]);
  if (!Array.isArray(o?.files) || o.files.length === 0) return [...bad, `${where}: no files`];
  o.files.forEach((f: unknown, i: number) => {
    const file = f as { path?: unknown; text?: unknown };
    if (keysOf(file) !== "path,text" || typeof file.path !== "string" || typeof file.text !== "string")
      bad.push(`${where}.files[${i}]: not {path, text}`);
  });
  return bad;
}

/** Every string outside the kept items must be an identifier: prose anywhere else is a residue. */
function identifiersOnly(v: unknown, where: string, kept: Set<unknown>): string[] {
  if (kept.has(v)) return [];
  if (typeof v === "string") return IDENT.test(v) ? [] : [`${where}: text ${JSON.stringify(v.slice(0, 40))}`];
  if (Array.isArray(v)) return v.flatMap((x, i) => identifiersOnly(x, `${where}[${i}]`, kept));
  if (v && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) => identifiersOnly(x, `${where}.${k}`, kept));
  return [];
}
/** The strings of a kept item (its text, its files' paths and texts, its cwd and root). */
function keep(kept: Set<unknown>, item: any): void {
  for (const k of ["text", "cwd", "root"]) if (typeof item?.[k] === "string") kept.add(item[k]);
  for (const f of Array.isArray(item?.files) ? item.files : []) {
    kept.add(f?.path);
    kept.add(f?.text);
  }
}

function renderResidue(json: unknown, thirdParty: boolean): string[] {
  if (!Array.isArray(json)) return ["a render must be an array of messages"];
  const bad: string[] = [];
  const kept = new Set<unknown>();
  json.forEach((m: any, i: number) => {
    if (keysOf(m) !== "content,internal_chat_message_metadata_passthrough,role,type")
      bad.push(`[${i}]: a message keeps more than type, role, content and kinds`);
    if (keysOf(m?.internal_chat_message_metadata_passthrough) !== "content_item_kinds")
      bad.push(`[${i}]: metadata other than content_item_kinds`);
    const kinds = m?.internal_chat_message_metadata_passthrough?.content_item_kinds;
    if (!Array.isArray(kinds) || !Array.isArray(m.content) || kinds.length !== m.content.length) {
      bad.push(`[${i}]: no kind for each content item`);
      return;
    }
    m.content.forEach((c: any, j: number) => {
      const where = `[${i}].content[${j}]`;
      if (kinds[j] === AGENTS_KIND && !thirdParty) bad.push(...agentsBlock(c, where));
      else if (kinds[j] === USER_KIND) bad.push(...prompt(c, where));
      else bad.push(...digest(c, where, kinds[j], kinds[j] === ENV_KIND ? ["cwd"] : []));
      if (kinds[j] === ENV_KIND && typeof c?.cwd !== "string") bad.push(`${where}: the environment lost its cwd`);
      if ((kinds[j] === AGENTS_KIND && !thirdParty) || kinds[j] === USER_KIND || kinds[j] === ENV_KIND) keep(kept, c);
    });
  });
  return [...bad, ...identifiersOnly(json, "", kept)];
}

const bodyOf = (record: any) => (typeof record.body === "string" ? JSON.parse(record.body) : record.body);
const toolDigests = (body: any, bad: string[]) => {
  if (!Array.isArray(body.tools)) return bad.push("tools: not a list");
  body.tools.forEach((t: unknown, i: number) => bad.push(...digest(t, `tools[${i}]`)));
};

function codexRequestResidue(record: any): string[] {
  const body = bodyOf(record);
  const bad: string[] = [...digest(body.instructions, "instructions", "instructions")];
  toolDigests(body, bad);
  const kept = new Set<unknown>();
  (body.input ?? []).forEach((m: any, i: number) =>
    (m.content ?? []).forEach((c: any, j: number) => {
      const where = `input[${i}].content[${j}]`;
      if (typeof c?.text === "string" && c.text.startsWith("# AGENTS.md instructions for "))
        bad.push(...agentsBlock(c, where));
      else if (typeof c?.text === "string") bad.push(...prompt(c, where));
      else bad.push(...digest(c, where, undefined, c?.cwd !== undefined ? ["cwd"] : []));
      keep(kept, c);
    }),
  );
  return [...bad, ...identifiersOnly(body, "body", kept)];
}

function claudeRequestResidue(record: any): string[] {
  if (record.body === "") return [];
  const body = bodyOf(record);
  const bad: string[] = [];
  (Array.isArray(body.system) ? body.system : [body.system]).forEach((b: unknown, i: number) =>
    bad.push(...digest(b, `system[${i}]`)),
  );
  toolDigests(body, bad);
  const kept = new Set<unknown>();
  let files = 0;
  (body.messages ?? []).forEach((m: any, i: number) =>
    (m.content ?? []).forEach((c: any, j: number) => {
      const where = `messages[${i}].content[${j}]`;
      if (c?.kind === "claude.instructions") {
        bad.push(...filesDigest(c, where, "claude.instructions", []));
        files += Array.isArray(c.files) ? c.files.length : 0;
      } else if (typeof c?.text === "string") bad.push(...prompt(c, where));
      else bad.push(...digest(c, where, undefined, c?.cwd !== undefined ? ["cwd"] : []));
      keep(kept, c);
    }),
  );
  if (files === 0) bad.push("no instruction file kept");
  return [...bad, ...identifiersOnly(body, "body", kept)];
}

function openCodeRequestResidue(record: any): string[] {
  const body = bodyOf(record);
  const bad: string[] = [];
  if (body.tools !== undefined) toolDigests(body, bad);
  const kept = new Set<unknown>();
  (body.input ?? []).forEach((m: any, i: number) => {
    const items = Array.isArray(m.content) ? m.content : [m.content];
    items.forEach((c: any, j: number) => {
      const where = `input[${i}].content[${j}]`;
      if (c?.files !== undefined) bad.push(...filesDigest(c, where, m.role, ["cwd", "root"]));
      else if (typeof c?.text === "string") bad.push(...prompt(c, where));
      else bad.push(...digest(c, where));
      keep(kept, c);
    });
  });
  return [...bad, ...identifiersOnly(body, "body", kept)];
}

const CAPTURES: Record<string, (record: any) => string[]> = {
  "capture/claude-A.jsonl": claudeRequestResidue,
  "capture/claude-B.jsonl": claudeRequestResidue,
  "capture/opencode.jsonl": openCodeRequestResidue,
  "capture/codex-exec.jsonl": codexRequestResidue,
};
const records = (text: string) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const captureResidue = (rel: string, text: string) => {
  const check = CAPTURES[rel];
  if (!check) throw new Error(`no checker for ${rel}`);
  return records(text).flatMap((r, i) => check(r).map((p) => `${rel} line ${i + 1}: ${p}`));
};
const renderFiles = () =>
  walk(path.join(pilotDir, "codex-renders"), "codex-renders/").filter((f) => f.endsWith(".json"));
const thirdParty = () =>
  new Set(
    sums()
      .filter((s) => s.flags.includes("--third-party"))
      .map((s) => s.dst),
  );
const renderOf = (rel: string, text: string, third: Set<string>): string[] => {
  const json = JSON.parse(text);
  if (!Array.isArray(json) && json.schema === "ctxreach.map/v1") return []; // ctxreach's own map output
  return renderResidue(json, third.has(rel)).map((p) => `${rel} ${p}`);
};

/** A kept instruction file's path, as recorded, back to the pilot copy of that file (through SHA256SUMS-sources.txt). */
function pilotCopyOf(recorded: string): string | undefined {
  const src = recorded
    .replace(/^<scratch>[\\/]/, "")
    .split("\\")
    .join("/");
  return sums().find((s) => s.src === src)?.dst;
}
function keptFiles(rel: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const r of records(readPilot(rel))) {
    if (!r.body) continue;
    const body = JSON.parse(r.body);
    for (const m of [...(body.messages ?? []), ...(body.input ?? [])])
      for (const c of Array.isArray(m.content) ? m.content : [m.content]) out.push(...(c?.files ?? []));
  }
  return out;
}
/** Problems with kept files: each must be the pilot copy of the file it names, byte for byte. */
function filesResidue(files: { path: string; text: string }[], trailingNewline: boolean): string[] {
  return files.flatMap((f) => {
    const copy = pilotCopyOf(f.path);
    if (!copy) return [`${f.path}: not a file of the pilot's fixtures`];
    const text = readPilot(copy);
    // Claude Code drops the file's last newline; OpenCode keeps it.
    return (trailingNewline ? text : text.replace(/\n$/, "")) === f.text ? [] : [`${f.path}: not ${copy}`];
  });
}

describe("the vendors' prompt text, by shape", () => {
  it("keeps no fragment of Codex's own prompt: every item but the AGENTS.md block and the prompt is a digest", () => {
    const third = thirdParty();
    const renders = renderFiles();
    expect(renders.length).toBeGreaterThanOrEqual(20);
    expect(third.has("codex-renders/passlock-packages-server.json")).toBe(true);
    const found = renders.flatMap((rel) => renderOf(rel, readPilot(rel), third));
    found.push(...captureResidue("capture/codex-exec.jsonl", readPilot("capture/codex-exec.jsonl")));
    expect(found).toEqual([]);
  });

  it("keeps no fragment of Claude Code's or OpenCode's own prompt: instruction files, the prompt and the cwd only", () => {
    const found: string[] = [];
    for (const rel of ["capture/claude-A.jsonl", "capture/claude-B.jsonl", "capture/opencode.jsonl"])
      found.push(...captureResidue(rel, readPilot(rel)));
    expect(found).toEqual([]);
    // Every capture of the pilot has a checker.
    expect(
      walk(path.join(pilotDir, "capture"), "capture/").filter(
        (f) => f.endsWith(".jsonl") && !f.endsWith(".stdout.jsonl") && !(f in CAPTURES),
      ),
    ).toEqual([]);
  });

  it("each kept instruction file is the pilot's copy of that file, byte for byte, in the order the agent sent it", () => {
    const claudeA = keptFiles("capture/claude-A.jsonl");
    const claudeB = keptFiles("capture/claude-B.jsonl");
    const openCode = keptFiles("capture/opencode.jsonl");
    expect(filesResidue([...claudeA, ...claudeB], false)).toEqual([]);
    expect(filesResidue(openCode, true)).toEqual([]);
    // What the pilot observed (README, P-b and P-g), read from the kept files.
    const names = (files: { path: string }[]) => files.map((f) => pilotCopyOf(f.path));
    expect(names(claudeA)).toEqual([
      "capture/fixture/cfx/A/.claude/CLAUDE.md",
      "capture/fixture/cfx/A/repo/.claude/rules/style.md",
    ]);
    expect(names(claudeB)).toEqual([
      "capture/fixture/cfx/B/repo/.claude/rules/style.md",
      "capture/fixture/cfx/B/repo/AGENTS.md",
    ]);
    expect(names(openCode)).toEqual([
      "capture/fixture/ofx/repo/packages/api/AGENTS.md",
      "capture/fixture/ofx/repo/AGENTS.md",
    ]);
  });

  it("the shape checks fail on planted text: a kept vendor item, a label, a tool, a reminder, prose in a field", () => {
    const third = thirdParty();
    const rel = "codex-renders/cx/f.json";
    const clean = JSON.parse(readPilot(rel));
    const plantRender = (edit: (r: any) => void) => {
      const r = structuredClone(clean);
      edit(r);
      return renderOf(rel, JSON.stringify(r), third);
    };
    expect(renderOf(rel, JSON.stringify(clean), third)).toEqual([]);
    // A short fragment of prose, anywhere outside the AGENTS.md block.
    expect(plantRender((r) => (r[2].content[0] = { type: "input_text", text: "Do this, not that." }))).not.toEqual([]);
    expect(plantRender((r) => (r[0].id = "msg_1"))).not.toEqual([]);
    expect(plantRender((r) => (r[2].content[0].note = "kept"))).not.toEqual([]);
    const kinds = (r: any) => r[3].internal_chat_message_metadata_passthrough.content_item_kinds;
    expect(plantRender((r) => (kinds(r)[1] = "user.text"))).not.toEqual([]);
    expect(plantRender((r) => (r.at(-1).content[0].text = "Answer in French."))).not.toEqual([]);
    // Text after the AGENTS.md block's closing tag is not part of the block.
    expect(plantRender((r) => (r[3].content[0].text += "\ntrailing vendor words"))).not.toEqual([]);
    // The same render counted as someone else's repository: its AGENTS.md text must go too.
    expect(renderResidue(clean, true)).not.toEqual([]);

    const plantCapture = (file: string, line: number, edit: (body: any) => void) => {
      const lines = readPilot(file).split("\n");
      const record = JSON.parse(lines[line] ?? "");
      const body = JSON.parse(record.body);
      edit(body);
      lines[line] = JSON.stringify({ ...record, body: JSON.stringify(body) });
      return captureResidue(file, lines.join("\n"));
    };
    const claude = "capture/claude-A.jsonl";
    expect(plantCapture(claude, 1, () => undefined)).toEqual([]);
    expect(
      plantCapture(claude, 1, (b) => (b.system[2] = { type: "text", text: "You are a planted agent." })),
    ).not.toEqual([]);
    expect(plantCapture(claude, 1, (b) => (b.messages[0].content[0].files[0].label = "planted label"))).not.toEqual([]);
    expect(plantCapture(claude, 1, (b) => (b.messages[0].content[1] = { type: "text", text: "<x>" }))).not.toEqual([]);
    expect(plantCapture(claude, 1, (b) => (b.tools = [{ name: "Bash", description: "Runs it." }]))).not.toEqual([]);
    expect(plantCapture(claude, 1, (b) => (b.thinking.note = "think step by step"))).not.toEqual([]);
    expect(plantCapture(claude, 1, (b) => (b.messages[0].content[0].kind = "user.text"))).not.toEqual([]);
    const oc = "capture/opencode.jsonl";
    expect(plantCapture(oc, 1, () => undefined)).toEqual([]);
    expect(plantCapture(oc, 0, (b) => (b.input[1].content[0] = { type: "input_text", text: "Title:" }))).not.toEqual(
      [],
    );
    expect(plantCapture(oc, 1, (b) => (b.input[0].content.note = "You are planted."))).not.toEqual([]);
    expect(plantCapture(oc, 1, (b) => (b.tools[0] = { name: "bash", description: "Runs it." }))).not.toEqual([]);
    // A file whose text carries words the file does not hold.
    const files = keptFiles(oc);
    expect(filesResidue([{ ...files[0]!, text: files[0]!.text + "Instructions end here.\n" }], true)).not.toEqual([]);
    expect(filesResidue([{ ...files[0]!, path: "<scratch>\\elsewhere\\AGENTS.md" }], true)).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// By phrase.

/**
 * Phrases taken from the original recordings of 2026-09-30, one or more per
 * kind of vendor text, as the SHA-256 of their words: lower case, every run
 * of characters other than a-z and 0-9 a single space. `words` is how many;
 * `first` is the first 16 hex digits of the first word's SHA-256, so the scan
 * hashes a window only where a phrase could start.
 */
const VENDOR_PHRASES: { from: string; words: number; first: string; sha256: string }[] = [
  {
    from: "Claude Code 2.1.285, system prompt (identity line)",
    words: 7,
    first: "bb0347a468d97e98",
    sha256: "3ed4d24cc0294a84834102ff1cef612189866c3e0137aae98160cb99f908bbba",
  },
  {
    from: "Claude Code 2.1.285, system prompt",
    words: 12,
    first: "bb0347a468d97e98",
    sha256: "e7493542f40ea10d55fcd55a42837a601768587fedd01518e3e812bf8786b16a",
  },
  {
    from: "Claude Code 2.1.285, system prompt",
    words: 7,
    first: "7b0363b65576ead3",
    sha256: "a0bfc066f5639bf1bf72a5c6430e8ca8d166a0c91f5ab1ebde119ed1244e6ad0",
  },
  {
    from: "Claude Code 2.1.285, billing block",
    words: 4,
    first: "2d711642b726b044",
    sha256: "d9b518b8e8b928384d0df431ffac1e63ea7c7c6bcede323d3daee35fa555a152",
  },
  {
    from: "Claude Code 2.1.285, instruction reminder",
    words: 7,
    first: "6461554feca326ab",
    sha256: "b0495ea1aca649c07c876bdf10332293f046633ea06f33b90495408e0c35f3a0",
  },
  {
    from: "Claude Code 2.1.285, instruction reminder",
    words: 6,
    first: "b808e156d18d1cec",
    sha256: "40ed2591a05412a4aa1f015c736ac6c57773d4a17004dd688f775d8063d1e4e6",
  },
  {
    from: "Claude Code 2.1.285, context reminder",
    words: 13,
    first: "f4bf9f7fcbedaba0",
    sha256: "23f1b00c77d00937c5259c09d7853c85d421cc2608dd43ba1bc3ca6abe483d6d",
  },
  {
    from: "Claude Code 2.1.285, context reminder",
    words: 6,
    first: "c857d09db23e6822",
    sha256: "58dc2d82c9fe46e5fa8e9b11d075ff8304e43e8d2163c50da96a76d9369903e5",
  },
  {
    from: "Claude Code 2.1.285, environment block",
    words: 8,
    first: "bb0347a468d97e98",
    sha256: "68c3b71d18346b96127fe40b7e8c8bf85ece8dc734d8520685edd2be2b32bc60",
  },
  {
    from: "Codex 0.159.2, instructions",
    words: 9,
    first: "bb0347a468d97e98",
    sha256: "ca219d6e67d3f9459612b1a1bb6cc257bfe99627b2aad00774ba62dda1d0786a",
  },
  {
    from: "Codex 0.159.2, permissions instructions",
    words: 10,
    first: "cbf61858f3260072",
    sha256: "a45fd9d5977c2b5573bf5c41e5f2d41af28f3cd74c07eb27c68d0f1188573be1",
  },
  {
    from: "Codex 0.159.2, skills instructions",
    words: 10,
    first: "ca978112ca1bbdca",
    sha256: "d4fe2068ba7d00c415a17ac5cee7d949ddef71951cb2013682f71eac98e2e6a3",
  },
  {
    from: "Codex 0.159.2, collaboration mode",
    words: 6,
    first: "bb0347a468d97e98",
    sha256: "5d6b955f1cba47f9a4ca52255af797a8099e8e8076c0135e9ffc36cc2719ca54",
  },
  {
    from: "Codex 0.159.2, multi-agent role",
    words: 8,
    first: "b9776d7ddf459c9a",
    sha256: "faa8f0ea1075086888181ececfa26c59fff8bc8a95ed0999bd787783fcf0bb22",
  },
  {
    from: "Codex 0.159.2, exec_command tool",
    words: 8,
    first: "1f64fff08d787e73",
    sha256: "e113643352b7d8b97dfd5e3adafca6d59914cf16371e6090f5053fdb7f2f3349",
  },
  {
    from: "Codex 0.159.2, tool parameter",
    words: 7,
    first: "e0ee8bb50685e05f",
    sha256: "83661820daca5b5578184ec167806d003112af36748828f3ce36f75b4fd0fcac",
  },
  {
    from: "OpenCode 1.18.33, system prompt",
    words: 11,
    first: "bb0347a468d97e98",
    sha256: "2a0ab3a2ca232173311d508f96838a4ce6911305f00be45bdf3b6ebc2e334ed5",
  },
  {
    from: "OpenCode 1.18.33, title prompt",
    words: 11,
    first: "bb0347a468d97e98",
    sha256: "b59c3e61a2b9bae8e6a3a61648d0cd04071b49d6f0eb9f7f9bac53d1122731f3",
  },
  {
    from: "OpenCode 1.18.33, title request",
    words: 6,
    first: "24cacf5004bf68ae",
    sha256: "86adcbd17806ca146fd82d80ee042b236ac1f3518da6455064712d3916d75c94",
  },
  {
    from: "OpenCode 1.18.33, bash tool",
    words: 10,
    first: "6be95b08e946e5ad",
    sha256: "6ed4ed960f2591ee326e4933d01452983bb16a9837e636be73cd302c1ae58734",
  },
  {
    from: "OpenCode 1.18.33, bash tool parameter",
    words: 13,
    first: "b9776d7ddf459c9a",
    sha256: "770437127e3eb91afc28ec346cc4490f972a700a0d8bd43052f363782609b90d",
  },
  {
    from: "OpenCode 1.18.33, edit tool",
    words: 6,
    first: "5dbc14b928678fd2",
    sha256: "3d28a026d04f804c568d99314df0138dc030222d5a21759acfb311185534efb0",
  },
  {
    from: "a Claude skill description in OpenCode's prompt",
    words: 13,
    first: "3316348dbadfb7b1",
    sha256: "898ddfcb01b90b149cb90bb929e3888afd9aafd47a12c6b10a665ea241d39cf9",
  },
];

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** Words, read through JSON escapes (a string inside a string inside a file) as well as plain text. */
const words = (s: string) =>
  s
    .replace(/\\+u[0-9a-fA-F]{4}/g, " ")
    .replace(/\\+[nrt"\\/]/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/** Every string in a JSON value, a JSON string inside it parsed in turn. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") {
    out.push(v);
    if (/^\s*[[{]/.test(v))
      try {
        strings(JSON.parse(v), out);
      } catch {
        // not JSON after all
      }
  } else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}
/** The texts of one file to scan: the file as it is, and, for JSON, every string in it. */
function textsOf(name: string, text: string): string[] {
  const out = [text];
  const json = (t: string) => {
    try {
      out.push(...strings(JSON.parse(t)));
    } catch {
      // not JSON
    }
  };
  if (name.endsWith(".jsonl")) text.split("\n").filter(Boolean).forEach(json);
  else if (name.endsWith(".json")) json(text);
  return out;
}
type Phrase = { from: string; words: number; first: string; sha256: string };
const firstOf = (word: string) => sha256(word).slice(0, 16);
/** The phrases of `list` that appear in `texts`. */
function phrasesIn(texts: string[], list: Phrase[] = VENDOR_PHRASES): string[] {
  const starting = new Map<string, Phrase[]>();
  for (const p of list) starting.set(p.first, [...(starting.get(p.first) ?? []), p]);
  const firsts = new Map<string, Phrase[] | undefined>();
  const found = new Set<string>();
  for (const t of texts) {
    const w = words(t);
    for (let i = 0; i < w.length; i++) {
      const word = w[i]!;
      if (!firsts.has(word)) firsts.set(word, starting.get(firstOf(word)));
      for (const p of firsts.get(word) ?? [])
        if (i + p.words <= w.length && sha256(w.slice(i, i + p.words).join(" ")) === p.sha256)
          found.add(`${p.from} (${p.sha256.slice(0, 12)})`);
    }
  }
  return [...found];
}

describe("the vendors' prompt text, by phrase", () => {
  it("no file under study/, nor any study test, holds a phrase of Claude Code's, Codex's or OpenCode's prompt", () => {
    const files = [
      ...walk(path.join(ROOT, "study"), "study/"),
      ...readdirSync(path.join(ROOT, "test"))
        .filter((f) => f.startsWith("study-"))
        .map((f) => `test/${f}`),
    ];
    expect(files.length).toBeGreaterThan(150);
    const found = files.flatMap((f) =>
      phrasesIn(textsOf(f, readFileSync(path.join(ROOT, ...f.split("/")), "utf8"))).map((p) => `${f}: ${p}`),
    );
    expect(found).toEqual([]);
  });

  it("the phrase scan finds a phrase in any case and spacing, inside a JSON string inside a JSON string", () => {
    const planted = [
      { from: "planted", words: 4, first: firstOf("ctxreach"), sha256: sha256("ctxreach planted vendor phrase") },
    ];
    const nested = JSON.stringify({
      body: JSON.stringify({ system: [{ text: "Intro.\nCtxreach  PLANTED\nvendor-phrase, then more." }] }),
    });
    expect(phrasesIn(textsOf("x.jsonl", nested), planted)).toEqual([`planted (${planted[0]!.sha256.slice(0, 12)})`]);
    expect(phrasesIn(textsOf("x.md", "a ctxreach planted vendor phrase."), planted)).toHaveLength(1);
    // Clean twins: the same words out of order, or one missing, are not the phrase.
    expect(phrasesIn(textsOf("x.md", "planted ctxreach vendor phrase"), planted)).toEqual([]);
    expect(phrasesIn(textsOf("x.md", "ctxreach planted phrase"), planted)).toEqual([]);
    // A phrase whose first word is listed wrong is never found: the two hashes must agree.
    expect(
      phrasesIn(textsOf("x.md", "ctxreach planted vendor phrase"), [{ ...planted[0]!, first: firstOf("planted") }]),
    ).toEqual([]);
    // Every listed phrase has the length it claims and its hashes.
    for (const p of VENDOR_PHRASES) {
      expect(p.first, p.from).toMatch(/^[0-9a-f]{16}$/);
      expect(p.words, p.from).toBeGreaterThanOrEqual(4);
      expect(p.sha256, p.from).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // The originals stay on the machine that recorded them (CTXR_SCRATCH, as for
  // `redact.mjs --all`). Where they are, the list and the reduction are checked
  // against them: every phrase is in them, and every pilot file is its original
  // reduced, so the list can fail and the copies are what redact.mjs makes.
  const scratch = process.env.CTXR_SCRATCH;
  it.runIf(scratch !== undefined && existsSync(scratch ?? ""))(
    "with the originals: every phrase is in them, and every pilot file is its original reduced",
    () => {
      const originals = sums().map((s) => ({ ...s, path: path.join(scratch!, ...s.src.split("/")) }));
      const texts = originals.flatMap((o) => textsOf(o.src, readFileSync(o.path, "utf8").replace(/^\uFEFF/, "")));
      expect(phrasesIn(texts).length).toBe(VENDOR_PHRASES.length);
      const lf = (s: string) => s.replace(/\r\n/g, "\n");
      const differ: string[] = [];
      for (const o of originals) {
        const bytes = readFileSync(o.path);
        expect(createHash("sha256").update(bytes).digest("hex"), o.src).toBe(o.sha256);
        const out = redact.reduce(bytes.toString("utf8"), path.basename(o.path), o.flags);
        if (lf(out) !== lf(readPilot(o.dst))) differ.push(o.dst);
      }
      expect(differ).toEqual([]);
    },
  );
});
