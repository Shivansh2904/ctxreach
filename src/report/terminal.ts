import os from "node:os";
import pc from "picocolors";
import type { ClaudeResult } from "../agents/claude/resolve.js";
import type { CodexResult } from "../agents/codex/resolve.js";
import type { AgentId, Finding } from "../agents/types.js";
import type { MapResult } from "../map/map.js";
import type { MatrixCell } from "../map/matrix.js";
import { displayPath } from "../util/fs.js";

export function table(rows: string[][], indent = "  "): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(cell).length)));
  return rows
    .map((row) =>
      (
        indent +
        row
          .map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat((widths[i] ?? 0) - visible(cell).length)))
          .join("  ")
      ).trimEnd(),
    )
    .join("\n");
}

// Strip ANSI colour codes so column widths are measured on what is shown.
function visible(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

export function home(p: string): string {
  const h = os.homedir();
  return p.startsWith(h) ? "~" + p.slice(h.length).split("\\").join("/") : p;
}

function codexSection(result: MapResult, codex: CodexResult): string {
  const rel = (p: string) => displayPath(p, result.repoRoot);
  const s = codex.settings;
  const lines: string[] = [];
  lines.push(pc.bold("Codex"));
  const maxSource = s.sources.find((x) => x.key === "project_doc_max_bytes")?.from ?? "default";
  lines.push(
    table([
      [
        "project root",
        rel(s.projectRoot),
        s.rootFound ? `(has ${s.rootMarkers.join(" or ")})` : "(no root marker: launch dir only)",
      ],
      [
        "budget",
        `${s.maxBytes} bytes`,
        `(${maxSource === "default" || maxSource === "override" ? maxSource : home(maxSource)})`,
      ],
      [
        "trust",
        s.trust,
        s.ignoredProjectConfig.length ? "(so the project's .codex/config.toml is not applied)" : `(${s.trustFrom})`,
      ],
      [
        "global file",
        codex.global ? home(codex.global.path) : "none",
        codex.global ? `(${codex.global.bytes} bytes, not charged to the budget)` : "",
      ],
    ]),
  );
  lines.push("");
  if (codex.chain.length === 0) {
    lines.push("  No project instruction files reach Codex from this directory.");
  } else {
    const rows = [[pc.dim("#"), pc.dim("file"), pc.dim("bytes"), pc.dim("reaches Codex")]];
    codex.chain.forEach((e, i) => {
      let reach: string;
      if (e.status === "loaded") reach = pc.green("all of it");
      else if (e.status === "cut" && e.cut)
        reach =
          pc.yellow(`first ${e.keptBytes} bytes`) +
          ` (cut at line ${e.cut.line}${e.cut.midCodepoint ? ", mid-character" : ""})`;
      else if (e.status === "no-budget") reach = pc.red("nothing: budget used up");
      else reach = pc.red("nothing: empty");
      rows.push([String(i + 1), rel(e.path), String(e.bytes), reach]);
    });
    lines.push(table(rows));
    lines.push(pc.dim(`     budget used: ${codex.budget.used} of ${codex.budget.limit} bytes`));
  }
  if (codex.below.length) {
    lines.push("");
    lines.push("  Below the launch directory, not preloaded:");
    for (const s2 of codex.below) lines.push(`     ${rel(s2.path)}`);
  }
  return lines.join("\n");
}

function claudeSection(result: MapResult, claude: ClaudeResult): string {
  const rel = (p: string) => displayPath(p, result.repoRoot);
  const lines: string[] = [pc.bold("Claude Code")];
  lines.push(
    table([
      [
        "Project instructions",
        claude.mode,
        `(${claude.modeFrom === "default" || claude.modeFrom === "override" ? claude.modeFrom : home(claude.modeFrom)})`,
      ],
      [
        "AGENTS.md",
        claude.agentsMd.read ? "read" : "not read",
        claude.agentsMd.read ? "" : `(${claude.agentsMd.reason})`,
      ],
      [
        "version",
        claude.version ?? "not given",
        claude.version ? "" : "(assumes 2.1.281 or later; pass --claude-version to check an older one)",
      ],
    ]),
  );
  const launch = claude.files.filter((f) => f.delivery === "launch" || f.delivery === "import");
  lines.push("");
  lines.push(
    launch.length
      ? `  Loaded at launch, in order: ${launch.map((f) => (f.kind === "user" || f.kind === "user-rule" ? home(f.path) : rel(f.path))).join(", ")}`
      : "  No instruction files load at launch.",
  );
  return lines.join("\n");
}

const AGENT_TITLES: Record<AgentId, string> = { codex: "Codex", claude: "Claude Code" };

function cellText(cell: MatrixCell | undefined): string {
  if (!cell) return "";
  switch (cell.delivery) {
    case "launch":
      return pc.green("launch");
    case "launch-cut":
      return pc.yellow(`launch, cut at byte ${cell.cut?.at ?? "?"}`);
    case "import":
      return pc.green("import") + (cell.needsApproval ? pc.yellow(" (needs approval)") : "");
    case "on-read":
      return pc.cyan("on read");
    case "maybe":
      return pc.yellow("not preloaded");
    case "not-loaded":
      return pc.red("no") + pc.dim(`: ${cell.why}`);
  }
}

function matrixSection(result: MapResult): string {
  const agents = (["codex", "claude"] as AgentId[]).filter((a) => result[a]);
  const header = [pc.dim("file"), ...agents.map((a) => pc.dim(AGENT_TITLES[a]))];
  const rows = result.matrix.map((r) => {
    const inRepo = displayPath(r.path, result.repoRoot);
    const name = inRepo.startsWith("/") || /^[A-Za-z]:/.test(inRepo) ? home(r.path) : inRepo;
    return [name, ...agents.map((a) => cellText(r.cells[a]))];
  });
  if (rows.length === 0) return "  No instruction files found.";
  return table([header, ...rows]);
}

function findingLine(f: Finding): string {
  const tag = f.severity === "warn" ? pc.yellow("warn") : pc.dim("info");
  return `  ${tag}  ${f.agent.padEnd(6)} ${f.message}`;
}

export function renderTerminal(result: MapResult): string {
  const parts: string[] = [];
  parts.push(
    `${pc.bold("ctxreach map")}  launch dir: ${displayPath(result.launchDir, result.repoRoot)}  repo: ${home(result.repoRoot)}`,
  );
  parts.push(matrixSection(result));
  if (result.codex) parts.push(codexSection(result, result.codex));
  if (result.claude) parts.push(claudeSection(result, result.claude));
  if (result.findings.length) {
    const sorted = [...result.findings].sort((a, b) =>
      a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1,
    );
    parts.push(pc.bold("Findings") + "\n" + sorted.map(findingLine).join("\n"));
  } else {
    parts.push(pc.dim("No findings."));
  }
  return parts.join("\n\n") + "\n";
}
