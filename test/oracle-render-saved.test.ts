/**
 * What a saved Codex render may hold.
 *
 * `codex debug prompt-input` prints Codex's whole model input, and most of
 * it is OpenAI's own prompt text (the developer items: skills, permissions,
 * collaboration mode, multi-agent role), which is not ctxreach's to
 * publish. A render is saved holding only what ctxreach scores: the
 * `agents_md.instructions` item and ctxreach's own prompt (`user.text`),
 * whole; every other content item as `{kind, sha256, bytes}`, and the
 * environment context also as the one field the scorer reads, its `<cwd>`.
 * These tests read every recorded render, so a render saved whole, by the
 * recorder or by hand, fails here.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENTS_KIND, ENVIRONMENT_KIND, parseRender, reduceRender, USER_KIND } from "../src/oracle/codex-render.js";
import { RenderShapeError } from "../src/oracle/types.js";
import { renderAsSaved } from "../src/oracle/verify.js";

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
const FILES = walk(RECORDED);
const RENDERS = FILES.filter((p) => p.endsWith(".render.json")).map(rel);

/**
 * Markup only Codex's own items carry: the tag each developer item of
 * 0.159.2 opens with, and the environment context's fields other than the
 * cwd. Phrases of the items' text are looked for, as hashes, in
 * test/oracle-vendor-text.test.ts.
 */
const CODEX_OWN = [
  "<skills_instructions>",
  "<permissions instructions>",
  "<collaboration_mode>",
  "<multi_agent_role>",
  "<multi_agent_mode>",
  "<shell>",
  "<timezone>",
  "<permission_profile",
];

/** The longest a non-AGENTS content item may serialise to: a digest with a cwd, or ctxreach's one-line prompt. */
const ITEM_BOUND = 256;
const ITEM_KEYS = ["content", "internal_chat_message_metadata_passthrough", "role", "type"];

interface SavedItem {
  [key: string]: unknown;
  content: Record<string, unknown>[];
  internal_chat_message_metadata_passthrough?: { content_item_kinds?: string[] };
}

