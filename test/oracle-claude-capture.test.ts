import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertCaptureVersion,
  assertNoKillSwitch,
  captureArgs,
  captureEnv,
  DUMMY_API_KEY,
  filesInReminder,
  hasAgentsMdPlugin,
  initInfo,
  parseCaptureBody,
  stripHtmlComments,
} from "../src/oracle/claude-capture.js";
import { OracleError } from "../src/oracle/types.js";

const RECORDED = path.join(path.dirname(fileURLToPath(import.meta.url)), "recorded", "verify");

function pilotBody(name: string): string {
  const lines = readFileSync(path.join(RECORDED, name, "trial-1.capture.jsonl"), "utf8")
    .trim()
    .split("\n");
  const post = lines.map((l) => JSON.parse(l) as { method: string; body: string }).find((r) => r.method === "POST");
  if (!post) throw new Error(`${name}: no POST record`);
  return post.body;
}

describe("reading a captured Claude Code request (2.1.285, recorded 2026-09-30)", () => {
  it("finds the instruction files in the system-reminder, with their paths and labels, and the model and cwd", () => {
    const body = parseCaptureBody(pilotBody("capture-pilot-A"));
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.cwd).toBe("C:\\ctxreach-probe\\repo");
    expect(body.files.map((f) => [f.path, f.label])).toEqual([
      ["C:\\ctxreach-probe\\.claude\\CLAUDE.md", "project instructions, checked into the codebase"],
      ["C:\\ctxreach-probe\\repo\\.claude\\rules\\style.md", "project instructions, checked into the codebase"],
    ]);
    expect(body.files.map((f) => f.text)).toEqual([
      "Ancestor dot-claude CLAUDE.md CTXR-A0000e01",
      "Style rule CTXR-A0000c01",
    ]);
    // The pilot's prompt is kept whole; the recording holds the rest of the request as digests.
    expect(body.texts.some((t) => t.includes("List every token that starts with CTXR-"))).toBe(true);
    // Nothing of the account or the session id survives in the recording.
    expect(pilotBody("capture-pilot-A")).not.toMatch(/device_id|account_uuid/);
  });

  it("keeps a file's text byte for byte, including its own blank lines", () => {
    const body = parseCaptureBody(pilotBody("capture-pilot-B"));
    expect(body.files.map((f) => path.basename(f.path))).toEqual(["style.md", "AGENTS.md"]);
    expect(body.files[1]?.text).toBe(
      "# Root agents\nCTXR-B0000a01 root AGENTS head\nUse pnpm.\nCTXR-B0000a02 root AGENTS tail",
    );
  });

  it("splits sections on header lines only, so a file that mentions 'Contents of' is not split", () => {
    const reminder = [
      "A preamble line.",
      "",
      "Contents of C:\\repo\\CLAUDE.md (project instructions, checked into the codebase):",
      "",
      "line one",
      "",
      "Contents of the fridge: milk",
      "",
      "Contents of C:\\repo\\.claude\\rules\\a.md (project instructions, checked into the codebase):",
      "",
      "rule",
    ].join("\n");
    expect(filesInReminder(reminder)).toEqual([
      {
        path: "C:\\repo\\CLAUDE.md",
        label: "project instructions, checked into the codebase",
        text: "line one\n\nContents of the fridge: milk",
      },
      {
        path: "C:\\repo\\.claude\\rules\\a.md",
        label: "project instructions, checked into the codebase",
        text: "rule",
      },
    ]);
  });

  it("rejects a body that is not a messages request", () => {
    expect(() => parseCaptureBody("nope")).toThrow(OracleError);
    expect(() => parseCaptureBody("{}")).toThrow(/no messages array/);
    for (const body of ["null", "[]", "7"]) expect(() => parseCaptureBody(body), body).toThrow(/no messages array/);
  });

  it("strips whole-line HTML comments as Claude Code does, and leaves inline ones", () => {
    expect(stripHtmlComments("a\n<!-- maintainer note -->\nb\n  <!-- multi\nline -->\nc <!-- inline --> d\n")).toBe(
      "a\nb\nc <!-- inline --> d\n",
    );
  });
});

