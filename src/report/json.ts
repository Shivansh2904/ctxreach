import { z } from "zod";
import { CLAUDE_MODES } from "../agents/claude/settings.js";
import type { MapResult } from "../map/map.js";
import { displayPath } from "../util/fs.js";

/**
 * The `--json` output. Paths inside the repository are relative to it, with
 * forward slashes; paths outside it are absolute. The schema is versioned so
 * that a change in shape is a visible, deliberate break.
 */
export const CutJson = z.object({
  at: z.number().int(),
  line: z.number().int(),
  column: z.number().int(),
  midCodepoint: z.boolean(),
  cutSection: z.string().optional(),
  lostSections: z.array(z.string()),
});

export const FindingJson = z.object({
  code: z.string(),
  severity: z.enum(["warn", "info"]),
  agent: z.enum(["codex", "claude"]),
  rule: z.string(),
  path: z.string().optional(),
  message: z.string(),
});

export const CodexJson = z.object({
  projectRoot: z.string(),
  rootFound: z.boolean(),
  trust: z.enum(["trusted", "untrusted", "unknown"]),
  settings: z.array(z.object({ key: z.string(), value: z.unknown(), from: z.string() })),
  global: z.object({ path: z.string(), bytes: z.number().int() }).optional(),
  chain: z.array(
    z.object({
      path: z.string(),
      bytes: z.number().int(),
      keptBytes: z.number().int(),
      status: z.enum(["loaded", "cut", "no-budget", "empty"]),
      budgetBefore: z.number().int(),
      cut: CutJson.optional(),
      shadowed: z.array(z.string()),
    }),
  ),
  budget: z.object({ limit: z.number().int(), used: z.number().int(), left: z.number().int() }),
  notPreloaded: z.array(z.string()),
});

const DeliveryJson = z.enum(["launch", "launch-cut", "import", "on-read", "maybe", "not-loaded"]);

export const ClaudeJson = z.object({
  mode: z.enum(CLAUDE_MODES),
  modeFrom: z.string(),
  version: z.string().optional(),
  agentsMd: z.object({ read: z.boolean(), reason: z.string() }),
  shadowers: z.array(z.string()),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.string(),
      delivery: DeliveryJson,
      why: z.string(),
      rule: z.string(),
      bytes: z.number().int(),
      importedBy: z.string().optional(),
      depth: z.number().int().optional(),
      needsApproval: z.boolean().optional(),
      notModelled: z.boolean().optional(),
    }),
  ),
  unresolvedImports: z.array(z.object({ in: z.string(), token: z.string() })),
});

const CellJson = z.object({
  delivery: DeliveryJson,
  why: z.string(),
  rule: z.string(),
  cut: CutJson.optional(),
  needsApproval: z.boolean().optional(),
  notModelled: z.boolean().optional(),
});

export const MapJson = z.object({
  schema: z.literal("ctxreach.map/v1"),
  version: z.string(),
  launchDir: z.string(),
  repoRoot: z.string(),
  codex: CodexJson.optional(),
  claude: ClaudeJson.optional(),
  matrix: z.array(z.object({ path: z.string(), codex: CellJson.optional(), claude: CellJson.optional() })),
  findings: z.array(FindingJson),
});

export type MapJson = z.infer<typeof MapJson>;

export function toJson(result: MapResult, version: string): MapJson {
  const rel = (p: string) => displayPath(p, result.repoRoot);
  const out: MapJson = {
    schema: "ctxreach.map/v1",
    version,
    launchDir: rel(result.launchDir),
    repoRoot: result.repoRoot.split("\\").join("/"),
    matrix: result.matrix.map((r) => ({ path: rel(r.path), ...r.cells })),
    findings: result.findings.map((f) => ({ ...f, ...(f.path !== undefined ? { path: rel(f.path) } : {}) })),
  };
  const codex = result.codex;
  if (codex) {
    out.codex = {
      projectRoot: rel(codex.settings.projectRoot),
      rootFound: codex.settings.rootFound,
      trust: codex.settings.trust,
      settings: codex.settings.sources.map((s) => ({
        ...s,
        from: s.from.includes("/") || s.from.includes("\\") ? rel(s.from) : s.from,
      })),
      ...(codex.global ? { global: { path: rel(codex.global.path), bytes: codex.global.bytes } } : {}),
      chain: codex.chain.map((e) => ({
        path: rel(e.path),
        bytes: e.bytes,
        keptBytes: e.keptBytes,
        status: e.status,
        budgetBefore: e.budgetBefore,
        ...(e.cut ? { cut: e.cut } : {}),
        shadowed: e.shadowed.map(rel),
      })),
      budget: codex.budget,
      notPreloaded: codex.below.map((s) => rel(s.path)),
    };
  }
  const claude = result.claude;
  if (claude) {
    out.claude = {
      mode: claude.mode,
      modeFrom:
        claude.modeFrom === "default" || claude.modeFrom === "override" ? claude.modeFrom : rel(claude.modeFrom),
      ...(claude.version !== undefined ? { version: claude.version } : {}),
      agentsMd: claude.agentsMd,
      shadowers: claude.shadowers.map(rel),
      files: claude.files.map((f) => ({
        ...f,
        path: rel(f.path),
        ...(f.importedBy !== undefined ? { importedBy: rel(f.importedBy) } : {}),
      })),
      unresolvedImports: claude.unresolvedImports.map((u) => ({ in: rel(u.in), token: u.token })),
    };
  }
  // Validate our own output: a shape change fails here, in the tests, rather
  // than in whatever reads the JSON.
  return MapJson.parse(out);
}