describe("the recorded Codex renders hold only what ctxreach scores", () => {
  it("finds every recorded render: 48 from verify runs and the pilot's 3", () => {
    expect(RENDERS).toHaveLength(51);
    expect(RENDERS.filter((r) => r.startsWith("codex-pilot/"))).toHaveLength(3);
  });

  it("no recorded file, render or manifest, holds text of Codex's own items", () => {
    const hits = FILES.flatMap((p) => {
      const text = readFileSync(p, "utf8");
      return CODEX_OWN.filter((s) => text.includes(s)).map((s) => `${rel(p)}: ${s}`);
    });
    expect(hits).toEqual([]);
  });

  it.each(RENDERS)(
    "%s: the AGENTS block and the prompt whole, every other item a digest of at most 256 characters",
    (name) => {
      const items = JSON.parse(readFileSync(path.join(RECORDED, name), "utf8")) as SavedItem[];
      let agents = 0;
      for (const [i, item] of items.entries()) {
        expect(
          Object.keys(item).filter((k) => !ITEM_KEYS.includes(k)),
          `$[${i}]`,
        ).toEqual([]);
        const meta = item.internal_chat_message_metadata_passthrough;
        expect(Object.keys(meta ?? {}), `$[${i}].internal_chat_message_metadata_passthrough`).toEqual([
          "content_item_kinds",
        ]);
        const kinds = meta?.content_item_kinds ?? [];
        expect(kinds, `$[${i}]: one kind per content item`).toHaveLength(item.content.length);
        item.content.forEach((block, j) => {
          const where = `$[${i}].content[${j}] (${kinds[j]})`;
          if (kinds[j] === AGENTS_KIND) {
            agents++;
            expect(String(block.text), where).toMatch(/^# AGENTS\.md instructions for /);
            return;
          }
          expect(JSON.stringify(block).length, where).toBeLessThanOrEqual(ITEM_BOUND);
          if (kinds[j] === USER_KIND) {
            expect(Object.keys(block).sort(), where).toEqual(["text", "type"]);
            return;
          }
          expect(block, where).not.toHaveProperty("text");
          expect(block, where).toMatchObject({ kind: kinds[j], sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
          expect(Number.isInteger(block.bytes) && (block.bytes as number) > 0, where).toBe(true);
        });
      }
      // Every render holds one AGENTS block, except the pilot's untrusted project, where Codex rendered none.
      expect(agents).toBe(name === "codex-pilot/untrusted-toml.render.json" ? 0 : 1);
    },
  );
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const meta = (kinds: string[]) => ({
  turn_id: "auto-compact-0",
  create_time: 1790804773.45,
  content_item_kinds: kinds,
});
const text = (t: string) => ({ type: "input_text", text: t });
const DEVELOPER =
  "<permissions instructions>\nWhatever Codex says about its sandbox, 日本.\n</permissions instructions>";
const COLLABORATION = "<collaboration_mode>x</collaboration_mode>";
const ENVIRONMENT =
  "<environment_context>\n  <cwd>C:\\ctxreach-probe\\repo</cwd>\n  <shell>powershell</shell>\n</environment_context>";
const AGENTS =
  "# AGENTS.md instructions for C:\\ctxreach-probe\\repo\n\n<INSTRUCTIONS>\n# Root\nCTXR-0000aa01\n</INSTRUCTIONS>";
const PROMPT = "ctxreach verify CTXR-0000cc01: list every token that starts with CTXR- in your instructions.";

/** A render of the shape Codex 0.159.2 prints, with made-up text in Codex's own items. */
function sample(environment = ENVIRONMENT) {
  return [
    {
      type: "message",
      id: "msg_1",
      role: "developer",
      content: [text(DEVELOPER), text(COLLABORATION)],
      internal_chat_message_metadata_passthrough: meta(["permissions.instructions", "collaboration_mode.instructions"]),
    },
    {
      type: "message",
      id: "msg_2",
      role: "user",
      content: [text(AGENTS), text(environment)],
      internal_chat_message_metadata_passthrough: meta([AGENTS_KIND, ENVIRONMENT_KIND]),
    },
    {
      type: "message",
      id: "msg_3",
      role: "user",
      content: [text(PROMPT)],
      internal_chat_message_metadata_passthrough: meta([USER_KIND]),
    },
  ];
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
/** The message `parseRender` refuses a render with, or "parsed". */
function refusal(raw: string): string {
  try {
    parseRender(raw);
  } catch (err) {
    if (err instanceof RenderShapeError) return err.message;
    throw err;
  }
  return "parsed";
}

describe("reducing a render before it is saved", () => {
  it("keeps the AGENTS block and the prompt whole, digests every other item, and drops ids and timestamps", () => {
    expect(reduceRender(sample())).toEqual([
      {
        type: "message",
        role: "developer",
        content: [
          { kind: "permissions.instructions", sha256: sha(DEVELOPER), bytes: DEVELOPER.length + 4 },
          { kind: "collaboration_mode.instructions", sha256: sha(COLLABORATION), bytes: COLLABORATION.length },
        ],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["permissions.instructions", "collaboration_mode.instructions"],
        },
      },
      {
        type: "message",
        role: "user",
        content: [
          text(AGENTS),
          {
            kind: ENVIRONMENT_KIND,
            sha256: sha(ENVIRONMENT),
            bytes: ENVIRONMENT.length,
            cwd: "C:\\ctxreach-probe\\repo",
          },
        ],
        internal_chat_message_metadata_passthrough: { content_item_kinds: [AGENTS_KIND, ENVIRONMENT_KIND] },
      },
      {
        type: "message",
        role: "user",
        content: [text(PROMPT)],
        internal_chat_message_metadata_passthrough: { content_item_kinds: [USER_KIND] },
      },
    ]);
  });

  it("parses to exactly what the whole render parses to", () => {
    const whole = parseRender(json(sample()));
    expect(whole).toMatchObject({ body: "# Root\nCTXR-0000aa01", environmentCwd: "C:\\ctxreach-probe\\repo" });
    expect(parseRender(json(reduceRender(sample())))).toEqual(whole);
  });

  it("changes nothing in a reduced render, and every recorded render is exactly its own reduction", () => {
    const once = json(reduceRender(sample()));
    expect(json(reduceRender(JSON.parse(once)))).toBe(once);
    const changed = RENDERS.filter((name) => {
      const saved = readFileSync(path.join(RECORDED, name), "utf8");
      return json(reduceRender(JSON.parse(saved))) !== saved;
    });
    expect(changed).toEqual([]);
  });

  it("refuses what the whole render refused, for the same reason", () => {
    // No kinds: nothing can be told to be the AGENTS block, so everything is digested; still no environment item.
    const untagged = sample().map(({ internal_chat_message_metadata_passthrough: _, ...rest }) => rest);
    expect(refusal(json(untagged))).toMatch(/content_item_kinds: no item carries environments/);
    expect(refusal(json(reduceRender(untagged)))).toBe(refusal(json(untagged)));
    expect(json(reduceRender(untagged))).not.toContain("<permissions instructions>");
    // An environment context without a <cwd> keeps a null cwd, and fails as it did.
    const noCwd = sample("<environment_context>\n  <shell>bash</shell>\n</environment_context>");
    expect(refusal(json(noCwd))).toBe("$[1].content: no <environment_context> with a <cwd>");
    expect(refusal(json(reduceRender(noCwd)))).toBe(refusal(json(noCwd)));
    // Not a list of messages: still refused, and its text is not kept.
    expect(refusal(json(reduceRender({ prompt: DEVELOPER })))).toMatch(/^\$: /);
    expect(json(reduceRender({ prompt: DEVELOPER }))).not.toContain("permissions");
  });

  it("digests every item of a message whose kinds do not line up with its content, so the run fails instead of guessing", () => {
    // Three kinds for two items: the whole render parses, but which item is the AGENTS block cannot be told.
    const misaligned = sample();
    misaligned[1]!.internal_chat_message_metadata_passthrough.content_item_kinds = [
      AGENTS_KIND,
      ENVIRONMENT_KIND,
      USER_KIND,
    ];
    expect(refusal(json(misaligned))).toBe("parsed");
    const saved = json(reduceRender(misaligned));
    expect(saved).not.toContain("# AGENTS.md instructions for");
    expect(refusal(saved)).toMatch(/^\$\[1\]\.content: the item tagged agents_md\.instructions has no/);
  });

  it("does not save output that is not JSON: a line with its length and hash stands in, and fails the same way", () => {
    const out = `${DEVELOPER}\nnot JSON`;
    const saved = renderAsSaved(out, []);
    expect(saved).toBe(
      `ctxreach: codex printed ${Buffer.byteLength(out)} bytes that are not JSON (sha256 ${sha(out)}); not saved, since they may hold Codex's own prompt text.\n`,
    );
    expect(refusal(saved)).toBe("$: the render is not JSON");
    expect(refusal(saved)).toBe(refusal(out));
    expect(renderAsSaved("", [])).toBe("");
  });

  it("redacts before it digests, so a digest never hashes a real path", () => {
    const real = "C:\\Users\\someone\\AppData\\Local\\Temp\\ctxreach-probe-abc";
    const raw = JSON.stringify(sample(ENVIRONMENT.replace("C:\\ctxreach-probe", real)));
    const saved = JSON.parse(renderAsSaved(raw, [{ from: real, to: "C:\\ctxreach-probe" }])) as {
      content: Record<string, unknown>[];
    }[];
    expect(saved[1]?.content[1]).toMatchObject({ sha256: sha(ENVIRONMENT), cwd: "C:\\ctxreach-probe\\repo" });
    expect(JSON.stringify(saved)).not.toContain("someone");
  });
});
