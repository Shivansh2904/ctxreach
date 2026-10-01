// Local capture endpoint: records each request (auth headers redacted) to a JSONL file and answers 400.
import http from "node:http"; import { appendFileSync } from "node:fs";
const [port, out] = [Number(process.argv[2]), process.argv[3]];
http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const headers = { ...req.headers }; for (const k of ["authorization", "x-api-key", "cookie"]) if (headers[k]) headers[k] = "REDACTED";
    appendFileSync(out, JSON.stringify({ t: Date.now(), method: req.method, url: req.url, headers, body }) + "\n");
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "ctxreach capture: request recorded, no model here" } }));
  });
}).listen(port, "127.0.0.1", () => console.log("capture listening", port));
