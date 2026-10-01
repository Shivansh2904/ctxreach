// Seeded sampling. The seed is the first 8 hex digits of the commit that the
// tag prereg-v1 points to (study/census/seed.mjs), so nobody can choose it
// after seeing data. Random integers come from SHA-256 in counter mode, which
// any language can reproduce: see study/PREREG.md, "Sampling".

import { createHash } from "node:crypto";

/** Accept exactly 8 lowercase hex digits. */
export function checkSeed(seed) {
  if (!/^[0-9a-f]{8}$/.test(seed)) throw new RangeError(`seed must be 8 lowercase hex digits, got "${seed}"`);
  return seed;
}

/** seed + k as 8 hex digits (for the one pre-registered redraw, seed+1). */
export function offsetSeed(seed, k) {
  return ((parseInt(checkSeed(seed), 16) + k) >>> 0).toString(16).padStart(8, "0");
}

/**
 * A stream of uniform 32-bit integers: word i is the first 4 bytes
 * (big-endian) of SHA-256("ctxreach-study|<seed>|<stream>|<i>").
 */
export function rng(seed, stream) {
  checkSeed(seed);
  let i = 0;
  const next32 = () => createHash("sha256").update(`ctxreach-study|${seed}|${stream}|${i++}`).digest().readUInt32BE(0);
  return {
    next32,
    /** Uniform integer in [0, m), by rejection so no value is favoured. */
    below(m) {
      if (!Number.isInteger(m) || m < 1 || m > 2 ** 32) throw new RangeError(`below: bad bound ${m}`);
      const limit = Math.floor(2 ** 32 / m) * m;
      for (;;) {
        const x = next32();
        if (x < limit) return x % m;
      }
    },
  };
}

/** Fisher-Yates shuffle of a copy of `items` (j drawn from [0, i] for i = n-1 down to 1). */
export function shuffle(items, seed, stream) {
  const out = items.slice();
  const r = rng(seed, stream);
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.below(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The first `n` items of the seeded shuffle (all of them when there are fewer). */
export function draw(items, n, seed, stream) {
  return shuffle(items, seed, stream).slice(0, n);
}
