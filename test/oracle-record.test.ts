/**
 * Re-records `test/recorded/verify/` against the real tools, through the
 * same `runVerify` the tests and the command use. Skipped unless
 * CTXREACH_RECORD is set, so the suite never runs an agent.
 *
 *   CTXREACH_RECORD=codex CTXREACH_CODEX_BIN=<bin/codex.js> [CTXREACH_CODEX_VERSION=<checked once>]
 *     records <fixture>-<launch> for every codex fixture, from the root
 *     and from packages/api, plus codex-planted-over-cap-root (map given
 *     --codex-max-bytes 30000: the planted-fault pass, which must disagree).
 *   CTXREACH_RECORD=claude CTXREACH_CLAUDE_BIN=<claude.exe> CTXREACH_MODEL=<pin>
 *     CTXREACH_FIXTURES=<fixture>:<launch>,...
 *     records <fixture>-<launch> for each named fixture.
 *
 * Isolation is the command's: Codex is seeded from the fixture's own home
 * (never `~/.codex`) with a throwaway CODEX_HOME inside the sandbox; Claude
 * Code gets a fresh, empty CLAUDE_CONFIG_DIR inside the sandbox, a dummy key
 * and the loopback recorder as its endpoint (never `~/.claude`, never the
 * network). Every recording is redacted before it is written.
 */
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agrees, runVerify, scoreVerify } from "../src/oracle/verify.js";
import { renderVerify } from "../src/report/verify.js";
import { materialise } from "./helpers/fixture.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = path.join(HERE, "recorded", "verify");
const RECORD = process.env.CTXREACH_RECORD;
const slug = (launch: string) => (launch === "." ? "root" : launch.replace(/\//g, "-"));

describe.skipIf(!RECORD)("recording the fixtures against the real tools", () => {
  it.skipIf(RECORD !== "codex")(
    "codex: every codex fixture from both launch directories, and the planted pass",
    async () => {
      const bin = process.env.CTXREACH_CODEX_BIN;
      if (!bin) throw new Error("CTXREACH_CODEX_BIN is not set");
      const version = process.env.CTXREACH_CODEX_VERSION;
      const names = [
        "codex-empty-override",
        "codex-nested-below-cwd",
        "codex-over-cap",
        "codex-override-wins",
        "codex-project-config",
        "codex-root-starves-nested",
        "codex-utf8-cut",
      ].flatMap((n) => [n, `${n}-twin`]);
      const lines: string[] = [];
      const record = async (name: string, from: string, dir: string, mapMaxBytes?: number) => {
        const fx = materialise(name);
        if (!existsSync(fx.at(from))) return;
        const save = path.join(RECORDED, dir);
        rmSync(save, { recursive: true, force: true });
        const recording = await runVerify({
          agent: "codex",
          repoRoot: fx.repo,
          launchDir: fx.at(from),
          trials: 2,
          timeoutMs: 120_000,
          saveDir: save,
          ctxreachVersion: "0.0.0",
          codex: {
            bin,
            userHome: fx.codexHome,
            ...(version ? { version } : {}),
            ...(mapMaxBytes !== undefined ? { mapMaxBytes } : {}),
          },
          progress: (l) => process.stderr.write(`  ${l}\n`),
        });
        const result = scoreVerify(recording);
        const bytes = result.segments.filter((s) => s.verdict === "EXACT").length;
        lines.push(
          `${dir}: ${agrees(result) ? "AGREE" : "DISAGREE"}${result.score.instrument.fault ? " FAULT" : ""} cells ${result.score.agreement.agree}/${result.score.agreement.decided} bytes ${bytes}/${result.segments.length} hooks ${recording.manifest.codex?.hooksFlag}`,
        );
        if (result.score.instrument.fault) lines.push(renderVerify(result, { color: false }));
      };
      for (const name of names)
        for (const from of [".", "packages/api"]) await record(name, from, `${name}-${slug(from)}`);
      await record("codex-over-cap", ".", "codex-planted-over-cap-root", 30000);
      process.stdout.write(lines.join("\n") + "\n");
      expect(lines.length).toBe(23);
    },
    1_800_000,
  );

  it.skipIf(RECORD !== "codex-unplanted")(
    "codex, no tokens planted: the two fixtures whose meaning planting changes",
    async () => {
      const bin = process.env.CTXREACH_CODEX_BIN;
      if (!bin) throw new Error("CTXREACH_CODEX_BIN is not set");
      const version = process.env.CTXREACH_CODEX_VERSION;
      const lines: string[] = [];
      for (const [name, from] of [
        ["codex-empty-override", "packages/api"],
        ["codex-utf8-cut", "."],
      ] as const) {
        const fx = materialise(name);
        const dir = `${name}-${slug(from)}-unplanted`;
        const save = path.join(RECORDED, dir);
        rmSync(save, { recursive: true, force: true });
        const recording = await runVerify({
          agent: "codex",
          repoRoot: fx.repo,
          launchDir: fx.at(from),
          trials: 1,
          timeoutMs: 120_000,
          saveDir: save,
          ctxreachVersion: "0.0.0",
          plant: false,
          codex: { bin, userHome: fx.codexHome, ...(version ? { version } : {}) },
          progress: (l) => process.stderr.write(`  ${l}\n`),
        });
        const result = scoreVerify(recording);
        lines.push(
          `${dir}: ${agrees(result) ? "AGREE" : "DISAGREE"}${result.score.instrument.fault ? " FAULT" : ""} ${result.segments.map((s) => `${s.file}=${s.observedBytes}/${s.predictedBytes} ${s.verdict}`).join("; ")}`,
        );
        lines.push(renderVerify(result, { color: false }));
      }
      process.stdout.write(lines.join("\n") + "\n");
      expect(lines.length).toBe(4);
    },
    600_000,
  );

  it.skipIf(RECORD !== "claude")(
    "claude: the named fixtures",
    async () => {
      const bin = process.env.CTXREACH_CLAUDE_BIN;
      const model = process.env.CTXREACH_MODEL;
      const list = process.env.CTXREACH_FIXTURES;
      if (!bin || !model || !list)
        throw new Error("CTXREACH_CLAUDE_BIN, CTXREACH_MODEL and CTXREACH_FIXTURES must be set");
      const lines: string[] = [];
      for (const item of list.split(",")) {
        const [name, from = "."] = item.split(":") as [string, string?];
        const fx = materialise(name);
        const dir = `${name}-${slug(from)}`;
        const save = path.join(RECORDED, dir);
        rmSync(save, { recursive: true, force: true });
        const recording = await runVerify({
          agent: "claude",
          repoRoot: fx.repo,
          launchDir: fx.at(from),
          trials: 1,
          timeoutMs: 180_000,
          saveDir: save,
          ctxreachVersion: "0.0.0",
          claude: { bin, model },
          progress: (l) => process.stderr.write(`  ${l}\n`),
        });
        const result = scoreVerify(recording);
        lines.push(
          `${dir}: ${agrees(result) ? "AGREE" : "DISAGREE"}${result.score.instrument.fault ? " FAULT" : ""} cells ${result.score.agreement.agree}/${result.score.agreement.decided} trials ${result.score.trials.map((t) => t.status).join(",")}`,
        );
        lines.push(renderVerify(result, { color: false }));
      }
      process.stdout.write(lines.join("\n") + "\n");
      expect(lines.length).toBeGreaterThan(0);
    },
    1_800_000,
  );
});
