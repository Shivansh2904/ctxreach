import path from "node:path";
import { codexReach } from "../agents/codex/resolve.js";
import type { AgentId, Cut, Delivery } from "../agents/types.js";
import { discoverSurfaces } from "../discover/surfaces.js";
import { isInside, samePath } from "../util/fs.js";
import type { MapResult } from "./map.js";

export interface MatrixCell {
  delivery: Delivery;
  why: string;
  rule: string;
  cut?: Cut;
  needsApproval?: boolean;
}

export interface MatrixRow {
  path: string;
  cells: Partial<Record<AgentId, MatrixCell>>;
}

/**
 * One row per instruction file (in the repository, above it, or imported),
 * one column per agent: how each agent receives that file from the launch
 * directory.
 */
export function buildMatrix(result: MapResult): MatrixRow[] {
  const rows = new Map<string, MatrixRow>();
  const key = (p: string) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  const row = (p: string): MatrixRow => {
    const k = key(p);
    let r = rows.get(k);
    if (!r) {
      r = { path: p, cells: {} };
      rows.set(k, r);
    }
    return r;
  };

  const fallbackNames = result.codex?.settings.fallbackNames ?? [];
  for (const s of discoverSurfaces(result.repoRoot, { fallbackNames })) row(s.path);

  if (result.codex) {
    for (const reach of codexReach(result.codex)) {
      row(reach.path).cells.codex = {
        delivery: reach.delivery,
        why: reach.why,
        rule: reach.rule,
        ...(reach.cut ? { cut: reach.cut } : {}),
      };
    }
  }
  if (result.claude) {
    for (const f of result.claude.files) {
      row(f.path).cells.claude = {
        delivery: f.delivery,
        why: f.why,
        rule: f.rule,
        ...(f.needsApproval ? { needsApproval: true } : {}),
      };
    }
  }

  // Fill the gaps: files an agent's resolver never looked at.
  const codex = result.codex;
  const codexNames = codex ? ["AGENTS.override.md", "AGENTS.md", ...fallbackNames] : [];
  for (const r of rows.values()) {
    if (codex && !r.cells.codex) {
      const name = path.basename(r.path);
      const dir = path.dirname(r.path);
      let why = "not a Codex instruction file";
      let rule = "codex.one-per-dir";
      let delivery: Delivery = "not-loaded";
      if (codexNames.includes(name) && !samePath(dir, codex.settings.codexHome)) {
        rule = "codex.walk";
        if (isInside(dir, codex.launchDir)) {
          delivery = "maybe";
          why = "below launch dir: not preloaded";
          rule = "codex.nested";
        } else if (isInside(codex.launchDir, dir)) {
          why = "above the project root";
        } else {
          why = "not on the path from the project root to the launch dir";
        }
      }
      r.cells.codex = { delivery, why, rule };
    }
    if (result.claude && !r.cells.claude) {
      r.cells.claude = { delivery: "not-loaded", why: "not a file Claude Code reads", rule: "claude.agents-never" };
    }
  }

  const inRepo = (p: string) => isInside(p, result.repoRoot);
  return [...rows.values()].sort((a, b) => {
    const ia = inRepo(a.path);
    const ib = inRepo(b.path);
    if (ia !== ib) return ia ? 1 : -1;
    const ra = path.relative(result.repoRoot, a.path).split(path.sep).join("/");
    const rb = path.relative(result.repoRoot, b.path).split(path.sep).join("/");
    return ra < rb ? -1 : ra > rb ? 1 : 0;
  });
}
