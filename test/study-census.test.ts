// Tests for the pre-registered study's census and behavioural harness
// (study/). The study's scripts are plain JavaScript run by node; these tests
// import them directly and drive them with local transports, the in-process
// CLI and fake agents. No test reaches the network or runs a real agent.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createCli } from "../src/program.js";
import { ConfigError as SrcConfigError, map as srcMap, toJson as srcToJson } from "../src/index.js";
import pkg from "../package.json" with { type: "json" };
// @ts-expect-error -- plain JavaScript module without type declarations
import * as clientLib from "../study/census/lib/client.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as stats from "../study/census/lib/stats.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as norm from "../study/census/lib/normalise.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as prng from "../study/census/lib/prng.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as paths from "../study/census/lib/paths.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as local from "../study/census/lib/local-source.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as maprun from "../study/census/lib/maprun.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as plantsLib from "../study/census/lib/plants.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as recon from "../study/census/recon.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as pipeline from "../study/census/pipeline.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as k1 from "../study/census/known-answer.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as k2 from "../study/census/plant-census-faults.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as k4 from "../study/census/codex-check.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as sse_ from "../study/census/lib/sse.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as frame from "../study/census/frame.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as sample from "../study/census/sample.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as seed from "../study/census/seed.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as runCensus from "../study/census/run-census.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as analyze from "../study/census/analyze.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as consistency from "../study/census/consistency.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as k5 from "../study/census/k5-select.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as k5score from "../study/census/k5-score.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as registryLib from "../study/census/lib/registry.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as digest from "../study/census/dist-digest.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as cellsLib from "../study/behavioural/lib.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as runCells from "../study/behavioural/run-cells.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as setupHome from "../study/behavioural/setup-b2-home.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as prereg from "../study/prereg.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as k6 from "../study/handcheck/lib.mjs";
// @ts-expect-error -- plain JavaScript module without type declarations
import * as k6cli from "../study/handcheck/handcheck.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_CODEX = path.join(ROOT, "study", "census", "testing", "fake-codex.mjs");
const made: string[] = [];
function tmp(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ctxr-study-${label}-`));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** `ctxreach map --json` through the real command-line program, in this process. */
function inProcessMapRunner() {
  return async (opts: Record<string, string>) => {
    let out = "";
    let err = "";
    const cli = createCli({ stdout: (t) => (out += t), stderr: (t) => (err += t) }, { exitOverride: true });
    await cli.program.parseAsync(["node", "ctxreach", ...maprun.mapArgs(opts)]);
    if (cli.status !== 0) return { error: `map exited ${cli.status}: ${err}` };
    return { json: JSON.parse(out) };
  };
}

const noSleep = async () => undefined;

/** A client over local repositories, with every request recorded in `seen`. */
function localClient(repos: unknown[], extra: Record<string, unknown> = {}) {
  const seen: { method: string; url: string }[] = [];
  // The local repositories stand in for both transports: gh api (api.github.com) and fetch (raw files).
  const transport = local.localFetch(repos, { seen, ...extra });
  const client = new clientLib.GetOnlyClient({
    fetchImpl: transport,
    ghApi: transport,
    minIntervalMs: 0,
    sleep: noSleep,
  });
  return { client, seen };
}

function fixtureRepo(name: string, files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const dir = path.join(tmp("repo"), "repo");
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, ...rel.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return local.localRepo(name, dir, extra);
}

describe("Wilson intervals and decision rules", () => {
  it("reproduces the bounds quoted in the plan", () => {
    expect(stats.wilson(0, 10).hi).toBeCloseTo(0.2775, 4);
    expect(stats.wilson(10, 10).lo).toBeCloseTo(0.7225, 4);
    expect(stats.wilson(0, 5).hi).toBeCloseTo(0.4345, 3);
    expect(stats.wilson(0, 0).p).toBeUndefined();
    expect(() => stats.wilson(3, 2)).toThrow();
  });

  it("prints fractions as k/n with the interval", () => {
    expect(stats.formatFraction(stats.wilson(31, 100))).toBe("31/100 (31.0%, [22.8%, 40.6%])");
  });

  it("applies the bound rule (O1-content, O2) and the range rule (O1-file, P1)", () => {
    expect(stats.decideBound(stats.wilson(300, 1000), 0.2)).toBe("confirmed");
    expect(stats.decideBound(stats.wilson(100, 1000), 0.2)).toBe("refuted");
    expect(stats.decideBound(stats.wilson(20, 100), 0.2)).toBe("inconclusive");
    expect(stats.decideRange(stats.wilson(330, 1100), 0.25, 0.4)).toBe("hit");
    expect(stats.decideRange(stats.wilson(100, 1100), 0.25, 0.4)).toBe("miss");
    expect(stats.decideRange(stats.wilson(280, 1100), 0.25, 0.4)).toBe("overlaps");
    expect(stats.decideRange(stats.wilson(0, 0), 0.25, 0.4)).toBe("no-data");
  });
});

describe("O1-content normaliser", () => {
  const agents =
    "# Service guidelines\n\n- Use the shared HTTP client for every outbound call.\n- Keep migrations reversible and reviewed.\n";

  it("keeps lines of 20 or more characters after trimming and collapsing whitespace, once each", () => {
    expect([
      ...norm.lineSet(
        "  a  b\n#   Service    guidelines  \n- Use the shared HTTP client.\n- Use the shared HTTP client.\n",
      ),
    ]).toEqual(["# Service guidelines", "- Use the shared HTTP client."]);
    expect(norm.lineSet("1234567890123456789").size).toBe(0);
    expect(norm.lineSet("12345678901234567890").size).toBe(1);
  });

  it("treats CRLF, tabs and a byte-order mark as whitespace", () => {
    const crlf = "\uFEFF# Service guidelines\r\n\r\n-\tUse the shared HTTP client for every outbound call.\r\n";
    expect(norm.lineContainment(agents, [crlf])).toMatchObject({ a: 3, r: 2 });
  });

  it("counts a line inside a code fence as delivered text", () => {
    const fenced = "Our rules:\n\n```markdown\n- Use the shared HTTP client for every outbound call.\n```\n";
    expect(norm.lineContainment(agents, [fenced]).r).toBe(1);
  });

  it("gives R = |A| for a byte copy, and share exactly 0.5 for half the lines", () => {
    expect(norm.lineContainment(agents, [agents])).toEqual({ a: 3, r: 3, share: 1 });
    const four =
      "line one is long enough here\nline two is long enough here\nline three is long enough\nline four is long enough!!\n";
    expect(norm.lineContainment(four, ["line one is long enough here\nline two is long enough here\n"]).share).toBe(
      0.5,
    );
    expect(norm.lineContainment("short\n", [agents])).toEqual({ a: 0, r: 0, share: undefined });
  });

  it("matches a rewrapped paragraph by shingles but not by lines", () => {
    const source = "- When you add an endpoint, document it in the OpenAPI file and add a contract test for it.\n";
    const rewrapped =
      "- When you add an endpoint, document it in the OpenAPI file\n  and add a contract test for it.\n";
    expect(norm.lineContainment(source, [rewrapped]).r).toBe(0);
    expect(norm.shingleContainment(source, [rewrapped]).r).toBe(1);
    expect(norm.shingleContainment(source, ["nothing like it at all, not a single shared phrase here"]).r).toBe(0);
  });

  it("measures the CJK share and the characters a byte budget holds", () => {
    expect(norm.cjkShare("所有请求都必须通过共享客户端")).toBe(1);
    expect(norm.cjkShare("abc 日本")).toBeCloseTo(0.4, 5);
    expect(norm.cjkShare("   ")).toBe(0);
    expect(norm.charsInBytes(Buffer.from("日本語", "utf8"), 4)).toBe(2); // one whole character, then U+FFFD
  });
});

describe("seeded sampling", () => {
  const frame = Array.from({ length: 500 }, (_, i) => `github.com/o${i}/r${i}`);

  it("draws the same sample from the same seed, and a different one from another", () => {
    const a = prng.draw(frame, 20, "1a2b3c4d", "S-main");
    expect(prng.draw(frame, 20, "1a2b3c4d", "S-main")).toEqual(a);
    expect(prng.draw(frame, 20, "1a2b3c4e", "S-main")).not.toEqual(a);
    expect(prng.draw(frame, 20, "1a2b3c4d", "S-imp")).not.toEqual(a);
    expect(new Set(a).size).toBe(20);
    expect(prng.draw(frame.slice(0, 5), 20, "1a2b3c4d", "x")).toHaveLength(5);
  });

  it("pins the generator: the same seed gives these draws on any machine", () => {
    // Word i is the first 4 bytes of SHA-256("ctxreach-study|<seed>|<stream>|<i>"), big-endian.
    const r = prng.rng("00000000", "pin");
    expect([r.next32(), r.next32(), r.next32()]).toEqual([4275717181, 4114769062, 4151230928]);
    expect(prng.draw(["a", "b", "c", "d", "e", "f", "g", "h"], 8, "00000000", "pin")).toEqual([
      "d",
      "b",
      "g",
      "a",
      "e",
      "c",
      "h",
      "f",
    ]);
  });

  it("is uniform enough over a small range and rejects bad seeds", () => {
    const r = prng.rng("deadbeef", "u");
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) {
      const k: number = r.below(3);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const c of counts) expect(c).toBeGreaterThan(900);
    expect(() => prng.checkSeed("DEADBEEF")).toThrow();
    expect(() => prng.checkSeed("123")).toThrow();
    expect(prng.offsetSeed("ffffffff", 1)).toBe("00000000");
    expect(prng.offsetSeed("0000000f", 1)).toBe("00000010");
  });
});

describe("paths the census fetches and launches from", () => {
  it("fetches instruction files, agent settings and rules, outside node_modules", () => {
    for (const p of [
      "AGENTS.md",
      "a/b/CLAUDE.md",
      ".claude/CLAUDE.md",
      "x/.claude/rules/r.md",
      ".codex/config.toml",
      "CLAUDE.local.md",
      "AGENTS.override.md",
    ])
      expect(paths.isFetched(p)).toBe(true);
    for (const p of ["agents.md", "README.md", "node_modules/x/AGENTS.md", ".claude/rules/r.txt", "docs/AGENTS.md.bak"])
      expect(paths.isFetched(p)).toBe(false);
  });

  it("lists type-2 and type-3 launch directories", () => {
    const tree = [
      "AGENTS.md",
      "a/AGENTS.md",
      "b/.claude/CLAUDE.md",
      "c/CLAUDE.local.md",
      "d/.claude/rules/x.md",
      "e/package.json",
      "f/g/h/i/go.mod",
      "a/Cargo.toml",
      "node_modules/z/AGENTS.md",
    ];
    const t2 = paths.instructionDirs(tree);
    expect(t2).toEqual(["a", "b", "c"]);
    expect(paths.manifestDirs(tree, new Set([".", ...t2]))).toEqual(["e"]);
  });

  it("refuses paths that would escape or cannot be written", () => {
    expect(paths.unsafePath("../x")).toBe("malformed");
    expect(paths.unsafePath("a//b")).toBe("malformed");
    expect(paths.unsafePath("a/CON/AGENTS.md", "win32")).toBe("reserved-on-windows");
    expect(paths.unsafePath("a:b/AGENTS.md", "win32")).toBe("invalid-on-windows");
    expect(paths.unsafePath("a:b/AGENTS.md", "linux")).toBeUndefined();
    expect(paths.joinInside("docs", "../AGENTS.md")).toBe("AGENTS.md");
    expect(paths.joinInside(".", "../x")).toBeUndefined();
    expect(paths.joinInside(".", "~/x")).toBeUndefined();
    expect(paths.importCandidates("see @AGENTS.md, and `@docs/a.md` (@b.md)")).toEqual(
      expect.arrayContaining(["AGENTS.md", "AGENTS.md,", "docs/a.md", "b.md"]),
    );
  });

  it("computes git blob ids", () => {
    // `git hash-object` of an empty file and of "hello\n".
    expect(paths.gitBlobSha(Buffer.alloc(0))).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(paths.gitBlobSha(Buffer.from("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("K7: the GET-only client", () => {
  it("refuses a planted POST before anything is sent, and counts it", async () => {
    const calls: string[] = [];
    const record = async (url: string, init: { method: string }) => {
      calls.push(`${init.method} ${url}`);
      return new Response("{}");
    };
    const client = new clientLib.GetOnlyClient({ fetchImpl: record, ghApi: record, minIntervalMs: 0 });
    await expect(client.request("POST", "https://api.github.com/repos/o/r/issues")).rejects.toThrow(/GET only/);
    await expect(client.request("delete", "https://api.github.com/repos/o/r")).rejects.toThrow(/GET only/);
    await expect(client.request("PUT", "https://raw.githubusercontent.com/o/r/s/AGENTS.md")).rejects.toThrow(
      /GET only/,
    );
    expect(client.nonGetAttempts).toBe(3);
    expect(calls).toEqual([]);
    expect(client.summary()).toMatch(/non-GET attempts: 3$/);
    await client.request("GET", "https://api.github.com/rate_limit");
    expect(calls).toEqual(["GET https://api.github.com/rate_limit"]);
  });

  it("routes a stray global fetch through the client, so a POST anywhere is refused and counted", async () => {
    const ok = async () => new Response("ok");
    const client = new clientLib.GetOnlyClient({ fetchImpl: ok, ghApi: ok, minIntervalMs: 0 });
    const restore = clientLib.installFetchGuard(client);
    try {
      await expect(fetch("https://api.github.com/x", { method: "POST", body: "{}" })).rejects.toThrow(/GET only/);
      expect(client.nonGetAttempts).toBe(1);
      expect(await (await fetch("https://sourcegraph.com/x")).text()).toBe("ok");
    } finally {
      restore();
    }
  });

  it("refuses hosts outside the three the study reads", async () => {
    const client = new clientLib.GetOnlyClient({ fetchImpl: async () => new Response("x"), minIntervalMs: 0 });
    await expect(client.get("https://example.com/")).rejects.toThrow(/host not in/);
    expect(client.refusedHosts).toBe(1);
  });

  it("takes no token, builds no Authorization header, and reaches api.github.com only through gh", async () => {
    expect(() => new clientLib.GetOnlyClient({ token: "t0ken" })).toThrow(/no token/);
    const seen: Record<string, { via: string; headers: Record<string, string> }> = {};
    const via = (name: string) => async (url: string, init: { headers: Record<string, string> }) => {
      seen[new URL(url).hostname] = { via: name, headers: init.headers };
      return new Response("x");
    };
    const client = new clientLib.GetOnlyClient({ fetchImpl: via("fetch"), ghApi: via("gh"), minIntervalMs: 0 });
    await client.get("https://api.github.com/x");
    await client.get("https://raw.githubusercontent.com/o/r/s/AGENTS.md");
    await client.get("https://sourcegraph.com/.api/search/stream?q=x");
    expect(seen["api.github.com"]?.via).toBe("gh");
    expect(seen["raw.githubusercontent.com"]?.via).toBe("fetch");
    expect(seen["sourcegraph.com"]?.via).toBe("fetch");
    for (const s of Object.values(seen)) {
      expect(Object.keys(s.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
      expect(s.headers["User-Agent"]).toMatch(/ctxreach/);
    }
    // A client given a test transport for fetch but none for gh never falls back to the real gh.
    const half = new clientLib.GetOnlyClient({ fetchImpl: via("fetch"), minIntervalMs: 0, sleep: noSleep });
    await expect(half.get("https://api.github.com/x")).rejects.toThrow(/no gh transport/);
    expect(seen["api.github.com"]?.via).toBe("gh");
  });

  it("no study script reads a token from the environment or builds an Authorization header", () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? (e.name === "pilot" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)],
      );
    const scripts = walk(path.join(ROOT, "study")).filter((f) => f.endsWith(".mjs"));
    expect(scripts.length).toBeGreaterThan(20);
    const reads =
      /process\.env\.\w*TOKEN|process\.env\[["'`]\w*TOKEN|["'`]Authorization["'`]|\bAuthorization:|Bearer \$\{/;
    expect(scripts.filter((f) => reads.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f))).toEqual([]);
    // The check can fail.
    expect(reads.test("const t = process.env.CTXR_GITHUB_TOKEN;")).toBe(true);
    expect(reads.test('headers["Authorization"] = x')).toBe(true);
  });

  it("waits as long as retry-after says, then retries", async () => {
    const waits: number[] = [];
    let n = 0;
    const client = new clientLib.GetOnlyClient({
      ghApi: async () =>
        n++ === 0 ? new Response("slow down", { status: 403, headers: { "retry-after": "7" } }) : new Response("ok"),
      minIntervalMs: 0,
      sleep: async (ms: number) => void waits.push(ms),
    });
    const res = await client.get("https://api.github.com/x");
    expect(res.status).toBe(200);
    expect(waits).toContain(7000);
    expect(client.retries).toBe(1);
  });

  it("waits for the rate-limit reset when none is left, and stops before running out", async () => {
    const now = 1_000_000;
    const waits: number[] = [];
    let remaining = 6;
    const client = new clientLib.GetOnlyClient({
      ghApi: async () =>
        new Response("x", {
          headers: {
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": String(--remaining),
            "x-ratelimit-reset": String(now / 1000 + 30),
          },
        }),
      minIntervalMs: 0,
      reserve: 5,
      now: () => now,
      sleep: async (ms: number) => void waits.push(ms),
    });
    await client.get("https://api.github.com/a"); // leaves 5
    await client.get("https://api.github.com/b"); // must pause for the reset first
    expect(waits[0]).toBe(31_000);
  });

  it("gives up after three failures and returns 404 without retrying", async () => {
    let n = 0;
    const answer = async (url: string) => {
      n++;
      return url.endsWith("gone") ? new Response("no", { status: 404 }) : new Response("err", { status: 502 });
    };
    const client = new clientLib.GetOnlyClient({ ghApi: answer, fetchImpl: answer, minIntervalMs: 0, sleep: noSleep });
    await expect(client.get("https://api.github.com/bad")).rejects.toThrow(/after 3 attempt/);
    expect(n).toBe(3);
    expect((await client.get("https://api.github.com/gone")).status).toBe(404);
    expect(n).toBe(4);
  });

  it("sends one request at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const slow = async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response("x");
    };
    const client = new clientLib.GetOnlyClient({ ghApi: slow, fetchImpl: slow, minIntervalMs: 0 });
    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        client.get(i % 2 ? `https://api.github.com/${i}` : `https://raw.githubusercontent.com/o/r/s/${i}`),
      ),
    );
    expect(most).toBe(1);
  });

  it("sends If-None-Match and reports 304", async () => {
    let sent: string | undefined;
    const client = new clientLib.GetOnlyClient({
      ghApi: async (_u: string, init: { headers: Record<string, string> }) => {
        sent = init.headers["If-None-Match"];
        return new Response(null, { status: 304 });
      },
      minIntervalMs: 0,
    });
    const res = await client.get("https://api.github.com/x", { etag: '"abc"' });
    expect(sent).toBe('"abc"');
    expect(res.status).toBe(304);
    expect(client.notModified).toBe(1);
  });
});

