import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertLoopback, captureAnswer, REDACTED, redactHeaders, startCapture } from "../src/oracle/capture.js";
import { SafetyError } from "../src/probe/types.js";
import { tempDir } from "./helpers/fixture.js";

function request(url: string, method: string, headers: Record<string, string>, body: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      url,
      { method, headers: { ...headers, "content-length": String(Buffer.byteLength(body)) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("the capture endpoint", () => {
  it("binds the loopback interface only, on a free port, and answers 400 with an API-shaped error", async () => {
    const s = await startCapture();
    try {
      expect(s.host).toBe("127.0.0.1");
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const r = await request(`${s.url}/v1/messages?beta=true`, "POST", { "content-type": "application/json" }, "{}");
      expect(r.status).toBe(400);
      expect(r.body).toBe(captureAnswer());
      expect(JSON.parse(r.body)).toMatchObject({ type: "error", error: { type: "invalid_request_error" } });
    } finally {
      await s.close();
    }
  });

  it("records method, url, headers and the exact body, in memory and on disk, and never a credential value", async () => {
    const file = path.join(tempDir("capture"), "capture.jsonl");
    const s = await startCapture({ file });
    try {
      const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "CTXR-0badcafe" }] });
      await request(`${s.url}/api/hello`, "HEAD", {}, "");
      await request(
        `${s.url}/v1/messages?beta=true`,
        "POST",
        {
          "content-type": "application/json",
          "x-api-key": "sk-ant-SECRET-ONE",
          authorization: "Bearer SECRET-TWO",
          cookie: "session=SECRET-THREE",
          "x-custom-token": "SECRET-FOUR",
          "anthropic-version": "2023-06-01",
        },
        body,
      );
      expect(s.records.map((r) => [r.method, r.url])).toEqual([
        ["HEAD", "/api/hello"],
        ["POST", "/v1/messages?beta=true"],
      ]);
      const post = s.records[1];
      expect(post?.body).toBe(body);
      expect(post?.headers["x-api-key"]).toBe(REDACTED);
      expect(post?.headers.authorization).toBe(REDACTED);
      expect(post?.headers.cookie).toBe(REDACTED);
      expect(post?.headers["x-custom-token"]).toBe(REDACTED);
      expect(post?.headers["anthropic-version"]).toBe("2023-06-01");
      expect(post?.t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const everywhere = JSON.stringify(s.records) + readFileSync(file, "utf8");
      expect(everywhere).not.toContain("SECRET");
      // One JSON line per request, the same as in memory.
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines.map((l) => JSON.parse(l))).toEqual(s.records);
    } finally {
      await s.close();
    }
  });

  it("refuses any host but the loopback interface, and says so before binding", async () => {
    for (const host of ["0.0.0.0", "192.0.2.1", "example.invalid", ""]) {
      await expect(startCapture({ host }), host).rejects.toThrow(SafetyError);
    }
    expect(() => assertLoopback("0.0.0.0")).toThrow(/loopback interface only/);
    expect(() => assertLoopback("127.0.0.1")).not.toThrow();
  });

  it("redacts by header name, whatever its case, and keeps the rest", () => {
    const out = redactHeaders({
      Authorization: "x",
      "X-API-KEY": "y",
      "proxy-authorization": "z",
      "x-stainless-lang": "js",
      host: "127.0.0.1:1",
      "set-cookie": ["a=1", "b=2"],
    });
    expect(out).toEqual({
      Authorization: REDACTED,
      "X-API-KEY": REDACTED,
      "proxy-authorization": REDACTED,
      "x-stainless-lang": "js",
      host: "127.0.0.1:1",
      "set-cookie": REDACTED,
    });
  });

  it("can answer another status when asked, so a client's retry logic can be exercised", async () => {
    const s = await startCapture({ status: 500 });
    try {
      const r = await request(`${s.url}/v1/messages`, "POST", {}, "{}");
      expect(r.status).toBe(500);
    } finally {
      await s.close();
    }
  });
});
