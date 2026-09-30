import { realpathSync } from "node:fs";
import path from "node:path";
import { discoverSurfaces, type Surface } from "../../discover/surfaces.js";
import { dirsBetween, displayPath, isFileNamed, isInside, readBytes, samePath } from "../../util/fs.js";
import { decodeLossy, headings, isBlankRust, lineAndColumn, splitsCodepoint } from "../../util/text.js";
import type { Cut, Finding, Reach } from "../types.js";
import { resolveCodexSettings, type CodexSettings, type CodexSettingsOptions } from "./config.js";

export type CodexEntryStatus =
  /** Read in full. */
  | "loaded"
  /** Read, but cut short by the shared budget. */
  | "cut"
  /** Not read: the budget was used up by files earlier in the chain. */
  | "no-budget"
  /** Took the directory's slot but is empty after trimming, so it adds nothing. */
  | "empty";

export interface CodexChainEntry {
  /** Directory on the root-to-launch path. */
  dir: string;
  /** The one file Codex takes from this directory. */
  path: string;
  name: string;
  bytes: number;
  /** Bytes that reach Codex (0 unless loaded or cut). */
  keptBytes: number;
  status: CodexEntryStatus;
  /** Budget left when Codex reached this file. */
  budgetBefore: number;
  cut?: Cut;
  /** Other candidate files in the same directory that Codex does not read. */
  shadowed: string[];
}

export interface CodexGlobal {
  path: string;
  bytes: number;
  /** Candidates in Codex home that were skipped because they were empty. */
  skippedEmpty: string[];
}

export interface CodexResult {
  agent: "codex";
  launchDir: string;
  settings: CodexSettings;
  global?: CodexGlobal;
  /** Root-first chain of project files Codex preloads. */
  chain: CodexChainEntry[];
  budget: { limit: number; used: number; left: number };
  /** Files below the launch directory that Codex would take if launched there, but does not preload. */
  below: Surface[];
  findings: Finding[];
}

export interface CodexResolveOptions extends CodexSettingsOptions {
  /** Directory to scan for files below the launch directory. Defaults to the launch directory. */
  scanRoot?: string;
}

/**
 * Predict what Codex preloads when launched in `launchDir`, following the
 * rules recorded in docs/rules.md (section "Codex").
 */
