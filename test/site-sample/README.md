# SAMPLE data: made up, never results

Everything under `data/` is invented, to test the results page
(`site/index.html`), the write-up generator (`scripts/writeup.mjs`) and the
private preview. None of it was measured. Each file says so itself:

- `data/results.json`: label `sample`. The study's own `analyze()` run on
  census rows invented by `make-sample.mjs` (repositories named
  `sample-owner-N/sample-repo-...`, versions `0.0.0-sample`, frame sizes that
  are not the registered ones).
- `data/cells-results.json`: `dryRun: true`. The study's own harness,
  `run-cells.mjs --dry-run`, against its fake instrument.
- `data/conformance/latest/*.json`: every record's version is `0.0.0-sample`.
- `data/provenance.json`: label `sample`; an invented pre-registration
  (`prereg-sample`, an `example.invalid` issue address) and invented check
  outputs, assembled by `scripts/site-data.mjs`.

The page shows a SAMPLE banner whenever any of these markers is present, and
`test/site.test.ts` fails if `site/data/` ever holds sample data.

Regenerate (needs the study's code, `study/`):

```sh
node test/site-sample/make-sample.mjs
npx prettier --write test/site-sample
```

When `study/census/analyze.mjs` is present, a test regenerates the sample
and fails if the study's analysis no longer gives the same `results.json`
(a schema change upstream).
