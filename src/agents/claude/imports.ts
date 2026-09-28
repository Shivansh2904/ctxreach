import { statSync } from "node:fs";
import path from "node:path";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// A code span: a run of backticks, then anything up to the same run again.
const CODE_SPAN = /(`+)[\s\S]*?\1/g;
// Rule `claude.imports` (assumed syntax): `@` at the start of a line or after
// whitespace, followed by non-space characters.
const IMPORT = /(?:^|\s)@(\S+)/g;

/** Text with fenced code blocks and code spans removed, the parts Claude Code does not parse for imports. */
export function withoutCode(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = FENCE.exec(line);
    if (m?.[1]) {
      const marker = m[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      out.push("");
      continue;
    }
    out.push(fence === null ? line.replace(CODE_SPAN, "") : "");
  }
  return out.join("\n");
}

/** The raw `@path` tokens in a file, in order, outside code. */
export function importTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const m of withoutCode(text).matchAll(IMPORT)) if (m[1]) tokens.push(m[1]);
  return tokens;
}

function regularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve an import token against the importing file. Returns the absolute
 * path of an existing regular file, or undefined.
 */
export function resolveImport(token: string, fromFile: string, homeDir: string): string | undefined {
  const attempt = (t: string): string | undefined => {
    if (t === "") return undefined;
    let p: string;
    if (t === "~" || t.startsWith("~/")) p = path.join(homeDir, t.slice(2));
    else if (path.isAbsolute(t)) p = t;
    else p = path.resolve(path.dirname(fromFile), t);
    return regularFile(p) ? p : undefined;
  };
  const direct = attempt(token);
  if (direct) return direct;
  const trimmed = token.replace(/[.,;:!?)]+$/, "");
  return trimmed !== token ? attempt(trimmed) : undefined;
}
