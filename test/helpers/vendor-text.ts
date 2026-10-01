/**
 * Finds the agents' own prompt text, which ctxreach does not publish, in
 * recordings and source files.
 *
 * The phrases are kept as hashes, never as text, so this file does not hold
 * what it looks for: each is the SHA-256 of the phrase's words, lower-cased
 * and joined by single spaces (`words`), with its first word in the clear
 * so that only the windows starting with it are hashed. Every phrase except
 * the first was taken from the requests and renders the two agents actually
 * sent on 2026-09-30, before they were saved reduced.
 */
import { createHash } from "node:crypto";

export interface VendorPhrase {
  /** Where the phrase comes from (the agent, its version, the part of its prompt). */
  source: string;
  first: string;
  words: number;
  sha256: string;
}

export const VENDOR_PHRASES: readonly VendorPhrase[] = [
  {
    source: "Claude Code: the identity line of its interactive system prompt",
    first: "you",
    words: 4,
    sha256: "f145f7f859b0bce281fb3f467e091f741bf9a969d70fe02bafb146a333208096",
  },
  {
    source: "Claude Code 2.1.285: the identity line of its system prompt under -p",
    first: "built",
    words: 7,
    sha256: "bd38c69d596cb553e0219e7ecdc254aba83c21593054df50300352e85bba5452",
  },
  {
    source: "Claude Code 2.1.285: the opening of its main system prompt block",
    first: "you",
    words: 8,
    sha256: "190e698b945bedf4b16dc3353a886d5000efa0e4afb3e823c0b6c711fc5dffcb",
  },
  {
    source: "Claude Code 2.1.285: the security paragraph of its system prompt",
    first: "assist",
    words: 5,
    sha256: "07e7b86f007838528606a73615f5eb7de327629cd3f3891d3cd39f102fdc395b",
  },
  {
    source: "Claude Code 2.1.285: the memory section of its system prompt",
    first: "you",
    words: 7,
    sha256: "0aebd46e82c31f761a3288101e9943df8cce38958ba06e0327e12ae0cc7e2164",
  },
  {
    source: "Claude Code 2.1.285: the preamble of the instruction-file reminder",
    first: "codebase",
    words: 7,
    sha256: "b0495ea1aca649c07c876bdf10332293f046633ea06f33b90495408e0c35f3a0",
  },
  {
    source: "Claude Code 2.1.285: the preamble of the instruction-file reminder",
    first: "be",
    words: 7,
    sha256: "9d33eb74986c7523c853dd455033f53b3f2808413d49d994fa886b533c3de636",
  },
  {
    source: "Claude Code 2.1.285: the git status reminder",
    first: "this",
    words: 11,
    sha256: "8b5e531721cee4af2dffbc1b4b83e6cc335cc22f3803f264a914c4eba8141195",
  },
  {
    source: "Claude Code 2.1.285: the end of the git status reminder",
    first: "claude",
    words: 6,
    sha256: "58dc2d82c9fe46e5fa8e9b11d075ff8304e43e8d2163c50da96a76d9369903e5",
  },
  {
    source: "Claude Code 2.1.285: the Environment block",
    first: "you",
    words: 8,
    sha256: "68c3b71d18346b96127fe40b7e8c8bf85ece8dc734d8520685edd2be2b32bc60",
  },
  {
    source: "Codex 0.159.2: the permissions developer item",
    first: "filesystem",
    words: 3,
    sha256: "aef25aad613bbdeb222b64fbb2296ab9b80eda226bde7c2119d683ca626b4196",
  },
  {
    source: "Codex 0.159.2: the permissions developer item",
    first: "commands",
    words: 13,
    sha256: "f22e9515202fb596f191a56ddf05d40701f2d92bbd5c96a354f55920ab7d8179",
  },
  {
    source: "Codex 0.159.2: the skills developer item",
    first: "a",
    words: 8,
    sha256: "1a1a5d557406283df20fb801d4bf36e2d4018d6628d3cdf47022993642c0e09f",
  },
  {
    source: "Codex 0.159.2: the collaboration-mode developer item",
    first: "you",
    words: 6,
    sha256: "5d6b955f1cba47f9a4ca52255af797a8099e8e8076c0135e9ffc36cc2719ca54",
  },
  {
    source: "Codex 0.159.2: the multi-agent role developer item",
    first: "the",
    words: 8,
    sha256: "faa8f0ea1075086888181ececfa26c59fff8bc8a95ed0999bd787783fcf0bb22",
  },
];

/** A text as words: lower case, split on anything that is not a letter or a digit. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The hash a phrase is kept as. */
export function phraseHash(phrase: string): string {
  return sha256(words(phrase).join(" "));
}

/** The phrases whose words occur, in order and adjacent, in `text`. */
export function vendorPhrasesIn(text: string, phrases: readonly VendorPhrase[] = VENDOR_PHRASES): VendorPhrase[] {
  const w = words(text);
  const found = new Set<VendorPhrase>();
  w.forEach((word, i) => {
    for (const p of phrases) {
      if (p.first !== word || found.has(p) || i + p.words > w.length) continue;
      if (sha256(w.slice(i, i + p.words).join(" ")) === p.sha256) found.add(p);
    }
  });
  return [...found];
}

/** Every string in a JSON value (keys included), and, for a string that is itself JSON, every string in that too. */
export function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      let inner: unknown;
      try {
        inner = JSON.parse(t);
      } catch {
        return out;
      }
      stringsOf(inner, out);
    }
  } else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (value !== null && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      stringsOf(v, out);
    }
  return out;
}

/**
 * The texts of one file to look in: for JSON and JSON Lines, every string in it (a phrase does not span two
 * strings); for anything else, the file with its escape sequences (`\n`, `\"`) read as spaces, so a phrase
 * written inside a string literal is still found.
 */
export function textsOfFile(name: string, content: string): string[] {
  const lines = name.endsWith(".jsonl") ? content.split("\n").filter((l) => l.trim() !== "") : [content];
  if (name.endsWith(".json") || name.endsWith(".jsonl")) {
    try {
      return lines.flatMap((l) => stringsOf(JSON.parse(l) as unknown));
    } catch {
      // Not JSON after all: read as text below.
    }
  }
  return [content.replace(/\\[nrt"'\\]/g, " ")];
}