describe("K7: api.github.com through `gh api` (a fake gh, no network)", () => {
  const FAKE_GH = path.join(ROOT, "study", "census", "testing", "fake-gh.mjs");
  function fakeGh(replies: unknown[]) {
    const dir = tmp("gh");
    writeFileSync(path.join(dir, "replies.json"), JSON.stringify(replies));
    const transport = clientLib.ghTransport({
      bin: process.execPath,
      prefixArgs: [FAKE_GH],
      env: { FAKE_GH_DIR: dir },
    });
    const calls = (): { argv: string[] }[] => {
      const log = path.join(dir, "argv.jsonl");
      return existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [];
    };
    const refuse = async () => {
      throw new Error("not this transport");
    };
    const client = (extra: Record<string, unknown> = {}) =>
      new clientLib.GetOnlyClient({ ghApi: transport, fetchImpl: refuse, minIntervalMs: 0, sleep: noSleep, ...extra });
    return { dir, transport, calls, client };
  }

  it("asks gh for GET only, with --include and the project's User-Agent, and reads status, headers and body", async () => {
    const gh = fakeGh([
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Ratelimit-Limit": "5000",
          "X-Ratelimit-Remaining": "4999",
          "X-Ratelimit-Reset": "1790000000",
        },
        body: '{"full_name":"o/r","note":"a\\r\\n\\r\\nb"}',
      },
    ]);
    const client = gh.client();
    const res = await client.getJson("https://api.github.com/repos/o/r/git/trees/abc?recursive=1");
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ full_name: "o/r", note: "a\r\n\r\nb" });
    expect(client.rate).toMatchObject({ limit: 5000, remaining: 4999 });
    const [call] = gh.calls();
    expect(call!.argv.slice(0, 6)).toEqual(["api", "-X", "GET", "--include", "--hostname", "github.com"]);
    expect(call!.argv.at(-1)).toBe("repos/o/r/git/trees/abc?recursive=1");
    expect(call!.argv.filter((a) => a === "-X")).toHaveLength(1);
    expect(call!.argv.some((a) => /^(-f|-F|--field|--raw-field|--input|--method|--paginate)$/.test(a))).toBe(false);
    expect(call!.argv).toContain(`User-Agent: ${clientLib.USER_AGENT}`);
    expect(call!.argv.join("\n")).not.toMatch(/authorization|token/i);
    expect(client.summary()).toMatch(/api\.github\.com 1 via gh api/);
  });

  it("returns 404 and 304 as answers although gh exits 1, and retries a 5xx", async () => {
    const gh = fakeGh([
      { status: 404, statusText: "Not Found", body: '{"message":"Not Found"}' },
      { status: 304, statusText: "Not Modified" },
      { status: 502, statusText: "Bad Gateway", body: "busy" },
      { status: 200, body: "{}" },
    ]);
    const client = gh.client();
    expect((await client.get("https://api.github.com/repos/o/gone")).status).toBe(404);
    const cached = await client.get("https://api.github.com/repos/o/r", { etag: '"e1"' });
    expect(cached.status).toBe(304);
    expect(gh.calls()[1]!.argv).toContain('If-None-Match: "e1"');
    expect((await client.get("https://api.github.com/repos/o/r")).status).toBe(200);
    expect(client.retries).toBe(1);
    expect(gh.calls()).toHaveLength(4);
  });

  it("waits as long as retry-after says, through gh, then asks again", async () => {
    const gh = fakeGh([
      { status: 403, statusText: "Forbidden", headers: { "Retry-After": "7" }, body: "slow down" },
      { status: 200, body: "ok" },
    ]);
    const waits: number[] = [];
    const client = gh.client({ sleep: async (ms: number) => void waits.push(ms) });
    const res = await client.get("https://api.github.com/repos/o/r");
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("ok");
    expect(waits).toContain(7000);
    expect(gh.calls()).toHaveLength(2);
  });

  it("retries a gh that cannot reach GitHub, and stops the run when gh is missing or not logged in", async () => {
    const offline = fakeGh([{ noStdout: true, stderr: "error connecting to api.github.com", exit: 1 }]);
    await expect(offline.client().get("https://api.github.com/repos/o/r")).rejects.toThrow(/after 3 attempt/);
    expect(offline.calls()).toHaveLength(3);

    const loggedOut = fakeGh([
      { noStdout: true, stderr: "To get started with GitHub CLI, please run:  gh auth login", exit: 4 },
    ]);
    const err = await loggedOut
      .client()
      .get("https://api.github.com/repos/o/r")
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(clientLib.GhUnavailable);
    expect(String(err)).toMatch(/gh auth login/);
    expect(loggedOut.calls()).toHaveLength(1);

    // A login GitHub refuses (401) would turn every later unit into an exclusion: it stops the run too.
    const refused = fakeGh([{ status: 401, statusText: "Unauthorized", body: '{"message":"Bad credentials"}' }]);
    await expect(refused.client().get("https://api.github.com/repos/o/r")).rejects.toThrow(/401/);
    expect(refused.calls()).toHaveLength(1);

    const missing = clientLib.ghTransport({ bin: path.join(tmp("gh"), "no-such-gh") });
    const none = new clientLib.GetOnlyClient({ ghApi: missing, minIntervalMs: 0, sleep: noSleep });
    await expect(none.get("https://api.github.com/repos/o/r")).rejects.toBeInstanceOf(clientLib.GhUnavailable);

    // A stopped gh stops the reconstruction too: the unit is not quietly excluded as fetch-failed.
    const dir = path.join(tmp("recon"), "repo");
    await expect(
      recon.reconstruct({
        client: loggedOut.client(),
        repo: "o/r",
        commit: "a".repeat(40),
        dir,
        seed: "00000000",
      }),
    ).rejects.toBeInstanceOf(clientLib.GhUnavailable);
  });

  it("refuses an endpoint gh could read as a flag, and a header that could split", () => {
    expect(() => clientLib.ghArgs("https://api.github.com/-X", {})).toThrow(/endpoint/);
    expect(() => clientLib.ghArgs("https://raw.githubusercontent.com/o/r/s/f", {})).toThrow(/api\.github\.com/);
    expect(() => clientLib.ghArgs("https://api.github.com/repos/o/r", { "X-A": "1\r\nX-B: 2" })).toThrow(/header/);
    expect(clientLib.ghArgs("https://api.github.com/repos/o/r", { Accept: "application/json" })).toEqual([
      "api",
      "-X",
      "GET",
      "--include",
      "--hostname",
      "github.com",
      "-H",
      "Accept: application/json",
      "repos/o/r",
    ]);
  });

  it("splits gh's --include output at the end of the headers, byte for byte", () => {
    const head = Buffer.from("HTTP/2.0 200 OK\nContent-Type: application/octet-stream\r\nX-A: 1, 2\r\n\r\n");
    const body = Buffer.from([0, 1, 2, 13, 10, 13, 10, 3, 0xff]);
    const parsed = clientLib.parseGhInclude(Buffer.concat([head, body]));
    expect(parsed).toMatchObject({ status: 200, statusText: "OK" });
    expect(parsed.headers).toEqual([
      ["Content-Type", "application/octet-stream"],
      ["X-A", "1, 2"],
    ]);
    expect(Buffer.compare(parsed.body, body)).toBe(0);
    expect(clientLib.parseGhInclude(Buffer.from("HTTP/1.1 304 Not Modified\n\r\n"))).toMatchObject({
      status: 304,
      headers: [],
    });
    expect(clientLib.parseGhInclude(Buffer.from(""))).toBeUndefined();
    expect(clientLib.parseGhInclude(Buffer.from("error connecting\n"))).toBeUndefined();
  });
});

describe("reconstruction at a pinned commit", () => {
  const base = { "AGENTS.md": "# Rules\n\n- Always run the full test suite first.\n", "src/index.ts": "export {};\n" };

  async function reconOf(repo: ReturnType<typeof fixtureRepo>, extra: Record<string, unknown> = {}) {
    const { client, seen } = localClient([repo], extra);
    const dir = path.join(tmp("recon"), "repo");
    const r = await recon.reconstruct({ client, repo: repo.name, commit: repo.commit, dir, seed: "00000000" });
    return { r, seen, dir };
  }

  it("writes only the files ctxreach reads, checks their blob ids, and marks the root", async () => {
    const { r, seen, dir } = await reconOf(fixtureRepo("basic", base));
    expect(r.status).toBe("ok");
    expect(r.files.map((f: { path: string }) => f.path)).toEqual(["AGENTS.md"]);
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe(base["AGENTS.md"]);
    expect(() => readFileSync(path.join(dir, "src", "index.ts"))).toThrow();
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(r.requests).toEqual({ api: 2, raw: 1 });
  });

  it.each([
    [{ meta: { fork: true } }, "fork"],
    [{ meta: { archived: true } }, "archived"],
    [{ meta: { mirror_url: "https://example.com/x.git" } }, "mirror"],
    [{ truncated: true }, "tree-truncated"],
  ])("excludes %j as %s", async (extra, reason) => {
    const { r } = await reconOf(fixtureRepo("ex", base, extra));
    expect(r).toMatchObject({ status: "excluded", exclusion: reason });
  });

  it("excludes a commit that is gone, and a repository that is gone", async () => {
    const repo = fixtureRepo("gone", base);
    const { client } = localClient([repo]);
    const dir = path.join(tmp("recon"), "repo");
    const gone = await recon.reconstruct({ client, repo: repo.name, commit: "f".repeat(40), dir, seed: "00000000" });
    expect(gone.exclusion).toBe("commit-gone");
    const missing = await recon.reconstruct({
      client,
      repo: "fixture/none",
      commit: repo.commit,
      dir,
      seed: "00000000",
    });
    expect(missing.exclusion).toBe("repo-gone");
  });

  it("excludes after three failed attempts, but survives a transient 5xx", async () => {
    const repo = fixtureRepo("flaky", base);
    const once = await reconOf(repo, { faults: [{ match: "/git/trees/", status: 503, times: 1 }] });
    expect(once.r.status).toBe("ok");
    const always = await reconOf(repo, { faults: [{ match: "/git/trees/", status: 503, times: 3 }] });
    expect(always.r.exclusion).toBe("fetch-failed");
  });

  it("excludes the repository when an instruction file's bytes do not match its blob id", async () => {
    const repo = fixtureRepo("tamper", base);
    repo.files.set("AGENTS.md", Buffer.from("something else\n"));
    const { r } = await reconOf(repo);
    expect(r).toMatchObject({ status: "excluded", exclusion: "recon-incomplete" });
  });

  it("writes a symlink as a copy of its target and records the link", async () => {
    const repo = fixtureRepo("link", base, {
      symlinks: { "CLAUDE.md": "AGENTS.md", "docs/CLAUDE.md": "../../outside.md" },
    });
    const { r, dir } = await reconOf(repo);
    const link = r.files.find((f: { path: string }) => f.path === "CLAUDE.md");
    expect(link).toMatchObject({ mode: "120000", link: { target: "AGENTS.md", resolved: "AGENTS.md" }, written: true });
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe(base["AGENTS.md"]);
    const broken = r.files.find((f: { path: string }) => f.path === "docs/CLAUDE.md");
    expect(broken.link).toMatchObject({ broken: true, resolved: null });
  });

  it("fetches import targets, which are not instruction files, up to six hops", async () => {
    const files: Record<string, string> = { "CLAUDE.md": "@docs/a1.md\n" };
    for (let i = 1; i <= 7; i++) files[`docs/a${i}.md`] = i < 7 ? `@a${i + 1}.md\n` : "end\n";
    const { r } = await reconOf(fixtureRepo("deep", files));
    const imported = r.files.filter((f: { role: string }) => f.role === "import").map((f: { path: string }) => f.path);
    expect(imported).toEqual(["docs/a1.md", "docs/a2.md", "docs/a3.md", "docs/a4.md", "docs/a5.md", "docs/a6.md"]);
  });

  it("creates type-2 and type-3 launch directories, capped and seeded", async () => {
    const files: Record<string, string> = { ...base, "pkg/a/AGENTS.md": "# A\n" };
    for (let i = 0; i < 25; i++) files[`apps/app${String(i).padStart(2, "0")}/package.json`] = "{}\n";
    const { r, dir } = await reconOf(fixtureRepo("launch", files));
    expect(r.launch.t2).toEqual(["pkg/a"]);
    expect(r.launch.t3Total).toBe(25);
    expect(r.launch.t3).toHaveLength(20);
    const again = await reconOf(fixtureRepo("launch", files));
    expect(again.r.launch.t3).toEqual(r.launch.t3);
    // The directory exists for map to launch in; the manifest itself is not fetched.
    expect(() => readFileSync(path.join(dir, ...r.launch.t3[0].split("/"), "package.json"))).toThrow();
    expect(readdirSync(path.join(dir, ...r.launch.t3[0].split("/")))).toEqual([]);
  });

  it("caps type-2 directories at 20 per repository, drawn with the study seed and recorded before the cap", async () => {
    expect(recon.MAX_TYPE2_DIRS).toBe(20);
    const files: Record<string, string> = { ...base };
    for (let i = 0; i < 25; i++) files[`pkg/p${String(i).padStart(2, "0")}/AGENTS.md`] = `# P${i}\n`;
    const repo = fixtureRepo("many-t2", files);
    const withSeed = async (seed: string) => {
      const { client } = localClient([repo]);
      const dir = path.join(tmp("recon"), "repo");
      return (await recon.reconstruct({ client, repo: repo.name, commit: repo.commit, dir, seed })).launch;
    };
    const a = await withSeed("0badc0de");
    expect(a.t2Total).toBe(25);
    expect(a.t2).toHaveLength(20);
    const all = Array.from({ length: 25 }, (_, i) => `pkg/p${String(i).padStart(2, "0")}`);
    expect(a.t2).toEqual(prng.draw(all, 20, "0badc0de", `t2|${repo.name}`).sort());
    expect(await withSeed("0badc0de")).toEqual(a);
    expect((await withSeed("0badc0df")).t2).not.toEqual(a.t2);
  });
});

