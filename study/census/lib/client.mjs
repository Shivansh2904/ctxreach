// The study's only network client (check K7). It sends GET requests and
// nothing else: any other method is refused before a byte leaves the
// machine, and each refusal is counted, so every script can print
// "non-GET attempts: 0" at the end and mean it.
//
// It also does what the GitHub REST docs ask of a polite client: one request
// at a time, a User-Agent naming the project, conditional requests
// (If-None-Match), and waiting as long as `retry-after` or the rate-limit
// reset says. Only three hosts are allowed.
//
// Credentials: none pass through this code. Requests to api.github.com go
// through the GitHub CLI, `gh api -X GET --include <endpoint>`, which
// authenticates itself from its own login; ctxreach never reads, copies or
// stores a token, and the client refuses one. raw.githubusercontent.com and
// sourcegraph.com are read with fetch, without credentials.

import { execFile } from "node:child_process";

export const USER_AGENT = "ctxreach-study/1 (+https://github.com/Shivansh2904/ctxreach; read-only GET)";
export const ALLOWED_HOSTS = ["api.github.com", "raw.githubusercontent.com", "sourcegraph.com"];

export class NonGetRefused extends Error {
  constructor(method, url) {
    super(`refused a ${method} request to ${url}: this client sends GET only`);
    this.name = "NonGetRefused";
  }
}

export class HostRefused extends Error {
  constructor(url) {
    super(`refused a request to ${url}: host not in ${ALLOWED_HOSTS.join(", ")}`);
    this.name = "HostRefused";
  }
}

/**
 * gh cannot be used at all (not installed, not logged in, or it refused its
 * arguments). Not retried: the run stops instead of excluding every unit.
 */
export class GhUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "GhUnavailable";
    this.fatal = true;
  }
}

/** Environment added for gh: no prompt, no pager, no colour, no update check. Nothing about credentials. */
export const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "", NO_COLOR: "1" };

/**
 * The arguments for one GET through `gh api`: always `-X GET --include` for
 * github.com, one `-H` per header, then the endpoint. Never a field, an
 * input body or another method.
 */