export function resolveCodex(options: CodexResolveOptions): CodexResult {
  const launchDir = path.resolve(options.launchDir);
  const settings = resolveCodexSettings({ ...options, launchDir });
  const findings: Finding[] = [];
  const rel = (p: string) => displayPath(p, settings.projectRoot);

  const global = readGlobal(settings.codexHome);

  if (!settings.rootFound) {
    findings.push({
      code: "codex.no-root",
      severity: "info",
      agent: "codex",
      rule: "codex.root",
      message:
        settings.rootMarkers.length === 0
          ? "project_root_markers is empty, so Codex reads instruction files from the launch directory only."
          : `No ${settings.rootMarkers.join(" / ")} found at or above the launch directory, so Codex reads instruction files from the launch directory only.`,
    });
  }

  for (const ignored of settings.ignoredProjectConfig) {
    findings.push({
      code: "codex.project-config-ignored",
      severity: "warn",
      agent: "codex",
      rule: "codex.config",
      path: ignored.file,
      message: `${rel(ignored.file)} sets ${ignored.keys.join(" and ")}, but Codex only applies a project's config when the project is trusted (trust: ${settings.trust}). Using ${settings.maxBytes} bytes.`,
    });
  }

  const candidates = ["AGENTS.override.md", "AGENTS.md", ...settings.fallbackNames];
  const chain: CodexChainEntry[] = [];
  let left = settings.maxBytes;

  const projectDocsOff = settings.trust === "untrusted" || settings.maxBytes === 0;
  if (settings.trust === "untrusted") {
    findings.push({
      code: "codex.untrusted",
      severity: "warn",
      agent: "codex",
      rule: "codex.untrusted",
      message: `This project is marked untrusted in ${settings.trustFrom}, so Codex loads no project instruction files at all.`,
    });
  } else if (settings.maxBytes === 0) {
    findings.push({
      code: "codex.zero-budget",
      severity: "warn",
      agent: "codex",
      rule: "codex.zero",
      message: "project_doc_max_bytes is 0, which turns project instruction files off.",
    });
  }

  if (!projectDocsOff) {
    for (const dir of dirsBetween(settings.projectRoot, launchDir)) {
      const present = candidates.filter((name) => isFileNamed(dir, name));
      const [chosen, ...others] = present;
      if (!chosen) continue;
      const file = path.join(dir, chosen);
      const bytes = readBytes(file);
      const entry: CodexChainEntry = {
        dir,
        path: file,
        name: chosen,
        bytes: bytes.length,
        keptBytes: 0,
        status: "loaded",
        budgetBefore: left,
        shadowed: others.map((name) => path.join(dir, name)),
      };
      chain.push(entry);

      if (left === 0) {
        entry.status = "no-budget";
        continue;
      }
      const kept = Math.min(bytes.length, left);
      const text = decodeLossy(bytes.subarray(0, kept));
      if (isBlankRust(text)) {
        entry.status = "empty";
        continue;
      }
      entry.keptBytes = kept;
      if (kept < bytes.length) {
        entry.status = "cut";
        entry.cut = describeCut(bytes, kept);
      }
      left -= kept;
    }
  }

  for (const entry of chain) {
    const name = rel(entry.path);
    for (const other of entry.shadowed) {
      const empty = entry.status === "empty";
      findings.push({
        code: empty ? "codex.empty-override" : "codex.shadowed",
        severity: empty ? "warn" : "info",
        agent: "codex",
        rule: empty ? "codex.empty-skip" : "codex.one-per-dir",
        path: other,
        message: empty
          ? `${name} is empty but still takes its directory's slot, so ${rel(other)} is not read and this directory gives Codex nothing.`
          : `${rel(other)} is not read: ${entry.name} in the same directory takes precedence.`,
      });
    }
    if (entry.status === "empty" && entry.shadowed.length === 0) {
      findings.push({
        code: "codex.empty",
        severity: "info",
        agent: "codex",
        rule: "codex.empty-skip",
        path: entry.path,
        message: `${name} is empty after trimming whitespace, so Codex skips it.`,
      });
    }
    if (entry.status === "no-budget") {
      findings.push({
        code: "codex.no-budget",
        severity: "warn",
        agent: "codex",
        rule: "codex.budget",
        path: entry.path,
        message: `${name} (${entry.bytes} bytes) never reaches Codex: files earlier in the chain used the whole ${settings.maxBytes}-byte budget.`,
      });
    }
    if (entry.status === "cut" && entry.cut) {
      const cut = entry.cut;
      const shared =
        entry.budgetBefore < settings.maxBytes
          ? ` Only ${entry.budgetBefore} of the ${settings.maxBytes}-byte budget was left after the files above it.`
          : "";
      const lost = cut.lostSections.length
        ? ` Sections that never reach Codex: ${listSections(cut.lostSections)}.`
        : "";
      const within = cut.cutSection ? ` The cut falls inside "${cut.cutSection}".` : "";
      findings.push({
        code: "codex.cut",
        severity: "warn",
        agent: "codex",
        rule: "codex.budget",
        path: entry.path,
        message: `${name} is cut at byte ${cut.at} of ${entry.bytes} (line ${cut.line}).${shared}${within}${lost}`,
      });
      if (cut.midCodepoint) {
        findings.push({
          code: "codex.mid-codepoint",
          severity: "warn",
          agent: "codex",
          rule: "codex.cut",
          path: entry.path,
          message: `The cut in ${name} at byte ${cut.at} splits a multi-byte character, so Codex sees U+FFFD (the replacement character) where it was.`,
        });
      }
    }
  }

  // Rule codex.home-is-root: Codex home is a directory on the chain, so the
  // file there is read once as the global file and again as a project file.
  const twice = global && chain.find((e) => e.keptBytes > 0 && sameFile(e.path, global.path));
  if (global && twice) {
    const where = samePath(twice.dir, settings.projectRoot) ? "the project root" : `${rel(twice.dir)}/`;
    findings.push({
      code: "codex.home-is-root",
      severity: "warn",
      agent: "codex",
      rule: "codex.home-is-root",
      path: global.path,
      message: `Codex home (CODEX_HOME) is ${where}, so Codex reads ${rel(global.path)} twice: once as the global instructions file and once as that directory's project file. The model gets its text twice${twice.status === "cut" ? ` (the second copy cut at byte ${twice.keptBytes})` : ""}. Point CODEX_HOME at a directory outside the project.`,
    });
  }

  const below = belowLaunch(options.scanRoot ?? launchDir, launchDir, candidates, settings.fallbackNames);
  for (const surface of below) {
    findings.push({
      code: "codex.nested",
      severity: "warn",
      agent: "codex",
      rule: "codex.nested",
      path: surface.path,
      message: `${rel(surface.path)} is below the launch directory, so Codex does not preload it. It is read only if the model decides to open it.`,
    });
  }

  const used = settings.maxBytes - left;
  return {
    agent: "codex",
    launchDir,
    settings,
    global,
    chain,
    budget: {
      limit: settings.maxBytes,
      used: projectDocsOff ? 0 : used,
      left: projectDocsOff ? settings.maxBytes : left,
    },
    below,
    findings,
  };
}

