// Proportions with Wilson score intervals, and the pre-registered decision
// rules that turn an interval into a verdict (study/PREREG.md, "Outcomes").

export const Z95 = 1.959963984540054;

/** Wilson score interval for k successes in n trials. Returns undefined bounds when n is 0. */
export function wilson(k, n, z = Z95) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n)
    throw new RangeError(`wilson: need whole numbers 0 <= k <= n, got ${k}/${n}`);
  if (n === 0) return { k, n, p: undefined, lo: undefined, hi: undefined };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Clamp the rounding noise at the ends (0/n and n/n).
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** "k/n (x%, [lo, hi])" with one decimal, the form every figure is printed in. */
export function formatFraction(w) {
  if (w.n === 0) return `${w.k}/${w.n} (no eligible units)`;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  return `${w.k}/${w.n} (${pct(w.p)}, [${pct(w.lo)}, ${pct(w.hi)}])`;
}

/**
 * Bound rule (O1-content with H1, O2 with H2): confirmed when the lower
 * bound is at least `bound`, refuted when the upper bound is below it,
 * inconclusive otherwise.
 */
export function decideBound(w, bound) {
  if (w.n === 0) return "no-data";
  if (w.lo >= bound) return "confirmed";
  if (w.hi < bound) return "refuted";
  return "inconclusive";
}

/**
 * Range rule (O1-file with H1b, P1 with H3): a hit when the whole interval
 * lies inside [lo, hi], a miss when it lies wholly outside, and "overlaps"
 * when it straddles an end.
 */
export function decideRange(w, lo, hi) {
  if (w.n === 0) return "no-data";
  if (w.lo >= lo && w.hi <= hi) return "hit";
  if (w.hi < lo || w.lo > hi) return "miss";
  return "overlaps";
}
