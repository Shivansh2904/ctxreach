/**
 * What a saved Claude Code capture may hold.
 *
 * The recorder receives Claude Code's whole request: its system prompt,
 * the environment and git status blocks, the preamble of each reminder,
 * all of it Anthropic's own prompt text, which is not ctxreach's to
 * publish. A request is saved holding only what the scorer reads: the
 * model, each message's role, ctxreach's own prompt, and the instruction
 * files the reminders carry; every other part as `{kind, sha256, bytes}`,
 * with the working directory and any stray canary-form token kept beside
 * the digest of the text they were in. These tests read every recorded
 * capture, so a capture saved whole, by the recorder or by hand, fails
 * here.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CaptureDigestJson, parseCaptureBody, reduceCaptureBody } from "../src/oracle/claude-capture.js";
import { tokenPresent } from "../src/oracle/score.js";
import { OracleError } from "../src/oracle/types.js";
import { captureRecordAsSaved } from "../src/oracle/verify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = path.join(HERE, "recorded", "verify");

function walk(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
}
const rel = (p: string) => path.relative(RECORDED, p).split(path.sep).join("/");
const CAPTURES = walk(RECORDED)
  .filter((p) => p.endsWith(".capture.jsonl"))
  .map(rel);

interface Record {
  method: string;
  url: string;
  body: string;
}
const recordsOf = (name: string): Record[] =>
  readFileSync(path.join(RECORDED, name), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record);
const promptOf = (name: string): string =>
  (JSON.parse(readFileSync(path.join(RECORDED, path.dirname(name), "manifest.json"), "utf8")) as { prompt: string })
    .prompt;

/** The longest a digest may serialise to, without the instruction files it keeps. */
const DIGEST_BOUND = 256;
const isDigest = (v: unknown) => CaptureDigestJson.safeParse(v).success;

