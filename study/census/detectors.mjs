// Outcome detectors (study/PREREG.md, "Outcomes"). Each is a pure function of
// one measured repository: its reconstruction record, the `map --json`
// summary for every launch directory, and read access to the reconstructed
// files. Each can be switched off by a K2 plant, in which case it returns its
// no-event value.

import { charsInBytes, cjkShare, lineContainment, shingleContainment } from "./lib/normalise.mjs";
import { dirOf } from "./lib/paths.mjs";
import { planted } from "./lib/plants.mjs";

/** Deliveries that mean "in the model's context when the session starts" (imports are expanded at launch). */
const RECEIVED = new Set(["launch", "import"]);
/** Codex finding codes that mean a file on the chain is cut or dropped (P1). */
export const P1_CODES = ["codex.cut", "codex.no-budget", "codex.empty-override"];
/** O1-content's event: Claude receives under this share of the root AGENTS.md's lines. */
export const O1_EVENT_SHARE = 0.5;
export const CJK_EVENT = 0.1;
export const CODEX_BUDGET = 32768;
const ROOT_CLAUDE_FAMILY = new Set(["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]);

export const isOutside = (p) => p.startsWith("/") || /^[A-Za-z]:\//.test(p);

function rootAgents(recon) {
  return recon.files.find((f) => f.path === "AGENTS.md" && f.role === "instruction");
}

/** Resolved targets of the reconstruction's working symlinks: link path -> target path. */
function links(recon) {
  const out = new Map();
  for (const f of recon.files) if (f.link && !f.link.broken && f.link.resolved) out.set(f.path, f.link.resolved);
  return out;
}

/** In the model's context when a headless session starts: loaded or imported at launch, needing no approval, inside the repository. */
export const received = (f) => RECEIVED.has(f.delivery) && !f.needsApproval && !isOutside(f.path);

/**
 * Does the file `rel` reach Claude Code, headless, at this launch directory?
 * A symlink and its target are one file (rule claude.symlink): the
 * reconstruction writes links as copies, so the link is applied here.
 */
export function claudeReceives(ctx, pair, rel) {
  const entries = pair.claude.files.filter((f) => f.path === rel);
  if (entries.some(received)) return { yes: true, via: "map" };
  if (!planted(ctx.plants, "measure:link-correction")) {
    const lk = links(ctx.recon);
    const loaded = pair.claude.files.filter(received).map((f) => f.path);
    if (loaded.some((p) => lk.get(p) === rel)) return { yes: true, via: "symlink" };
    if (lk.has(rel) && loaded.includes(lk.get(rel))) return { yes: true, via: "symlink" };
  }
  let cause = "absent";
  if (entries.some((f) => f.needsApproval)) cause = "external-import";
  else if (entries.some((f) => f.rule === "claude.imports")) cause = "external-import";
  else if (entries.some((f) => f.rule === "claude.agents-default")) cause = "shadowed";
  else if (entries.length) cause = entries[0].rule;
  return { yes: false, cause };
}

/**
 * A pair's warning codes with the symlink rule applied: map ran on copies,
 * so it can warn that an AGENTS.md is shadowed by a CLAUDE.md that is really
 * a link to it (or the other way round), or that such a CLAUDE.md names
 * AGENTS.md in words. On a checkout that keeps the link, neither warning
 * applies (rule claude.symlink).
 */
export function warnCodes(ctx, pair) {
  const lk = links(ctx.recon);
  if (!pair.findings || lk.size === 0 || planted(ctx.plants, "measure:link-correction")) return pair.warn;
  const keep = pair.findings.filter((f) => {
    if (f.severity !== "warn") return false;
    if (f.code === "claude.agents-shadowed" && f.path && claudeReceives(ctx, pair, f.path).via === "symlink")
      return false;
    if (f.code === "claude.words-not-import" && f.path && lk.has(f.path)) return false;
    return true;
  });
  return [...new Set(keep.map((f) => f.code))].sort();
}

function rootPair(ctx) {
  return ctx.pairs.find((p) => p.dir === "." && !p.error);
}

function loadedTexts(ctx, pair) {
  const seen = new Set();
  const texts = [];
  for (const f of pair.claude.files) {
    if (!received(f) || seen.has(f.path)) continue;
    seen.add(f.path);
    texts.push(ctx.read(f.path));
  }
  return texts;
}

function contentDetector(id, measureFn) {
  return (ctx) => {
    const agents = rootAgents(ctx.recon);
    if (!agents || !agents.written) return { eligible: false, why: "no root AGENTS.md" };
    const root = rootPair(ctx);
    if (!root) return { eligible: false, why: "root launch not measured" };
    const res = measureFn(ctx.read("AGENTS.md"), loadedTexts(ctx, root));
    if (res.a === 0) return { eligible: false, why: "no line of 20 or more characters", a: 0 };
    if (planted(ctx.plants, id)) return { eligible: true, a: res.a, r: res.a, share: 1, event: false };
    return { eligible: true, a: res.a, r: res.r, share: res.share, event: res.share < O1_EVENT_SHARE };
  };
}

export const DETECTORS = {
  /** O1-content: at root launch Claude receives under half of the root AGENTS.md's lines. */
  o1content: contentDetector("detector:o1content", lineContainment),

  /** O1-content, sensitivity: lines matched by 8-word shingles at a 0.8 threshold. */
  o1contentShingle: contentDetector("detector:o1content-shingle", shingleContainment),

  /** O1-file: the root AGENTS.md is not in Claude's launch set. */
  o1file(ctx) {
    const agents = rootAgents(ctx.recon);
    if (!agents || !agents.written) return { eligible: false, why: "no root AGENTS.md" };
    const root = rootPair(ctx);
    if (!root) return { eligible: false, why: "root launch not measured" };
    if (planted(ctx.plants, "detector:o1file")) return { eligible: true, event: false };
    const r = claudeReceives(ctx, root, "AGENTS.md");
    return r.yes
      ? { eligible: true, event: false, via: r.via }
      : { eligible: true, event: true, cause: r.cause, shadowers: root.claude.shadowers };
  },

  /** O2: from at least one type-2 directory, a headless session gets none of the root AGENTS.md. */
  o2(ctx) {
    const agents = rootAgents(ctx.recon);
    if (!agents || !agents.written) return { eligible: false, why: "no root AGENTS.md" };
    const t2 = ctx.pairs.filter((p) => p.type === 2 && !p.error);
    const t3 = ctx.pairs.filter((p) => p.type === 3 && !p.error);
    if (planted(ctx.plants, "detector:o2"))
      return { eligible: true, t2Dirs: t2.length, event: false, eventDirs: [], eventT123: false, t3EventDirs: [] };
    const miss = (pairs) =>
      pairs
        .map((p) => ({ dir: p.dir, r: claudeReceives(ctx, p, "AGENTS.md") }))
        .filter((x) => !x.r.yes)
        .map((x) => ({ dir: x.dir, cause: x.r.cause }));
    const e2 = miss(t2);
    const e3 = miss(t3);
    return {
      eligible: true,
      t2Dirs: t2.length,
      event: e2.length > 0,
      eventDirs: e2.map((x) => x.dir),
      causes: [...new Set(e2.map((x) => x.cause))].sort(),
      eventT123: e2.length + e3.length > 0,
      t3EventDirs: e3.map((x) => x.dir),
    };
  },

  /** P1: Codex cuts or drops a file on the chain, per (repo, launch dir) pair and per repo. */
  p1(ctx) {
    const measured = ctx.pairs.filter((p) => !p.error);
    const main = measured.filter((p) => p.type !== 3);
    const t3 = measured.filter((p) => p.type === 3);
    const hit = (p) => p.codex.codes.some((c) => P1_CODES.includes(c));
    if (planted(ctx.plants, "detector:p1"))
      return { pairs: main.length, eventDirs: [], repoEvent: false, pairsT3: t3.length, t3EventDirs: [] };
    const e = main.filter(hit).map((p) => p.dir);
    const e3 = t3.filter(hit).map((p) => p.dir);
    return {
      pairs: main.length,
      eventDirs: e,
      repoEvent: e.length > 0,
      pairsT3: t3.length,
      t3EventDirs: e3,
      repoEventT123: e.length + e3.length > 0,
    };
  },

  /** O4: a nested AGENTS.md that neither agent preloads at root launch. */
  o4(ctx) {
    const root = rootPair(ctx);
    if (!root) return { eligible: false, why: "root launch not measured" };
    const nested = ctx.recon.files
      .filter(
        (f) =>
          f.role === "instruction" && /(^|\/)AGENTS\.md$/.test(f.path) && !/(^|\/)\.claude\/AGENTS\.md$/.test(f.path),
      )
      .filter((f) => dirOf(f.path) !== ".")
      .map((f) => f.path);
    if (planted(ctx.plants, "detector:o4")) return { eligible: true, nested: nested.length, event: false };
    const codexHas = (p) => root.codex.chain.some((c) => c.path === p && c.kept > 0);
    const claudeHas = (p) => claudeReceives(ctx, root, p).yes;
    const missed = nested.filter((p) => !codexHas(p) && !claudeHas(p));
    return { eligible: true, nested: nested.length, notPreloaded: missed.length, event: missed.length > 0 };
  },

  /**
   * O5: map warnings by code, at the root and at any type-1 or type-2
   * launch directory, after the symlink rule (rootWarn, anyWarn), and as map
   * printed them for the reconstruction's copies (rootWarnMap).
   */
  o5(ctx) {
    const root = rootPair(ctx);
    const linkAffected = links(ctx.recon).size > 0;
    if (planted(ctx.plants, "detector:o5")) return { rootWarn: [], rootWarnMap: [], anyWarn: [], linkAffected };
    const any = new Set();
    for (const p of ctx.pairs) if (!p.error && p.type !== 3) for (const c of warnCodes(ctx, p)) any.add(c);
    return {
      rootWarn: root ? warnCodes(ctx, root) : [],
      rootWarnMap: root ? root.warn : [],
      anyWarn: [...any].sort(),
      linkAffected,
    };
  },

  /**
   * O6: at root launch, map raises claude.words-not-import, after the symlink
   * rule (study/PREREG.md, O6). A CLAUDE.md-family file whose whole text is a
   * path raises claude.link-as-text instead, and is counted under O5.
   */
  o6(ctx) {
    const root = rootPair(ctx);
    if (!root) return { eligible: false, why: "root launch not measured" };
    if (planted(ctx.plants, "detector:o6")) return { eligible: true, event: false };
    return { eligible: true, event: warnCodes(ctx, root).includes("claude.words-not-import") };
  },

  /**
   * O7: instruction files that are symlinks (tree mode 120000), broken ones,
   * and a root CLAUDE.md-family link to AGENTS.md (which a Windows checkout
   * without core.symlinks writes as a text file; the census writes links as
   * copies, so claude.link-as-text never fires for these).
   */
  o7(ctx) {
    const ls = ctx.recon.files.filter((f) => f.mode === "120000" && f.role === "instruction");
    if (planted(ctx.plants, "detector:o7")) return { links: 0, broken: 0, event: false, rootLinkToAgents: false };
    const rootLinkToAgents = ls.some((f) => ROOT_CLAUDE_FAMILY.has(f.path) && f.link?.resolved === "AGENTS.md");
    return {
      links: ls.length,
      broken: ls.filter((f) => f.link?.broken).length,
      event: ls.length > 0,
      rootLinkToAgents,
    };
  },

  /** O8: CJK share of the root AGENTS.md and the characters Codex's default budget holds. */
  o8(ctx) {
    const agents = rootAgents(ctx.recon);
    if (!agents || !agents.written) return { eligible: false, why: "no root AGENTS.md" };
    const bytes = ctx.readBytes("AGENTS.md");
    if (bytes.length === 0) return { eligible: false, why: "empty root AGENTS.md" };
    const text = bytes.toString("utf8");
    const share = cjkShare(text);
    const effectiveChars = charsInBytes(bytes, CODEX_BUDGET);
    if (planted(ctx.plants, "detector:o8")) return { eligible: true, cjkShare: 0, event: false, effectiveChars };
    return {
      eligible: true,
      cjkShare: Math.round(share * 10000) / 10000,
      event: share >= CJK_EVENT,
      bytes: bytes.length,
      chars: [...text].length,
      effectiveChars,
    };
  },

  /**
   * K3's per-repo input: the regex version of O1-file (a root CLAUDE.md
   * without the text "@AGENTS.md"). Every measured repository is eligible,
   * as every repository in the frame is in the census proportion.
   */
  k3(ctx) {
    const claude = ctx.recon.files.find((f) => f.path === "CLAUDE.md" && f.role === "instruction");
    if (planted(ctx.plants, "detector:k3")) return { eligible: true, rootClaude: false, event: false };
    if (!claude) return { eligible: true, rootClaude: false, event: false };
    // What Sourcegraph indexes for a symlink is the link text.
    const text = claude.link ? claude.link.target : ctx.read("CLAUDE.md");
    const imports = text.includes("@AGENTS.md");
    return { eligible: true, rootClaude: true, importsText: imports, event: !imports };
  },
};

export function computeOutcomes(ctx) {
  const out = {};
  for (const [id, fn] of Object.entries(DETECTORS)) out[id] = fn(ctx);
  return out;
}
