import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import registry from "../../../docs/evidence.json" with { type: "json" };
import { discoverSurfaces, markdownFilesUnder, type SurfaceKind } from "../../discover/surfaces.js";
import { ancestors, displayPath, existsNamed, isFileNamed, isInside, samePath } from "../../util/fs.js";
import type { Delivery, Finding } from "../types.js";
import { externalImportApproval, type ExternalImportApproval } from "./approvals.js";
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
  /** ctxreach does not model whether this file loads; it is shown as not loaded. */
  notModelled?: boolean;
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
  /** The external-import approval looked up in `.claude.json`, when an import resolved outside the launch directory. */
  approval?: ExternalImportApproval;
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
  /** The file holding external-import approvals (rule `claude.imports`). Defaults to `.claude.json` in homeDir. */
  claudeJson?: string;
  /**
   * Predict the `.claude/rules/` of directories above the launch directory,
   * which load like the launch directory's own (rule `claude.rules`). When
   * false, the default for now, they are listed as not modelled, and those
   * above the repository are not listed.
   */
  ancestorRules?: boolean;
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

// docs/evidence.json: how well each rule is supported. Only the fields a
// label needs are checked; the registry may carry more.
const EvidenceEntry = z.looseObject({
  rule: z.string(),
  status: z.enum(["documented", "source", "observed", "contradicted"]),
  version: z.string().optional(),
  k: z.number().int().nonnegative().optional(),
  n: z.number().int().positive().optional(),
});
export const EvidenceRegistry = z.looseObject({ entries: z.array(EvidenceEntry) });
export type EvidenceRegistry = z.infer<typeof EvidenceRegistry>;
const REGISTRY = EvidenceRegistry.parse(registry);

/**
 * The evidence label a finding carries for `rule`, from docs/evidence.json:
 * the status (`documented`, `source`), or for a run-backed status the
 * version too (`observed@2.1.285 10/10`). Throws when the registry has no
 * entry, so a rule never shows a label nobody wrote.
 */
export function evidenceLabel(rule: string, from: EvidenceRegistry = REGISTRY): string {
  const entry = from.entries.find((e) => e.rule === rule);
  if (!entry) throw new Error(`docs/evidence.json has no entry for ${rule}`);
  if (entry.status === "documented" || entry.status === "source") return entry.status;
  if (entry.version === undefined)
    throw new Error(`docs/evidence.json: ${rule} is ${entry.status} but names no version`);
  const count = entry.k !== undefined && entry.n !== undefined ? ` ${entry.k}/${entry.n}` : "";
  return `${entry.status}@${entry.version}${count}`;
}

/**
 * Rule `claude.symlink`: a file whose whole trimmed text is one relative path
 * to an existing file, which is what git writes for a symlink it checks out
 * as a plain file (`core.symlinks` false, the Windows default). A real link
 * is not one.
 */