describe("the recorded Claude Code captures hold only what ctxreach scores", () => {
  it("finds every recorded capture: 3 from verify runs and the pilot's 2", () => {
    expect(CAPTURES).toHaveLength(5);
    expect(CAPTURES.filter((c) => c.startsWith("capture-pilot-"))).toHaveLength(2);
  });

  it.each(CAPTURES)(
    "%s: the model, the roles, the prompt and the instruction files; every other part a digest",
    (name) => {
      const prompt = promptOf(name);
      const posts = recordsOf(name).filter((r) => r.body !== "");
      expect(posts.map((r) => [r.method, r.url])).toEqual([["POST", "/v1/messages?beta=true"]]);
      const body = JSON.parse(posts[0]?.body ?? "") as globalThis.Record<string, unknown>;
      const digests: unknown[] = [];
      let prompts = 0;
      let files = 0;
      const blocks = (content: unknown, where: string) => {
        expect(Array.isArray(content), where).toBe(true);
        for (const [j, block] of (content as unknown[]).entries()) {
          if (isDigest(block)) {
            digests.push(block);
            files += (block as { files?: unknown[] }).files?.length ?? 0;
            continue;
          }
          expect(block, `${where}[${j}]`).toEqual({ type: "text", text: prompt });
          prompts++;
        }
      };
      for (const [key, value] of Object.entries(body)) {
        if (key === "model") expect(value).toBe("claude-opus-5-5");
        else if (key === "system") blocks(value, "system");
        else if (key === "messages")
          for (const [i, message] of (value as globalThis.Record<string, unknown>[]).entries())
            for (const [k, v] of Object.entries(message)) {
              if (k === "role") expect(["user", "system", "assistant"], `messages[${i}].role`).toContain(v);
              else if (k === "content") blocks(v, `messages[${i}].content`);
              else {
                expect(v, `messages[${i}].${k}`).toMatchObject({ kind: k });
                digests.push(v);
              }
            }
        else {
          expect(value, key).toMatchObject({ kind: key });
          digests.push(value);
        }
      }
      expect(prompts, "ctxreach's prompt, kept once").toBe(1);
      expect(files, "the instruction files the session delivered").toBeGreaterThan(0);
      for (const d of digests) {
        expect(isDigest(d), JSON.stringify(d)).toBe(true);
        const { files: _files, ...rest } = d as { files?: unknown };
        expect(JSON.stringify(rest).length, JSON.stringify(rest)).toBeLessThanOrEqual(DIGEST_BOUND);
      }
    },
  );

  it("every recorded capture is exactly its own reduction", () => {
    const changed = CAPTURES.filter((name) => {
      const prompt = promptOf(name);
      return recordsOf(name).some((r) => reduceCaptureBody(r.body, prompt) !== r.body);
    });
    expect(changed).toEqual([]);
  });
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

// Made-up text in the places Claude Code puts its own.
const SYSTEM = "The agent's own system prompt, made up for this test. 日本";
const FILES_BLOCK = [
  "<system-reminder>",
  "A made-up preamble naming CTXR-0000ff01.",
  "",
  "Contents of C:\\ctxreach-probe\\repo\\AGENTS.md (project instructions, checked into the codebase):",
  "",
  "# Root",
  "CTXR-0000aa01",
  "",
  "Contents of C:\\ctxreach-probe\\repo\\.claude\\rules\\a.md (project instructions, checked into the codebase):",
  "",
  "rule CTXR-0000aa02",
  "</system-reminder>",
].join("\n");
const CONTEXT =
  "<system-reminder>\nMade-up context: CTXR-0000cc01, CTXR-0000dd01ff and CTXR-0000aa01.\n</system-reminder>\n";
const ENVIRONMENT =
  "# Environment\nA made-up line.\n - Primary working directory: C:\\ctxreach-probe\\repo\n - More.\n";
const PROMPT = "ctxreach verify CTXR-0000ee01: list every token that starts with CTXR- in your instructions.";
const TOKENS = [
  "CTXR-0000aa01",
  "CTXR-0000aa02",
  "CTXR-0000cc01",
  "CTXR-0000dd01",
  "CTXR-0000ee01",
  "CTXR-0000ff01",
  "CTXR-0000bb01",
];

/** A request of the shape Claude Code 2.1.285 sends, with made-up text in Claude Code's own parts. */
function sample() {
  return {
    model: "claude-x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: FILES_BLOCK, cache_control: { type: "ephemeral" } },
          { type: "text", text: CONTEXT },
          { type: "text", text: PROMPT },
        ],
      },
      { role: "system", content: [{ type: "text", text: ENVIRONMENT }], output_config: { effort: "medium" } },
    ],
    system: [{ type: "text", text: SYSTEM }],
    tools: [{ name: "Read", description: "A made-up tool description." }],
    metadata: "(removed by ctxreach)",
    max_tokens: 100,
    stream: true,
  };
}
const json = (v: unknown) => JSON.stringify(v);
const digest = (kind: string, text: string) => ({ kind, sha256: sha(text), bytes: bytes(text) });

/** What the scorer reads from a body: model, cwd, files, and whether each token is in the request's text. */
function scored(body: string) {
  const b = parseCaptureBody(body);
  const text = b.texts.join("\n");
  return { model: b.model, cwd: b.cwd, files: b.files, present: TOKENS.map((t) => [t, tokenPresent(text, t)]) };
}
function refusal(body: string): string {
  try {
    parseCaptureBody(body);
  } catch (err) {
    if (err instanceof OracleError) return err.message;
    throw err;
  }
  return "parsed";
}