describe("K1: known-answer fixtures through the census pipeline", () => {
  it("every fixture has an answer and every answer a fixture; known defects fail on exactly their fields", async () => {
    const res = await k1.runKnownAnswers({ mapRunner: inProcessMapRunner() });
    const answers = k1.loadAnswers();
    expect(res.orphans).toEqual([]);
    expect(res.nonGet).toBe(0);
    const unanswered = res.results
      .filter((r: { unanswered?: boolean }) => r.unanswered)
      .map((r: { name: string }) => r.name);
    expect(unanswered).toEqual([]);
    for (const r of res.results) {
      const defect = answers.knownDefects[r.name];
      if (defect) {
        expect(r.pass, r.name).toBe(false);
        expect(r.diffs.map((d: string) => d.split(":")[0]).sort(), r.name).toEqual([...defect.fields].sort());
      } else {
        expect(r.diffs, r.name).toEqual([]);
      }
    }
    expect(res.n).toBe(Object.keys(answers.fixtures).length);
    expect(res.k).toBe(res.n - Object.keys(answers.knownDefects).length);
  }, 120_000);

  it("lists no known defect since the map-rules fix merged, and never lets K1 pass while a known defect fails", () => {
    const answers = k1.loadAnswers();
    // census-o2-external-import was the one known defect; the map-rules fix made it pass, so the entry is gone.
    expect(answers.knownDefects).toEqual({});
    const withDefect = {
      ...answers,
      knownDefects: {
        "census-o2-external-import": { fields: ["o5.rootWarn", "o6.event"], awaiting: "the map-rules fix (lane L1)" },
      },
    };
    const defects = Object.keys(withDefect.knownDefects);
    const row = (name: string, pass: boolean) => ({ name, pass, diffs: pass ? [] : ["o5.rootWarn: x"] });
    const failing = { k: 54, n: 55, orphans: [], results: [row("a", true), row(defects[0]!, false)] };
    const v = k1.k1Verdict(failing, withDefect);
    expect(v.pass).toBe(false);
    expect(v.line).toBe(
      `K1: 54/55 fixtures match their known answers; FAIL, 1 known map defect awaiting the map-rules fix (lane L1): ${defects[0]}`,
    );
    // Without the entry the same failure is unexplained, never a pass.
    expect(k1.k1Verdict(failing, answers).line).toMatch(/FAIL, 1 unexplained: census-o2-external-import$/);
    // An unexplained failure is named as such, and n/n with no orphan is the only pass.
    expect(k1.k1Verdict({ ...failing, results: [row("b", false)] }, answers).line).toMatch(/FAIL, 1 unexplained: b$/);
    expect(k1.k1Verdict({ k: 2, n: 2, orphans: [], results: [row("a", true), row("b", true)] }, answers)).toEqual({
      pass: true,
      line: "K1: 2/2 fixtures match their known answers; pass",
    });
    expect(k1.k1Verdict({ k: 2, n: 2, orphans: ["c"], results: [row("a", true), row("b", true)] }, answers).pass).toBe(
      false,
    );
  });

  it("PREREG.md states K1's distinct inputs and its unpinned answer fields as the fixtures and answers give them", async () => {
    const text = readFileSync(path.join(ROOT, "study", "PREREG.md"), "utf8").replace(/\s+/g, " ");
    const answers = k1.loadAnswers();
    const fixtures = k1.allFixtures() as { name: string; repoDir: string }[];
    // Distinct inputs: what K1 serves of a fixture (its repo/ files and declared links), byte for byte.
    const groups = new Map<string, string[]>();
    for (const f of fixtures) {
      const repo = local.localRepo(f.name, f.repoDir);
      const key = JSON.stringify(
        repo.entries.map((e: { path: string; mode: string; sha: string }) => [e.path, e.mode, e.sha]),
      );
      groups.set(key, [...(groups.get(key) ?? []), f.name]);
    }
    const stated = /K1's (\d+) answers cover (\d+) distinct inputs/.exec(text);
    expect(stated?.slice(1).map(Number)).toEqual([Object.keys(answers.fixtures).length, groups.size]);
    const para = text.slice(text.indexOf("**What K1 covers.**"), text.indexOf("Answer fields pinned in 0"));
    // Each identical group is named; a trap/twin pair by its trap's name.
    for (const g of groups.values())
      for (const name of g.length > 1 ? g : []) {
        const trap = name.replace(/-twin$/, "");
        expect(para, name).toContain(`\`${g.includes(trap) ? trap : name}\``);
      }

    // Every leaf field the detectors produce over K1's rows, against every field an answer pins.
    const leaves = (v: unknown, at: string, out: Map<string, number>) => {
      if (v !== null && typeof v === "object" && !Array.isArray(v))
        for (const [k, x] of Object.entries(v)) leaves(x, `${at}.${k}`, out);
      else out.set(at, (out.get(at) ?? 0) + 1);
      return out;
    };
    const res = await k1.runKnownAnswers({ mapRunner: inProcessMapRunner() });
    expect(res.k).toBe(res.n);
    const produced = new Map<string, number>();
    const pinned = new Map<string, number>();
    for (const r of res.results as { name: string; row: { outcomes: Record<string, unknown> } }[]) {
      for (const k of k1.DETECTOR_KEYS as string[]) {
        for (const f of leaves(r.row.outcomes[k], k, new Map()).keys()) produced.set(f, (produced.get(f) ?? 0) + 1);
        if (k in answers.fixtures[r.name])
          for (const f of leaves(answers.fixtures[r.name][k], k, new Map()).keys())
            pinned.set(f, (pinned.get(f) ?? 0) + 1);
      }
    }
    const isField = (t: string) => (k1.DETECTOR_KEYS as string[]).includes(t.split(".")[0]!) && t.includes(".");
    const between = (from: string, to: string) =>
      [...text.slice(text.indexOf(from), text.indexOf(to)).matchAll(/`([^`]+)`/g)].map((m) => m[1]!).filter(isField);
    const zero = [...produced.keys()].filter((f) => !pinned.has(f)).sort();
    const count = /(\d+) answer fields are pinned in 0 of the (\d+) answers/.exec(text);
    expect(count?.slice(1).map(Number)).toEqual([zero.length, res.n]);
    const feeds = between("answer fields are pinned in 0 of the", "The ones that feed none:");
    const none = between("The ones that feed none:", "Fields pinned in 1 to 4 answers");
    expect(feeds.filter((f) => none.includes(f))).toEqual([]);
    expect([...feeds, ...none].sort()).toEqual(zero);
    const few = [...text.matchAll(/`([a-z0-9]+\.[A-Za-z0-9]+)` \((\d)\)/g)].map((m) => [m[1], Number(m[2])]);
    const fewActual = [...pinned].filter(([, n]) => n >= 1 && n <= 4).sort();
    expect(few.sort()).toEqual(fewActual);
  }, 120_000);

  it("fails a row whose answer is wrong (the comparison can fail)", () => {
    expect(k1.compare({ a: 1, b: [1, 2] }, { a: 1, b: [2, 1], c: 3 })).toEqual([]);
    expect(k1.compare({ a: 1 }, { a: 2 })).toEqual(["a: expected 1, got 2"]);
    expect(k1.compare({ o: { e: true } }, { o: undefined })).toHaveLength(1);
    expect(
      k1.checkRow(
        { launch: { t2: [], t3: [] } },
        { status: "measured", faults: [], launch: { t2: [], t3: [] }, outcomes: {} },
      )[0],
    ).toMatch(/answer lacks o1content/);
  });
});

describe("map in process, called as the CLI calls it", () => {
  const lib = { map: srcMap, toJson: srcToJson, ConfigError: SrcConfigError };
  /** A fixture copied to a fresh folder with a .git marker, and its launch directories of types 1-3. */
  function launches(name: string, repoDir: string) {
    const root = path.join(tmp("inproc"), name);
    cpSync(repoDir, root, { recursive: true });
    mkdirSync(path.join(root, ".git"), { recursive: true });
    const files = (d: string, rel = ""): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.name === ".git"
          ? []
          : e.isDirectory()
            ? files(path.join(d, e.name), `${rel}${e.name}/`)
            : [`${rel}${e.name}`],
      );
    const all = files(root);
    const t2 = paths.instructionDirs(all);
    return { root, dirs: [".", ...t2, ...paths.manifestDirs(all, new Set([".", ...t2]))] };
  }

  it("gives the CLI program's answer, byte for byte, from every launch directory of every K1 fixture", async () => {
    const inProcess = maprun.inProcessMapRunner({ lib, version: pkg.version });
    const viaCli = inProcessMapRunner();
    const home = tmp("inproc-home");
    const homes = { codexHome: path.join(home, ".codex"), claudeHome: path.join(home, ".claude") };
    mkdirSync(homes.codexHome, { recursive: true });
    mkdirSync(homes.claudeHome, { recursive: true });
    let n = 0;
    for (const f of k1.allFixtures()) {
      const { root, dirs } = launches(f.name, f.repoDir);
      for (const d of dirs) {
        const opts = {
          launchDir: d === "." ? root : path.join(root, ...d.split("/")),
          repoRoot: root,
          ...homes,
          claudeVersion: "2.1.285",
        };
        expect(JSON.stringify(await inProcess(opts)), `${f.name} ${d}`).toBe(JSON.stringify(await viaCli(opts)));
        n++;
      }
    }
    expect(n).toBeGreaterThanOrEqual(50);
  }, 120_000);

  it("answers a missing directory and a broken config in the CLI's words", async () => {
    const inProcess = maprun.inProcessMapRunner({ lib, version: pkg.version });
    const root = tmp("inproc-bad");
    mkdirSync(path.join(root, ".codex"), { recursive: true });
    writeFileSync(path.join(root, ".codex", "config.toml"), "project_doc_max_bytes = [\n");
    const home = tmp("inproc-home");
    const opts = { repoRoot: root, codexHome: home, claudeHome: home };
    const missing = await inProcess({ ...opts, launchDir: path.join(root, "nowhere") });
    expect(missing.error).toMatch(/^map exited 2: ctxreach: --from .*nowhere does not exist/);
    const broken = await inProcess({ ...opts, launchDir: root });
    expect(broken.error).toMatch(/^map exited 2: ctxreach: .*config\.toml: not valid TOML/);
    // The spawned CLI gives the same text for the same failure: the program's own stderr line.
    let err = "";
    const cli = createCli({ stdout: () => undefined, stderr: (t) => (err += t) }, { exitOverride: true });
    await cli.program.parseAsync(["node", "ctxreach", ...maprun.mapArgs({ ...opts, launchDir: root })]);
    expect(broken.error).toBe(`map exited 2: ${err.trim().slice(0, 300)}`);
  });

  it("checks the chosen calls against the CLI, and makes a disagreement a fault on the row", async () => {
    const stats = { checked: 0, agreed: 0, differ: [] as string[] };
    let pick = false;
    let answer = { json: { a: 1 } };
    const runner = maprun.crossCheckedRunner(
      async () => ({ json: { a: 1 } }),
      async () => answer,
      { pick: () => pick, stats },
    );
    expect(await runner({ launchDir: "x" })).toEqual({ json: { a: 1 } });
    expect(stats.checked).toBe(0);
    pick = true;
    expect(await runner({ launchDir: "y" })).toEqual({ json: { a: 1 } });
    answer = { json: { a: 2 } } as never;
    expect((await runner({ launchDir: "z" })).error).toMatch(/in-process map and the CLI disagree at z/);
    expect(stats).toEqual({ checked: 2, agreed: 1, differ: ["z"] });
  });
});

describe("K2: each planted fault makes K1 fail", () => {
  // The full K2 (every plant against every fixture) is study/census/plant-census-faults.mjs.
  // Here each plant runs against one fixture that must catch it, so the suite stays quick.
  const sentinel: Record<string, string> = {
    "detector:o1content": "claude-words-not-import",
    "detector:o1content-shingle": "claude-words-not-import",
    "detector:o1file": "claude-words-not-import",
    "detector:o2": "census-o2-package-claude",
    "detector:p1": "codex-over-cap",
    "detector:o4": "codex-nested-below-cwd",
    "detector:o5": "claude-words-not-import",
    "detector:o6": "claude-words-not-import",
    "detector:o7": "census-o7-symlink",
    "detector:o8": "census-o8-cjk",
    "detector:k3": "claude-words-not-import",
    "recon:import-targets": "claude-import-too-deep",
    "recon:links": "census-o7-symlink",
    "launch:type2": "codex-nested-below-cwd",
    "launch:type3": "census-type3-import",
    "measure:link-correction": "census-o7-symlink",
  };
  it("has a sentinel fixture for every plant", () => {
    expect(Object.keys(sentinel).sort()).toEqual([...plantsLib.PLANTS].sort());
  });
  it.each(Object.entries(sentinel))(
    "catches %s with %s",
    async (plant, fixture) => {
      const { rows } = await k2.runPlants({ mapRunner: inProcessMapRunner(), plants: [plant], only: [fixture] });
      expect(rows[0]).toMatchObject({ plant, verdict: "caught", broke: [fixture] });
      expect(rows[0].hits).toBeGreaterThan(0);
    },
    60_000,
  );
});

describe("pipeline preconditions", () => {
  it("finds instruction files above the work directory", () => {
    const top = tmp("anc");
    const work = path.join(top, "a", "b");
    mkdirSync(work, { recursive: true });
    expect(pipeline.ancestorInstructionFiles(work).filter((p: string) => p.startsWith(top))).toEqual([]);
    mkdirSync(path.join(top, "a", ".claude"));
    writeFileSync(path.join(top, "a", ".claude", "CLAUDE.md"), "x");
    expect(pipeline.ancestorInstructionFiles(work).filter((p: string) => p.startsWith(top))).toEqual([
      path.join(top, "a", ".claude", "CLAUDE.md"),
    ]);
  });

  it("refuses homes that are no longer empty", () => {
    const work = tmp("homes");
    const homes = pipeline.freshHomes(work);
    writeFileSync(path.join(homes.claudeHome, "CLAUDE.md"), "x");
    expect(() => pipeline.checkHomes(homes)).toThrow(/fresh-machine/);
  });

  it("records map faults instead of using a leaked outside file", async () => {
    const repo = fixtureRepo("leak", { "AGENTS.md": "# Rules for this repository\n" });
    const { client } = localClient([repo]);
    const work = tmp("leak");
    const homes = pipeline.freshHomes(work);
    const runner = inProcessMapRunner();
    const leaky = async (opts: Record<string, string>) => {
      const r = await runner(opts);
      r.json.claude.shadowers.push("C:/Users/someone/.claude/CLAUDE.md");
      return r;
    };
    const row = await pipeline.runUnit({
      client,
      unit: { id: "leak", repo: repo.name, commit: repo.commit },
      workDir: work,
      mapRunner: leaky,
      homes,
      claudeVersion: "2.1.285",
      seed: "00000000",
    });
    expect(row.faults.join("\n")).toMatch(/outside the repository: C:\/Users\/someone/);
  });
});

describe("K4: map against Codex's renderer (with a fake codex)", () => {
  const overCap = path.join(ROOT, "test", "fixtures", "codex-over-cap", "repo");
  const nested = path.join(ROOT, "test", "fixtures", "codex-root-starves-nested", "repo");

  async function k4Row(name: string, repoDir: string, env: Record<string, string> = {}) {
    const repo = local.localRepo(name, repoDir);
    const { client } = localClient([repo]);
    const work = tmp("k4");
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    try {
      return await pipeline.runUnit({
        client,
        unit: { id: name, repo: repo.name, commit: repo.commit },
        workDir: work,
        mapRunner: inProcessMapRunner(),
        homes: pipeline.freshHomes(work),
        claudeVersion: "2.1.285",
        seed: "00000000",
        codexBin: FAKE_CODEX,
      });
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  }

  it("agrees byte for byte where the renderer follows map's rules, from every launch directory", async () => {
    const row = await k4Row("k4-nested", nested);
    expect(row.k4.pairs.map((p: { dir: string; verdict: string }) => `${p.dir} ${p.verdict}`)).toEqual([
      ". EXACT",
      "packages/api EXACT",
    ]);
    expect(row.k4.pairs[1].predictedBytes).toBe(32168 + 2 + 600);
    expect(row.k4).toMatchObject({ exact: 2, n: 2, faults: 0 });
  }, 60_000);

  it("disagrees when the renderer's budget differs (the planted pass must disagree)", async () => {
    const row = await k4Row("k4-planted", overCap, { FAKE_CODEX_MAX_BYTES: "30000" });
    expect(row.k4.pairs[0]).toMatchObject({ verdict: "OFF", offBy: -2768, firstDiff: 30000, predictedBytes: 32768 });
  }, 60_000);

  it.each([
    ["flaky", /renders differ/],
    ["drop-prompt", /control token missing/],
    ["wrong-cwd", /rendered for/],
    ["fail", /exited 1/],
    ["bad-shape", /unknown render shape/],
  ])(
    "reports an instrument fault when the renderer is %s",
    async (mode, why) => {
      const counter = path.join(tmp("k4c"), "n");
      const row = await k4Row(`k4-${mode}`, overCap, { FAKE_CODEX_MODE: mode, FAKE_CODEX_COUNTER: counter });
      expect(row.k4.pairs[0].verdict).toBe("FAULT");
      expect(row.k4.pairs[0].faults.join(" | ")).toMatch(why);
    },
    60_000,
  );

  it("throws the renderer's home away and gives it no credentials or reachable proxy", async () => {
    const env = k4.renderEnv("/tmp/h", { OPENAI_API_KEY: "sk-real", CODEX_HOME: "/home/me/.codex", PATH: "/bin" });
    expect(env).toMatchObject({
      CODEX_HOME: "/tmp/h",
      OPENAI_API_KEY: "",
      HTTPS_PROXY: "http://127.0.0.1:9",
      PATH: "/bin",
    });
    const home = path.join(tmp("k4h"), "codex-home");
    const r = await k4.render({ codexBin: FAKE_CODEX, cwd: overCap, codexHome: home, prompt: "x" });
    expect(r.code).toBe(0);
    expect(() => readdirSync(home)).toThrow();
  });

  it("reads the AGENTS.md block by its content tag and joins map's prediction with a blank line", () => {
    const NL = String.fromCharCode(10);
    const item = (kinds: string[], texts: string[], role = "user") => ({
      type: "message",
      role,
      content: texts.map((text) => ({ type: "input_text", text })),
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    });
    const body = ["# AGENTS.md instructions for /repo", "", "<INSTRUCTIONS>", "A", "", "B", "</INSTRUCTIONS>"].join(NL);
    const block = k4.extractBlock([
      item(["agents_md.instructions", "environments.environment_context"], [body, "<environment_context>"]),
      item(["user.text"], ["prompt CTXR-12345678"]),
    ]);
    expect(block).toMatchObject({ text: ["A", "", "B"].join(NL), cwd: "/repo" });
    expect(block.lastUser).toMatch(/CTXR-12345678/);
    expect(k4.extractBlock([item(["user.text"], ["x"])]).text).toBeNull();
    const bytes: Record<string, Buffer> = {
      a: Buffer.from("A-long" + NL),
      b: Buffer.from("  " + NL),
      c: Buffer.from([0xe6, 0x97, 0xa5, 0x78]),
    };
    const chain = [
      { path: "a", kept: 1 },
      { path: "b", kept: 3 },
      { path: "c", kept: 2 },
      { path: "d", kept: 0 },
    ];
    expect(k4.predictedBlock({ codex: { chain } }, (p: string) => bytes[p])).toBe(
      ["A", "", String.fromCharCode(0xfffd)].join(NL),
    );
  });
});

describe("frames from Sourcegraph's stream", () => {
  const sse = (events: [string, unknown][]) =>
    events.map(([e, d]) => `event: ${e}\r\ndata: ${JSON.stringify(d)}\r\n\r\n`).join("") + ": keep-alive\n\n";
  const m = (repo: string, commit = "a".repeat(40)) => ({
    type: "path",
    repository: repo,
    commit,
    path: "AGENTS.md",
    repoStars: 5,
  });

  it("parses events split across chunks, with CRLF and comments", () => {
    const got: [string, unknown][] = [];
    const p = sse_.sseParser((e: string, j: unknown) => got.push([e, j]));
    const text = sse([
      ["matches", [m("github.com/b/b")]],
      ["progress", { done: true }],
    ]);
    for (let i = 0; i < text.length; i += 7) p.push(text.slice(i, i + 7));
    p.end();
    expect(got.map((g) => g[0])).toEqual(["matches", "progress"]);
  });

  it("freezes one row per repository, sorted, with the indexed commit, and requires two identical answers", async () => {
    const list = sse([
      ["matches", [m("github.com/z/z"), m("github.com/a/a"), m("github.com/a/a")]],
      ["matches", [m("gitlab.com/g/g")]],
      [
        "progress",
        { done: true, matchCount: 4, skipped: [{ reason: "repository-fork" }, { reason: "excluded-archive" }] },
      ],
      ["done", {}],
    ]);
    const client = new clientLib.GetOnlyClient({ fetchImpl: async () => new Response(list), minIntervalMs: 0 });
    const first = await frame.streamSearch(client, frame.FRAMES.S.query);
    const second = await frame.streamSearch(client, frame.FRAMES.S.query);
    const rows = frame.frameRows(first.matches);
    expect(rows.map((r: { repo: string; host: string }) => `${r.host}/${r.repo}`)).toEqual([
      "github.com/a/a",
      "github.com/z/z",
      "gitlab.com/g/g",
    ]);
    expect(frame.frameChecks(first, second, rows).problems).toEqual([]);
    expect(frame.toTsv(rows.slice(0, 1))).toBe(["a/a", "a".repeat(40), "AGENTS.md", "5"].join("\t") + "\n");

    // Index churn of a repository or two is allowed; a silently partial answer is not.
    const churned = { ...second, matches: second.matches.slice(1), progress: undefined };
    expect(frame.frameChecks(first, churned, rows).problems).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => m(`github.com/o/r${i}`));
    const whole = { ...first, matches: many, progress: undefined };
    const partial = { ...first, matches: many.slice(0, 30), progress: undefined };
    expect(frame.frameChecks(whole, partial, frame.frameRows(many)).problems.join(" ")).toMatch(
      /10 repositories only in the first/,
    );
    const moved = {
      ...second,
      matches: second.matches.map((x: { repository: string }) =>
        x.repository === "github.com/z/z" ? m(x.repository, "b".repeat(40)) : x,
      ),
    };
    expect(frame.frameChecks(first, moved, rows)).toMatchObject({ problems: [], commitMoved: 1 });
    const bad = {
      ...first,
      done: false,
      alerts: ["timed out"],
      skipped: ["shard-timeout"],
      progress: { matchCount: 9 },
    };
    expect(frame.frameChecks(bad, second, rows).problems).toHaveLength(4);
    expect(
      frame.frameChecks(first, second, [{ repo: "x/y", commit: "", host: "github.com" }]).problems.join(" "),
    ).toMatch(/no indexed commit/);
  });

  it("asks Sourcegraph with GET only, with fetch and no credentials", async () => {
    let seen: { method: string; auth?: string } | undefined;
    const client = new clientLib.GetOnlyClient({
      fetchImpl: async (_u: string, init: { method: string; headers: Record<string, string> }) => {
        seen = { method: init.method, auth: init.headers.Authorization };
        return new Response(sse([["done", {}]]));
      },
      minIntervalMs: 0,
    });
    await frame.streamSearch(client, frame.FRAMES["S-imp"].query);
    expect(seen).toEqual({ method: "GET", auth: undefined });
  });
});

describe("drawing the sample", () => {
  const frameTsv = Array.from({ length: 300 }, (_, i) => `o${i}/r${i}\t${String(i).padStart(40, "0")}\tAGENTS.md\t1`)
    .reverse()
    .join("\n");

  it("draws in canonical order, so the frame's row order does not matter", () => {
    const rows = sample.readFrame(frameTsv);
    const a = sample.drawSample(rows, { n: 10, seed: "0badcafe", stream: "S-main" });
    const b = sample.drawSample([...rows].reverse(), { n: 10, seed: "0badcafe", stream: "S-main" });
    expect(a).toEqual(b);
    expect(a[0].id).toBe("S-main-0000");
    expect(a.map((r: { index: number }) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("excludes another sample's repositories and round-trips through its TSV", () => {
    const rows = sample.readFrame(frameTsv);
    const main = sample.drawSample(rows, { n: 50, seed: "0badcafe", stream: "S-main" });
    const imp = sample.drawSample(rows, {
      n: 50,
      seed: "0badcafe",
      stream: "S-imp",
      exclude: new Set(main.map((r: { repo: string }) => r.repo)),
    });
    expect(imp.filter((r: { repo: string }) => main.some((x: { repo: string }) => x.repo === r.repo))).toEqual([]);
    const text = sample.sampleTsv(main, "label=pilot");
    expect(sample.readSample(text)).toEqual(main);
  });

  it("takes the seed from the prereg tag, and refuses before the tag exists", () => {
    const repo = tmp("git");
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
        cwd: repo,
        encoding: "utf8",
        env: seed.gitEnv(),
      }).trim();
    git("init", "-q");
    writeFileSync(path.join(repo, "x.md"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "first");
    git("tag", "no-prereg");
    expect(() => seed.seedFromTag("prereg-v1", repo)).toThrow(/does not exist/);
    expect(() => seed.seedFromTag("no-prereg", repo)).toThrow(/does not contain study\/PREREG.md/);
    mkdirSync(path.join(repo, "study"));
    writeFileSync(path.join(repo, "study", "PREREG.md"), "# prereg\n\nbuild {{stamp:dist.digest}}\n");
    git("add", ".");
    git("commit", "-q", "-m", "unstamped");
    git("tag", "unstamped");
    expect(() => seed.seedFromTag("unstamped", repo)).toThrow(/1 placeholder\(s\) \(dist.digest\)/);
    writeFileSync(path.join(repo, "study", "PREREG.md"), "# prereg\n");
    git("add", ".");
    git("commit", "-q", "-m", "prereg");
    git("tag", "prereg-v1");
    const head = git("rev-parse", "HEAD");
    expect(seed.seedFromTag("prereg-v1", repo)).toEqual({
      tag: "prereg-v1",
      commit: head,
      seed: head.slice(0, 8),
      prereg: "# prereg\n",
    });
    expect(prereg.taggedPrereg("prereg-v1", repo)).toBe("# prereg\n");
    expect(prereg.taggedPrereg("no-such-tag", repo)).toBeUndefined();
    // A GIT_DIR pointing elsewhere (as under git rebase --exec) must not redirect either git.
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(tmp("not-a-repo"), ".git");
    try {
      expect(seed.gitEnv().GIT_DIR).toBeUndefined();
      expect(seed.seedFromTag("prereg-v1", repo).commit).toBe(head);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  }, 60_000);
});

describe("the one redraw (study/PREREG.md section 4)", () => {
  const registry = prereg.readRegistry(readFileSync(path.join(ROOT, "study", "PREREG.md"), "utf8"));
  const mainHeader = (draw: string) => ({ label: "study", stream: "S-main", draw, seed: "0badc0de", n: "1100" });

  it("draws a study sample only as draw 1 (offset 0) or its one redraw (offset 1)", () => {
    expect(sample.registeredProblems(registry, { stream: "S-main", n: 1100, offset: 0 })).toEqual([]);
    expect(sample.registeredProblems(registry, { stream: "S-main", n: 1100, offset: 1 })).toEqual([]);
    for (const offset of [2, -1, 0.5])
      expect(
        sample.registeredProblems(registry, { stream: "S-main", n: 1100, offset }).join("\n"),
        String(offset),
      ).toMatch(/--seed-offset 0 \(draw 1\) or 1 \(the one redraw, draw 2\)/);
  });

  it("makes S-imp, and its redraw, exclude S-main's first draw only: a redrawn S-main is counted, not excluded", () => {
    const ok = { stream: "S-imp", n: 385 };
    expect(sample.registeredProblems(registry, { ...ok, excludeHeaders: [mainHeader("1")] })).toEqual([]);
    expect(sample.registeredProblems(registry, { ...ok, offset: 1, excludeHeaders: [mainHeader("1")] })).toEqual([]);
    // The redrawn S-main instead of, or beside, the first draw.
    expect(
      sample.registeredProblems(registry, { ...ok, offset: 1, excludeHeaders: [mainHeader("2")] }).join("\n"),
    ).toMatch(/S-main's first draw/);
    expect(
      sample.registeredProblems(registry, { ...ok, excludeHeaders: [mainHeader("1"), mainHeader("2")] }).join("\n"),
    ).toMatch(/counted against it, not excluded/);
    // A header without a draw, a pilot sample, and an exclusion nobody registered.
    expect(
      sample.registeredProblems(registry, { ...ok, excludeHeaders: [{ ...mainHeader("1"), draw: undefined }] }),
    ).not.toEqual([]);
    expect(
      sample.registeredProblems(registry, { ...ok, excludeHeaders: [{ ...mainHeader("1"), label: "pilot" }] }),
    ).not.toEqual([]);
    expect(
      sample.registeredProblems(registry, { stream: "S-main", n: 1100, excludeHeaders: [mainHeader("1")] }).join("\n"),
    ).toMatch(/S-main excludes nothing/);
  });

  it("writes the draw and the seed offset into the sample's header", () => {
    const line = sample.sampleHeaderText({
      label: "study",
      stream: "S-imp",
      seed: "0badc0df",
      offset: 1,
      n: 385,
      frame: "S-imp.tsv",
      frameSha256: "f".repeat(64),
      excluded: 1100,
    });
    const header = sample.sampleHeader(sample.sampleTsv([], line));
    expect(header).toMatchObject({ label: "study", stream: "S-imp", draw: "2", seed: "0badc0df", seedOffset: "1" });
    expect(sample.sampleHeader(sample.sampleTsv([], sample.sampleHeaderText({ ...header, offset: 0 }))).draw).toBe("1");
  });

  it("refuses a study --seed-offset other than 0 or 1 before drawing", () => {
    const dir = tmp("offset");
    const frameFile = path.join(dir, "S.tsv");
    writeFileSync(frameFile, `o/r\t${"a".repeat(40)}\tAGENTS.md\t1\n`);
    const r = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "study", "census", "sample.mjs"),
        ...["--frame", frameFile, "--n", "1100", "--stream", "S-main", "--seed-from-tag", "prereg-v1"],
        ...["--seed-offset", "2", "--out", path.join(dir, "out.tsv")],
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refusing: .*--seed-offset 0 \(draw 1\) or 1/);
    expect(existsSync(path.join(dir, "out.tsv"))).toBe(false);
  });
});

describe("the pre-registration (study/PREREG.md)", () => {
  const text = readFileSync(path.join(ROOT, "study", "PREREG.md"), "utf8");
  const registry = prereg.readRegistry(text);

  it("registers exactly what the code runs", () => {
    expect(prereg.checkAgainstCode(registry)).toEqual([]);
  });

  it("the registry check fails on drift in any registered value (planted)", () => {
    const copy = () => JSON.parse(JSON.stringify(registry));
    const plants: [string, (r: Record<string, any>) => void][] = [
      ["frames.S", (r) => (r.frames.S = r.frames.S.replace("case:yes ", ""))],
      ["hypotheses", (r) => (r.hypotheses[0].bound = 0.25)],
      ["normalise.minLineChars", (r) => (r.normalise.minLineChars = 30)],
      ["cells.B2.arms.A1", (r) => (r.cells.B2.arms.A1 = 9)],
      ["cells.B2.confirm", (r) => (r.cells.B2.confirm[0][3] = 0.2)],
      ["limits.maxType3Dirs", (r) => (r.limits.maxType3Dirs = 25)],
      ["k4.expectedAtLeast", (r) => (r.k4.expectedAtLeast = 0.95)],
      ["k5.strata", (r) => (r.k5.strata.shadowed = 10)],
      ["k5.trials", (r) => (r.k5.trials = 3)],
      ["k6.pairs", (r) => (r.k6.pairs = 15)],
      ["mapCheckEvery", (r) => (r.mapCheckEvery = 50)],
      ["samples", (r) => delete r.samples["S-imp"]],
      ["seed", (r) => (r.seed.digits = 7)],
    ];
    for (const [key, plant] of plants) {
      const r = copy();
      plant(r);
      const problems: string[] = prereg.checkAgainstCode(r);
      expect(problems.length, key).toBeGreaterThan(0);
      expect(problems.join("\n"), key).toContain(key.split(".")[0]);
    }
  });

  it("reports a cell without a refute rule as not confirmed, never refuted, in the text and in the code", () => {
    expect(text.replace(/\s+/g, " ")).toContain(
      "A cell without a refute rule whose confirm rule is not met is reported **not confirmed** (`not-confirmed` in `cells-results.json`), never **refuted**.",
    );
    type Rule = [string, string, string, number];
    const cells = Object.entries(
      registry.cells as Record<string, { arms: Record<string, number>; confirm: Rule[]; refute: Rule[] }>,
    );
    const noRefute = cells.filter(([, c]) => c.confirm.length && !c.refute.length);
    expect(noRefute.map(([id]) => id).sort()).toEqual(["B1", "B3", "B4", "B6"]);
    for (const [id, c] of noRefute) {
      // Every observable at the far end from what the confirm rule needs: the strongest evidence against.
      const arms: Record<
        string,
        { planned: number; usable: number; observe: Record<string, { k: number; n: number }> }
      > = {};
      for (const [arm, trials] of Object.entries(c.arms)) arms[arm] = { planned: trials, usable: trials, observe: {} };
      for (const [arm, key, op] of c.confirm) {
        const n = arms[arm]!.usable;
        arms[arm]!.observe[key] = { k: op === "<=" ? n : 0, n };
      }
      expect(cellsLib.decideCell({ id, ...c }, arms), id).toBe("not-confirmed");
    }
  });

  it("tells repository owners to opt out through an issue on the public repository, and gives no email address", () => {
    const optOut =
      "Repository owners can opt out by opening an issue on github.com/Shivansh2904/ctxreach; there is no email address to write to.";
    const docs = ["study/PREREG.md", "study/census/README.md"];
    for (const doc of docs)
      expect(readFileSync(path.join(ROOT, ...doc.split("/")), "utf8").replace(/\s+/g, " "), doc).toContain(optOut);
    const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
    for (const doc of [...docs, "README.md", "study/behavioural/README.md"])
      expect(email.exec(readFileSync(path.join(ROOT, ...doc.split("/")), "utf8"))?.[0] ?? null, doc).toBe(null);
    expect(email.test("write to someone@example.org")).toBe(true);
  });

  /** The text of one numbered section ("## 7. ..." up to the next "## "), whitespace collapsed. */
  const section = (n: number) => {
    const from = text.indexOf(`\n## ${n}. `);
    const to = text.indexOf("\n## ", from + 1);
    expect(from, `section ${n}`).toBeGreaterThan(0);
    return text.slice(from, to).replace(/\s+/g, " ");
  };

  /** Three measured rows of a complete S-main draw, every detector at its no-event value. */
  const threeRows = () =>
    Array.from({ length: 3 }, (_, i) => ({
      frame: "S-main",
      sampleN: 3,
      id: `S-main-${i}`,
      index: i,
      repo: `o${i}/r`,
      owner: `o${i}`,
      status: "measured",
      faults: [],
      blobs: { rootAgents: `b${i}` },
      launch: { t2: [], t2Total: 0, t3: [], t3Total: 0 },
      pairs: [{ dir: ".", type: 1, codex: { chain: [] } }],
      outcomes: {
        o1content: { eligible: true, event: false, share: 1 },
        o1contentShingle: { eligible: true, event: false },
        o1file: { eligible: true, event: false },
        o2: { eligible: true, t2Dirs: 0, event: false, eventDirs: [], eventT123: false, t3EventDirs: [] },
        p1: { pairs: 1, eventDirs: [], repoEvent: false, pairsT3: 0, t3EventDirs: [], repoEventT123: false },
        o4: { eligible: true, event: false },
        o5: { rootWarn: [], rootWarnMap: [], anyWarn: [], linkAffected: false },
        o6: { eligible: true, event: false },
        o7: { links: 0, broken: 0, event: false, rootLinkToAgents: false },
        o8: { eligible: true, event: false, bytes: 1, effectiveChars: 1 },
        k3: { eligible: true, event: false },
      },
    }));

  it("names every figure analyze.mjs writes, and analyze.mjs writes every figure it names", () => {
    const res = analyze.analyze({ rowSets: [{ file: "r", sha256: "x", rows: threeRows() }] });
    const generic = (id: string) => id.replace(/^(O5-root(?:-map)?):.*$/, "$1:<code>");
    const written = new Set([...res.outcomes, ...res.summaries].map((o: { id: string }) => generic(o.id)));
    // Sections 0, 4 and 6 to 8 name figures in backticks: O1-content, P1-repos, O5-root:<code>, K3-regex-O1-file, ...
    const prose = [0, 4, 6, 7, 8].map(section).join(" ");
    const named = new Set(
      [...prose.matchAll(/`((?:O|P|K)\d[A-Za-z0-9-]*(?::[a-z<>.-]+)?)`/g)].map((m) => generic(m[1]!)),
    );
    expect([...named].filter((id) => !written.has(id)).sort(), "named in PREREG.md, not written").toEqual([]);
    expect([...written].filter((id) => !named.has(id)).sort(), "written, not named in PREREG.md").toEqual([]);
  });

  it("names `in results.json` only keys analyze.mjs writes", () => {
    const res = analyze.analyze({ rowSets: [{ file: "r", sha256: "x", rows: threeRows() }] });
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
    };
    walk(res);
    const flat = text.replace(/\s+/g, " ");
    const named = [...flat.matchAll(/`([A-Za-z][A-Za-z0-9]*)` in `results\.json`/g)].map((m) => m[1]!);
    expect(named).toEqual(expect.arrayContaining(["redrawRequired", "sharedRepos", "type2Capped", "ineligibleWhy"]));
    expect(named.filter((k) => !keys.has(k) && k !== "sharedRepos")).toEqual([]);
    // sharedRepos is written only beside another sample in use.
    const imp = threeRows().map((r) => ({ ...r, frame: "S-imp", id: `S-imp-${r.index}` }));
    const both = analyze.analyze({ rowSets: [{ file: "r", sha256: "x", rows: [...threeRows(), ...imp] }] });
    expect(both.frames["S-main"]).toHaveProperty("sharedRepos", { "S-imp": 3 });
  });

  it("holds every tag-time value once in the stamps block, which the scripts read", () => {
    expect(prereg.stampsBlockProblems(text)).toEqual([]);
    expect(registryLib.readStamps(text)).toEqual({});
    const block = registryLib.readStampsBlock(text);
    expect(Object.keys(block).sort()).toEqual([...prereg.STAMP_KEYS].sort());
    // Planted: a key left out, a key nobody stamps, another key's placeholder.
    const plant = (f: (b: Record<string, string>) => void) => {
      const b = { ...block };
      f(b);
      return prereg.stampsBlockProblems(
        text.replace(
          /```json prereg-stamps\n[\s\S]*?\n```/,
          `\`\`\`json prereg-stamps\n${JSON.stringify(b, null, 2)}\n\`\`\``,
        ),
      );
    };
    expect(plant((b) => delete b["dist.digest"]).join("\n")).toMatch(/no dist\.digest/);
    expect(plant((b) => (b["frame.G.sha256"] = "x")).join("\n")).toMatch(/frame\.G\.sha256 is not a tag-time value/);
    expect(plant((b) => (b["dist.digest"] = "{{stamp:node.version}}")).join("\n")).toMatch(/dist\.digest holds/);
    // Stamped, the block holds the values, and readStamps returns them.
    const values = Object.fromEntries((prereg.STAMP_KEYS as string[]).map((k) => [k, `v-${k}`]));
    const filled = prereg.applyStamps(text, values).text;
    expect(prereg.stampsBlockProblems(filled)).toEqual([]);
    expect(registryLib.readStamps(filled)).toEqual(values);
  });

  it("refuses, once tagged, any change above the Deviations heading and any edit below it; appending is fine", () => {
    const tagged = "# P\n\n## 1. A\n\ntext\n\n## Deviations\n\nAppended below this line.\n";
    const check = (working: string) => registryLib.appendOnlyProblems(tagged, working).join("\n");
    expect(check(tagged)).toBe("");
    expect(check(tagged + "\n### 2026-10-10\n\nA deviation.\n")).toBe("");
    expect(check(tagged.replace(/\n/g, "\r\n"))).toBe("");
    expect(check(tagged.replace("text", "test"))).toMatch(
      /line 5 differs from prereg-v1: nothing above the Deviations heading changes/,
    );
    expect(check(tagged.replace("Appended below", "Added below"))).toMatch(
      /line 9, in the Deviations section .* edited in place/,
    );
    expect(check(tagged.replace("this line.\n", "this line, and more.\n"))).toMatch(/edited in place/);
    expect(registryLib.appendOnlyProblems("# P\n", "# P\n").join()).toMatch(/no "## Deviations" heading/);
    // The registration itself has the heading, and is unchanged against itself.
    expect(registryLib.appendOnlyProblems(text, text)).toEqual([]);
  });

  it("draws a study sample only from the frame TSV the tag stamps, under an unchanged registration", () => {
    const tsv = `o/r\t${"a".repeat(40)}\tAGENTS.md\t1\n`;
    const sha = createHash("sha256").update(tsv).digest("hex");
    const values = Object.fromEntries((prereg.STAMP_KEYS as string[]).map((k) => [k, `v-${k}`]));
    const tagged = prereg.applyStamps(text, {
      ...values,
      "frame.S.sha256": sha,
      "frame.S-imp.sha256": "f".repeat(64),
    }).text;
    const problems = (o: Record<string, string>) =>
      sample.studyFrameProblems({ tagged, working: tagged, stream: "S-main", frameSha256: sha, ...o }).join("\n");
    expect(problems({})).toBe("");
    expect(problems({ working: tagged + "\n### 2026-10-10\n\nA deviation.\n" })).toBe("");
    expect(problems({ frameSha256: "0".repeat(64) })).toMatch(/is not frame S's, as prereg-v1 stamps it/);
    expect(problems({ stream: "S-imp" })).toMatch(/is not frame S-imp's/);
    expect(problems({ working: text })).toMatch(/differs from prereg-v1: nothing above the Deviations heading/);
    expect(problems({ tagged: text, working: text })).toMatch(/prereg-v1 stamps no SHA-256 for frame S/);
  });

  it("states O8's CJK characters as the code tests them, code point for code point", () => {
    const o8 = section(7);
    const listed = /CJK characters are the code points in ([^;]+);/.exec(o8)?.[1];
    expect(listed).toBeDefined();
    const ranges = listed!
      .replace(/ and /g, ", ")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((r) => {
        const m = /^U\+([0-9A-F]{4,5})–([0-9A-F]{4,5})$/.exec(r);
        expect(m, r).not.toBeNull();
        return [parseInt(m![1]!, 16), parseInt(m![2]!, 16)] as const;
      });
    const inText = (cp: number) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
    const wrong: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++)
      if (norm.CJK.test(String.fromCodePoint(cp)) !== inText(cp)) wrong.push(cp.toString(16));
    expect(wrong.slice(0, 10)).toEqual([]);
    // Whitespace is left out of the denominator, as the text says.
    expect(norm.cjkShare("漢 a　\n")).toBe(0.5);
  });

  it("uses one wording per instrument in section 9, section 10, cells.json and results.json", () => {
    const cells = JSON.parse(readFileSync(path.join(ROOT, "study", "behavioural", "cells.json"), "utf8"));
    const capture = "delivered to the model endpoint (custom base URL, gateway path)";
    const echo = "echoed by the model in a first-party session; an echo proves delivery, not compliance";
    expect(cells.instruments.capture.wording.startsWith(capture)).toBe(true);
    expect(cells.instruments.echo.wording).toBe(echo);
    for (const n of [9, 10]) expect(section(n), `section ${n}`).toContain(`"${capture}"`);
    expect(section(9)).toContain(`"${echo}"`);
    expect(section(10)).not.toMatch(/model endpoint \(custom base URL\)"/);
    const res = analyze.analyze({ rowSets: [] });
    for (const [agent, wording] of Object.entries(res.wording as Record<string, string>))
      if (agent !== "pairs") expect(section(10), agent).toContain(`"${wording}"`);
  });

  it("says which checks stop the study and which are validity estimates, as the code has them", () => {
    const s8 = section(8);
    expect(s8).toContain(
      "K4, K5 and K6 are validity estimates with no pass threshold: each is reported as found, with its Wilson 95% interval, and stops nothing.",
    );
    const rowOf = (k: string) => {
      const from = s8.indexOf(`| ${k} `);
      const next = s8.indexOf("| K", from + 3);
      return s8.slice(from, next > 0 ? next : undefined);
    };
    for (const k of ["K4", "K5", "K6"]) expect(rowOf(k), k).toMatch(/a validity estimate, no pass threshold/i);
    for (const k of ["K1", "K2", "K3", "K7"]) expect(rowOf(k), k).not.toMatch(/validity estimate/);
    expect(s8).toContain("`checks.K4.expectationMet`");
    expect(analyze.k4Summary([{ repo: "a", k4: { pairs: [{ dir: ".", verdict: "EXACT" }] } }])).toHaveProperty(
      "expectationMet",
      true,
    );
  });

  it("orders the main session's work as the scripts require: study-v1 is tagged before the stamp", () => {
    const readme = readFileSync(path.join(ROOT, "study", "census", "README.md"), "utf8");
    const order = readme.slice(readme.indexOf("## Order in the main session"));
    const at = (s: string) => {
      const i = order.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      return i;
    };
    expect(at("git tag study-v1")).toBeLessThan(at("npm run build"));
    expect(at("npm run build")).toBeLessThan(at("node study/prereg.mjs stamp"));
    expect(at("node study/prereg.mjs stamp")).toBeLessThan(at("git tag prereg-v1"));
    expect(at("git tag prereg-v1")).toBeLessThan(at("node study/census/seed.mjs"));
    expect(order).toContain("--seed-offset 1");
  });

  it("holds a placeholder for every tag-time value and no other", () => {
    expect([...prereg.placeholders(text)].sort()).toEqual([...prereg.STAMP_KEYS].sort());
  });

  it("lists every registered arm and its trials in the cells table", () => {
    const rows = text.split("\n").filter((l: string) => /^\| (\*\*)?B\d/.test(l));
    for (const [id, cell] of Object.entries(registry.cells as Record<string, { arms: Record<string, number> }>)) {
      const row = rows.find((l: string) => l.startsWith(`| ${id} `) || l.startsWith(`| **${id}**`));
      expect(row, id).toBeDefined();
      for (const [arm, trials] of Object.entries(cell.arms)) expect(row, `${id} ${arm}`).toContain(`${arm} ${trials}`);
    }
  });

  it("stamps every value from a study freeze, and refuses pilot frames, a moved TSV, changed sources and known defects", () => {
    const repo = tmp("stamp");
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], {
        cwd: repo,
        encoding: "utf8",
        env: seed.gitEnv(),
      }).trim();
    git("init", "-q");
    mkdirSync(path.join(repo, "src"));
    writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "ctxreach", version: "1.0.0" }));
    git("add", ".");
    git("commit", "-q", "-m", "tool");
    git("tag", "study-v1");
    const dist = path.join(repo, "dist");
    mkdirSync(dist);
    writeFileSync(path.join(dist, "cli.js"), "// built\n");
    const frames = path.join(repo, "frames");
    mkdirSync(frames);
    const freeze = (frame: string, label = "study") => {
      const tsv = `o/r${frame}\t${"a".repeat(40)}\tAGENTS.md\t1\n`;
      writeFileSync(path.join(frames, `${frame}-2026-10-01.tsv`), tsv);
      const m = {
        label,
        frame,
        query: registry.frames[frame],
        repos: 1,
        file: `${frame}-2026-10-01.tsv`,
        sha256: createHash("sha256").update(tsv).digest("hex"),
        problems: [],
        valid: true,
        fetchedAt: "2026-10-01T10:00:00.000Z",
        client: "requests: 2 (sourcegraph.com 2); non-GET attempts: 0",
      };
      writeFileSync(path.join(frames, `${frame}-2026-10-01.manifest.json`), JSON.stringify(m));
    };
    for (const f of ["S", "S-imp", "S-ci"]) freeze(f);
    writeFileSync(
      path.join(frames, "K3-2026-10-01.manifest.json"),
      JSON.stringify({
        label: "study",
        frame: "K3",
        counts: { claude: 7, claudeImport: 2 },
        problems: [],
        valid: true,
        fetchedAt: "2026-10-01T10:05:00.000Z",
        client: "requests: 4 (sourcegraph.com 4); non-GET attempts: 0",
      }),
    );
    const noDefects = { knownDefects: {} };
    const ok = prereg.stampValues({ framesDir: frames, distDir: dist, cwd: repo, registry, answers: noDefects });
    expect(ok.problems).toEqual([]);
    expect(ok.values["study-v1.commit"]).toBe(git("rev-parse", "HEAD"));
    expect(ok.values["ctxreach.version"]).toBe("1.0.0");
    expect(ok.values["K3.claudeImport"]).toBe("2");
    const filled = prereg.applyStamps(text, ok.values);
    expect(filled.missing).toEqual([]);
    expect(prereg.placeholders(filled.text)).toEqual([]);
    expect(prereg.checkAgainstCode(prereg.readRegistry(filled.text))).toEqual([]);

    // Each fault is refused.
    const problemsWith = (answers = noDefects) =>
      prereg.stampValues({ framesDir: frames, distDir: dist, cwd: repo, registry, answers }).problems.join("\n");
    expect(problemsWith({ knownDefects: { x: {} } })).toMatch(/known map defects would fail K1: x/);
    writeFileSync(path.join(repo, "src", "a.ts"), "export const a = 2;\n");
    expect(problemsWith()).toMatch(/differ from study-v1/);
    git("checkout", "--", "src");
    writeFileSync(path.join(frames, "S-2026-10-01.tsv"), "o/moved\n");
    expect(problemsWith()).toMatch(/frame S: S-2026-10-01.tsv no longer has the SHA-256/);
    freeze("S", "pilot");
    expect(problemsWith()).toMatch(/frame S: labelled pilot, not study/);
    freeze("S");
    expect(problemsWith()).toBe("");
    git("tag", "-d", "study-v1");
    expect(problemsWith()).toMatch(/tag study-v1 does not exist/);
  }, 60_000);

  it("draws a study sample only with its registered stream, size and exclusion", () => {
    expect(sample.registeredProblems(registry, { stream: "S-main", n: 1100 })).toEqual([]);
    expect(sample.registeredProblems(registry, { stream: "S-main", n: 1000 })).toEqual([
      "S-main is registered with n = 1100, not 1000",
    ]);
    expect(sample.registeredProblems(registry, { stream: "S-other", n: 1100 })[0]).toMatch(/not a registered sample/);
    expect(sample.registeredProblems(registry, { stream: "S-imp", n: 385 })[0]).toMatch(
      /must exclude the study sample S-main/,
    );
    const header = sample.sampleHeader(
      "# label=study stream=S-main draw=1 seed=0badc0de seedOffset=0 n=1100\n0\tS-main-0000\to/r\tabc\n",
    );
    expect(header).toMatchObject({ label: "study", stream: "S-main", draw: "1", n: "1100" });
    expect(sample.registeredProblems(registry, { stream: "S-imp", n: 385, excludeHeaders: [header] })).toEqual([]);
    expect(
      sample.registeredProblems(registry, { stream: "S-imp", n: 385, excludeHeaders: [{ ...header, label: "pilot" }] }),
    ).toEqual([
      "S-imp excludes only the study sample S-main; --exclude S-main (label pilot) is not registered",
      "S-imp must exclude the study sample S-main's first draw (--exclude its draw=1 TSV)",
    ]);
  });
});

