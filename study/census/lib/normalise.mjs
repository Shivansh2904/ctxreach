// Text measures for outcome O1-content and its sensitivity variant, and for
// O8 (CJK share). Pure functions over strings; no file access.

/** Minimum length of a normalised line for it to count (study/PREREG.md, O1-content). */
export const MIN_LINE_CHARS = 20;
/** Words per shingle in the sensitivity variant. */
export const SHINGLE_WORDS = 8;
/** A line counts as received in the sensitivity variant when this share of its shingles appear. */
export const SHINGLE_THRESHOLD = 0.8;

/** Trim a line and collapse every run of whitespace to one space. CR, tabs and NBSP are whitespace. */
export function normaliseLine(line) {
  return line.replace(/\s+/gu, " ").trim();
}

/**
 * The set A of a text: every line, normalised, at least MIN_LINE_CHARS
 * characters long (counted in code points), deduplicated. Code fences are
 * ordinary lines: the text inside a fence is delivered like any other text,
 * and a fence marker is shorter than the minimum.
 */
export function lineSet(text) {
  const out = new Set();
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = normaliseLine(raw);
    if ([...line].length >= MIN_LINE_CHARS) out.add(line);
  }
  return out;
}

/**
 * O1-content: how many lines of `source` (the root AGENTS.md) appear, after
 * the same normalisation, among the lines of the `delivered` texts.
 */
export function lineContainment(source, delivered) {
  const a = lineSet(source);
  const got = new Set();
  for (const t of delivered) for (const l of lineSet(t)) got.add(l);
  let r = 0;
  for (const l of a) if (got.has(l)) r++;
  return { a: a.size, r, share: a.size === 0 ? undefined : r / a.size };
}

function words(text) {
  return normaliseLine(text).split(" ").filter(Boolean);
}

/** The 8-word shingles of a text (one shingle of all its words when it has fewer than 8). */
export function shingles(text) {
  const w = words(text);
  const out = new Set();
  if (w.length === 0) return out;
  if (w.length < SHINGLE_WORDS) {
    out.add(w.join(" "));
    return out;
  }
  for (let i = 0; i + SHINGLE_WORDS <= w.length; i++) out.add(w.slice(i, i + SHINGLE_WORDS).join(" "));
  return out;
}

/**
 * Sensitivity variant of O1-content: a line of A counts as received when at
 * least SHINGLE_THRESHOLD of its shingles appear among the shingles of the
 * delivered text (all delivered files joined, so a line that wraps
 * differently still matches). Short lines fall back to the whole line being a
 * substring of the delivered text's normalised form.
 */
export function shingleContainment(source, delivered) {
  const a = lineSet(source);
  const joined = delivered.map((t) => words(t).join(" ")).join(" \u0000 ");
  const pool = new Set();
  for (const t of delivered) for (const s of shingles(t)) pool.add(s);
  let r = 0;
  for (const line of a) {
    const own = shingles(line);
    const w = words(line);
    if (w.length < SHINGLE_WORDS) {
      if (joined.includes(w.join(" "))) r++;
      continue;
    }
    let hit = 0;
    for (const s of own) if (pool.has(s)) hit++;
    if (hit / own.size >= SHINGLE_THRESHOLD) r++;
  }
  return { a: a.size, r, share: a.size === 0 ? undefined : r / a.size };
}

const CJK =
  /[\u1100-\u11ff\u2e80-\u2fdf\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31a0-\u31bf\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\uff66-\uff9f]|[\u{20000}-\u{3134f}]/u;

/** Share of non-whitespace characters (code points) that are CJK: Han, kana, Hangul. */
export function cjkShare(text) {
  let total = 0;
  let cjk = 0;
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    total++;
    if (CJK.test(ch)) cjk++;
  }
  return total === 0 ? 0 : cjk / total;
}

/** Characters (code points, U+FFFD for a split one) that fit in the first `bytes` bytes of a UTF-8 buffer. */
export function charsInBytes(buf, bytes) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.subarray(0, bytes));
  return [...text].length;
}