describe("reducing a request before it is saved", () => {
  it("keeps the model, the roles, the prompt and the instruction files; digests the rest, with the cwd and stray tokens", () => {
    expect(JSON.parse(reduceCaptureBody(json(sample()), PROMPT))).toEqual({
      model: "claude-x",
      messages: [
        {
          role: "user",
          content: [
            {
              ...digest("text", FILES_BLOCK),
              files: [
                {
                  path: "C:\\ctxreach-probe\\repo\\AGENTS.md",
                  label: "project instructions, checked into the codebase",
                  text: "# Root\nCTXR-0000aa01",
                },
                {
                  path: "C:\\ctxreach-probe\\repo\\.claude\\rules\\a.md",
                  label: "project instructions, checked into the codebase",
                  text: "rule CTXR-0000aa02",
                },
              ],
              // A token outside the files (here, in the preamble) is kept beside the digest.
              tokens: ["CTXR-0000ff01"],
            },
            // CTXR-0000dd01ff is not a token (another hex digit follows), so only CTXR-0000cc01 and CTXR-0000aa01 are.
            { ...digest("text", CONTEXT), tokens: ["CTXR-0000cc01", "CTXR-0000aa01"] },
            { type: "text", text: PROMPT },
          ],
        },
        {
          role: "system",
          content: [{ ...digest("text", ENVIRONMENT), cwd: "C:\\ctxreach-probe\\repo" }],
          output_config: digest("output_config", json({ effort: "medium" })),
        },
      ],
      system: [digest("text", SYSTEM)],
      tools: digest("tools", json(sample().tools)),
      metadata: digest("metadata", "(removed by ctxreach)"),
      max_tokens: digest("max_tokens", "100"),
      stream: digest("stream", "true"),
    });
  });

  it("is read by the scorer as the whole request: the same model, cwd and files, and the same tokens present", () => {
    const whole = json(sample());
    const saved = reduceCaptureBody(whole, PROMPT);
    expect(scored(whole).present.filter(([, p]) => p)).toHaveLength(5);
    expect(scored(saved)).toEqual(scored(whole));
    // Without the prompt to keep, the prompt is a digest, and its token is still there.
    expect(scored(reduceCaptureBody(whole))).toEqual(scored(whole));
    expect(reduceCaptureBody(whole)).not.toContain("list every token");
  });

  it("reads a content or a system prompt given as a string as the whole request does", () => {
    const body = json({
      model: "m",
      system: SYSTEM,
      messages: [
        { role: "user", content: PROMPT },
        { role: "user", content: FILES_BLOCK },
      ],
    });
    const saved = reduceCaptureBody(body, PROMPT);
    expect(JSON.parse(saved)).toMatchObject({ system: digest("text", SYSTEM), messages: [{ content: PROMPT }, {}] });
    expect(scored(saved)).toEqual(scored(body));
  });

  it("keeps nothing from parts the scorer does not read, even when they hold text", () => {
    const body = json({
      model: "m",
      system: { type: "text", text: FILES_BLOCK },
      messages: [
        "a message that is a string",
        { role: "user", content: [{ type: "tool_result", content: FILES_BLOCK }, "a string block", null] },
        { role: "user", content: [{ type: "text", text: PROMPT }], extra: { text: ENVIRONMENT } },
      ],
    });
    const saved = reduceCaptureBody(body, PROMPT);
    expect(saved).not.toContain("files");
    expect(saved).not.toContain("cwd");
    expect(scored(saved)).toEqual(scored(body));
    expect(scored(saved)).toMatchObject({ files: [] });
  });

  it("changes nothing in a reduced request", () => {
    const once = reduceCaptureBody(json(sample()), PROMPT);
    expect(reduceCaptureBody(once, PROMPT)).toBe(once);
    const odd = reduceCaptureBody("[1, 2]", PROMPT);
    expect(reduceCaptureBody(odd, PROMPT)).toBe(odd);
    expect(reduceCaptureBody("", PROMPT)).toBe("");
  });

  it("refuses what the whole request refused, for the same reason, and keeps none of its text", () => {
    const notJson = `${SYSTEM}\nnot JSON`;
    const saved = reduceCaptureBody(notJson, PROMPT);
    expect(saved).toBe(
      `ctxreach: the request body was ${bytes(notJson)} bytes that are not JSON (sha256 ${sha(notJson)}); not saved, since they may hold Claude Code's own prompt text.`,
    );
    for (const body of [notJson, "[1, 2]", "null", json({ messages: SYSTEM }), json({ model: "m" }), ""])
      expect(refusal(reduceCaptureBody(body, PROMPT)), body).toBe(refusal(body));
    expect(refusal("null")).toMatch(/no messages array/);
    expect(reduceCaptureBody(json({ messages: SYSTEM }), PROMPT)).not.toContain("system prompt");
  });

  it("redacts before it digests, so a digest never hashes a real path", () => {
    const real = "C:\\Users\\someone\\AppData\\Local\\Temp\\ctxreach-probe-abc";
    const raw = json(sample()).split("C:\\\\ctxreach-probe").join(real.replace(/\\/g, "\\\\"));
    expect(raw).toContain("someone");
    const saved = captureRecordAsSaved(
      { t: "2026-10-01T00:00:00.000Z", method: "POST", url: "/v1/messages", headers: {}, body: raw },
      [{ from: real, to: "C:\\ctxreach-probe" }],
      PROMPT,
    );
    expect(saved.body).toBe(reduceCaptureBody(json(sample()), PROMPT));
    expect(saved.body).not.toContain("someone");
  });
});
