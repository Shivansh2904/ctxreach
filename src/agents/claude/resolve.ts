import { readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSurfaces, markdownFilesUnder, type SurfaceKind } from "../../discover/surfaces.js";
import { ancestors, displayPath, isFileNamed, isInside, samePath } from "../../util/fs.js";
import type { Delivery, Finding } from "../types.js";
import { importTokens, resolveImport } from "./imports.js";
import {
  CLAUDE_DEFAULT_MODE,
  compareVersions,
  defaultClaudeHome,
  modeInSettings,
  type ClaudeMode,
} from "./settings.js";

/** Claude Code skips an instruction file over 4 MiB (rule `claude.size`). */
export const CLAUDE_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Imports nest at most this many hops (rule `claude.imports`). */
export const CLAUDE_MAX_IMPORT_DEPTH = 4;
const AGENTS_MD_MIN_VERSION = "2.1.277";
const AGENTS_MD_ALL_SESSIONS_VERSION = "2.1.281";

export type ClaudeFileKind = SurfaceKind | "user" | "user-rule" | "import";

export interface ClaudeFile {
  path: string;
  kind: ClaudeFileKind;
  delivery: Delivery;
  why: string;
  rule: string;
  bytes: number;
  /** For imports: the file that imports this one, and how many hops from a memory file. */
  importedBy?: string;
  depth?: number;
  /** An import from outside the launch directory, which Claude Code loads only after a one-time approval. */
  needsApproval?: boolean;
}

export interface ClaudeResult {
  agent: "claude";
  launchDir: string;
  mode: ClaudeMode;
  modeFrom: string;
  version?: string;
  /** Whether Claude reads AGENTS.md at all in this session, and why not if it does not. */
  agentsMd: { read: boolean; reason: string };
  /** CLAUDE.md-family files at or above the launch directory that switch AGENTS.md off in the default mode. */
  shadowers: string[];
  files: ClaudeFile[];
  /** `@` tokens that name no existing file (Claude Code ignores them). */
  unresolvedImports: { in: string; token: string }[];
  findings: Finding[];
}

export interface ClaudeResolveOptions {
  launchDir: string;
  /** Directory scanned for files below and beside the launch directory. Defaults to the launch directory. */
  scanRoot?: string;
  /** Defaults to ~/.claude. */
  claudeHome?: string;
  /** The user's home directory, for `~/` imports. Defaults to the parent of claudeHome when that is given, else os.homedir(). */
  homeDir?: string;
  /** Use this Project instructions value instead of reading it from settings. */
  mode?: ClaudeMode;
  /** Claude Code version to model, for the version gates in rule `claude.version`. */
  version?: string;
  /** Stop the upward walk here. Claude Code itself walks to the filesystem root; tests use this to stay inside a temp dir. */
  ceiling?: string;
}