describe("the census run, analysis and K3", () => {
  const names = [
    "claude-words-not-import",
    "claude-words-not-import-twin",
    "codex-over-cap",
    "census-o2-package-claude",
  ];
  async function census(extraRepos: unknown[] = [], extraUnits: string[] = [], header = "label=test") {
    const repos = [
      ...names.map((n) =>
        local.localRepo(
          n,
          path.join(ROOT, n.startsWith("census") ? "study/census/known-answer-fixtures" : "test/fixtures", n, "repo"),
        ),
      ),
      ...extraRepos,
    ];
    const dir = tmp("census");
    const sampleFile = path.join(dir, "sample.tsv");
    const units = [...names, ...extraUnits].map((n, i) => ({
      index: i,
      id: `T-${i}`,
      repo: `fixture/${n}`,
      commit: local.fixtureCommit(n),
    }));
    writeFileSync(sampleFile, sample.sampleTsv(units, header));
    const out = path.join(dir, "rows.jsonl");
    const logs: string[] = [];
    const args = {
      sample: sampleFile,
      frameName: "S-main",
      out,
      work: path.join(dir, "work"),
      seed: "00000000",
      label: "pilot",
      fetchImpl: local.localFetch(repos),
      mapRunner: inProcessMapRunner(),
      minFreeGb: 0,
      log: (l: string) => logs.push(l),
    };
    return { args, out, logs, dir };
  }

  it("measures every unit, records exclusions, resumes, and counts zero non-GET attempts", async () => {
    const fork = local.localRepo("forked", path.join(ROOT, "test", "fixtures", "codex-over-cap", "repo"), {
      meta: { fork: true },
    });
    const { args, out, logs } = await census([fork], ["forked"]);
    const first = await runCensus.runCensus(args);
    expect(first.code).toBe(0);
    expect(first.manifest.client.nonGetAttempts).toBe(0);
    expect(first.manifest.exclusions).toEqual({ fork: 1 });
    const rows = runCensus.readRows(out);
    expect(rows.map((r: { status: string }) => r.status)).toEqual([
      "measured",
      "measured",
      "measured",
      "measured",
      "excluded",
    ]);
    expect(rows.every((r: { label: string; frame: string }) => r.label === "pilot" && r.frame === "S-main")).toBe(true);
    const again = await runCensus.runCensus(args);
    expect(again.manifest.units).toBe(0);
    expect(logs.join("\n")).toMatch(/non-GET attempts: 0/);
  }, 60_000);

  it("checks map in process against the CLI on every Nth unit, and faults a unit where they differ", async () => {
    const { args, out } = await census();
    const primary = inProcessMapRunner();
    let asked = 0;
    const reference = async (opts: Record<string, string>) => {
      asked++;
      const r = await primary(opts);
      // The third unit (T-2) is where the planted reference disagrees.
      return /[\\/]T-2[\\/]/.test(opts.launchDir!) ? { json: { ...r.json, version: "9.9.9" } } : r;
    };
    const res = await runCensus.runCensus({ ...args, referenceRunner: reference, cliCheckEvery: 2 });
    expect(res.code).toBe(1);
    const rows = runCensus.readRows(out);
    const check = res.manifest.map.check;
    expect(check).toMatchObject({ every: 2, units: 2 });
    expect(check.checked).toBe(asked);
    expect(check.agreed).toBe(asked - check.differ.length);
    expect(check.differ.length).toBeGreaterThan(0);
    expect(check.differ.every((d: string) => /[\\/]T-2[\\/]/.test(d))).toBe(true);
    expect(rows.find((r: { id: string }) => r.id === "T-2").faults.join("\n")).toMatch(/disagree/);
    expect(rows.filter((r: { faults?: string[] }) => r.faults?.length).map((r: { id: string }) => r.id)).toEqual([
      "T-2",
    ]);
  }, 60_000);

  it("checks the same units against the CLI when a run is resumed: by position in the sample, not in the run", async () => {
    const { args } = await census();
    const primary = inProcessMapRunner();
    const asked: string[] = [];
    const reference = async (opts: Record<string, string>) => {
      asked.push(opts.launchDir!);
      return primary(opts);
    };
    const first = await runCensus.runCensus({ ...args, referenceRunner: reference, cliCheckEvery: 2, limit: 1 });
    expect(first.manifest.map.check.units).toBe(1);
    const resumed = await runCensus.runCensus({ ...args, referenceRunner: reference, cliCheckEvery: 2 });
    // T-1, T-2 and T-3 remain; only T-2 is at an even position (counting by the run would have checked T-1 and T-3).
    expect(resumed.manifest.map.check.units).toBe(1);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((d) => /[\\/]T-[02][\\/]/.test(d))).toBe(true);
    expect(asked.some((d) => /[\\/]T-2[\\/]/.test(d))).toBe(true);
  }, 60_000);

  it("refuses to start when gh api does not answer, before the first unit", async () => {
    const { args, out, logs } = await census();
    const loggedOut = async () => {
      throw new clientLib.GhUnavailable("gh api exited 4: To get started with GitHub CLI, please run:  gh auth login");
    };
    const r = await runCensus.runCensus({ ...args, ghApi: loggedOut });
    expect(r.code).toBe(2);
    expect(logs.join("\n")).toMatch(/refusing: .*gh auth login/);
    expect(runCensus.readRows(out)).toEqual([]);
  });

  it("refuses to run under a directory holding an instruction file", async () => {
    const { args, dir } = await census();
    writeFileSync(path.join(dir, "CLAUDE.md"), "# would reach every reconstruction\n");
    expect((await runCensus.runCensus(args)).code).toBe(2);
  });

  it("analyses rows into fractions per frame and variant, with the pre-registered verdicts", async () => {
    const { args, out } = await census();
    await runCensus.runCensus(args);
    const rows = runCensus.readRows(out);
    // Two more repositories with the first one's root AGENTS.md blob, all under one owner ("fixture").
    const copy = { ...rows[0], id: "T-9", index: 9, repo: "fixture/copy" };
    const copy2 = { ...rows[0], id: "T-10", index: 10, repo: "fixture/copy2" };
    // A sample of 6: the 4 measured rows and the two copies.
    const six = [...rows, copy, copy2].map((r) => ({ ...r, sampleN: 6 }));
    const res = analyze.analyze({ rowSets: [{ file: "rows.jsonl", sha256: "x", rows: six }] });
    const get = (id: string, variant = "raw") =>
      res.outcomes.find(
        (o: { id: string; frame: string; variant: string }) =>
          o.id === id && o.frame === "S-main" && o.variant === variant,
      );
    expect(get("O1-content")).toMatchObject({ k: 3, n: 6 });
    expect(get("O1-content", "dedup")).toMatchObject({ k: 1, n: 3 });
    expect(get("O1-content", "ownercap")).toMatchObject({ k: 2, n: 5 });
    expect(get("O2")).toMatchObject({ k: 1, n: 6 });
    expect(get("P1-repos")).toMatchObject({ k: 1, n: 6 });
    expect(get("P1-pairs")).toMatchObject({ k: 1, n: 7 });
    expect(get("O5-root:claude.words-not-import")).toMatchObject({ k: 3, n: 6 });
    const h1 = res.hypotheses.find((h: { id: string }) => h.id === "H1");
    expect(h1.verdict).toBe("inconclusive");
    expect(res.frames["S-main"]).toMatchObject({ drawn: 6, measured: 6, excluded: 0, redrawRequired: false });
  }, 60_000);

  it("reports per frame how many measured repositories had more type-2 directories than the cap", async () => {
    const { args, out } = await census();
    await runCensus.runCensus(args);
    const rows = runCensus.readRows(out);
    const capped = {
      ...rows[0],
      id: "T-9",
      index: 9,
      repo: "other/capped",
      owner: "other",
      launch: { ...rows[0].launch, t2Total: 21 },
    };
    const five = [...rows, capped].map((r) => ({ ...r, sampleN: 5 }));
    const res = analyze.analyze({ rowSets: [{ file: "rows.jsonl", sha256: "x", rows: five }] });
    expect(res.frames["S-main"].type2Capped).toMatchObject({ k: 1, n: 5, cap: 20 });
  }, 60_000);

  describe("every statistic PREREG.md promises is in results.json", () => {
    type Outcome = { id: string; frame: string; variant: string; k: number; n: number; ineligible: number };
    /** A measured row holding only what analyze reads: every detector at its no-event value unless overridden. */
    function row(i: number, outcomes: Record<string, unknown> = {}, rootChain?: unknown[]) {
      return {
        frame: "S-main",
        index: i,
        repo: `owner${i}/repo`,
        owner: `owner${i}`,
        status: "measured",
        faults: [],
        blobs: { rootAgents: `blob-${i}` },
        launch: { t2: [], t2Total: 0, t3: [], t3Total: 0 },
        pairs: [
          {
            dir: ".",
            type: 1,
            codex: { chain: rootChain ?? [{ path: "AGENTS.md", bytes: 100, kept: 100, status: "loaded" }] },
          },
        ],
        outcomes: {
          o1content: { eligible: true, a: 4, r: 4, share: 1, event: false },
          o1contentShingle: { eligible: true, a: 4, r: 4, share: 1, event: false },
          o1file: { eligible: true, event: false, via: "map" },
          o2: { eligible: true, t2Dirs: 0, event: false, eventDirs: [], eventT123: false, t3EventDirs: [] },
          p1: { pairs: 1, eventDirs: [], repoEvent: false, pairsT3: 0, t3EventDirs: [], repoEventT123: false },
          o4: { eligible: true, nested: 0, notPreloaded: 0, event: false },
          o5: { rootWarn: [], rootWarnMap: [], anyWarn: [], linkAffected: false },
          o6: { eligible: true, event: false },
          o7: { links: 0, broken: 0, event: false, rootLinkToAgents: false },
          o8: { eligible: true, cjkShare: 0, event: false, bytes: 100, chars: 100, effectiveChars: 100 },
          k3: { eligible: true, rootClaude: false, event: false },
          ...outcomes,
        },
      };
    }
    function run(rows: Record<string, unknown>[]) {
      const complete = rows.map((r) => ({ ...r, sampleN: rows.length }));
      const res = analyze.analyze({ rowSets: [{ file: "rows.jsonl", sha256: "x", rows: complete }] });
      const get = (id: string, variant = "raw") =>
        (res.outcomes as Outcome[]).find((o) => o.id === id && o.frame === "S-main" && o.variant === variant);
      return { res, get };
    }

    it("reports Codex's share of the root AGENTS.md beside O1-content, in bytes, over O1-content's repositories", () => {
      const { get } = run([
        row(0, {}, [{ path: "AGENTS.md", bytes: 40960, kept: 32768, status: "cut" }]),
        row(1, {}, [{ path: "AGENTS.md", bytes: 100000, kept: 32768, status: "cut" }]),
        // A root AGENTS.override.md takes the root's slot: Codex keeps none of the root AGENTS.md.
        row(2, {}, [{ path: "AGENTS.override.md", bytes: 50, kept: 50, status: "loaded" }]),
        row(3),
        row(4, { o1content: { eligible: false, why: "no line of 20 or more characters", a: 0 } }),
      ]);
      expect(get("O1-codex-under-half")).toMatchObject({ k: 2, n: 4, ineligible: 1 });
      expect(get("O1-codex-under-all")).toMatchObject({ k: 3, n: 4, ineligible: 1 });
      expect(get("O1-codex-under-half")!.n).toBe(get("O1-content")!.n);
    });

    it("counts each outcome's ineligible repositories by reason, so |A| = 0 is counted apart", () => {
      const { res, get } = run([
        row(0),
        row(1, {
          o1content: { eligible: false, why: "no root AGENTS.md" },
          o2: { eligible: false, why: "no root AGENTS.md" },
        }),
        row(2, { o1content: { eligible: false, why: "no line of 20 or more characters", a: 0 } }),
        row(3, { o2: { eligible: true, t2Dirs: 2, event: true, eventDirs: ["a"], eventT123: true, t3EventDirs: [] } }),
      ]);
      expect(get("O1-content")).toMatchObject({
        k: 0,
        n: 2,
        ineligible: 2,
        ineligibleWhy: { "no root AGENTS.md": 1, "no line of 20 or more characters": 1 },
      });
      expect(get("O2-given-type2")).toMatchObject({
        k: 1,
        n: 1,
        ineligibleWhy: { "no root AGENTS.md": 1, "no type-2 launch directory": 2 },
      });
      for (const o of res.outcomes as (Outcome & { unit: string; ineligibleWhy?: Record<string, number> })[]) {
        if (o.unit !== "repository") continue;
        const sum = Object.values(o.ineligibleWhy ?? {}).reduce((a, b) => a + b, 0);
        expect([o.id, o.variant, sum]).toEqual([o.id, o.variant, o.ineligible]);
      }
    });

    it("reports O5 and O6 as map printed them, beside the figures after the symlink rule", () => {
      const { get } = run([
        // map warned on the reconstruction's copy of a link; the symlink rule removes both warnings.
        row(0, {
          o5: {
            rootWarn: [],
            rootWarnMap: ["claude.agents-shadowed", "claude.words-not-import"],
            anyWarn: [],
            linkAffected: true,
          },
        }),
        row(1, { o5: { rootWarn: ["codex.nested"], rootWarnMap: ["codex.nested"], anyWarn: [], linkAffected: false } }),
        row(2),
        row(3, { o6: { eligible: false, why: "root launch not measured" } }),
      ]);
      expect(get("O5-any-root-warning")).toMatchObject({ k: 1, n: 4 });
      expect(get("O5-any-root-warning-map")).toMatchObject({ k: 2, n: 4 });
      expect(get("O5-root:claude.words-not-import")).toMatchObject({ k: 0, n: 4 });
      expect(get("O5-root-map:claude.words-not-import")).toMatchObject({ k: 1, n: 4 });
      expect(get("O5-root-map:codex.nested")).toMatchObject({ k: 1, n: 4 });
      expect(get("O6")).toMatchObject({ k: 0, n: 3 });
      expect(get("O6-map")).toMatchObject({ k: 1, n: 3, ineligibleWhy: { "root launch not measured": 1 } });
    });

    it("prints an O5 row for every warn code in docs/rules.md, 0/n included, in both forms", () => {
      const doc = readFileSync(path.join(ROOT, "docs", "rules.md"), "utf8");
      const documented = [...doc.matchAll(/^\| `((?:codex|claude)\.[a-z-]+)` \| warn \|/gm)].map((m) => m[1]);
      expect([...analyze.WARN_CODES].sort()).toEqual(documented.sort());
      const { get } = run([
        row(0),
        row(1, { o5: { rootWarn: ["codex.later"], rootWarnMap: ["codex.later"], anyWarn: [], linkAffected: false } }),
      ]);
      for (const variant of ["raw", "dedup", "ownercap"])
        for (const code of analyze.WARN_CODES as string[]) {
          expect(get(`O5-root:${code}`, variant), `${variant} ${code}`).toMatchObject({ k: 0, n: 2 });
          expect(get(`O5-root-map:${code}`, variant), `${variant} ${code}`).toMatchObject({ k: 0, n: 2 });
        }
      // A code the list does not know is still reported.
      expect(get("O5-root:codex.later")).toMatchObject({ k: 1, n: 2 });
      expect(get("O5-root:claude.link-as-text")).toMatchObject({ k: 0, n: 2 });
    });

    it("reports repositories with a broken instruction-file link (O7)", () => {
      const { get } = run([
        row(0, { o7: { links: 2, broken: 1, event: true, rootLinkToAgents: false } }),
        row(1, { o7: { links: 1, broken: 0, event: true, rootLinkToAgents: true } }),
        row(2),
      ]);
      expect(get("O7")).toMatchObject({ k: 2, n: 3 });
      expect(get("O7-broken")).toMatchObject({ k: 1, n: 3 });
      expect(get("O7-root-link-to-agents")).toMatchObject({ k: 1, n: 3 });
    });

    it("reports, for root AGENTS.md files over Codex's budget, the characters its 32,768 bytes hold, by O8 event", () => {
      const o8 = (event: boolean, bytes: number, effectiveChars: number) => ({
        o8: { eligible: true, cjkShare: event ? 0.9 : 0, event, bytes, chars: effectiveChars, effectiveChars },
      });
      const { res, get } = run([
        row(0, o8(true, 40000, 10923)),
        row(1, o8(true, 50000, 11000)),
        row(2, o8(true, 300, 100)),
        row(3, o8(false, 40960, 32768)),
        row(4, { o8: { eligible: false, why: "no root AGENTS.md" } }),
      ]);
      expect(get("O8")).toMatchObject({ k: 3, n: 4 });
      expect(get("O8-over-budget")).toMatchObject({ k: 3, n: 4, ineligibleWhy: { "no root AGENTS.md": 1 } });
      const held = (res.summaries as { id: string; frame: string; variant: string }[]).find(
        (s) => s.id === "O8-held-chars" && s.frame === "S-main" && s.variant === "raw",
      );
      expect(held).toMatchObject({
        budget: 32768,
        cjk: { n: 2, min: 10923, median: 10961.5, max: 11000 },
        other: { n: 1, min: 32768, median: 32768, max: 32768 },
      });
    });
  });

  /** PREREG.md as the tag would hold it once stamped, with the injected runner as the frozen build. */
  const taggedText = prereg.applyStamps(
    readFileSync(path.join(ROOT, "study", "PREREG.md"), "utf8"),
    Object.fromEntries(
      (prereg.STAMP_KEYS as string[]).map((k) => [k, k === "dist.digest" ? "injected runner (tests)" : `v-${k}`]),
    ),
  ).text;
  /** A study run's options: the seed and registration from a stand-in tag, the stamped build, Codex for K4 at the registered version. */
  const studyRun = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...args,
    label: "study",
    seed: undefined,
    seedFromTag: "prereg-v1",
    seedResolver: (tag: string) => ({
      tag,
      commit: `0badc0de${"0".repeat(32)}`,
      seed: "0badc0de",
      prereg: taggedText,
    }),
    workingPrereg: taggedText,
    expectDist: "injected runner (tests)",
    codexBin: FAKE_CODEX,
    codexVersionOf: async () => "codex-cli 0.159.2",
    ...extra,
  });
  const studyHeader = (fields = "") =>
    `label=study stream=S-main draw=1 seed=0badc0de seedOffset=0 n=4 frame=S.tsv ${fields}`.trim();

  it("takes a study run's seed from the prereg tag, which also seeds the type-2 and type-3 draws", async () => {
    const { args, logs } = await census([], [], studyHeader());
    expect((await runCensus.runCensus({ ...args, label: "study" })).code).toBe(2);
    expect(logs.join("\n")).toMatch(/a study run takes its seed from the prereg tag/);
    const tagged = await runCensus.runCensus(studyRun(args));
    expect(tagged.code).toBe(0);
    expect(tagged.manifest).toMatchObject({ seed: "0badc0de", seedFrom: "prereg-v1", codex: "codex-cli 0.159.2" });
  }, 120_000);

  it("runs a study census once deviations are appended below the tagged registration", async () => {
    const { args, out } = await census([], [], studyHeader());
    const appended = taggedText + "\n### 2026-10-10: a deviation\n\nAppended, as section 1 says.\n";
    expect((await runCensus.runCensus(studyRun(args, { workingPrereg: appended }))).code).toBe(0);
    expect(runCensus.readRows(out)).toHaveLength(4);
  }, 120_000);

  it("stamps every row with its draw, sample, build, Codex version and platform, and keeps a rows file to one sample", async () => {
    const { args, out, logs, dir } = await census();
    expect((await runCensus.runCensus(args)).code).toBe(0);
    const sampleSha = createHash("sha256").update(readFileSync(args.sample)).digest("hex");
    for (const r of runCensus.readRows(out))
      expect(r).toMatchObject({
        draw: 1,
        sampleSha256: sampleSha,
        sampleN: 4,
        dist: "injected runner (tests)",
        codexVersion: null,
        platform: process.platform,
      });
    // Another sample (here the redraw) into the same rows file: its ids would read as done, so it is refused.
    const redraw = path.join(dir, "redraw.tsv");
    writeFileSync(redraw, readFileSync(args.sample, "utf8").replace("label=test", "label=test draw=2"));
    const again = await runCensus.runCensus({ ...args, sample: redraw });
    expect(again.code).toBe(2);
    expect(logs.join("\n")).toMatch(/refusing: .*rows\.jsonl holds 4 row\(s\) of another sample/);
  }, 60_000);

  it("refuses a study run on another sample, stream, seed or n, without Codex, or with another Codex, build, Claude Code or registration", async () => {
    const refused = async (header: string, extra: Record<string, unknown> = {}) => {
      const { args, logs, out } = await census([], [], header);
      const r = await runCensus.runCensus(studyRun(args, extra));
      expect(runCensus.readRows(out), header).toEqual([]);
      return r.code === 2 ? logs.join("\n") : `exit ${r.code}`;
    };
    expect(await refused(studyHeader().replace("label=study", "label=pilot"))).toMatch(/not a study sample/);
    expect(await refused(studyHeader().replace("stream=S-main", "stream=S-imp"))).toMatch(
      /--frame-name S-main is not the sample's stream S-imp/,
    );
    expect(await refused(studyHeader().replace("seed=0badc0de", "seed=0badc0df"))).toMatch(
      /draw 1 is drawn with seed 0badc0de/,
    );
    expect(await refused(studyHeader().replace("draw=1", "draw=3"))).toMatch(/draw 3/);
    expect(await refused(studyHeader(), { codexBin: undefined })).toMatch(/--codex-bin/);
    expect(await refused(studyHeader(), { codexVersionOf: async () => "codex-cli 0.160.0" })).toMatch(
      /codex --version reports 0\.160\.0, not the registered 0\.159\.2/,
    );
    // The fake renderer, asked for real: it is not the registered Codex.
    expect(await refused(studyHeader(), { codexVersionOf: undefined })).toMatch(/0\.0\.0-fake, not the registered/);
    // The sample's n: given, and the number of units it holds.
    expect(await refused(studyHeader().replace(" n=4", ""))).toMatch(/the sample's header gives no n/);
    expect(await refused(studyHeader().replace("n=4", "n=5"))).toMatch(/header says n=5, but it holds 4 units/);
    // The frozen build, as the tag stamps it.
    expect(await refused(studyHeader(), { expectDist: undefined })).toMatch(
      /a study run names the frozen build with --expect-dist \(prereg-v1 stamps injected runner \(tests\)\)/,
    );
    expect(await refused(studyHeader(), { expectDist: "another" })).toMatch(
      /--expect-dist another is not the build prereg-v1 stamps/,
    );
    // The registered Claude Code version.
    expect(await refused(studyHeader(), { claudeVersion: "2.1.280" })).toMatch(
      /--claude-version 2\.1\.280 is not the registered 2\.1\.285/,
    );
    // The registration: the working PREREG.md changed above the Deviations heading, or no tagged copy to read.
    const edited = taggedText.replace("1,100 repositories from S", "1,000 repositories from S");
    expect(await refused(studyHeader(), { workingPrereg: edited })).toMatch(
      /differs from prereg-v1: nothing above the Deviations heading changes/,
    );
    const noText = (tag: string) => ({ tag, commit: "0".repeat(40), seed: "0badc0de" });
    expect(await refused(studyHeader(), { seedResolver: noText })).toMatch(/no study\/PREREG\.md to read/);
  }, 60_000);

  it("runs the redraw as draw 2 with the tag's seed + 1, and records the Codex version on every row", async () => {
    const header = studyHeader().replace("draw=1 seed=0badc0de seedOffset=0", "draw=2 seed=0badc0df seedOffset=1");
    const { args, out } = await census([], [], header);
    expect((await runCensus.runCensus(studyRun(args))).code).toBe(0);
    const rows = runCensus.readRows(out);
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r).toMatchObject({ frame: "S-main", draw: 2, codexVersion: "codex-cli 0.159.2" });
  }, 120_000);

  it("reads the registered Codex version from what `codex --version` prints", () => {
    expect(k4.codexVersionProblem("codex-cli 0.159.2", "0.159.2")).toBeUndefined();
    expect(k4.codexVersionProblem("codex-cli 0.159.2\n", "0.159.2")).toBeUndefined();
    expect(k4.codexVersionProblem("codex-cli 0.159.20", "0.159.2")).toMatch(/0\.159\.20, not the registered 0\.159\.2/);
    expect(k4.codexVersionProblem("codex-cli 0.0.0-fake", "0.159.2")).toMatch(/0\.0\.0-fake/);
    expect(k4.codexVersionProblem("unknown (exit 1)", "0.159.2")).toMatch(/not a version/);
    expect(k4.codexVersionProblem(null, "0.159.2")).toMatch(/not a version/);
  });

  it("flags a frame for the redraw when over 10% of its n is lost, and leaves faulty rows out", () => {
    const base = { frame: "S-main", sampleN: 2, status: "measured", faults: [], outcomes: {} };
    const rows = [
      { ...base, repo: "a/a", status: "excluded", exclusion: "fork" },
      { ...base, repo: "b/b", faults: ["x"] },
    ];
    const res = analyze.analyze({ rowSets: [{ file: "f", sha256: "x", rows }] });
    expect(res.frames["S-main"]).toMatchObject({
      drawn: 2,
      rowsGiven: 2,
      complete: true,
      measured: 0,
      excluded: 1,
      withFaults: 1,
      redrawRequired: true,
    });
  });

  it("K3 passes when the census proportion is inside the sample's interval, and fails when it is not", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ outcomes: { k3: { eligible: true, event: i < 30 } } }));
    expect(consistency.k3Check(rows, { counts: { claude: 11415, claudeImport: 3405 }, frameRepos: 26266 }).pass).toBe(
      true,
    );
    expect(consistency.k3Check(rows, { counts: { claude: 2000, claudeImport: 1900 }, frameRepos: 26266 }).pass).toBe(
      false,
    );
    expect(consistency.k3Check(rows, { counts: {}, frameRepos: 0 }).pass).toBe(false);
  });

  it("summarises K4 and lists every mismatch", () => {
    const rows = [
      {
        repo: "a/a",
        commit: "c",
        k4: {
          pairs: [
            { dir: ".", verdict: "EXACT" },
            { dir: "x", verdict: "OFF", offBy: 3, firstDiff: 10, faults: [] },
          ],
        },
      },
    ];
    expect(analyze.k4Summary(rows)).toMatchObject({ k: 1, n: 2, mismatches: [{ repo: "a/a", dir: "x", offBy: 3 }] });
    expect(analyze.k4Summary([{ repo: "b" }])).toBeNull();
  });

  it("draws K5's strata from measured rows", () => {
    const row = (repo: string, o1: boolean, o2: boolean, files: string[] = ["AGENTS.md"]) => ({
      repo,
      commit: "c",
      status: "measured",
      faults: [],
      files: files.map((p) => ({ path: p })),
      outcomes: { o1file: { eligible: true, event: o1 }, o2: { event: o2, eventDirs: ["pkg"] } },
    });
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row(`s/${i}`, true, false, ["AGENTS.md", "CLAUDE.md"])),
      ...Array.from({ length: 10 }, (_, i) => row(`i/${i}`, false, true, ["AGENTS.md", "CLAUDE.md"])),
      ...Array.from({ length: 10 }, (_, i) => row(`n/${i}`, false, false)),
    ];
    const picked = k5.selectK5(rows, "00000001");
    expect(picked.filter((p: { stratum: string }) => p.stratum === "shadowed")).toHaveLength(12);
    expect(
      picked.filter(
        (p: { stratum: string; launchDir: string }) => p.stratum === "importer-subdir" && p.launchDir === "pkg",
      ),
    ).toHaveLength(8);
    expect(picked.filter((p: { stratum: string }) => p.stratum === "no-claude-md")).toHaveLength(5);
    expect(k5.selectK5(rows, "00000001")).toEqual(picked);
    expect(picked.map((p: { id: string }) => p.id)).toEqual(
      Array.from({ length: 25 }, (_, i) => `K5-${String(i + 1).padStart(2, "0")}`),
    );
    // A repository in two samples (S-imp and a redrawn S-main) is drawn once, whichever row qualifies.
    const twice = [
      ...rows.map((r) => ({ ...r, frame: "S-main" })),
      ...rows.map((r) => ({ ...r, frame: "S-imp", commit: "d" })),
    ];
    const once = k5.selectK5(twice, "00000001");
    expect(once).toHaveLength(25);
    expect(new Set(once.map((p: { repo: string }) => p.repo)).size).toBe(25);
    expect(new Set(once.map((p: { commit: string }) => p.commit))).toEqual(new Set(["d"]));
  });

  it("fingerprints a build directory", () => {
    const dir = tmp("dist");
    writeFileSync(path.join(dir, "cli.js"), "a");
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "x.js"), "b");
    const d = digest.distDigest(dir);
    expect(d.files.map((f: { path: string }) => f.path)).toEqual(["cli.js", "sub/x.js"]);
    writeFileSync(path.join(dir, "cli.js"), "A");
    expect(digest.distDigest(dir).digest).not.toBe(d.digest);
  });
});

