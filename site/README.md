# The results site

`site/` is the study's results page, deployed to GitHub Pages by
`.github/workflows/pages.yml`. It is one file, `index.html`, with its CSS and
script inline; it loads nothing from another site, and it fetches nothing but
its own `data/` files.

## No number is typed into the page

Every number the page shows is printed from a field of a data file, inside an
element that names the file, the JSON pointer and the format
(`<span class="n" data-src="results.json#/outcomes/0" data-fmt="wilson">`).
`test/site.test.ts` renders the page from a sample, re-reads every named
field, re-formats it with formatters of its own, and fails on any mismatch,
on any digit outside such an element (identifiers like `K1`, `H1b` or
`openai/codex#41499` are allowed), and on a typed number in the page shell.
`scripts/plant-site-faults.mjs` breaks the page, the write-up and the launch
material one way at a time and checks that a test catches each break.

The page's logic lives in `<script id="ctxr-core">` as pure functions of the
data. `scripts/writeup.mjs` runs that same script in `node:vm` to fill the
write-up and the other templates (`site/writeup.template.md`,
`talk/slides.md`, `site/readme-first-screen.md`), so the page and the
write-up cannot print different numbers.

## The data files

| File in `site/data/` | Made by | Schema |
|---|---|---|
| `results.json` | `node study/census/analyze.mjs ... --out site/data/results.json` | `ctxreach.study-results/v1` |
| `cells-results.json` | `study/behavioural/run-cells.mjs --live` (its `cells-results.json`) | `ctxreach.study-cell-results/v1` |
| `provenance.json` | `node scripts/site-data.mjs --label study ...` (pre-registration tag and issue, run manifests, checks K1, K2, K5, K6, the cells' trials, recordings, the demo cast) | `ctxreach.site-provenance/v1` |
| `conformance/latest/results-<agent>-<column>-<OS>.json` | the nightly `conformance.yml`, copied in by `pages.yml` (or `index.json` listing other names) | `ctxreach.conformance/v1` |

Every file is optional. With none, the page shows the registered headline
with letters for numbers, and says the study has not run. A sample, pilot,
dry-run or unlabelled file puts a banner at the top of the page; it goes away
only when every loaded file says it is study data.

`site/data/` must never hold the sample: the sample lives in
`test/site-sample/data/` (made by `test/site-sample/make-sample.mjs`), and a
test fails if `site/data/` holds sample, dry-run or fake data.

## Filling it (the integrator, after the study has run)

```sh
cp <results.json> site/data/results.json
cp <cells out>/cells-results.json site/data/cells-results.json
gh api repos/Shivansh2904/ctxreach/issues/<n> > prereg-issue.json
node scripts/site-data.mjs --label study --out site/data/provenance.json \
  --prereg-tag prereg-v1 --issue prereg-issue.json --freeze-tag study-v1 \
  --run rows-S-main.jsonl.run-<time>.json --run rows-S-imp.jsonl.run-<time>.json \
  --k1 k1.json --k2 k2.txt --k5 k5.json --k6 <k6>/k6-results.json \
  --trials <cells out>/trials.jsonl --recordings site/runs --cast docs/demo.cast.json
node scripts/writeup.mjs --format html --out site/writeup.html
npx vitest run test/site.test.ts
```

`site/runs/<cell>-<arm>/` holds each lab cell's recording (for example
`site/runs/B2-A1/`), so every matrix cell links to it and to its replay
command.

## Looking at it locally

Browsers do not let a page opened from disk fetch its data files, so serve
the folder with any static file server and open it over `http://`. To look
at the sample, copy `test/site-sample/data` to a scratch folder beside a copy
of `index.html`; never into `site/data/`.