const CLAUDE_NAMES = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"] as const;
const AGENTS_NAMES = ["AGENTS.md", ".claude/AGENTS.md"] as const;
const WORDS = /AGENTS\.md/;

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function size(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

function hasPathsFrontmatter(text: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return m?.[1] !== undefined && /^paths\s*:/m.test(m[1]);
}

/**
 * Predict what Claude Code loads when launched in `launchDir`, following the
 * rules recorded in docs/rules.md (section "Claude Code").
 */
export function resolveClaude(options: ClaudeResolveOptions): ClaudeResult {
  const launchDir = path.resolve(options.launchDir);
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const homeDir = options.homeDir ?? (options.claudeHome ? path.dirname(options.claudeHome) : os.homedir());
  const scanRoot = options.scanRoot ?? launchDir;
  const findings: Finding[] = [];
  const files: ClaudeFile[] = [];
  const unresolvedImports: { in: string; token: string }[] = [];
  const delivered = new Map<string, ClaudeFile>();
  const rel = (p: string) => displayPath(p, scanRoot);

  // Rule claude.modes: user settings count, project and local settings do not.
  let mode: ClaudeMode = CLAUDE_DEFAULT_MODE;
  let modeFrom = "default";
  const userSettings = path.join(claudeHome, "settings.json");
  const fromUser = modeInSettings(userSettings);
  if (fromUser) {
    mode = fromUser;
    modeFrom = userSettings;
  }
  if (options.mode) {
    mode = options.mode;
    modeFrom = "override";
  }
  const projectSettingsDirs = [
    launchDir,
    ...(isInside(launchDir, scanRoot) && !samePath(launchDir, scanRoot) ? [scanRoot] : []),
  ];
  for (const dir of projectSettingsDirs) {
    for (const name of ["settings.json", "settings.local.json"]) {
      const file = path.join(dir, ".claude", name);
      const set = modeInSettings(file);
      if (set) {
        findings.push({
          code: "claude.mode-in-project-settings",
          severity: "warn",
          agent: "claude",
          rule: "claude.modes",
          path: file,
          message: `${rel(file)} sets Project instructions to "${set}", but Claude Code ignores that setting in project and local settings files. It is in effect only from ~/.claude/settings.json, a --settings file or managed settings (using "${mode}").`,
        });
      }
    }
  }

  // Rule claude.version.
  let agentsSupported = mode !== "claude-md" && mode !== "managed-only";
  let agentsOffReason =
    mode === "claude-md" ? `Project instructions is "claude-md"` : `Project instructions is "managed-only"`;
  if (options.version !== undefined) {
    if (compareVersions(options.version, AGENTS_MD_MIN_VERSION) < 0) {
      agentsSupported = false;
      agentsOffReason = `Claude Code ${options.version} predates AGENTS.md support (${AGENTS_MD_MIN_VERSION})`;
      findings.push({
        code: "claude.version-no-agents",
        severity: "warn",
        agent: "claude",
        rule: "claude.version",
        message: `Claude Code ${options.version} reads CLAUDE.md only; reading AGENTS.md needs ${AGENTS_MD_MIN_VERSION} or later.`,
      });
    } else if (compareVersions(options.version, AGENTS_MD_ALL_SESSIONS_VERSION) < 0) {
      findings.push({
        code: "claude.version-some-sessions",
        severity: "info",
        agent: "claude",
        rule: "claude.version",
        message: `On Claude Code ${options.version}, sessions on Amazon Bedrock or with telemetry disabled read CLAUDE.md only. ${AGENTS_MD_ALL_SESSIONS_VERSION} fixed this.`,
      });
    }
  }

  const add = (file: ClaudeFile): ClaudeFile => {
    if (file.bytes > CLAUDE_MAX_FILE_BYTES && file.delivery !== "not-loaded") {
      file.delivery = "not-loaded";
      file.why = "over 4 MiB, skipped";
      file.rule = "claude.size";
      findings.push({
        code: "claude.too-large",
        severity: "warn",
        agent: "claude",
        rule: "claude.size",
        path: file.path,
        message: `${rel(file.path)} is ${file.bytes} bytes; Claude Code skips files over 4 MiB.`,
      });
    }
    files.push(file);
    if (file.delivery !== "not-loaded") delivered.set(real(file.path), file);
    return file;
  };

  // Rule claude.imports: expand @imports depth-first after the importing file.
  const expandImports = (
    file: string,
    scope: "user" | "project" | "agents",
    depth: number,
    delivery: Delivery,
  ): void => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const token of importTokens(text)) {
      const target = resolveImport(token, file, homeDir);
      if (!target) {
        unresolvedImports.push({ in: file, token });
        continue;
      }
      if (delivered.has(real(target))) continue;
      const hops = depth + 1;
      if (hops > CLAUDE_MAX_IMPORT_DEPTH) {
        add({
          path: target,
          kind: "import",
          delivery: "not-loaded",
          why: `import ${hops} hops deep (limit ${CLAUDE_MAX_IMPORT_DEPTH})`,
          rule: "claude.imports",
          bytes: size(target),
          importedBy: file,
          depth: hops,
        });
        findings.push({
          code: "claude.import-too-deep",
          severity: "warn",
          agent: "claude",
          rule: "claude.imports",
          path: target,
          message: `${rel(file)} imports ${rel(target)}, but that is ${hops} hops from a memory file and Claude Code follows imports only ${CLAUDE_MAX_IMPORT_DEPTH} deep.`,
        });
        continue;
      }
      const external = scope !== "user" && !isInside(target, launchDir);
      add({
        path: target,
        kind: "import",
        delivery: delivery === "on-read" ? "on-read" : "import",
        why: `imported by ${rel(file)}${external ? (scope === "agents" ? " (external: loads only if already approved)" : " (external: needs approval)") : ""}`,
        rule: "claude.imports",
        bytes: size(target),
        importedBy: file,
        depth: hops,
        ...(external ? { needsApproval: true } : {}),
      });
      if (external) {
        findings.push({
          code: "claude.external-import",
          severity: "info",
          agent: "claude",
          rule: "claude.imports",
          path: target,
          message:
            scope === "agents"
              ? `${rel(file)} imports ${rel(target)}, which is outside the launch directory. For an AGENTS.md, Claude Code loads it only if external imports were already approved for this project.`
              : `${rel(file)} imports ${rel(target)}, which is outside the launch directory. Claude Code asks once to approve external imports; if that is declined, it never loads.`,
        });
      }
      expandImports(target, scope, hops, delivery);
    }
  };

  // Directories from the top of the walk down to the launch directory.
  const upward = ancestors(launchDir, options.ceiling).reverse();
  const isHome = (dir: string) => samePath(dir, homeDir);
  const claudeFilesIn = (dir: string): string[] =>
    CLAUDE_NAMES.filter((n) => !(n === ".claude/CLAUDE.md" && isHome(dir)) && isFileNamed(dir, n)).map((n) =>
      path.join(dir, ...n.split("/")),
    );

  // Rule claude.agents-default: which files switch AGENTS.md off.
  const shadowers = upward.flatMap(claudeFilesIn);
  let agentsAtLaunch = false;
  let agentsReason = "";
  if (!agentsSupported) {
    agentsReason = agentsOffReason;
  } else if (mode === "claude-md-and-agents-md") {
    agentsAtLaunch = true;
  } else if (shadowers.length === 0) {
    agentsAtLaunch = true;
  } else {
    agentsReason = `switched off by ${shadowers.map(rel).join(", ")}`;
  }

  // User scope (rules claude.user, claude.rules).
  if (mode !== "managed-only") {
    const userFile = path.join(claudeHome, "CLAUDE.md");
    if (isFileNamed(claudeHome, "CLAUDE.md")) {
      add({
        path: userFile,
        kind: "user",
        delivery: "launch",
        why: "user file",
        rule: "claude.user",
        bytes: size(userFile),
      });
      expandImports(userFile, "user", 0, "launch");
    }
    for (const rule of markdownFilesUnder(path.join(claudeHome, "rules"))) {
      const paths = hasPathsFrontmatter(readFileSync(rule, "utf8"));
      add({
        path: rule,
        kind: "user-rule",
        delivery: paths ? "on-read" : "launch",
        why: paths ? "user rule with paths: on read of a matching file" : "user rule",
        rule: "claude.rules",
        bytes: size(rule),
      });
    }
  }

  // Launch directory and ancestors, root first (rules claude.ancestors, claude.agents-default).
  for (const dir of upward) {
    for (const file of claudeFilesIn(dir)) {
      const kind = (
        path.basename(path.dirname(file)) === ".claude" ? ".claude/CLAUDE.md" : path.basename(file)
      ) as SurfaceKind;
      if (mode === "managed-only") {
        add({
          path: file,
          kind,
          delivery: "not-loaded",
          why: `Project instructions is "managed-only"`,
          rule: "claude.modes",
          bytes: size(file),
        });
        continue;
      }
      if (delivered.has(real(file))) continue;
      add({
        path: file,
        kind,
        delivery: "launch",
        why: samePath(dir, launchDir) ? "launch dir" : "ancestor of launch dir",
        rule: "claude.ancestors",
        bytes: size(file),
      });
      expandImports(file, "project", 0, "launch");
    }
    for (const name of AGENTS_NAMES) {
      if (!isFileNamed(dir, name)) continue;
      const file = path.join(dir, ...name.split("/"));
      const kind = name as SurfaceKind;
      const already = delivered.get(real(file));
      if (already) {
        if (!samePath(already.path, file)) {
          add({
            path: file,
            kind,
            delivery: already.delivery,
            why: already.kind === "import" ? `${already.why}` : `same file as ${rel(already.path)} (symlink)`,
            rule: already.kind === "import" ? "claude.imports" : "claude.symlink",
            bytes: size(file),
          });
        }
        continue;
      }
      if (agentsAtLaunch) {
        add({
          path: file,
          kind,
          delivery: "launch",
          why: "AGENTS.md read at launch",
          rule: "claude.agents-default",
          bytes: size(file),
        });
        expandImports(file, "agents", 0, "launch");
      } else {
        add({
          path: file,
          kind,
          delivery: "not-loaded",
          why: agentsReason,
          rule: agentsSupported ? "claude.agents-default" : "claude.modes",
          bytes: size(file),
        });
      }
    }
  }

  // Everything else in the scanned tree.
  const seen = new Set(files.map((f) => real(f.path)));
  const surfaces = discoverSurfaces(scanRoot).filter((s) => !seen.has(real(s.path)));
  for (const s of surfaces) {
    const below = isInside(s.dir, launchDir) && !samePath(s.dir, launchDir);
    const atOrAbove = isInside(launchDir, s.dir);
    if (s.kind === "AGENTS.override.md" || s.kind === "AGENTS.local.md" || s.kind === "fallback") {
      add({
        path: s.path,
        kind: s.kind,
        delivery: "not-loaded",
        why: "not a file Claude Code reads",
        rule: "claude.agents-never",
        bytes: s.bytes,
      });
      continue;
    }
    if (!below) {
      if (s.kind === ".claude/rules" && samePath(s.dir, launchDir)) {
        const paths = hasPathsFrontmatter(readFileSync(s.path, "utf8"));
        if (mode === "managed-only" && !paths) {
          add({
            path: s.path,
            kind: s.kind,
            delivery: "not-loaded",
            why: `Project instructions is "managed-only"`,
            rule: "claude.modes",
            bytes: s.bytes,
          });
        } else {
          add({
            path: s.path,
            kind: s.kind,
            delivery: paths ? "on-read" : "launch",
            why: paths ? "rule with paths: on read of a matching file" : "project rule",
            rule: "claude.rules",
            bytes: s.bytes,
          });
        }
      } else if (s.kind === ".claude/rules" && atOrAbove) {
        add({
          path: s.path,
          kind: s.kind,
          delivery: "not-loaded",
          why: "ancestor's rule: not modelled",
          rule: "claude.rules",
          bytes: s.bytes,
        });
      } else {
        add({
          path: s.path,
          kind: s.kind,
          delivery: "not-loaded",
          why: "outside the launch dir's tree",
          rule: "claude.subdirs",
          bytes: s.bytes,
        });
      }
      continue;
    }
    // Below the launch directory (rules claude.subdirs, claude.agents-default, claude.rules).
    const where = rel(s.dir);
    if (s.kind === "CLAUDE.md" || s.kind === ".claude/CLAUDE.md" || s.kind === "CLAUDE.local.md") {
      add({
        path: s.path,
        kind: s.kind,
        delivery: "on-read",
        why: `on read of a file in ${where}/`,
        rule: "claude.subdirs",
        bytes: s.bytes,
      });
      expandImports(s.path, "project", 0, "on-read");
    } else if (s.kind === "AGENTS.md" || s.kind === ".claude/AGENTS.md") {
      const ownClaude = claudeFilesIn(s.dir);
      if (agentsSupported && (mode === "claude-md-and-agents-md" || (agentsAtLaunch && ownClaude.length === 0))) {
        add({
          path: s.path,
          kind: s.kind,
          delivery: "on-read",
          why: `on read of a file in ${where}/`,
          rule: "claude.agents-default",
          bytes: s.bytes,
        });
        expandImports(s.path, "agents", 0, "on-read");
      } else {
        const why = !agentsSupported
          ? agentsOffReason
          : !agentsAtLaunch
            ? agentsReason
            : `${where}/ has its own ${ownClaude.map((f) => path.basename(f)).join(", ")}`;
        add({ path: s.path, kind: s.kind, delivery: "not-loaded", why, rule: "claude.agents-default", bytes: s.bytes });
      }
    } else if (s.kind === ".claude/rules") {
      add({
        path: s.path,
        kind: s.kind,
        delivery: "on-read",
        why: `on read in ${where}/`,
        rule: "claude.rules",
        bytes: s.bytes,
      });
    }
  }

  // Findings about AGENTS.md that does not arrive.
  const lostAgents = files.filter(
    (f) =>
      // Only files the AGENTS.md rule itself keeps out: not files that are
      // too large, or that sit outside the launch directory's tree.
      (f.kind === "AGENTS.md" || f.kind === ".claude/AGENTS.md") &&
      f.delivery === "not-loaded" &&
      f.rule === "claude.agents-default",
  );
  const localShadowers = shadowers.filter((s) => path.basename(s) === "CLAUDE.local.md");
  for (const f of lostAgents) {
    if (!agentsSupported) continue;
    const onlyLocal = localShadowers.length > 0 && localShadowers.length === shadowers.length;
    findings.push({
      code: "claude.agents-shadowed",
      severity: "warn",
      agent: "claude",
      rule: "claude.agents-default",
      path: f.path,
      message: onlyLocal
        ? `${rel(f.path)} does not reach Claude Code: the personal ${localShadowers.map(rel).join(", ")} switches AGENTS.md off. Import it with @AGENTS.md, or set Project instructions to claude-md-and-agents-md.`
        : `${rel(f.path)} does not reach Claude Code: ${f.why}. Import it with @AGENTS.md in a CLAUDE.md, or set Project instructions to claude-md-and-agents-md.`,
    });
  }

  // Rule claude.words: a CLAUDE.md that names AGENTS.md without importing it.
  if (lostAgents.length > 0 && agentsSupported) {
    for (const f of files) {
      if (!(f.kind === "CLAUDE.md" || f.kind === ".claude/CLAUDE.md" || f.kind === "CLAUDE.local.md")) continue;
      if (f.delivery === "not-loaded") continue;
      const text = readFileSync(f.path, "utf8");
      if (!WORDS.test(text)) continue;
      const inCode = /@AGENTS\.md/.test(text);
      findings.push({
        code: "claude.words-not-import",
        severity: "warn",
        agent: "claude",
        rule: "claude.words",
        path: f.path,
        message: `${rel(f.path)} mentions AGENTS.md but does not import it${inCode ? " (an @AGENTS.md inside a code block or code span is not an import)" : ""}, so Claude sees AGENTS.md only if it decides to open the file. Use a bare @AGENTS.md line instead.`,
      });
    }
  }

  for (const f of files) {
    if (f.delivery !== "on-read" || f.kind === "import" || f.kind === "user-rule") continue;
    if (f.kind === ".claude/rules") continue;
    findings.push({
      code: "claude.nested",
      severity: "info",
      agent: "claude",
      rule: f.rule,
      path: f.path,
      message: `${rel(f.path)} is not loaded at launch; Claude Code loads it when it reads a file in ${rel(path.dirname(f.path).replace(/[\\/]\.claude$/, ""))}/.`,
    });
  }

  return {
    agent: "claude",
    launchDir,
    mode,
    modeFrom,
    ...(options.version !== undefined ? { version: options.version } : {}),
    agentsMd: { read: agentsAtLaunch, reason: agentsAtLaunch ? "" : agentsReason },
    shadowers,
    files,
    unresolvedImports,
    findings,
  };
}