export function linkAsText(file: string): { text: string; target: string } | undefined {
  try {
    if (lstatSync(file).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const text = readFileSync(file, "utf8").trim();
  if (text === "" || text.length > 4096 || /\s/.test(text)) return undefined;
  if (text.startsWith("@") || text.startsWith("~") || path.isAbsolute(text)) return undefined;
  const target = path.resolve(path.dirname(file), text);
  try {
    return statSync(target).isFile() ? { text, target } : undefined;
  } catch {
    return undefined;
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
  const modelAncestorRules = options.ancestorRules === true;
  const findings: Finding[] = [];
  const files: ClaudeFile[] = [];
  const unresolvedImports: { in: string; token: string }[] = [];
  const delivered = new Map<string, ClaudeFile>();
  /** Real paths of every row in `files`. */
  const listed = new Set<string>();
  const rel = (p: string) => displayPath(p, scanRoot);
  const inRepo = (p: string) => isInside(p, scanRoot);
  const personalFile = path.join(homeDir, ".claude", "CLAUDE.md");
  /** A path for messages: repository-relative inside it, `~/...` under home, else absolute. */
  const show = (p: string) => (!inRepo(p) && isInside(p, homeDir) ? `~/${displayPath(p, homeDir)}` : rel(p));

  // Rule claude.imports: an import from outside the launch directory loads
  // only with an approval recorded in .claude.json, read when first needed.
  const claudeJson = options.claudeJson ?? path.join(homeDir, ".claude.json");
  let approval: ExternalImportApproval | undefined;
  const approvalFor = () => (approval ??= externalImportApproval(launchDir, claudeJson, options.ceiling));
  /** Real paths of files imported by the user's own files, which are not project files. */
  const userScope = new Set<string>();
  /** External imports left out for want of an approval, by real path. */
  const blocked = new Map<string, { row: ClaudeFile; importer: string; scope: "project" | "agents" }>();

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
    listed.add(real(file.path));
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
      if (external && !approvalFor().approved) {
        // No recorded approval: left out, and so are its own imports.
        if (blocked.has(real(target))) continue;
        const row = add({
          path: target,
          kind: "import",
          delivery: "not-loaded",
          why: `imported by ${rel(file)} from outside the launch dir: no approval recorded, so left out (claude -p, SDK, CI)`,
          rule: "claude.imports",
          bytes: size(target),
          importedBy: file,
          depth: hops,
          needsApproval: true,
        });
        blocked.set(real(target), { row, importer: file, scope });
        continue;
      }
      add({
        path: target,
        kind: "import",
        delivery: delivery === "on-read" ? "on-read" : "import",
        why: `imported by ${rel(file)}${external ? " (external: approved for this project)" : ""}`,
        rule: "claude.imports",
        bytes: size(target),
        importedBy: file,
        depth: hops,
      });
      if (scope === "user") userScope.add(real(target));
      if (external) {
        findings.push({
          code: "claude.external-import",
          severity: "info",
          agent: "claude",
          rule: "claude.imports",
          path: target,
          message: `${rel(file)} imports ${rel(target)}, which is outside the launch directory. ${show(claudeJson)} records that external imports are approved for this project, so it loads here; in a fresh clone, in CI or on another machine it does not.`,
        });
      }
      expandImports(target, scope, hops, delivery);
    }
  };

  // An imported file that loads anyway by another rule (an ancestor's
  // CLAUDE.md, or an AGENTS.md the setting reads) is not left out after all.
  const unblock = (file: string): void => {
    const b = blocked.get(real(file));
    if (!b) return;
    blocked.delete(real(file));
    files.splice(files.indexOf(b.row), 1);
    listed.delete(real(file));
  };

  // Rule claude.rules: a project rule without `paths` loads at launch, one
  // with `paths` on read of a matching file; an ancestor's the same way.
  const ruleRow = (file: string, bytes: number, ancestor: boolean): ClaudeFile => {
    const paths = hasPathsFrontmatter(readFileSync(file, "utf8"));
    if (mode === "managed-only" && !paths)
      return {
        path: file,
        kind: ".claude/rules",
        delivery: "not-loaded",
        why: `Project instructions is "managed-only"`,
        rule: "claude.modes",
        bytes,
      };
    const whose = ancestor ? "ancestor's rule" : "rule";
    return {
      path: file,
      kind: ".claude/rules",
      delivery: paths ? "on-read" : "launch",
      why: paths ? `${whose} with paths: on read of a matching file` : ancestor ? whose : "project rule",
      rule: "claude.rules",
      bytes,
    };
  };

  // Directories from the top of the walk down to the launch directory.
  const upward = ancestors(launchDir, options.ceiling).reverse();
  // Rule claude.home-ancestor: every directory counts, the home directory
  // too, so ~/.claude/CLAUDE.md is also an ancestor's .claude/CLAUDE.md for a
  // launch directory under home.
  const claudeFilesIn = (dir: string): string[] =>
    CLAUDE_NAMES.filter((n) => isFileNamed(dir, n)).map((n) => path.join(dir, ...n.split("/")));

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
      const alsoAncestor = shadowers.some((s) => samePath(s, userFile));
      add({
        path: userFile,
        kind: "user",
        delivery: "launch",
        why: alsoAncestor ? "user file, and an ancestor's .claude/CLAUDE.md here" : "user file",
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
      unblock(file);
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
        unblock(file);
        add({
          path: file,
          kind,
          delivery: "launch",
          why: "AGENTS.md read at launch",
          rule: "claude.agents-default",
          bytes: size(file),
        });
        expandImports(file, "agents", 0, "launch");
      } else if (blocked.has(real(file))) {
        // Its import row already says why it does not arrive.
        continue;
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
    // Rule claude.rules: an ancestor's rules above the repository. Those in
    // it are listed with the rest of the tree below.
    if (
      modelAncestorRules &&
      !inRepo(dir) &&
      existsNamed(dir, ".claude") &&
      existsNamed(path.join(dir, ".claude"), "rules")
    ) {
      for (const file of markdownFilesUnder(path.join(dir, ".claude", "rules"))) {
        if (!listed.has(real(file))) add(ruleRow(file, size(file), true));
      }
    }
  }

  // Everything else in the scanned tree.
  // A file already listed (at launch, or imported by a file listed earlier in
  // this loop) is not listed twice. AGENTS.md files come last, so a nested
  // CLAUDE.md that imports its directory's AGENTS.md is seen first.
  const isAgentsKind = (k: SurfaceKind) => k === "AGENTS.md" || k === ".claude/AGENTS.md";
  const tree = discoverSurfaces(scanRoot);
  for (const s of [...tree.filter((t) => !isAgentsKind(t.kind)), ...tree.filter((t) => isAgentsKind(t.kind))]) {
    if (listed.has(real(s.path))) continue;
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
        add(ruleRow(s.path, s.bytes, false));
      } else if (s.kind === ".claude/rules" && atOrAbove && modelAncestorRules) {
        add(ruleRow(s.path, s.bytes, true));
      } else if (s.kind === ".claude/rules" && atOrAbove) {
        add({
          path: s.path,
          kind: s.kind,
          delivery: "not-loaded",
          why: "ancestor's rule: not modelled",
          rule: "claude.rules",
          bytes: s.bytes,
          notModelled: true,
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

  // Rule claude.modes: an AGENTS.md whose text equals an instruction file
  // already in the context is not loaded again; the mod compares by path,
  // then by content. A nested AGENTS.md is also compared with the CLAUDE.md
  // files on its path, which load with it.
  const dedupeByText = (): void => {
    const texts = new Map<string, string>();
    const textOf = (p: string): string => {
      let t = texts.get(p);
      if (t === undefined) {
        t = readFileSync(p, "utf8").trim();
        texts.set(p, t);
      }
      return t;
    };
    const isClaudeKind = (f: ClaudeFile) =>
      f.kind === "CLAUDE.md" || f.kind === ".claude/CLAUDE.md" || f.kind === "CLAUDE.local.md";
    const bySetting = (f: ClaudeFile) =>
      (f.kind === "AGENTS.md" || f.kind === ".claude/AGENTS.md") &&
      f.rule === "claude.agents-default" &&
      f.delivery !== "not-loaded";
    const projectFile = (f: ClaudeFile) => f.kind !== "user" && f.kind !== "user-rule" && !userScope.has(real(f.path));
    const dirOf = (p: string) => path.dirname(p).replace(/[\\/]\.claude$/, "");
    const handed = files.filter(
      (f) => (f.delivery === "launch" || f.delivery === "import") && projectFile(f) && !bySetting(f),
    );
    const twinOf = (f: ClaudeFile, among: ClaudeFile[]) => {
      const text = textOf(f.path);
      return text === "" ? undefined : among.find((o) => real(o.path) !== real(f.path) && textOf(o.path) === text);
    };
    const drop = (f: ClaudeFile, twin: ClaudeFile) => {
      f.delivery = "not-loaded";
      f.why = `same text as ${rel(twin.path)}, which ${twin.delivery === "on-read" ? "loads with it" : "already loads"} (compared by content)`;
      f.rule = "claude.modes";
      delivered.delete(real(f.path));
    };
    for (const f of files.filter((x) => bySetting(x) && x.delivery === "launch")) {
      const twin = twinOf(f, handed);
      if (twin) drop(f, twin);
    }
    const inContext = [...handed, ...files.filter((x) => bySetting(x) && x.delivery === "launch")];
    for (const f of files.filter((x) => bySetting(x) && x.delivery === "on-read")) {
      const onPath = files.filter(
        (o) => isClaudeKind(o) && o.delivery === "on-read" && isInside(dirOf(f.path), dirOf(o.path)),
      );
      const twin = twinOf(f, [...inContext, ...onPath]);
      if (twin) drop(f, twin);
    }
  };
  if (agentsSupported) dedupeByText();

  // Rule claude.imports: external imports left out for want of an approval.
  for (const { row, importer, scope } of blocked.values()) {
    const target = row.path;
    const setting =
      scope === "project" &&
      (options.version === undefined || compareVersions(options.version, AGENTS_MD_MIN_VERSION) >= 0) &&
      (path.basename(target) === "AGENTS.md" || target.endsWith(path.join(".claude", "AGENTS.md"))) &&
      isInside(launchDir, path.dirname(target).replace(/[\\/]\.claude$/, ""));
    findings.push({
      code: "claude.external-import-headless",
      severity: "warn",
      agent: "claude",
      rule: "claude.imports",
      path: target,
      message:
        scope === "agents"
          ? `${rel(importer)} imports ${rel(target)}, which is outside the launch directory. Claude Code loads an AGENTS.md's external imports only if they were approved for this project before, and never asks; ${show(claudeJson)} records no approval (${approvalFor().why}), so it is left out.`
          : `${rel(importer)} imports ${rel(target)}, which is outside the launch directory, and ${show(claudeJson)} records no approval of external imports for this project (${approvalFor().why}). claude -p, the Agent SDK and CI never ask, so they leave it out; an interactive session asks once.${setting ? ` Setting Project instructions to claude-md-and-agents-md reads ${rel(target)} without the import.` : ""}`,
    });
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

  // Rule claude.home-ancestor: the only files switching AGENTS.md off are
  // above the repository, where nobody reading it can see them.
  const aboveRepo = shadowers.filter((s) => !inRepo(s));
  if (agentsSupported && lostAgents.length > 0 && aboveRepo.length > 0 && aboveRepo.length === shadowers.length) {
    const label = evidenceLabel("claude.home-ancestor");
    for (const s of aboveRepo) {
      findings.push({
        code: "claude.home-ancestor",
        severity: "warn",
        agent: "claude",
        rule: "claude.home-ancestor",
        path: s,
        message: samePath(s, personalFile)
          ? `~/.claude/CLAUDE.md, your personal file, switches AGENTS.md off here: the repository is under your home directory, so Claude Code also finds that file as an ancestor's .claude/CLAUDE.md, and nothing in the repository shows it. Keep personal instructions in ~/.claude/rules/ instead, add a CLAUDE.md with @AGENTS.md to the repository, or set Project instructions to claude-md-and-agents-md. [evidence: ${label}]`
          : `${rel(s)} is above the repository and switches AGENTS.md off for it: Claude Code counts a CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md in any directory above the launch directory, and nothing in the repository shows it. Add a CLAUDE.md with @AGENTS.md to the repository, or set Project instructions to claude-md-and-agents-md. [evidence: ${label}]`,
      });
    }
  }

  // Rule claude.symlink: a CLAUDE.md that is a symlink checked out as text.
  const linksAsText = new Set<string>();
  for (const f of files) {
    if (!(f.kind === "CLAUDE.md" || f.kind === ".claude/CLAUDE.md" || f.kind === "CLAUDE.local.md")) continue;
    if (f.delivery === "not-loaded") continue;
    const link = linkAsText(f.path);
    if (!link) continue;
    linksAsText.add(f.path);
    const dirOf = (p: string) => path.dirname(p).replace(/[\\/]\.claude$/, "");
    const switchesOff = shadowers.includes(f.path) || lostAgents.some((a) => samePath(dirOf(a.path), dirOf(f.path)));
    findings.push({
      code: "claude.link-as-text",
      severity: "warn",
      agent: "claude",
      rule: "claude.symlink",
      path: f.path,
      message: `${rel(f.path)} holds only the text "${link.text}": a symlink to ${rel(link.target)} that git checked out as a plain file, as git does on Windows unless symlinks are enabled (core.symlinks). Claude Code reads it as a ${path.basename(f.path)} whose whole text is that path: it imports nothing${switchesOff && lostAgents.length > 0 ? ", and as a CLAUDE.md it switches AGENTS.md off" : ""}. A line "@${link.text}" works on every system.`,
    });
  }

  // Rule claude.words: a CLAUDE.md that names AGENTS.md without importing it.
  if (lostAgents.length > 0 && agentsSupported) {
    for (const f of files) {
      if (!(f.kind === "CLAUDE.md" || f.kind === ".claude/CLAUDE.md" || f.kind === "CLAUDE.local.md")) continue;
      if (f.delivery === "not-loaded" || linksAsText.has(f.path)) continue;
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
    ...(approval ? { approval } : {}),
    findings,
  };
}
