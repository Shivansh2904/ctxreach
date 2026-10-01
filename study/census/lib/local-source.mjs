// A stand-in for api.github.com and raw.githubusercontent.com that serves
// local directories as repositories. Check K1 runs every known-answer fixture
// through the real client, reconstruction and measurement with this as the
// transport, so only the network is replaced. Tests also use it to produce
// the failures the census must handle (forks, missing commits, truncated
// trees, 5xx, rate limits).
//
// A repository is registered as "fixture/<name>" with the directory that
// holds its files. An optional `tree.json` beside that directory can declare
// symlinks, which a fixture checked out on Windows could not hold:
//   { "symlinks": { "CLAUDE.md": "AGENTS.md" } }

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { gitBlobSha } from "./paths.mjs";

export function fixtureCommit(name) {
  return createHash("sha1").update(`ctxreach-fixture|${name}`).digest("hex");
}

function walk(root) {
  const out = [];
  const go = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) go(full, r);
      else if (e.isFile()) out.push({ rel: r, bytes: readFileSync(full) });
    }
  };
  go(root, "");
  return out;
}

/**
 * Build a repository from a directory.
 * @param {string} name
 * @param {string} repoDir the repository's files
 * @param {object} [extra] { symlinks, meta, treeStatus, truncated, extraEntries }
 */
export function localRepo(name, repoDir, extra = {}) {
  const sidecar = path.join(path.dirname(repoDir), "tree.json");
  const declared = existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : {};
  const symlinks = { ...(declared.symlinks ?? {}), ...(extra.symlinks ?? {}) };
  const files = new Map();
  for (const f of walk(repoDir)) if (!(f.rel in symlinks)) files.set(f.rel, f.bytes);
  const entries = [];
  for (const [rel, bytes] of files)
    entries.push({ path: rel, mode: "100644", type: "blob", sha: gitBlobSha(bytes), size: bytes.length });
  const links = new Map();
  for (const [rel, target] of Object.entries(symlinks)) {
    const bytes = Buffer.from(target, "utf8");
    const sha = gitBlobSha(bytes);
    links.set(sha, bytes);
    entries.push({ path: rel, mode: "120000", type: "blob", sha, size: bytes.length });
  }
  entries.push(...(extra.extraEntries ?? []));
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    name: `fixture/${name}`,
    commit: fixtureCommit(name),
    files,
    links,
    entries,
    meta: {
      full_name: `fixture/${name}`,
      fork: false,
      archived: false,
      mirror_url: null,
      is_template: false,
      stargazers_count: 0,
      default_branch: "main",
      ...(extra.meta ?? {}),
    },
    treeStatus: extra.treeStatus ?? 200,
    truncated: extra.truncated ?? false,
  };
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * A `fetch` that serves the given repositories. `faults` injects failures:
 * [{ match: substring of the URL, status, times, headers }] answers the
 * first `times` matching requests with `status` (0 means a network error).
 * `seen` receives every request as { method, url }.
 */
export function localFetch(repos, { faults = [], seen = [], rate } = {}) {
  const byName = new Map(repos.map((r) => [r.name, r]));
  const budget = faults.map((f) => ({ ...f, left: f.times ?? 1 }));
  return async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    seen.push({ method, url });
    for (const f of budget) {
      if (f.left > 0 && url.includes(f.match)) {
        f.left--;
        if (f.status === 0) throw new TypeError("fetch failed (planted)");
        return new Response("planted failure", { status: f.status, headers: f.headers ?? {} });
      }
    }
    const u = new URL(url);
    const rateHeaders = rate
      ? {
          "x-ratelimit-limit": String(rate.limit),
          "x-ratelimit-remaining": String(rate.remaining()),
          "x-ratelimit-reset": String(rate.reset),
        }
      : {};
    if (u.hostname === "api.github.com") {
      if (u.pathname === "/rate_limit")
        return json(200, { resources: { core: { limit: 5000, remaining: 5000, reset: 0, used: 0 } } }, rateHeaders);
      const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/git\/(trees|blobs)\/([0-9a-f]+))?$/.exec(u.pathname);
      const repo = m ? byName.get(`${m[1]}/${m[2]}`) : undefined;
      if (!m || !repo) return json(404, { message: "Not Found" }, rateHeaders);
      if (!m[3]) return json(200, repo.meta, rateHeaders);
      if (m[3] === "trees") {
        if (m[4] !== repo.commit) return json(422, { message: "No commit found for SHA" }, rateHeaders);
        if (repo.treeStatus !== 200) return json(repo.treeStatus, { message: "planted" }, rateHeaders);
        return json(200, { sha: repo.commit, tree: repo.entries, truncated: repo.truncated }, rateHeaders);
      }
      const bytes = repo.links.get(m[4]) ?? [...repo.files.values()].find((b) => gitBlobSha(b) === m[4]);
      if (!bytes) return json(404, { message: "Not Found" }, rateHeaders);
      return json(200, { sha: m[4], encoding: "base64", content: bytes.toString("base64") }, rateHeaders);
    }
    if (u.hostname === "raw.githubusercontent.com") {
      const parts = u.pathname.split("/").slice(1).map(decodeURIComponent);
      const repo = byName.get(`${parts[0]}/${parts[1]}`);
      if (!repo || parts[2] !== repo.commit) return new Response("404: Not Found", { status: 404 });
      const bytes = repo.files.get(parts.slice(3).join("/"));
      if (!bytes) return new Response("404: Not Found", { status: 404 });
      return new Response(bytes, { status: 200 });
    }
    return new Response("unknown host", { status: 404 });
  };
}

/** Directories under `root` that hold a `repo/` directory: the fixtures. */
export function fixtureDirs(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((n) => statSync(path.join(root, n)).isDirectory() && existsSync(path.join(root, n, "repo")))
    .sort();
}