describe("analysis never pools two draws, builds or versions (study/PREREG.md sections 1 and 4)", () => {
  type Row = Record<string, unknown>;
  /** A row as run-census stamps it: an event on O1-content when `event`, excluded when `excluded`. */
  function row(frame: string, draw: number, i: number, o: { event?: boolean; excluded?: boolean; repo?: string } = {}) {
    const stamp = {
      id: `${frame}-${String(i).padStart(4, "0")}`,
      frame,
      draw,
      index: i,
      repo: o.repo ?? `${frame}-d${draw}-owner${i}/repo`,
      owner: `${frame}-d${draw}-owner${i}`,
      sampleSha256: `${frame}-draw${draw}-sample`,
      sampleN: 10,
      dist: "frozen",
      codexVersion: "codex-cli 0.159.2",
      platform: "win32",
    };
    if (o.excluded) return { ...stamp, status: "excluded", exclusion: "fork" };
    return {
      ...stamp,
      status: "measured",
      faults: [],
      claudeVersion: "2.1.285",
      mapVersion: "1.0.0",
      blobs: { rootAgents: `blob-${frame}-${draw}-${i}` },
      launch: { t2: [], t2Total: 0, t3: [], t3Total: 0 },
      pairs: [{ dir: ".", type: 1, codex: { chain: [{ path: "AGENTS.md", bytes: 100, kept: 100 }] } }],
      k4: { pairs: [{ dir: ".", verdict: "EXACT" }] },
      outcomes: {
        o1content: { eligible: true, a: 4, r: o.event ? 1 : 4, share: o.event ? 0.25 : 1, event: !!o.event },
        o1contentShingle: { eligible: true, a: 4, r: 4, share: 1, event: false },
        o1file: { eligible: true, event: false },
        o2: { eligible: true, t2Dirs: 0, event: false, eventDirs: [], eventT123: false, t3EventDirs: [] },
        p1: { pairs: 1, eventDirs: [], repoEvent: false, pairsT3: 0, t3EventDirs: [], repoEventT123: false },
        o4: { eligible: true, nested: 0, notPreloaded: 0, event: false },
        o5: { rootWarn: [], rootWarnMap: [], anyWarn: [], linkAffected: false },
        o6: { eligible: true, event: false },
        o7: { links: 0, broken: 0, event: false, rootLinkToAgents: false },
        o8: { eligible: true, cjkShare: 0, event: false, bytes: 100, chars: 100, effectiveChars: 100 },
        k3: { eligible: true, rootClaude: false, event: false },
      },
    };
  }
  /** Draw 1 of S-main: 10 rows, 2 excluded (20% lost, so the redraw applies), 1 event among the 8 measured. */
  const draw1 = () => Array.from({ length: 10 }, (_, i) => row("S-main", 1, i, { excluded: i < 2, event: i === 2 }));
  /** Draw 2 of S-main: 10 rows, all measured, 6 events. */
  const draw2 = () => Array.from({ length: 10 }, (_, i) => row("S-main", 2, i, { event: i < 6 }));
  const run = (...sets: Row[][]) =>
    analyze.analyze({ rowSets: sets.map((rows, i) => ({ file: `rows-${i}.jsonl`, sha256: "x", rows })) });
  const get = (res: { outcomes: { id: string; frame: string; variant: string }[] }, frame: string, id: string) =>
    res.outcomes.find((o) => o.frame === frame && o.id === id && o.variant === "raw");

  it("lets the redraw replace the first draw for every figure and verdict, and reports the first under its own name", () => {
    const res = run(draw1(), draw2());
    expect(get(res, "S-main", "O1-content")).toMatchObject({ k: 6, n: 10 });
    expect(get(res, "S-main-draw1", "O1-content")).toMatchObject({ k: 1, n: 8 });
    expect(res.frames["S-main"]).toMatchObject({ frame: "S-main", draw: 2, replaces: "S-main-draw1", drawn: 10 });
    expect(res.frames["S-main"].redrawRequired).toBe(false);
    expect(res.frames["S-main-draw1"]).toMatchObject({
      frame: "S-main",
      draw: 1,
      supersededBy: "S-main",
      drawn: 10,
      excluded: 2,
      redrawRequired: true,
    });
    const h1 = res.hypotheses.find((h: { id: string }) => h.id === "H1");
    expect(h1.estimate).toMatchObject({ k: 6, n: 10 });
    // K4 reads the rows in use only: 10 pairs, not 18.
    expect(res.checks.K4).toMatchObject({ k: 10, n: 10 });
    // Given in the other order, the same result.
    expect(run(draw2(), draw1()).outcomes).toEqual(res.outcomes);
  });

  it("refuses what would pool two draws, two samples, builds, versions or platforms, or a unit twice", () => {
    const refuse = (sets: Row[][], why: RegExp) => expect(() => run(...sets), String(why)).toThrow(why);
    refuse([draw2()], /draw 2 \(the redraw\) without the draw 1 it replaces/);
    const fine = Array.from({ length: 10 }, (_, i) => row("S-main", 1, i, { excluded: i === 0 }));
    refuse([fine, draw2()], /draw 1 lost 10%, not over 10%: the redraw does not apply/);
    refuse([draw1(), draw1()], /S-main draw 1: unit S-main-0000 appears twice/);
    refuse([draw1(), draw2().map((r) => ({ ...r, draw: 3 }))], /draw 3/);
    const one = (key: string, value: unknown, measuredOnly = false) =>
      draw1().map((r, i) => (i === 5 && (!measuredOnly || r.status === "measured") ? { ...r, [key]: value } : r));
    refuse([one("sampleSha256", "another")], /S-main draw 1: rows of more than one sampleSha256/);
    refuse([one("dist", "fixed build")], /more than one dist/);
    refuse([one("codexVersion", "codex-cli 0.160.0")], /more than one codexVersion/);
    refuse([one("platform", "linux")], /more than one platform/);
    refuse([one("claudeVersion", "2.1.280", true)], /more than one claudeVersion/);
    refuse([one("mapVersion", "1.0.1", true)], /more than one mapVersion/);
    refuse(
      [draw1(), draw2(), Array.from({ length: 3 }, (_, i) => ({ ...row("S-main-draw1", 1, i), sampleN: 3 }))],
      /two frames named/,
    );
    refuse([one("sampleN", 11)], /more than one sampleN/);
    refuse([one("label", "pilot")], /more than one label/);
    // Excluded rows carry no agent versions; that is not a second version.
    expect(() => run(draw1())).not.toThrow();
  });

  it("takes the lost share over the n drawn, and refuses a study draw with rows for fewer units than its n", () => {
    const refuse = (sets: Row[][], why: RegExp) => expect(() => run(...sets), String(why)).toThrow(why);
    // A complete draw that lost 1 of its 10 units: 10%, so no redraw.
    const oneLost = () => Array.from({ length: 10 }, (_, i) => row("S-main", 1, i, { excluded: i === 0 }));
    expect(run(oneLost()).frames["S-main"]).toMatchObject({ drawn: 10, excludedShare: 0.1, redrawRequired: false });
    // The first 5 rows of it (an interrupted run) lose 1 of 5, 20%: refused, never a licence to redraw.
    refuse(
      [oneLost().slice(0, 5)],
      /S-main draw 1: 5 of the 10 units drawn have rows; an incomplete study draw is refused/,
    );
    refuse([oneLost().slice(0, 5), draw2()], /an incomplete study draw is refused/);
    refuse([draw1(), draw2().slice(0, 9)], /S-main draw 2: 9 of the 10 units drawn have rows/);
    refuse([draw1().map((r) => ({ ...r, sampleN: 9 }))], /10 rows for a sample of n = 9/);
    refuse([draw1().map(({ sampleN: _n, ...r }) => r)], /the rows carry no sample size \(sampleN/);
    // A pilot draw may be incomplete: reported as such, its share over its n, and never redrawn.
    const pilot = (rows: Row[]) => rows.map((r) => ({ ...r, label: "pilot" }));
    const res = analyze.analyze({
      rowSets: [{ file: "p", sha256: "x", rows: pilot(oneLost().slice(0, 5)) }],
      label: "pilot",
    });
    expect(res.frames["S-main"]).toMatchObject({
      drawn: 10,
      rowsGiven: 5,
      complete: false,
      excludedShare: 0.1,
      redrawRequired: false,
    });
    expect(() =>
      analyze.analyze({
        rowSets: [{ file: "p", sha256: "x", rows: [...pilot(draw1().slice(0, 5)), ...pilot(draw2())] }],
        label: "pilot",
      }),
    ).toThrow(/draw 2 given, but draw 1 has rows for 5 of its 10 units/);
  });

  it("leaves rows with a fault out of K4, as out of every figure", () => {
    const faulted = draw1().map((r, i) => (i === 5 ? { ...r, faults: ["map exited 1"] } : r));
    expect(run(faulted).checks.K4).toMatchObject({ k: 7, n: 7 });
    expect(run(draw1()).checks.K4).toMatchObject({ k: 8, n: 8 });
  });

  it("counts S-imp's overlap with a redrawn S-main instead of excluding it", () => {
    const imp = Array.from({ length: 5 }, (_, i) => ({
      ...row("S-imp", 1, i, i < 2 ? { repo: `S-main-d2-owner${i}/repo` } : {}),
      sampleN: 5,
    }));
    const res = run(draw1(), draw2(), imp);
    expect(res.frames["S-imp"].sharedRepos).toEqual({ "S-main": 2 });
    expect(res.frames["S-main"].sharedRepos).toEqual({ "S-imp": 2 });
    // The superseded draw is not compared: it decides nothing.
    expect(res.frames["S-main-draw1"].sharedRepos).toBeUndefined();
    expect(get(res, "S-imp", "O1-content")).toMatchObject({ n: 5 });
  });

  it("carries the Codex version into results.json, per frame and for K4, and says whether K4 met its expectation", () => {
    const res = run(draw1());
    expect(res.frames["S-main"]).toMatchObject({ codexVersions: ["codex-cli 0.159.2"], dists: ["frozen"] });
    expect(res.checks.K4).toMatchObject({
      k: 8,
      n: 8,
      expectedAtLeast: 0.98,
      expectationMet: true,
      codexVersions: ["codex-cli 0.159.2"],
    });
    const pairs = (exact: number, n: number) => [
      {
        repo: "a/a",
        codexVersion: "v",
        k4: { pairs: Array.from({ length: n }, (_, i) => ({ dir: `${i}`, verdict: i < exact ? "EXACT" : "OFF" })) },
      },
    ];
    expect(analyze.k4Summary(pairs(49, 50)).expectationMet).toBe(true);
    expect(analyze.k4Summary(pairs(48, 50)).expectationMet).toBe(false);
  });

  it("gives K5 and K6 the rows in use: a redrawn sample's first draw is left out", () => {
    const dir = tmp("in-use");
    const files = [draw1(), draw2()].map((rows, i) => {
      const f = path.join(dir, `rows-${i}.jsonl`);
      writeFileSync(f, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      return f;
    });
    for (const rows of [k6cli.readRowFiles(files), k5.readRowFiles(files)]) {
      expect(rows).toHaveLength(10);
      expect(new Set(rows.map((r: { draw: number }) => r.draw))).toEqual(new Set([2]));
    }
  });
});

describe("behavioural cells: layout, scoring and decisions", () => {
  const cells = cellsLib.loadCells(path.join(ROOT, "study", "behavioural", "cells.json"));
  const cell = (id: string) => cells.cells.find((c: { id: string }) => c.id === id);
  const arm = (c: { arms: { id: string }[] }, id: string) => c.arms.find((a) => a.id === id);
  const fixturesDir = path.join(ROOT, "study", "behavioural", "fixtures");
  const NL = String.fromCharCode(10);

  it("plants head and tail tokens, a control rule, a decoy and the arm's ancestor file", () => {
    const dir = tmp("cell");
    const b1 = cell("B1");
    const t = cellsLib.layoutTrial({ cells, cell: b1, arm: arm(b1, "trap"), trialDir: dir, fixturesDir, vars: {} });
    const agents = readFileSync(path.join(t.repo, "AGENTS.md"), "utf8");
    expect(agents.startsWith(`ctxreach cell token ${t.tokens["AGENTS.md"][0]}`)).toBe(true);
    expect(agents.trimEnd().endsWith(t.tokens["AGENTS.md"][1])).toBe(true);
    expect(readFileSync(path.join(dir, "anc", ".claude", "CLAUDE.md"), "utf8")).toContain(t.tokens["@ancestor"][0]);
    expect(readFileSync(path.join(t.launchDir, ".claude", "rules", "ctxreach-cell-control.md"), "utf8")).toContain(
      t.control,
    );
    expect(t.env).toMatchObject({ TEMP: path.join(dir, "anc", "tmp"), TMP: path.join(dir, "anc", "tmp") });
    expect(readdirSync(path.join(dir, "anc", "tmp"))).toEqual([]);
  });

  it("leaves B4's CLAUDE.md exactly as a symlink checked out as text would be", () => {
    const dir = tmp("cell");
    const b4 = cell("B4");
    const t = cellsLib.layoutTrial({ cells, cell: b4, arm: arm(b4, "trap"), trialDir: dir, fixturesDir, vars: {} });
    expect(readFileSync(path.join(t.repo, "CLAUDE.md"), "utf8")).toBe("AGENTS.md");
    expect(t.tokens["CLAUDE.md"]).toBeUndefined();
  });

  it("builds the instrument's command: --home for B2's arms, --task for B7", () => {
    const b2 = cell("B2");
    const dir = tmp("cell");
    const vars = { home: path.join(dir, "h"), outside: path.join(dir, "o"), model: "m", claudeBin: "c" };
    const t = cellsLib.layoutTrial({
      cells,
      cell: b2,
      arm: arm(b2, "A2"),
      trialDir: path.join(dir, "t"),
      fixturesDir,
      vars,
    });
    const args = cellsLib.instrumentArgs({ cells, cell: b2, arm: arm(b2, "A2"), trial: t, vars });
    expect(args.slice(0, 3)).toEqual(["verify", "--agent", "claude"]);
    expect(args.slice(-2)).toEqual(["--home", vars.home]);
    expect(t.tmp).toBe(path.join(vars.outside, "tmp"));
    expect(t.env).toMatchObject({ HOME: vars.home, USERPROFILE: vars.home });
    const b7 = cell("B7");
    const t7 = cellsLib.layoutTrial({
      cells,
      cell: b7,
      arm: arm(b7, "trap"),
      trialDir: path.join(dir, "t7"),
      fixturesDir,
      vars,
    });
    const a7 = cellsLib.instrumentArgs({ cells, cell: b7, arm: arm(b7, "trap"), trial: t7, vars });
    expect(a7).toEqual(expect.arrayContaining(["probe", "--mode", "task", "--task", b7.task]));
  });

  it("reads tokens from capture bodies and from echo transcripts", () => {
    const dir = tmp("obs");
    const body = JSON.stringify({ messages: [{ content: "Contents of AGENTS.md CTXR-0000aaaa" }] });
    writeFileSync(
      path.join(dir, "trial-1.capture.jsonl"),
      [
        JSON.stringify({ method: "HEAD", url: "/api/hello", body: "CTXR-0000bbbb" }),
        JSON.stringify({ method: "POST", url: "/v1/messages?beta=true", body }),
      ].join(NL) + NL,
    );
    const cap = cellsLib.readObservation("capture", dir);
    expect([...cap.tokens]).toEqual(["CTXR-0000aaaa"]);
    const echo = tmp("obs");
    const events = [
      { type: "system", subtype: "init", model: "m1", plugins: [{ source: "agents-md@builtin" }] },
      { type: "assistant", message: { content: [{ type: "text", text: "CTXR-0000cccc" + NL + "CTXR-0000dddd" }] } },
    ];
    writeFileSync(path.join(echo, "trial-1.jsonl"), events.map((e) => JSON.stringify(e)).join(NL) + NL);
    const e = cellsLib.readObservation("echo", echo);
    expect([...e.tokens].sort()).toEqual(["CTXR-0000cccc", "CTXR-0000dddd"]);
    expect(e.init).toMatchObject({ model: "m1", plugins: ["agents-md@builtin"] });
  });

  it("voids a trial without its control, with the decoy, without the plugin or on another model", () => {
    const b1 = cell("B1");
    const trial = {
      control: "CTXR-c0000000",
      decoy: "CTXR-d0000000",
      tokens: { "AGENTS.md": ["CTXR-a0000001", "CTXR-a0000002"], "@ancestor": ["CTXR-e0000000"] },
    };
    const init = { plugins: ["agents-md@builtin"], model: "pin" };
    const score = (tokens: string[], i = init) =>
      cellsLib.scoreTrial({ cell: b1, trial, obs: { tokens: new Set(tokens), init: i, files: 1 }, pin: "pin" });
    expect(score(["CTXR-c0000000", "CTXR-a0000001"])).toMatchObject({
      status: "usable",
      seen: { agents: true, ancestor: false },
      partial: { agents: true },
    });
    expect(score(["CTXR-a0000001"]).reasons).toEqual(["positive control not seen"]);
    expect(score(["CTXR-c0000000", "CTXR-d0000000"]).reasons).toEqual(["decoy seen"]);
    expect(score(["CTXR-c0000000"], { plugins: [], model: "pin" }).status).toBe("void");
    expect(score(["CTXR-c0000000"], { plugins: ["agents-md@builtin"], model: "other" }).reasons[0]).toMatch(
      /not the pinned pin/,
    );
    expect(score(["CTXR-c0000000", "CTXR-12345678"]).unknownTokens).toEqual(["CTXR-12345678"]);
  });

  it("decides B2 by its rule: confirmed, refuted, inconclusive, insufficient, or a failed precondition", () => {
    const b2 = cell("B2");
    const armsWith = (a1: number, a2 = 10, a0 = 10, usable = 10) => {
      const o = (k: number) => ({ observe: { agents: { k, n: usable } }, usable, planned: 10 });
      return {
        A0: o(a0),
        A1: o(a1),
        A2: o(a2),
        A3: { ...o(0), planned: 5, usable: 5 },
        A4: { ...o(0), planned: 5, usable: 5 },
      };
    };
    expect(cellsLib.decideCell(b2, armsWith(1))).toBe("confirmed");
    expect(cellsLib.decideCell(b2, armsWith(9))).toBe("refuted");
    expect(cellsLib.decideCell(b2, armsWith(5))).toBe("inconclusive");
    expect(cellsLib.decideCell(b2, armsWith(0, 8))).toBe("inconclusive");
    expect(cellsLib.decideCell(b2, armsWith(0, 10, 10, 7))).toBe("insufficient");
    expect(cellsLib.decideCell(b2, armsWith(0), { precondition: false })).toBe("precondition-failed");
    expect(cellsLib.decideCell(cell("B7"), { trap: { observe: {}, usable: 10, planned: 10 } })).toBe("reported");
  });

  it("each trap and its twin get different predictions from map", async () => {
    const runner = inProcessMapRunner();
    const predict = async (fixture: string, launch: string) => {
      const dir = tmp("bmap");
      const repo = path.join(dir, "repo");
      cpSync(path.join(fixturesDir, fixture, "repo"), repo, { recursive: true });
      mkdirSync(path.join(repo, ".git"));
      const homes = pipeline.freshHomes(dir);
      const r = await runner({
        launchDir: path.join(repo, launch),
        repoRoot: repo,
        ...homes,
        claudeVersion: "2.1.285",
      });
      return r.json;
    };
    const rootAgents = (j: { claude: { files: { path: string; delivery: string; needsApproval?: boolean }[] } }) =>
      j.claude.files.find((f) => f.path === "AGENTS.md");
    // Rule claude.imports: an external import with no approval recorded is left out headless.
    expect(rootAgents(await predict("b3-external-import", "packages/api"))).toMatchObject({
      delivery: "not-loaded",
      needsApproval: true,
    });
    expect(rootAgents(await predict("b3-external-import-twin", "packages/api"))).toMatchObject({ delivery: "launch" });
    expect(rootAgents(await predict("b4-link-as-text", "."))).toMatchObject({ delivery: "not-loaded" });
    expect(rootAgents(await predict("b4-link-as-text-twin", "."))).toMatchObject({ delivery: "import" });
    const codes = (j: { findings: { code: string }[] }) => j.findings.map((f) => f.code);
    expect(codes(await predict("b7-words-task", "."))).toContain("claude.words-not-import");
    expect(codes(await predict("b7-words-task-twin", "."))).not.toContain("claude.words-not-import");
  }, 60_000);
});

describe("behavioural harness dry run (fake instrument, no agent)", () => {
  // The registered trial counts divided by 5 (at least 1), so the suite stays quick; the thresholds are
  // fractions of usable trials, so every verdict is reachable. `node study/behavioural/run-cells.mjs --dry-run`
  // runs the full counts.
  const scaled = (() => {
    const doc = cellsLib.loadCells(path.join(ROOT, "study", "behavioural", "cells.json"));
    for (const c of doc.cells)
      for (const a of c.arms) if (a.trials > 0) a.trials = Math.max(1, Math.ceil(a.trials / 5));
    const file = path.join(tmp("cells"), "cells.json");
    writeFileSync(file, JSON.stringify(doc));
    return file;
  })();
  function dry(cellsWanted: string[], mode?: string) {
    const out = tmp("dry");
    const logs: string[] = [];
    if (mode) process.env.FAKE_INSTRUMENT_MODE = mode;
    try {
      return {
        ...runCells.runCells({ out, cells: cellsWanted, cellsFile: scaled, log: (l: string) => logs.push(l) }),
        out,
        logs,
      };
    } finally {
      delete process.env.FAKE_INSTRUMENT_MODE;
    }
  }
  const verdicts = (r: { results: { cell: string; verdict: string }[] }) =>
    Object.fromEntries(r.results.map((x) => [x.cell, x.verdict]));

  it("runs every cell end to end with zero real agent runs, and each confirms where the fake follows the hypothesis", () => {
    const r = dry(["B1", "B2", "B3", "B4", "B6", "B7"]);
    expect(r.realRuns).toBe(0);
    expect(r.billedRuns).toBe(0);
    expect(verdicts(r)).toEqual({
      B1: "confirmed",
      B2: "confirmed",
      B3: "confirmed",
      B4: "confirmed",
      B6: "confirmed",
      B7: "reported",
    });
    const saved = JSON.parse(readFileSync(path.join(r.out, "cells-results.json"), "utf8"));
    expect(saved).toMatchObject({ dryRun: true, realAgentRuns: 0 });
    const b2 = saved.results.find((x: { cell: string }) => x.cell === "B2");
    expect(b2.precondition).toBe(true);
    expect(readdirSync(path.join(r.out, "fake-home", ".claude"))).toEqual([]);
    expect(r.logs.join(String.fromCharCode(10))).toMatch(/real agent runs: 0 \(billed 0\)/);
  }, 300_000);

  it("refutes B2 when the home file does not switch AGENTS.md off (the planted disagreement)", () => {
    expect(verdicts(dry(["B2"], "no-home-shadow"))).toEqual({ B2: "refuted" });
  }, 120_000);

  it("voids every trial whose control never arrives, leaving the cell undecided", () => {
    const r = dry(["B4"], "drop-control");
    expect(verdicts(r)).toEqual({ B4: "insufficient" });
    expect(r.results[0].arms.trap).toMatchObject({ ran: 1, usable: 0, void: 1 });
  }, 120_000);

  it("resumes: a second run adds no trials", () => {
    const r = dry(["B4"]);
    const again = runCells.runCells({ out: r.out, cells: ["B4"], cellsFile: scaled, log: () => undefined });
    expect(again.results[0].arms.trap.ran).toBe(1);
  }, 120_000);

  it("refuses a live run without its pins, a B2 run without the scratch home, and the real home", () => {
    const log = () => undefined;
    expect(runCells.runCells({ out: tmp("live"), live: true, log }).code).toBe(2);
    const pins = { ctxreach: "x", claudeBin: "y", model: "z", log };
    expect(runCells.runCells({ out: tmp("live"), live: true, cells: ["B2"], home: tmp("nohome"), ...pins }).code).toBe(
      2,
    );
    expect(runCells.runCells({ out: tmp("live"), live: true, cells: ["B1"], home: os.homedir(), ...pins }).code).toBe(
      2,
    );
  });

  it("makes and removes the scratch home only where it may", () => {
    const base = tmp("b2home");
    const realHome = path.join(base, "me");
    mkdirSync(realHome);
    const home = path.join(base, "ctxr-home");
    const outside = path.join(base, "ctxr-out");
    setupHome.setup({ home, outside, realHome });
    expect(readdirSync(home).sort()).toEqual([".claude", ".ctxr-home-marker", "tmp"]);
    expect(() => setupHome.setup({ home: path.join(realHome, "x"), outside, realHome })).toThrow(/real home/);
    const foreign = path.join(base, "foreign");
    mkdirSync(foreign);
    writeFileSync(path.join(foreign, "keep.txt"), "x");
    expect(() => setupHome.setup({ home: foreign, outside, realHome })).toThrow(/not made by this script/);
    setupHome.remove({ home, outside, realHome });
    expect(() => readdirSync(home)).toThrow();
    expect(() => setupHome.remove({ home: foreign, outside, realHome })).toThrow(/no .ctxr-home-marker/);
  });
});

describe("K6: the blind second reader", () => {
  const fixtureDir = (n: string) =>
    path.join(ROOT, n.startsWith("census") ? "study/census/known-answer-fixtures" : "test/fixtures", n, "repo");
  const size = (n: string, rel: string) => readFileSync(path.join(fixtureDir(n), ...rel.split("/"))).length;
  type Answer = { claude: { receives: string[]; notModelled: string[] }; codex: { chain: unknown[] } };
  const chain = (n: string, ...files: [string, number?][]) =>
    files.map(([p, kept]) => ({ path: p, keptBytes: kept ?? size(n, p) }));
  // Worked out by hand from docs/rules.md, not from map: rule ids beside each.
  const hand: { name: string; dir: string; answer: Answer }[] = [
    {
      // claude.symlink: the link delivers AGENTS.md's text once; codex.one-per-dir.
      name: "census-o7-symlink",
      dir: ".",
      answer: {
        claude: { receives: ["AGENTS.md"], notModelled: [] },
        codex: { chain: chain("census-o7-symlink", ["AGENTS.md"]) },
      },
    },
    {
      // Its twin: a regular CLAUDE.md naming AGENTS.md switches it off (claude.agents-default, claude.words).
      name: "census-o7-symlink-twin",
      dir: ".",
      answer: {
        claude: { receives: ["CLAUDE.md"], notModelled: [] },
        codex: { chain: chain("census-o7-symlink-twin", ["AGENTS.md"]) },
      },
    },
    {
      name: "claude-words-not-import",
      dir: ".",
      answer: {
        claude: { receives: ["CLAUDE.md"], notModelled: [] },
        codex: { chain: chain("claude-words-not-import", ["AGENTS.md"]) },
      },
    },
    {
      // claude.imports: @AGENTS.md at the root is inside the launch directory.
      name: "claude-words-not-import-twin",
      dir: ".",
      answer: {
        claude: { receives: ["AGENTS.md", "CLAUDE.md"], notModelled: [] },
        codex: { chain: chain("claude-words-not-import-twin", ["AGENTS.md"]) },
      },
    },
    {
      // codex.budget: 40,960 bytes against 32,768; Claude has no CLAUDE.md, so AGENTS.md loads.
      name: "codex-over-cap",
      dir: ".",
      answer: {
        claude: { receives: ["AGENTS.md"], notModelled: [] },
        codex: { chain: chain("codex-over-cap", ["AGENTS.md", 32768]) },
      },
    },
    {
      // claude.ancestors + claude.imports: the root CLAUDE.md loads, but its @AGENTS.md is outside
      // packages/api (external, never approved headless); codex.walk: root file, then the package's.
      name: "census-o2-external-import",
      dir: "packages/api",
      answer: {
        claude: { receives: ["CLAUDE.md", "packages/api/AGENTS.md", "packages/api/CLAUDE.md"], notModelled: [] },
        codex: { chain: chain("census-o2-external-import", ["AGENTS.md"], ["packages/api/AGENTS.md"]) },
      },
    },
    {
      name: "census-o2-external-import",
      dir: ".",
      answer: {
        claude: { receives: ["AGENTS.md", "CLAUDE.md"], notModelled: [] },
        codex: { chain: chain("census-o2-external-import", ["AGENTS.md"]) },
      },
    },
  ];
  const names = [...new Set(hand.map((h) => h.name))];
  const repos = () => names.map((n) => local.localRepo(n, fixtureDir(n)));
  type Row = Record<string, unknown>;
  let rowsOnce: Promise<Row[]> | undefined;
  /** Census rows for the fixtures, through the real pipeline with only the network replaced. */
  function measuredRows(): Promise<Row[]> {
    rowsOnce ??= (async () => {
      const { client } = localClient(repos());
      const workDir = tmp("k6-census");
      const homes = pipeline.freshHomes(workDir);
      const rows: Row[] = [];
      for (const [i, n] of names.entries())
        rows.push(
          await pipeline.runUnit({
            client,
            unit: { id: `T-${i}`, repo: `fixture/${n}`, commit: local.fixtureCommit(n), frame: "S-main", index: i },
            workDir,
            mapRunner: inProcessMapRunner(),
            homes,
            claudeVersion: "2.1.285",
            seed: "00000000",
          }),
        );
      return rows;
    })();
    return rowsOnce;
  }
  const rowOf = (rows: Row[], n: string) => rows.find((r) => r.repo === `fixture/${n}`);
  const answerFile = (id: string, a: Answer, notes = "") => ({ schema: k6.ANSWER_SCHEMA, id, ...a, notes });

  it("a reader applying docs/rules.md by hand agrees with map on every trap and twin", async () => {
    const rows = await measuredRows();
    expect(rows.every((r) => r.status === "measured" && (r.faults as string[]).length === 0)).toBe(true);
    const agree = hand.filter((h, i) => {
      const key = { id: `K6-${i}`, ...k6.keyFor(rowOf(rows, h.name), h.dir) };
      expect(key.claude, `${h.name} @ ${h.dir}`).toEqual(h.answer.claude);
      expect(key.codex, `${h.name} @ ${h.dir}`).toEqual(h.answer.codex);
      return k6.scorePair(key, answerFile(key.id, h.answer)).agree;
    });
    expect(`${agree.length}/${hand.length}`).toBe("7/7");
  }, 60_000);

  it("catches the planted fault: a key that forgets the symlink rule disagrees on the trap, not on its twin", async () => {
    const rows = await measuredRows();
    const [trap, twin] = hand;
    const planted = (h: (typeof hand)[number]) => ({
      id: "K6-01",
      ...k6.keyFor(rowOf(rows, h.name), h.dir, { linkCorrection: false }),
    });
    const caught = k6.scorePair(planted(trap!), answerFile("K6-01", trap!.answer));
    expect(caught.agree).toBe(false);
    expect(caught.diffs.map((d: { field: string }) => d.field)).toEqual(["claude.receives"]);
    expect(k6.scorePair(planted(twin!), answerFile("K6-01", twin!.answer)).agree).toBe(true);
  }, 60_000);

  it("scores Claude as sets and Codex in order with bytes; unanswered, malformed and misfiled answers count against", () => {
    const key = {
      id: "K6-01",
      claude: { receives: ["AGENTS.md", "CLAUDE.md"], notModelled: [] },
      codex: {
        chain: [
          { path: "AGENTS.md", keptBytes: 10 },
          { path: "a/AGENTS.md", keptBytes: 5 },
        ],
      },
    };
    const ans = (over: Record<string, unknown>) => ({
      schema: k6.ANSWER_SCHEMA,
      id: "K6-01",
      claude: { receives: ["CLAUDE.md", "AGENTS.md", "AGENTS.md"], notModelled: [] },
      codex: { chain: key.codex.chain },
      ...over,
    });
    const fields = (a: unknown) =>
      k6.scorePair(key, a).diffs.map((d: { field: string; reason: string }) => `${d.field}:${d.reason}`);
    expect(k6.scorePair(key, ans({})).agree).toBe(true);
    expect(fields(ans({ codex: { chain: [...key.codex.chain].reverse() } }))).toEqual(["codex.chain:differs"]);
    const offByOne = [
      { path: "AGENTS.md", keptBytes: 10 },
      { path: "a/AGENTS.md", keptBytes: 6 },
    ];
    expect(fields(ans({ codex: { chain: offByOne } }))).toEqual(["codex.chain:differs"]);
    expect(fields(ans({ claude: { receives: null, notModelled: [] } }))).toEqual(["claude.receives:unanswered"]);
    expect(fields(ans({ codex: { chain: [{ path: "AGENTS.md", keptBytes: "10" }] } }))).toEqual([
      "codex.chain:malformed",
    ]);
    expect(fields(ans({ id: "K6-02" }))).toEqual(["answer:missing, wrong schema or wrong id"]);
    expect(fields(undefined)).toHaveLength(1);
    const all = k6.scoreAll({ pairs: [key, { ...key, id: "K6-02" }] }, { "K6-01": ans({}) });
    expect([all.agree, all.claudeAgree, all.codexAgree, all.n]).toEqual([1, 1, 1, 2]);
    expect(all.printed.pairs).toBe("1/2 (50.0%, [9.5%, 90.5%])");
    expect(k6.adjudicationSheet(all)).toMatch(/\| K6-02 \| answer \| missing, wrong schema or wrong id \|/);
  });

  it("draws in two stages, reproducibly, from type-1 and type-2 directories of rows without faults", () => {
    const pairs = (dirs: [string, number][]) => dirs.map(([dir, type]) => ({ dir, type, codex: {}, claude: {} }));
    const many: [string, number][] = Array.from({ length: 171 }, (_, i) => [`p/${i}`, 2]);
    const rows = [
      { repo: "big/one", commit: "c", status: "measured", faults: [], pairs: pairs([[".", 1], ...many]) },
      ...Array.from({ length: 40 }, (_, i) => ({
        repo: `r/${String(i).padStart(2, "0")}`,
        commit: "c",
        status: "measured",
        faults: [],
        pairs: pairs([
          [".", 1],
          ["pkg", 2],
          ["web", 3],
        ]),
      })),
      { repo: "faulty/x", commit: "c", status: "measured", faults: ["x"], pairs: pairs([[".", 1]]) },
      { repo: "gone/x", commit: "c", status: "excluded" },
    ];
    const a = k6.drawPairs(rows, "0badcafe");
    expect(a).toHaveLength(30);
    expect(new Set(a.map((p: { repo: string }) => p.repo)).size).toBe(30);
    expect(a.map((p: { id: string }) => p.id).slice(0, 3)).toEqual(["K6-01", "K6-02", "K6-03"]);
    expect(a.every((p: { type: number; repo: string }) => p.type !== 3 && !/^(faulty|gone)\//.test(p.repo))).toBe(true);
    expect(k6.drawPairs([...rows].reverse(), "0badcafe")).toEqual(a);
    expect(k6.drawPairs(rows, "0badcaff")).not.toEqual(a);
    expect(k6.drawPairs(rows, "0badcafe", 100)).toHaveLength(41);
    expect(() => k6.drawPairs(rows, "xyz")).toThrow();
  });

  it("writes blind sheets that hold every file's text, and the leak check catches a planted leak", async () => {
    const text =
      "# Rules\n\nSee https://claude.ai/code and codex.rs; claude.imports is only a word here.\n~~~~\nnot a fence\n~~~~\n";
    const repo = fixtureRepo(
      "sheet",
      { "AGENTS.md": text, "docs/x.md": "extra\n" },
      { symlinks: { "CLAUDE.md": "AGENTS.md" } },
    );
    const { client } = localClient([repo]);
    const dir = path.join(tmp("k6s"), "repo");
    const r = await recon.reconstruct({ client, repo: repo.name, commit: repo.commit, dir, seed: "00000000" });
    const sheet = k6.renderSheet({ id: "K6-01", dir: "." }, r);
    expect(sheet).toContain(text.slice(0, -1));
    expect(sheet).toMatch(/## `CLAUDE\.md`\n\nsymlink to `AGENTS\.md`/);
    expect(sheet).toContain("~~~~~text\n");
    const key = {
      id: "K6-01",
      claude: { receives: ["AGENTS.md"], notModelled: [] },
      codex: { chain: [{ path: "AGENTS.md", keptBytes: 99 }] },
    };
    // Clean twin: rule-like words inside the repository's own text are not a leak.
    expect(k6.checkBlind(sheet, key)).toEqual([]);
    // Planted leaks: map's vocabulary in the frame, and the key itself.
    expect(k6.checkBlind(sheet.replace("## Your answer", "## Your answer (claude.agents-default)"), key)).toHaveLength(
      1,
    );
    expect(k6.checkBlind(sheet + JSON.stringify(key), key).length).toBeGreaterThanOrEqual(1);
    expect(k6.checkBlind(sheet + JSON.stringify(key.codex.chain), key)).toContain("sheet holds the Codex answer");
    // A leaked chain inside a file's own text is still caught by value.
    const inside = sheet.replace("See https://", `${JSON.stringify(key.codex.chain)} https://`);
    expect(k6.checkBlind(inside, key)).toEqual(["sheet holds the Codex answer"]);
  });

  it("writes the reader's folder with a sealed key over the GET-only client, then scores x/n and lists disagreements", async () => {
    const rows = await measuredRows();
    const pairs = hand.map((h, i) => ({
      id: `K6-0${i + 1}`,
      repo: `fixture/${h.name}`,
      commit: local.fixtureCommit(h.name),
      frame: "S-main",
      dir: h.dir,
      type: h.dir === "." ? 1 : 2,
    }));
    const out = tmp("k6");
    const { client, seen } = localClient(repos());
    const m = await k6cli.makeSheets({ client, rows, pairs, out });
    expect(m.nonGetAttempts).toBe(0);
    expect(seen.every((s) => s.method === "GET")).toBe(true);
    expect(readdirSync(path.join(out, "reader")).sort()).toEqual(["READER-BRIEF.md", "answers", "rules.md", "sheets"]);
    expect(readdirSync(out).sort()).toEqual(["key.json", "manifest.json", "reader"]);
    expect(Object.keys(m.sheets)).toHaveLength(7);
    for (const f of readdirSync(path.join(out, "reader", "sheets")))
      expect(k6.checkBlind(readFileSync(path.join(out, "reader", "sheets", f), "utf8"))).toEqual([]);
    // Blank answers score 0/7.
    expect(k6cli.score(out).agree).toBe(0);
    // The hand answers score 7/7; one wrong answer is listed for adjudication.
    const answers = path.join(out, "reader", "answers");
    for (const [i, h] of hand.entries())
      writeFileSync(path.join(answers, `K6-0${i + 1}.json`), JSON.stringify(answerFile(`K6-0${i + 1}`, h.answer)));
    expect(k6cli.score(out).printed.pairs).toMatch(/^7\/7 /);
    const wrong = { ...hand[5]!.answer, claude: { receives: ["AGENTS.md", "CLAUDE.md"], notModelled: [] } };
    writeFileSync(path.join(answers, "K6-06.json"), JSON.stringify(answerFile("K6-06", wrong)));
    const r = k6cli.score(out);
    expect([r.agree, r.claudeAgree, r.codexAgree]).toEqual([6, 6, 7]);
    const adjudication = readFileSync(path.join(out, "adjudication.md"), "utf8");
    expect(adjudication).toMatch(/\| K6-06 \| claude\.receives \| differs \|/);
    expect(adjudication).not.toMatch(/fixture\//);
    // The key is sealed: an edit after the sheets were written is refused.
    const keyFile = path.join(out, "key.json");
    writeFileSync(keyFile, readFileSync(keyFile, "utf8").replace("32768", "32767"));
    expect(() => k6cli.score(out)).toThrow(/changed after the sheets were written/);
    // Sheets are written once, and a rebuild that differs from the census row stops the step.
    await expect(k6cli.makeSheets({ client, rows, pairs, out })).rejects.toThrow(/written once/);
    const moved = rows.map((row) =>
      row.repo === "fixture/codex-over-cap"
        ? { ...row, files: (row.files as { sha: string }[]).map((f) => ({ ...f, sha: "0".repeat(40) })) }
        : row,
    );
    await expect(k6cli.makeSheets({ client, rows: moved, pairs, out: tmp("k6-moved") })).rejects.toThrow(
      /differ from the census row/,
    );
    // A sheet writer that leaks map's vocabulary is stopped before the reader sees anything.
    const leaky = (p: unknown, rc: unknown) => k6.renderSheet(p, rc) + "\n(codex.cut applies here)\n";
    await expect(k6cli.makeSheets({ client, rows, pairs, out: tmp("k6-leak"), render: leaky })).rejects.toThrow(
      /the sheet is not blind/,
    );
  }, 60_000);
});

describe("K5: scoring the live runs (k5-score.mjs)", () => {
  const selection = [
    { id: "K5-01", stratum: "shadowed", repo: "a/a", commit: "c", launchDir: "." },
    { id: "K5-02", stratum: "importer-subdir", repo: "b/b", commit: "c", launchDir: "pkg" },
    { id: "K5-03", stratum: "no-claude-md", repo: "c/c", commit: "c", launchDir: "." },
  ];
  const cell = (file: string, verdict: string, decoy = false) => ({
    file,
    position: "head",
    token: "t",
    decoy,
    predicted: { delivery: "launch", why: "", rule: "claude.agents-default" },
    expected: "launch",
    seen: 2,
    usable: 2,
    fraction: "2/2",
    verdict,
  });
  type Cell = ReturnType<typeof cell>;
  /** A `ctxreach verify --json` output, its agreement counted from its cells as verify counts them. */
  const verifyRun = (cells: Cell[], over: Record<string, unknown> = {}) => {
    const real = cells.filter((c) => !c.decoy);
    return {
      schema: "ctxreach.verify/v1",
      agent: "claude",
      instrument: "capture",
      cliVersion: "2.1.285",
      trials: [{}, {}],
      cells,
      instrument_checks: { fault: false, reasons: [] },
      agreement: {
        agree: real.filter((c) => ["confirmed", "discovered"].includes(c.verdict)).length,
        decided: real.filter((c) => ["confirmed", "discovered", "missed", "extra"].includes(c.verdict)).length,
        cells: real.length,
      },
      ...over,
    };
  };
  const score = (runs: Record<string, unknown>) => k5score.scoreK5(selection, runs, { claudeVersion: "2.1.285" });

  it("sums agreement over decided cells, per stratum too, lists disagreements by id, and leaves void runs out of n", () => {
    const r = score({
      "K5-01": verifyRun([
        cell("AGENTS.md", "confirmed"),
        cell("CLAUDE.md", "confirmed"),
        cell("decoy", "extra", true),
      ]),
      "K5-02": verifyRun([cell("AGENTS.md", "missed"), cell("pkg/AGENTS.md", "confirmed"), cell("x", "untested")]),
      "K5-03": verifyRun([cell("AGENTS.md", "confirmed")], {
        agreement: null,
        instrument_checks: { fault: true, reasons: ["control token missing"] },
      }),
    });
    expect(r).toMatchObject({ schema: "ctxreach.k5-results/v1", repositories: 3, runsScored: 2, trials: 2 });
    expect(r.agreement).toMatchObject({ k: 3, n: 4, printed: "3/4 (75.0%, [30.1%, 95.4%])" });
    expect(r.byStratum).toMatchObject({
      shadowed: { k: 2, n: 2 },
      "importer-subdir": { k: 1, n: 2 },
      "no-claude-md": { k: 0, n: 0 },
    });
    expect(r.voided).toEqual([{ id: "K5-03", stratum: "no-claude-md", reasons: ["control token missing"] }]);
    expect(r.disagreements).toEqual([
      expect.objectContaining({ id: "K5-02", launchDir: "pkg", file: "AGENTS.md", verdict: "missed" }),
    ]);
    expect(JSON.stringify(r)).not.toMatch(/"b\/b"/);
  });

  it("refuses a missing run, one not drawn, another agent, instrument, version or number of trials", () => {
    const ok = { "K5-01": verifyRun([]), "K5-02": verifyRun([]), "K5-03": verifyRun([]) };
    expect(score(ok).agreement).toMatchObject({ k: 0, n: 0 });
    const refuse = (runs: Record<string, unknown>, why: RegExp) => expect(() => score(runs), String(why)).toThrow(why);
    const { "K5-03": _gone, ...two } = ok;
    refuse(two, /K5-03: no ctxreach verify output \(every drawn repository is run; none is skipped\)/);
    refuse({ ...ok, "K5-04": verifyRun([]) }, /ids that were not drawn: K5-04/);
    refuse(
      { ...ok, "K5-01": verifyRun([], { cliVersion: "2.1.280" }) },
      /Claude Code 2\.1\.280, not the registered 2\.1\.285/,
    );
    refuse({ ...ok, "K5-01": verifyRun([], { agent: "codex", instrument: "render" }) }, /not Claude Code by capture/);
    refuse({ ...ok, "K5-01": verifyRun([], { trials: [{}] }) }, /K5-01: 1 trials, not 2/);
    refuse({ ...ok, "K5-01": { schema: "unparseable" } }, /K5-01: not a ctxreach verify --json output/);
    refuse(
      { ...ok, "K5-01": verifyRun([cell("AGENTS.md", "missed")], { agreement: { agree: 1, decided: 1 } }) },
      /its cells give 0\/1, its agreement 1\/1/,
    );
  });

  it("scores k5-select.mjs's TSV and the saved runs from the command line, and refuses a missing run", () => {
    const dir = tmp("k5");
    const tsv = selection.map((p) => [p.id, p.stratum, p.repo, p.commit, p.launchDir].join("\t")).join("\n") + "\n";
    writeFileSync(path.join(dir, "k5.tsv"), tsv);
    expect(k5score.readSelection(tsv)).toEqual(selection);
    const runs = path.join(dir, "verify");
    mkdirSync(runs);
    for (const p of selection.slice(0, 2))
      writeFileSync(path.join(runs, `${p.id}.json`), JSON.stringify(verifyRun([cell("AGENTS.md", "confirmed")])));
    const cli = () =>
      spawnSync(
        process.execPath,
        [
          path.join(ROOT, "study", "census", "k5-score.mjs"),
          ...["--selection", path.join(dir, "k5.tsv"), "--verify", runs, "--out", path.join(dir, "k5-results.json")],
        ],
        { encoding: "utf8" },
      );
    const missing = cli();
    expect(missing.status).toBe(2);
    expect(missing.stderr).toMatch(/refusing: K5-03: no ctxreach verify output/);
    expect(existsSync(path.join(dir, "k5-results.json"))).toBe(false);
    writeFileSync(path.join(runs, "K5-03.json"), JSON.stringify(verifyRun([cell("AGENTS.md", "confirmed")])));
    const done = cli();
    expect(done.status).toBe(0);
    const saved = JSON.parse(readFileSync(path.join(dir, "k5-results.json"), "utf8"));
    expect(saved.agreement).toMatchObject({ k: 3, n: 3 });
    expect(saved.selectionSha256).toBe(createHash("sha256").update(tsv).digest("hex"));
  });
});
