// The tool freeze's fingerprint: SHA-256 of every file in dist/, and one
// SHA-256 over that listing. study/PREREG.md records it for the study-v1
// tag, and run-census.mjs refuses to measure with any other build when given
// --expect-dist.
//
// Usage: node study/census/dist-digest.mjs [distDir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./lib/paths.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function distDigest(dist = path.join(ROOT, "dist")) {
  const files = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, r);
      else files.push({ path: r, sha256: sha256(readFileSync(full)) });
    }
  };
  walk(dist, "");
  if (!files.length) throw new Error(`${dist} is empty; run npm run build first`);
  const listing = files.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n";
  return { digest: sha256(Buffer.from(listing, "utf8")), files, listing };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const d = distDigest(process.argv[2] ? path.resolve(process.argv[2]) : undefined);
  process.stdout.write(d.listing);
  console.log(`dist digest: ${d.digest}`);
}