export function ghArgs(url, headers = {}) {
  const u = new URL(url);
  if (u.hostname !== "api.github.com") throw new HostRefused(`${url} (only api.github.com goes through gh)`);
  const endpoint = u.pathname.replace(/^\/+/, "") + u.search;
  if (!/^[A-Za-z0-9][A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(endpoint))
    throw new Error(`refusing endpoint "${endpoint}": gh could read it as something other than a path`);
  const args = ["api", "-X", "GET", "--include", "--hostname", "github.com"];
  for (const [name, value] of Object.entries(headers)) {
    if (/[\r\n]/.test(`${name}${value}`) || !/^[A-Za-z0-9-]+$/.test(name))
      throw new Error(`refusing header ${JSON.stringify(name)}: it could split into another header`);
    args.push("-H", `${name}: ${value}`);
  }
  args.push(endpoint);
  return args;
}

/**
 * `gh api --include` output: the status line (ending in a newline), header
 * lines (CRLF), a blank line, then the body as sent. Returns undefined when
 * the output is not a response (gh failed before one arrived).
 */
export function parseGhInclude(stdout) {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
  let at = buf.indexOf(0x0a);
  if (at < 0) return undefined;
  const m = /^HTTP\/[0-9.]+ (\d{3})(?: (.*))?$/.exec(buf.subarray(0, at).toString("latin1").replace(/\r$/, ""));
  if (!m) return undefined;
  const headers = [];
  let pos = at + 1;
  for (;;) {
    at = buf.indexOf(0x0a, pos);
    if (at < 0) return undefined;
    const line = buf.subarray(pos, at).toString("latin1").replace(/\r$/, "");
    pos = at + 1;
    if (line === "") break;
    const colon = line.indexOf(":");
    if (colon > 0) headers.push([line.slice(0, colon), line.slice(colon + 1).trim()]);
  }
  return { status: Number(m[1]), statusText: m[2] ?? "", headers, body: buf.subarray(pos) };
}

/**
 * A transport for api.github.com that runs `gh api` (see ghArgs) and turns
 * its output into a Response. An HTTP error still comes back as a Response
 * (gh prints it and exits 1). No output means gh did not get an answer: a
 * network error, which the client retries. gh missing, not logged in (exit
 * 4) or refusing its arguments (exit 2) throws GhUnavailable.
 * @param {{ bin?: string, prefixArgs?: string[], timeoutMs?: number, env?: Record<string, string> }} [options]
 */
export function ghTransport({ bin = "gh", prefixArgs = [], timeoutMs = 120_000, env = {} } = {}) {
  const transport = (url, init = {}) =>
    new Promise((resolve, reject) => {
      if (String(init.method ?? "GET").toUpperCase() !== "GET") {
        reject(new NonGetRefused(String(init.method).toUpperCase(), url));
        return;
      }
      let args;
      try {
        args = [...prefixArgs, ...ghArgs(url, init.headers ?? {})];
      } catch (err) {
        reject(err);
        return;
      }
      execFile(
        bin,
        args,
        {
          encoding: "buffer",
          maxBuffer: 512 * 1024 * 1024,
          timeout: timeoutMs,
          windowsHide: true,
          env: { ...process.env, ...GH_ENV, ...env },
        },
        (err, stdout, stderr) => {
          const said = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim().split("\n")[0] : "";
          if (err && err.code === "ENOENT") {
            reject(new GhUnavailable(`gh was not found (${bin}): install the GitHub CLI and run gh auth login`));
            return;
          }
          const parsed = parseGhInclude(stdout);
          if (parsed) {
            const empty = parsed.status === 204 || parsed.status === 304;
            try {
              resolve(
                new Response(empty ? null : parsed.body, {
                  status: parsed.status,
                  statusText: parsed.statusText,
                  headers: parsed.headers,
                }),
              );
            } catch (e) {
              reject(new Error(`gh api answered something that is not a response: ${e.message}`));
            }
            return;
          }
          if (err && (err.code === 4 || err.code === 2))
            reject(new GhUnavailable(`gh api exited ${err.code}: ${said || "no message"}`));
          else reject(new Error(`gh api got no response${err?.killed ? " (timed out)" : ""}: ${said || "no message"}`));
        },
      );
    });
  transport.viaGh = true;
  return transport;
}

/** A request that kept failing (network errors or 5xx), or a rate-limit wait longer than allowed. */
export class RequestFailed extends Error {
  constructor(url, reason, attempts) {
    super(`GET ${url} failed after ${attempts} attempt(s): ${reason}`);
    this.name = "RequestFailed";
    this.reason = reason;
    this.attempts = attempts;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GetOnlyClient {
  /**
   * @param {object} [options]
   * @param {typeof fetch} [options.fetchImpl] transport for raw.githubusercontent.com and sourcegraph.com (tests pass a fake)
   * @param {typeof fetch} [options.ghApi] transport for api.github.com: `gh api` by default (tests pass a fake;
   *   a client given a fetchImpl and no ghApi refuses api.github.com rather than run the real gh)
   * @param {object} [options.gh] options for the default gh transport (ghTransport)
   * @param {number} [options.minIntervalMs] minimum time between two requests
   * @param {number} [options.maxAttempts] attempts before a request counts as failed (network error or 5xx)
   * @param {number} [options.maxWaitMs] longest single rate-limit wait accepted
   * @param {number} [options.reserve] pause for the reset when api.github.com has this many requests left
   * @param {(ms: number) => Promise<void>} [options.sleep]
   * @param {() => number} [options.now]
   * @param {(line: string) => void} [options.log]
   */
  constructor(options = {}) {
    if ("token" in options)
      throw new Error(
        "GetOnlyClient takes no token: api.github.com is reached through gh api, which uses its own login; ctxreach never reads, copies or stores one",
      );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.ghApi =
      options.ghApi ??
      (options.fetchImpl
        ? async (url) => {
            throw new GhUnavailable(
              `no gh transport was given for ${url} (a client with a test fetchImpl needs a ghApi too)`,
            );
          }
        : ghTransport(options.gh));
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.maxWaitMs = options.maxWaitMs ?? 65 * 60 * 1000;
    this.reserve = options.reserve ?? 5;
    this.sleep = options.sleep ?? realSleep;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.nonGetAttempts = 0;
    this.refusedHosts = 0;
    this.requests = 0;
    this.byHost = {};
    this.byStatus = {};
    this.retries = 0;
    this.waitedMs = 0;
    this.notModified = 0;
    this.rate = undefined;
    this.last = 0;
    this.queue = Promise.resolve();
  }

  /** Any method but GET is refused and counted; nothing is sent. */
  async request(method, url, options = {}) {
    if (String(method).toUpperCase() !== "GET") {
      this.nonGetAttempts++;
      throw new NonGetRefused(String(method).toUpperCase(), url);
    }
    return this.get(url, options);
  }

  /**
   * GET `url`. Resolves to `{ status, headers, body }` (body is a Buffer, or
   * the Response itself when `stream` is set). 404, 409, 422 and 451 are
   * returned, not thrown: the caller decides what they mean.
   * @param {string} url
   * @param {{ accept?: string, etag?: string, stream?: boolean }} [options]
   */
  get(url, options = {}) {
    const run = this.queue.then(() => this.#get(url, options));
    // Serial: the next request starts only after this one has finished.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #get(url, options) {
    const host = new URL(url).hostname;
    if (!ALLOWED_HOSTS.includes(host)) {
      this.refusedHosts++;
      throw new HostRefused(url);
    }
    const headers = { "User-Agent": USER_AGENT, Accept: options.accept ?? "*/*" };
    const viaGh = host === "api.github.com";
    if (viaGh) {
      headers["X-GitHub-Api-Version"] = "2022-11-28";
      if (options.stream) throw new Error(`${url}: streaming is not available through gh api`);
    }
    if (options.etag) headers["If-None-Match"] = options.etag;
    const transport = viaGh ? this.ghApi : this.fetchImpl;

    let failures = 0;
    let lastReason = "";
    for (;;) {
      await this.#pace(host);
      let res;
      try {
        this.requests++;
        this.byHost[host] = (this.byHost[host] ?? 0) + 1;
        res = await transport(url, { method: "GET", headers, redirect: "follow" });
      } catch (err) {
        if (err?.fatal) throw err;
        failures++;
        lastReason = `network error: ${err?.message ?? err}`;
        if (failures >= this.maxAttempts) throw new RequestFailed(url, lastReason, failures);
        this.retries++;
        await this.#wait(2000 * 2 ** (failures - 1), lastReason);
        continue;
      }
      this.byStatus[res.status] = (this.byStatus[res.status] ?? 0) + 1;
      if (host === "api.github.com") this.#noteRate(res.headers);
      // GitHub refused gh's login: every later request would fail the same way, so stop instead of excluding units.
      if (viaGh && res.status === 401) {
        await discard(res);
        throw new GhUnavailable(`GitHub refused gh's login (HTTP 401) for ${url}: run gh auth status`);
      }

      const retryAfter = Number(res.headers.get("retry-after"));
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (res.status === 429 || (res.status === 403 && (retryAfter > 0 || remaining === "0"))) {
        await discard(res);
        let waitMs;
        if (retryAfter > 0) waitMs = retryAfter * 1000;
        else waitMs = Math.max(0, Number(res.headers.get("x-ratelimit-reset")) * 1000 - this.now()) + 1000;
        if (waitMs > this.maxWaitMs)
          throw new RequestFailed(url, `rate limited; asked to wait ${Math.round(waitMs / 1000)} s`, failures + 1);
        this.retries++;
        await this.#wait(waitMs, `rate limited (${res.status})`);
        continue;
      }
      if (res.status >= 500) {
        await discard(res);
        failures++;
        lastReason = `HTTP ${res.status}`;
        if (failures >= this.maxAttempts) throw new RequestFailed(url, lastReason, failures);
        this.retries++;
        await this.#wait(2000 * 2 ** (failures - 1), lastReason);
        continue;
      }
      if (res.status === 304) {
        this.notModified++;
        await discard(res);
        return { status: 304, headers: res.headers, body: Buffer.alloc(0) };
      }
      if (options.stream && res.ok) return { status: res.status, headers: res.headers, body: res };
      const body = Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers: res.headers, body };
    }
  }

  /** GET and parse JSON; non-2xx statuses come back with `json: undefined`. */
  async getJson(url, options = {}) {
    const res = await this.get(url, { accept: "application/vnd.github+json", ...options });
    const json = res.status >= 200 && res.status < 300 ? JSON.parse(res.body.toString("utf8")) : undefined;
    return { ...res, json };
  }

  #noteRate(headers) {
    const limit = headers.get("x-ratelimit-limit");
    if (limit === null) return;
    this.rate = {
      limit: Number(limit),
      remaining: Number(headers.get("x-ratelimit-remaining")),
      reset: Number(headers.get("x-ratelimit-reset")),
      resource: headers.get("x-ratelimit-resource") ?? "core",
    };
  }

  async #pace(host) {
    const gap = this.last + this.minIntervalMs - this.now();
    if (gap > 0) await this.#wait(gap, null);
    // Stop before the core limit runs out instead of hitting it.
    if (host === "api.github.com" && this.rate && this.rate.remaining <= this.reserve) {
      const waitMs = Math.max(0, this.rate.reset * 1000 - this.now()) + 1000;
      if (waitMs > this.maxWaitMs)
        throw new RequestFailed(host, `rate limit reserve reached; reset in ${Math.round(waitMs / 1000)} s`, 0);
      await this.#wait(waitMs, `rate limit reserve (${this.rate.remaining} left)`);
      this.rate = undefined;
    }
    this.last = this.now();
  }

  async #wait(ms, why) {
    if (why) this.log(`waiting ${Math.round(ms / 1000)} s: ${why}`);
    this.waitedMs += ms;
    await this.sleep(ms);
  }

  /** One line for the end of every script. */
  summary() {
    const hosts = Object.entries(this.byHost)
      .map(
        ([h, n]) =>
          `${h} ${n}${h === "api.github.com" ? (this.ghApi.viaGh ? " via gh api" : " (a stand-in for gh api)") : ""}`,
      )
      .join(", ");
    return (
      `requests: ${this.requests}${hosts ? ` (${hosts})` : ""}; 304: ${this.notModified}; retries: ${this.retries}; ` +
      `waited: ${Math.round(this.waitedMs / 1000)} s; refused hosts: ${this.refusedHosts}; non-GET attempts: ${this.nonGetAttempts}`
    );
  }
}

async function discard(res) {
  try {
    await res.arrayBuffer();
  } catch {
    // The body is not needed.
  }
}

/**
 * Route every `fetch` in this process through `client`, so a stray call
 * elsewhere in a script (or a planted POST) is refused and counted too.
 * Build the client first: it keeps the original `fetch` as its transport.
 * Returns a function that restores the original.
 */
export function installFetchGuard(client) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    const method = init.method ?? (typeof input === "object" && input !== null ? input.method : undefined) ?? "GET";
    const res = await client.request(method, url, init.headers?.Accept ? { accept: init.headers.Accept } : {});
    const empty = res.status === 204 || res.status === 304;
    return new Response(empty ? null : res.body, { status: res.status, headers: res.headers });
  };
  return () => {
    globalThis.fetch = original;
  };
}
