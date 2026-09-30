import type { MapJson } from "./json.js";

/**
 * The GitHub Action's job summary: one Markdown matrix per launch directory,
 * built from `map --json` output (schema `ctxreach.map/v1`), so it shows
 * exactly what `ctxreach map --json` would print for each directory.
 */

type Cell = NonNullable<MapJson["matrix"][number]["codex"]>;
type AgentKey = "codex" | "claude";

const AGENT_TITLES: Record<AgentKey, string> = { codex: "Codex", claude: "Claude Code" };

/** GitHub rejects a step summary over 1 MiB; stop adding sections well before that (bytes of UTF-8). */
export const SUMMARY_LIMIT = 900_000;

/** Size as GitHub counts it: bytes of UTF-8, so a CJK path or heading counts three a character. */
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** Text safe inside a Markdown table cell. */
export function tableText(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** A path or other literal as inline code, whatever backticks it holds. */
export function code(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** The same words the terminal table uses for a cell, without colour. */
export function cellWords(cell: Cell | undefined): string {
  if (!cell) return "";
  let text: string;
  switch (cell.delivery) {
    case "launch":
      text = "launch";
      break;
    case "launch-cut":
      text = cell.cut ? `launch, cut at byte ${cell.cut.at} (line ${cell.cut.line})` : "launch, cut";
      break;
    case "import":
      text = "import" + (cell.needsApproval ? " (needs approval)" : "");
      break;
    case "on-read":
      text = "on read";
      break;
    case "maybe":
      text = "not preloaded";
      break;
    case "not-loaded":
      text = `no: ${cell.why}`;
      break;
  }
  return cell.notModelled ? `${text} (not modelled)` : text;
}

function agentsOf(json: MapJson): AgentKey[] {
  return (["codex", "claude"] as AgentKey[]).filter((a) => json[a] !== undefined);
}

/** One launch directory: its matrix and its findings. */
export function launchSection(json: MapJson): string {
  const agents = agentsOf(json);
  const lines: string[] = [];
  lines.push(`### From ${code(json.launchDir)}`, "");
  if (json.matrix.length === 0) {
    lines.push("No instruction files found.", "");
  } else {
    lines.push(`| file | ${agents.map((a) => AGENT_TITLES[a]).join(" | ")} |`);
    lines.push(`|---|${agents.map(() => "---").join("|")}|`);
    for (const row of json.matrix)
      lines.push(`| ${tableText(code(row.path))} | ${agents.map((a) => tableText(cellWords(row[a]))).join(" | ")} |`);
    lines.push("");
  }
  const findings = [...json.findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "warn" ? -1 : 1));
  if (findings.length === 0) {
    lines.push("No findings.", "");
  } else {
    for (const f of findings) lines.push(`- **${f.severity}** ${AGENT_TITLES[f.agent]}, ${code(f.code)}: ${f.message}`);
    lines.push("");
  }
  return lines.join("\n");
}

function counts(json: MapJson): { warn: number; info: number } {
  return {
    warn: json.findings.filter((f) => f.severity === "warn").length,
    info: json.findings.filter((f) => f.severity === "info").length,
  };
}

/** What reaches one agent from one launch directory, in a few words. */
export function reachWords(json: MapJson, agent: AgentKey): string {
  const cells = json.matrix.map((r) => r[agent]).filter((c): c is Cell => c !== undefined);
  const atLaunch = cells.filter((c) => c.delivery === "launch" || c.delivery === "import").length;
  const cut = cells.filter((c) => c.delivery === "launch-cut").length;
  const later = cells.filter((c) => c.delivery === "on-read" || c.delivery === "maybe").length;
  const parts = [`${atLaunch + cut} at launch`];
  if (cut) parts.push(`${cut} cut`);
  if (later) parts.push(`${later} later or not preloaded`);
  return parts.join(", ");
}

export interface SummaryOptions {
  version: string;
  /** The scanned directory as the reader should see it. */
  scanned: string;
  /** Annotations written for this run (after merging launch directories). */
  annotations: number;
  /** Stop adding launch-directory sections past this many bytes of UTF-8 (default SUMMARY_LIMIT). */
  limit?: number;
}

/**
 * The whole job summary. Launch directories with warnings come first. If the
 * summary would pass GitHub's size limit, the remaining sections are left out
 * and the summary says how many.
 */
export function renderSummary(runs: readonly MapJson[], options: SummaryOptions): string {
  const agents = runs[0] ? agentsOf(runs[0]) : [];
  const ordered = [...runs].sort((a, b) => counts(b).warn - counts(a).warn);
  const head: string[] = [];
  head.push("## ctxreach map", "");
  head.push(
    `Predicted by ctxreach ${options.version} from each agent's documented loading rules ` +
      "([docs/rules.md](https://github.com/Shivansh2904/ctxreach/blob/main/docs/rules.md)). " +
      "No agent was run. The machine modelled has no personal Codex or Claude Code configuration, " +
      `and nothing above ${code(options.scanned)} is read.`,
    "",
  );
  const warn = runs.reduce((n, r) => n + counts(r).warn, 0);
  head.push(
    `${runs.length} launch ${runs.length === 1 ? "directory" : "directories"}, ` +
      `${warn} ${warn === 1 ? "warning" : "warnings"} in all, ` +
      `${options.annotations} ${options.annotations === 1 ? "annotation" : "annotations"} ` +
      "(GitHub shows at most 10 warning annotations per step; the log has every one).",
    "",
  );
  head.push(`| launch dir | ${agents.map((a) => AGENT_TITLES[a]).join(" | ")} | warn | info |`);
  head.push(`|---|${agents.map(() => "---").join("|")}|---|---|`);
  for (const r of ordered) {
    const c = counts(r);
    head.push(
      `| ${tableText(code(r.launchDir))} | ${agents.map((a) => reachWords(r, a)).join(" | ")} | ${c.warn} | ${c.info} |`,
    );
  }
  head.push("");

  let out = head.join("\n");
  let size = bytes(out);
  let shown = 0;
  for (const r of ordered) {
    const section = "\n" + launchSection(r);
    const more = bytes(section);
    if (size + more > (options.limit ?? SUMMARY_LIMIT)) break;
    out += section;
    size += more;
    shown++;
  }
  const left = ordered.length - shown;
  if (left > 0)
    out +=
      `\n${left} more launch ${left === 1 ? "directory is" : "directories are"} left out of this summary ` +
      "to stay under GitHub's size limit; the JSON output has all of them.\n";
  return out;
}
