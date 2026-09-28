/**
 * Byte- and text-level helpers shared by the resolvers.
 *
 * Agents measure instruction files in bytes, not characters, so everything
 * here works on raw bytes and only decodes when a rule says the agent does.
 */

/**
 * Decode bytes the way Rust's `String::from_utf8_lossy` does: invalid or
 * incomplete sequences become U+FFFD, and a leading byte-order mark is kept
 * (TextDecoder strips it unless told not to).
 */
export function decodeLossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(bytes);
}

// Unicode White_Space, which is what Rust's `str::trim` removes. JavaScript's
// `trim()` also removes U+FEFF, which Rust does not, so it cannot be used to
// decide whether an agent written in Rust sees a file as empty.
const RUST_WHITESPACE = new RegExp(
  "^[\t\n\u000B\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$",
  "u",
);

/** True when Rust's `text.trim().is_empty()` would be true. */
export function isBlankRust(text: string): boolean {
  return RUST_WHITESPACE.test(text);
}

/** True when a cut at `offset` would split a multi-byte UTF-8 character. */
export function splitsCodepoint(bytes: Uint8Array, offset: number): boolean {
  if (offset <= 0 || offset >= bytes.length) return false;
  const next = bytes[offset];
  return next !== undefined && (next & 0xc0) === 0x80;
}

/** 1-based line and byte column of a byte offset. */
export function lineAndColumn(bytes: Uint8Array, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, bytes.length);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

export interface Heading {
  /** Heading text without the leading #s. */
  text: string;
  level: number;
  /** Byte offset where the heading line starts. */
  offset: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;

/**
 * Markdown ATX headings with their byte offsets. Lines inside fenced code
 * blocks are skipped. Setext headings are not recognised.
 */
export function headings(bytes: Uint8Array): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  let start = 0;
  while (start <= bytes.length) {
    let end = bytes.indexOf(0x0a, start);
    if (end === -1) end = bytes.length;
    let line = decodeLossy(bytes.subarray(start, end));
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (fence === null) {
      const m = ATX.exec(line);
      if (m?.[1]) out.push({ text: (m[2] ?? "").trim(), level: m[1].length, offset: start });
    }
    start = end + 1;
  }
  return out;
}