/** Rule `codex.global`: first non-empty of AGENTS.override.md, AGENTS.md in Codex home. */
function readGlobal(codexHome: string): CodexGlobal | undefined {
  const skippedEmpty: string[] = [];
  for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
    if (!isFileNamed(codexHome, name)) continue;
    const file = path.join(codexHome, name);
    const bytes = readBytes(file);
    if (isBlankRust(decodeLossy(bytes))) {
      skippedEmpty.push(file);
      continue;
    }
    return { path: file, bytes: bytes.length, skippedEmpty };
  }
  return undefined;
}

/** One file under two spellings (a link, or case on Windows) counts as one. */
function sameFile(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return samePath(real(a), real(b));
}

function listSections(sections: string[], max = 4): string {
  const shown = sections.slice(0, max).map((s) => `"${s}"`);
  const more = sections.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

export function describeCut(bytes: Uint8Array, at: number): Cut {
  const { line, column } = lineAndColumn(bytes, at);
  const all = headings(bytes);
  const before = all.filter((h) => h.offset < at);
  const lost = all.filter((h) => h.offset >= at).map((h) => h.text);
  const cutSection = before.at(-1)?.text;
  return {
    at,
    line,
    column,
    midCodepoint: splitsCodepoint(bytes, at),
    ...(cutSection !== undefined ? { cutSection } : {}),
    lostSections: lost,
  };
}

/**
 * For each directory strictly below the launch directory, the file Codex
 * would take there if launched in it (rule `codex.nested`).
 */
function belowLaunch(scanRoot: string, launchDir: string, candidates: string[], fallbackNames: string[]): Surface[] {
  const surfaces = discoverSurfaces(scanRoot, { fallbackNames }).filter(
    (s) =>
      !samePath(s.dir, launchDir) &&
      isInside(s.dir, launchDir) &&
      path.dirname(s.path) === s.dir &&
      candidates.includes(path.basename(s.path)),
  );
  const byDir = new Map<string, Surface>();
  for (const s of surfaces) {
    const current = byDir.get(s.dir);
    const rank = candidates.indexOf(path.basename(s.path));
    if (!current || rank < candidates.indexOf(path.basename(current.path))) byDir.set(s.dir, s);
  }
  return [...byDir.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Per-file view of a Codex result, for the files-by-agents matrix. */
export function codexReach(result: CodexResult): Reach[] {
  const out: Reach[] = [];
  if (result.global) {
    out.push({ path: result.global.path, delivery: "launch", why: "global file in Codex home", rule: "codex.global" });
  }
  for (const entry of result.chain) {
    const base = { path: entry.path, rule: "codex.budget" };
    if (entry.status === "loaded")
      out.push({ ...base, delivery: "launch", why: `${entry.keptBytes} bytes`, rule: "codex.walk" });
    else if (entry.status === "cut" && entry.cut)
      out.push({
        ...base,
        delivery: "launch-cut",
        why: `cut at byte ${entry.cut.at} of ${entry.bytes}`,
        cut: entry.cut,
      });
    else if (entry.status === "no-budget")
      out.push({ ...base, delivery: "not-loaded", why: "budget used up by earlier files" });
    else out.push({ ...base, delivery: "not-loaded", why: "empty", rule: "codex.empty-skip" });
    for (const other of entry.shadowed) {
      out.push({
        path: other,
        delivery: "not-loaded",
        why: `shadowed by ${entry.name}`,
        rule: entry.status === "empty" ? "codex.empty-skip" : "codex.one-per-dir",
      });
    }
  }
  for (const s of result.below) {
    out.push({ path: s.path, delivery: "maybe", why: "below launch dir: not preloaded", rule: "codex.nested" });
  }
  return out;
}
