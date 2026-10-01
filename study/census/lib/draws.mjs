// Which census rows decide the figures (study/PREREG.md, section 4, "Redraw").
//
// A sample is drawn once (draw 1, seed offset 0) and, when it loses more than
// 10% of the n units drawn, redrawn once (draw 2, seed offset 1). The redraw
// replaces the first draw for every figure and verdict; the first draw's rows
// are reported under their own frame name (`S-main-draw1`) and never pooled.
// Every row carries its frame, draw, sample, the sample's n, build, Codex
// version and platform (run-census.mjs stamps them), so rows that would pool
// two draws, two samples, two builds, two agent versions or two platforms are
// refused here rather than averaged, and so is a study draw with fewer rows
// than its n: whether to redraw is decided on the whole draw, never on the
// part of it an interrupted run has written.

/** A sample that loses more than this share of its draws (exclusions and rows with faults) is redrawn once. */
export const REDRAW_OVER = 0.1;

/** Stamped by run-census.mjs on every row: one value per frame and draw. */
const RUN_KEYS = ["label", "sampleSha256", "sampleN", "dist", "codexVersion", "platform"];
/** Recorded by the measurement on every measured row: one value per frame and draw. */
const MEASURE_KEYS = ["claudeVersion", "mapVersion"];

/** The share of the n units drawn whose rows were excluded or measured with a fault (n defaults to the rows given). */
export function lostShare(rows, n = rows.length) {
  if (!n) return 0;
  const lost = rows.filter((r) => r.status === "excluded" || (r.status === "measured" && (r.faults ?? []).length));
  return lost.length / n;
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

/**
 * The size of one draw's sample and whether every unit has its row. The n is
 * the one run-census.mjs stamps on every row (`sampleN`, from the sample's
 * header). A study draw must carry it and be complete; a pilot draw without
 * it is taken to be the rows given.
 */
function drawSize(where, drows, study) {
  const stamped = drows[0]?.sampleN;
  let n;
  if (stamped === undefined || stamped === null) {
    if (study)
      throw new Error(
        `${where}: the rows carry no sample size (sampleN, stamped by run-census.mjs); a study draw's lost share is taken over the n drawn`,
      );
    n = drows.length;
  } else n = stamped;
  if (!Number.isInteger(n) || n < 1)
    throw new Error(`${where}: sample size ${JSON.stringify(n)} is not a whole number`);
  if (drows.length > n) throw new Error(`${where}: ${drows.length} rows for a sample of n = ${n}`);
  const complete = drows.length === n;
  if (study && !complete)
    throw new Error(
      `${where}: ${drows.length} of the ${n} units drawn have rows; an incomplete study draw is refused (resume run-census.mjs until every unit has its row)`,
    );
  return { n, complete };
}

/**
 * Split rows into reported frames: [{ name, frame, draw, n, complete, rows,
 * replaces?, supersededBy? }]. A frame with one draw is reported under its
 * own name. A frame with a redraw is reported twice: draw 2 under the frame's
 * name (it decides the figures) and draw 1 under `<frame>-draw1`
 * (superseded). Rows without a label of their own take `label` (analyze.mjs's
 * --label, study by default). Throws on rows that would pool what PREREG.md
 * keeps apart, on an incomplete study draw, and on a redraw that a complete
 * draw 1 does not license.
 */
export function splitDraws(rows, { label = "study" } = {}) {
  const byFrame = new Map();
  for (const r of rows) {
    const frame = String(r.frame);
    const draw = r.draw ?? 1;
    if (draw !== 1 && draw !== 2)
      throw new Error(`${frame}: draw ${draw}; a sample is drawn once (draw 1) and redrawn at most once (draw 2)`);
    if (!byFrame.has(frame)) byFrame.set(frame, new Map());
    const draws = byFrame.get(frame);
    if (!draws.has(draw)) draws.set(draw, []);
    draws.get(draw).push(r);
  }
  const out = [];
  for (const [frame, draws] of byFrame) {
    const size = new Map();
    for (const [draw, drows] of draws) {
      const where = `${frame} draw ${draw}`;
      const ids = new Set();
      for (const r of drows) {
        if (r.id === undefined) continue;
        if (ids.has(r.id))
          throw new Error(
            `${where}: unit ${r.id} appears twice (the same rows given twice, or one draw measured by two runs)`,
          );
        ids.add(r.id);
      }
      const measured = drows.filter((r) => r.status === "measured");
      for (const [keys, of] of [
        [RUN_KEYS, drows],
        [MEASURE_KEYS, measured],
      ])
        for (const key of keys) {
          const values = [...new Set(of.map((r) => JSON.stringify(r[key] ?? null)))];
          if (values.length > 1)
            throw new Error(`${where}: rows of more than one ${key} (${values.join(", ")}); they are never pooled`);
        }
      size.set(draw, drawSize(where, drows, (drows[0]?.label ?? label) === "study"));
    }
    if (draws.has(2)) {
      if (!draws.has(1))
        throw new Error(`${frame}: draw 2 (the redraw) without the draw 1 it replaces; both draws are reported`);
      const first = size.get(1);
      if (!first.complete)
        throw new Error(
          `${frame}: draw 2 given, but draw 1 has rows for ${draws.get(1).length} of its ${first.n} units: whether to redraw is decided on a complete draw`,
        );
      const lost = lostShare(draws.get(1), first.n);
      if (!(lost > REDRAW_OVER))
        throw new Error(
          `${frame}: draw 2 given, but draw 1 lost ${pct(lost)}, not over ${pct(REDRAW_OVER)}: the redraw does not apply`,
        );
      out.push({ name: frame, frame, draw: 2, ...size.get(2), rows: draws.get(2), replaces: `${frame}-draw1` });
      out.push({ name: `${frame}-draw1`, frame, draw: 1, ...first, rows: draws.get(1), supersededBy: frame });
    } else out.push({ name: frame, frame, draw: 1, ...size.get(1), rows: draws.get(1) });
  }
  const names = out.map((s) => s.name);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  if (twice.length) throw new Error(`two frames named ${twice[0]}: a frame's first draw is reported under that name`);
  return out;
}

/** The rows that decide the figures: every frame's rows, with a redrawn sample's first draw left out. */
export function rowsInUse(rows, opts) {
  return splitDraws(rows, opts)
    .filter((s) => !s.supersededBy)
    .flatMap((s) => s.rows);
}
