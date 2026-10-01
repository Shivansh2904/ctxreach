/**
 * A loopback HTTP server that stands in for an agent's model endpoint.
 *
 * It records every request it receives (method, URL, headers, body) and
 * answers 400, so the agent sends its first request, which carries the
 * instruction files, and then stops. No model runs and nothing is billed.
 *
 * It binds to the loopback interface only, and refuses any other host: the
 * body it receives is the agent's whole prompt. The `Authorization`,
 * `X-Api-Key` and similar header values are never kept, in memory or on
 * disk; they are replaced by `<redacted>` before the record exists. A
 * `save` function decides what else is kept of each request: `verify`
 * passes one that redacts paths and reduces the body to what ctxreach
 * scores, so the agent's own prompt text is never written.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { SafetyError } from "../probe/types.js";

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);
export const REDACTED = "<redacted>";

/** Header names whose values are never recorded, and a pattern for names that look like credentials. */
export const REDACT_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
  "set-cookie",
]);
const CREDENTIAL_NAME = /auth|api-?key|token|cookie|secret|password/i;

export interface CaptureRecord {
  /** ISO time the request finished arriving. */
  t: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface CaptureServer {
  /** `http://127.0.0.1:<port>`: what to put in the agent's base-URL setting. */
  url: string;
  host: string;
  port: number;
  /** Every request so far, in arrival order, as kept (credential headers redacted, then `save`). */
  records: CaptureRecord[];
  /** The JSONL file the records are appended to, if one was asked for. */
  file?: string;
  close(): Promise<void>;
}

export interface CaptureOptions {
  /** Must be a loopback host (default `127.0.0.1`). */
  host?: string;
  /** Default 0: a free port. */
  port?: number;
  /** Append each record as one JSON line here; the file is created empty first. */
  file?: string;
  /** HTTP status to answer with (default 400). */
  status?: number;
  /**
   * What is kept of each request, in memory and on disk, given the record with its credential headers
   * already redacted (default: that record).
   */
  save?: (record: CaptureRecord) => CaptureRecord;
}

/** Throws `SafetyError` unless `host` names the loopback interface. */
export function assertLoopback(host: string): void {
  if (!LOOPBACK_HOSTS.has(host))
    throw new SafetyError(
      `refusing to bind the capture endpoint to ${host}: it listens on the loopback interface only`,
    );
}

/** The headers as they will be recorded: credential values replaced, everything else kept. */
export function redactHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(", ") : value;
    out[name] = REDACT_HEADERS.has(name.toLowerCase()) || CREDENTIAL_NAME.test(name) ? REDACTED : text;
  }
  return out;
}

/** The body the server answers with: shaped like an API error, so the agent reports it and stops. */
export function captureAnswer(): string {
  return JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "ctxreach capture: request recorded, no model here" },
  });
}

export async function startCapture(options: CaptureOptions = {}): Promise<CaptureServer> {
  const host = options.host ?? "127.0.0.1";
  assertLoopback(host);
  const status = options.status ?? 400;
  const records: CaptureRecord[] = [];
  const file = options.file;
  const save = options.save ?? ((record: CaptureRecord) => record);
  if (file !== undefined) writeFileSync(file, "");

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const record = save({
        t: new Date().toISOString(),
        method: req.method ?? "",
        url: req.url ?? "",
        headers: redactHeaders(req.headers),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      records.push(record);
      if (file !== undefined) appendFileSync(file, JSON.stringify(record) + "\n");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(captureAnswer());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  // Whatever the name resolved to, the socket itself must be loopback.
  assertLoopback(address.address);
  const shown = address.address.includes(":") ? `[${address.address}]` : address.address;
  return {
    url: `http://${shown}:${address.port}`,
    host: address.address,
    port: address.port,
    records,
    ...(file !== undefined ? { file } : {}),
    close: () =>
      new Promise<void>((resolve) => {
        // Keep-alive connections would otherwise hold the server open.
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
