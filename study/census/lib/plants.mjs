// Planted faults for check K2 (study/census/plant-census-faults.mjs). Each
// plant switches off one detector or one pipeline step. The census code asks
// `planted(plants, id)` at the point the plant acts; the answer is false
// unless a K2 run turned that plant on, and every time it acts the hit is
// counted, so a plant that never acted is reported as not exercised instead
// of being mistaken for a catch.

export const PLANTS = [
  // Outcome detectors (study/census/detectors.mjs): each returns its no-event value.
  "detector:o1content",
  "detector:o1content-shingle",
  "detector:o1file",
  "detector:o2",
  "detector:p1",
  "detector:o4",
  "detector:o5",
  "detector:o6",
  "detector:o7",
  "detector:o8",
  "detector:k3",
  // Pipeline steps (study/census/recon.mjs, measure.mjs).
  "recon:import-targets",
  "recon:links",
  "launch:type2",
  "launch:type3",
  "measure:link-correction",
];

export function noPlants() {
  return { active: new Set(), hits: new Map() };
}

export function withPlant(id) {
  if (!PLANTS.includes(id)) throw new Error(`unknown plant ${id}`);
  return { active: new Set([id]), hits: new Map() };
}

/** True when plant `id` is on; counts the hit. */
export function planted(plants, id) {
  if (!plants || !plants.active.has(id)) return false;
  plants.hits.set(id, (plants.hits.get(id) ?? 0) + 1);
  return true;
}