describe("the session's own facts", () => {
  const init = JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "C:\\copy",
    tools: [],
    model: "claude-x",
    claude_code_version: "2.1.285",
    plugins: [
      { name: "agents-md", path: "builtin", source: "agents-md@builtin" },
      { name: "telemetry", path: "builtin", source: "telemetry@builtin" },
    ],
  });

  it("reads cwd, model, version and plugins from system/init, and tolerates everything else", () => {
    const info = initInfo(`{"type":"rate_limit_event"}\n${init}\n{"type":"result"}\nnot json\n`);
    expect(info).toEqual({
      found: true,
      cwd: "C:\\copy",
      model: "claude-x",
      version: "2.1.285",
      plugins: ["agents-md@builtin", "telemetry@builtin"],
    });
    expect(hasAgentsMdPlugin(info)).toBe(true);
    expect(hasAgentsMdPlugin({ found: true, plugins: ["telemetry@builtin"] })).toBe(false);
    // 2.1.285 names the built-in cc-plugin-agents-md@builtin (recorded 2026-09-30); 2.1.280 named it agents-md@builtin.
    expect(hasAgentsMdPlugin({ found: true, plugins: ["cc-plugin-agents-md@builtin"] })).toBe(true);
    expect(initInfo("")).toEqual({ found: false, plugins: [] });
    // A plugin entry without a source is named by name and path (older shapes).
    expect(
      initInfo(JSON.stringify({ type: "system", subtype: "init", plugins: [{ name: "agents-md", path: "builtin" }] }))
        .plugins,
    ).toEqual(["agents-md@builtin"]);
  });

  it("needs 2.1.281 or later, when AGENTS.md reached gateway sessions", () => {
    expect(() => assertCaptureVersion("2.1.280")).toThrow(/needs 2\.1\.281 or later/);
    expect(() => assertCaptureVersion("2.1.281")).not.toThrow();
    expect(() => assertCaptureVersion("2.1.285")).not.toThrow();
  });
});

describe("the session's environment and arguments", () => {
  it("removes the parent session, every ANTHROPIC and provider setting, tokens and proxies, and sets the capture settings", () => {
    const { env, removed } = captureEnv(
      {
        PATH: "/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "s",
        ANTHROPIC_API_KEY: "sk-live",
        ANTHROPIC_AUTH_TOKEN: "t",
        ANTHROPIC_BASE_URL: "https://real",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "o",
        HTTPS_PROXY: "http://corp",
        NO_PROXY: "x",
        CLAUDE_CONFIG_DIR: "/old",
      },
      { baseUrl: "http://127.0.0.1:1234", configDir: "/box/claude-config" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1234",
      ANTHROPIC_API_KEY: DUMMY_API_KEY,
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
      NO_PROXY: "127.0.0.1,localhost",
      CLAUDE_CONFIG_DIR: "/box/claude-config",
    });
    expect(removed).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDECODE",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_USE_BEDROCK",
      "HTTPS_PROXY",
      "NO_PROXY",
    ]);
  });

  it("points ~ at a scratch home and unsets CLAUDE_CONFIG_DIR for the home cells", () => {
    const { env } = captureEnv(
      { CLAUDE_CONFIG_DIR: "/old", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\x" },
      { baseUrl: "http://127.0.0.1:1", home: "C:\\ctxr-home" },
    );
    expect(env.USERPROFILE).toBe("C:\\ctxr-home");
    expect(env.HOME).toBe("C:\\ctxr-home");
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("HOMEDRIVE");
    expect(() => captureEnv({}, { baseUrl: "http://127.0.0.1:1" })).toThrow(
      /fresh CLAUDE_CONFIG_DIR or a scratch home/,
    );
  });

  it("refuses to run with a variable that turns instruction files off", () => {
    for (const k of [
      "CLAUDE_CODE_SIMPLE",
      "CLAUDE_CODE_SAFE_MODE",
      "CLAUDE_CODE_DISABLE_CLAUDE_MDS",
      "CLAUDE_CODE_DISABLE_ATTACHMENTS",
    ]) {
      expect(() => assertNoKillSwitch({ [k]: "1" }), k).toThrow(new RegExp(`${k} is set`));
      expect(() => assertNoKillSwitch({ [k]: "0" }), k).not.toThrow();
      expect(() => captureEnv({ [k]: "true" }, { baseUrl: "http://127.0.0.1:1", configDir: "/c" }), k).toThrow(
        OracleError,
      );
    }
  });

  it("uses the probe's recall flags plus the model pin, and a --settings file only when given", () => {
    const args = captureArgs("claude-pin");
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        "--tools",
        "",
        "--model",
        "claude-pin",
      ]),
    );
    expect(args).not.toContain("--settings");
    for (const banned of ["--bare", "--allowedTools", "--setting-sources", "--safe-mode", "--restricted"])
      expect(args).not.toContain(banned);
    expect(captureArgs("claude-pin", "/tmp/settings.json").slice(-2)).toEqual(["--settings", "/tmp/settings.json"]);
    expect(() => captureArgs("")).toThrow(/needs --model/);
  });
});
