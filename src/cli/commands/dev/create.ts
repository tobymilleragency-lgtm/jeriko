import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { ok, fail, failWithDetails } from "../../../shared/output.js";
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { detectDevCommand, getProjectDevLogFile, startDetachedDevServer, type DetachedDevServer } from "./dev.js";
import { buildProjectState, writeProjectState, type AppProfile } from "./project-state.js";

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

interface TemplateInfo {
  name: string;
  description: string;
  category: "webdev" | "deploy" | "inline";
  /** Subdirectory under templates/ (e.g. "webdev/web-static" or "deploy/portfolio-template") */
  dir?: string;
}

const TEMPLATES: TemplateInfo[] = [
  // Webdev (pre-built full-stack)
  { name: "web-static", description: "Vite + React 19 + Tailwind 4 + shadcn/ui + Wouter + Framer Motion", category: "webdev", dir: "webdev/web-static" },
  { name: "web-db-user", description: "web-static + Express + Drizzle ORM + tRPC + JWT auth + database", category: "webdev", dir: "webdev/web-db-user" },

  // Deploy — Portfolios
  { name: "portfolio", description: "Clean portfolio website", category: "deploy", dir: "deploy/portfolio-template" },
  { name: "minimal-portfolio", description: "Minimal portfolio with clean design", category: "deploy", dir: "deploy/minimal-portfolio-template" },
  { name: "tech-portfolio", description: "Tech-focused portfolio", category: "deploy", dir: "deploy/tech-portfolio-template" },
  { name: "neo-portfolio", description: "Neo/modern portfolio", category: "deploy", dir: "deploy/neo-portfolio-template" },
  { name: "emoji-portfolio", description: "Fun emoji-styled portfolio", category: "deploy", dir: "deploy/emoji-portfolio-template" },
  { name: "freelance-portfolio", description: "Freelancer portfolio", category: "deploy", dir: "deploy/freelance-portfolio-template" },
  { name: "loud-portfolio", description: "Bold loud portfolio", category: "deploy", dir: "deploy/loud-portfolio-template" },
  { name: "prologue-portfolio", description: "Prologue-style portfolio", category: "deploy", dir: "deploy/prologue-portfolio-template" },
  { name: "bnw-landing", description: "Black & white landing page", category: "deploy", dir: "deploy/bnw-landing-template" },

  // Deploy — Dashboards
  { name: "dashboard", description: "Admin dashboard", category: "deploy", dir: "deploy/dashboard-template" },
  { name: "bold-dashboard", description: "Bold styled dashboard", category: "deploy", dir: "deploy/bold-dashboard-template" },
  { name: "dark-dashboard", description: "Dark theme dashboard", category: "deploy", dir: "deploy/dark-dashboard-template" },
  { name: "cyber-dashboard", description: "Cyberpunk dashboard", category: "deploy", dir: "deploy/cyber-dashboard-template" },

  // Deploy — Events
  { name: "event", description: "Event page", category: "deploy", dir: "deploy/event-template" },
  { name: "charity-event", description: "Charity event page", category: "deploy", dir: "deploy/charity-event-template" },
  { name: "dynamic-event", description: "Dynamic event page", category: "deploy", dir: "deploy/dynamic-event-template" },
  { name: "elegant-wedding", description: "Elegant wedding page", category: "deploy", dir: "deploy/elegant-wedding-template" },
  { name: "minimal-event", description: "Minimal event page", category: "deploy", dir: "deploy/minimal-event-template" },
  { name: "night-event", description: "Night event page", category: "deploy", dir: "deploy/night-event-template" },
  { name: "whimsical-event", description: "Whimsical event page", category: "deploy", dir: "deploy/whimsical-event-template" },
  { name: "zen-event", description: "Zen-styled event page", category: "deploy", dir: "deploy/zen-event-template" },

  // Deploy — Landing pages
  { name: "landing-page", description: "Landing page", category: "deploy", dir: "deploy/landing-page-template" },
  { name: "mobile-landing", description: "Mobile app landing page", category: "deploy", dir: "deploy/mobile-landing-template" },
  { name: "pixel-landing", description: "Pixel art landing page", category: "deploy", dir: "deploy/pixel-landing-template" },
  { name: "professional-landing", description: "Professional landing page", category: "deploy", dir: "deploy/professional-landing-template" },
  { name: "services-landing", description: "Services landing page", category: "deploy", dir: "deploy/services-landing-template" },
  { name: "tech-landing", description: "Tech landing page", category: "deploy", dir: "deploy/tech-landing-template" },

  // Deploy — Frameworks
  { name: "react", description: "React + Vite + Tailwind (deploy-ready)", category: "deploy", dir: "deploy/react" },
  { name: "react-js", description: "React JS (no TypeScript, deploy-ready)", category: "deploy", dir: "deploy/react-js" },
  { name: "nextjs", description: "Next.js with App Router (deploy-ready)", category: "deploy", dir: "deploy/next" },
  { name: "flask", description: "Flask Python web app (deploy-ready)", category: "deploy", dir: "deploy/flask" },

  // Inline (generated on the fly, no pre-built directory)
  { name: "node", description: "Node.js project (package.json + tsconfig)", category: "inline" },
  { name: "api", description: "Express/Hono API server", category: "inline" },
  { name: "cli", description: "CLI tool with jeriko patterns", category: "inline" },
  { name: "plugin", description: "Jeriko plugin scaffold", category: "inline" },
];

const TEMPLATE_MAP = new Map(TEMPLATES.map((t) => [t.name, t]));
const PROJECTS_DIR = join(homedir(), ".jeriko", "projects");

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

/**
 * Locate a template directory on disk. Search order:
 *  1. Adjacent to the compiled binary (installed via install.sh)
 *  2. Repo root (dev mode: cwd is repo root)
 *  3. Installed library path (~/.local/lib/jeriko/templates/)
 */
function findTemplateDir(relPath: string): string | null {
  const candidates = [
    join(dirname(process.execPath), "..", "lib", "jeriko", "templates", relPath),
    join(process.cwd(), "templates", relPath),
    join(homedir(), ".local", "lib", "jeriko", "templates", relPath),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Deploy templates have inconsistent structures:
 *  - Some are FLAT (files directly in template dir: react, next, flask, etc.)
 *  - Some have a single subdirectory (e.g. portfolio-template/portfolio-new/)
 *  - Some have a template-website/ subdirectory
 *
 * This function resolves to the actual project root to copy.
 */
function resolveDeployDir(templateDir: string): string {
  const entries = readdirSync(templateDir, { withFileTypes: true });

  // Filter out metadata files
  const meaningful = entries.filter(
    (e) => e.name !== ".manus-template-version" && e.name !== ".DS_Store",
  );

  // If there's a package.json or index.html at root, it's flat — use as-is
  if (meaningful.some((e) => e.name === "package.json" || e.name === "index.html" || e.name === "requirements.txt")) {
    return templateDir;
  }

  // If there's exactly one subdirectory, descend into it
  const dirs = meaningful.filter((e) => e.isDirectory());
  if (dirs.length === 1 && dirs[0]) {
    const sub = join(templateDir, dirs[0].name);
    return sub;
  }

  // Check for template-website/ specifically
  const tw = join(templateDir, "template-website");
  if (existsSync(tw)) return tw;

  // Fallback: use root
  return templateDir;
}

// ---------------------------------------------------------------------------
// Help & list
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log("Usage: jeriko create <template> <name> [options]");
  console.log("\nScaffold a new project from a template.");
  console.log("\nFlags:");
  console.log("  --list            List all available templates");
  console.log("  --dir <path>      Exact output directory (default: ~/.jeriko/projects/<name>)");
  console.log("  --parent-dir <p>  Parent directory; creates <p>/<name>");
  console.log("  --reuse           Reuse an existing valid project directory");
  console.log("  --force           Delete and recreate an existing directory");
  console.log("  --git             Initialize git repo");
  console.log("  --dev             Install deps and start dev server in the background");
  console.log("\nRepair existing generated apps:");
  console.log("  jeriko create repair --dir <project> [--name <name>]");
  console.log("\nRun 'jeriko create --list' to see all templates.");
}

function printTemplateList(): void {
  console.log("Available templates:\n");

  const categories: Array<{ label: string; key: string }> = [
    { label: "Full-Stack (pre-built, instant)", key: "webdev" },
    { label: "Portfolios", key: "portfolio" },
    { label: "Dashboards", key: "dashboard" },
    { label: "Events", key: "event" },
    { label: "Landing Pages", key: "landing" },
    { label: "Frameworks", key: "framework" },
    { label: "Scaffolds (generated)", key: "inline" },
  ];

  for (const cat of categories) {
    let filtered: TemplateInfo[];
    if (cat.key === "webdev") {
      filtered = TEMPLATES.filter((t) => t.category === "webdev");
    } else if (cat.key === "inline") {
      filtered = TEMPLATES.filter((t) => t.category === "inline");
    } else if (cat.key === "portfolio") {
      filtered = TEMPLATES.filter((t) => t.category === "deploy" && (t.name.includes("portfolio") || t.name === "bnw-landing"));
    } else if (cat.key === "dashboard") {
      filtered = TEMPLATES.filter((t) => t.category === "deploy" && t.name.includes("dashboard"));
    } else if (cat.key === "event") {
      filtered = TEMPLATES.filter((t) => t.category === "deploy" && (t.name.includes("event") || t.name.includes("wedding")));
    } else if (cat.key === "landing") {
      filtered = TEMPLATES.filter((t) => t.category === "deploy" && t.name.includes("landing") && !t.name.includes("portfolio") && t.name !== "bnw-landing");
    } else if (cat.key === "framework") {
      filtered = TEMPLATES.filter((t) => t.category === "deploy" && ["react", "react-js", "nextjs", "flask"].includes(t.name));
    } else {
      continue;
    }

    if (filtered.length === 0) continue;
    console.log(`  ${cat.label}:`);
    const maxLen = Math.max(...filtered.map((t) => t.name.length));
    for (const t of filtered) {
      const pad = " ".repeat(maxLen - t.name.length + 2);
      console.log(`    ${t.name}${pad}${t.description}`);
    }
    console.log();
  }

  console.log("Usage: jeriko create <template> <name>");
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const command: CommandHandler = {
  name: "create",
  description: "Scaffold new project from template",
  async run(args: string[]) {
    const parsed = parseArgs(args);

    if (flagBool(parsed, "help")) {
      printHelp();
      process.exit(0);
    }

    if (flagBool(parsed, "list")) {
      printTemplateList();
      process.exit(0);
    }

    const template = parsed.positional[0];
    const name = parsed.positional[1];
    if (!template) fail("Missing template. Run 'jeriko create --list' to see all templates.");

    if (template === "repair") {
      const dir = flagStr(parsed, "dir", "");
      if (!dir) fail("Missing --dir <project> for repair. Usage: jeriko create repair --dir <project> [--name <name>]");
      const result = repairGeneratedProject(resolve(dir), { projectName: flagStr(parsed, "name", "") || undefined });
      ok(result);
      return;
    }

    if (!name) fail("Missing project name. Usage: jeriko create <template> <name>");

    const info = TEMPLATE_MAP.get(template);
    if (!info) {
      // Fuzzy suggest
      const similar = TEMPLATES.filter((t) => t.name.includes(template) || template.includes(t.name));
      let msg = `Unknown template: "${template}"`;
      if (similar.length > 0) {
        msg += `\n\nDid you mean?\n${similar.map((s) => `  ${s.name}`).join("\n")}`;
      }
      msg += "\n\nRun 'jeriko create --list' to see all templates.";
      fail(msg);
      return;
    }

    const initGit = flagBool(parsed, "git");
    const startDev = flagBool(parsed, "dev");
    const reuse = flagBool(parsed, "reuse");
    const force = flagBool(parsed, "force");

    if (reuse && force) {
      fail("Use either --reuse or --force, not both.");
    }

    // Rich templates (webdev + deploy) — copy from disk
    if (info.category === "webdev" || info.category === "deploy") {
      const dir = resolveCreateDirectory(parsed, name, join(PROJECTS_DIR, name));
      const prepared = prepareOutputDirectory(dir, { reuse, force });
      if (prepared.reused) {
        const devServer = startDev ? installAndStartDevServer(dir) : null;
        emitCreateSuccess({ name, template, category: info.category, directory: dir, files: countFiles(dir), reused: true, devServer });
        return;
      }

      if (!info.dir) {
        fail(`Template "${template}" has no directory configured.`);
        return;
      }

      const templateDir = findTemplateDir(info.dir);
      if (!templateDir) {
        fail(`Template "${template}" not found on disk. Searched:\n` +
          `  ${join(dirname(process.execPath), "..", "lib", "jeriko", "templates", info.dir)}\n` +
          `  ${join(process.cwd(), "templates", info.dir)}\n` +
          `  ${join(homedir(), ".local", "lib", "jeriko", "templates", info.dir)}`);
        return;
      }

      // For deploy templates, resolve to the actual project root
      const sourceDir = info.category === "deploy" ? resolveDeployDir(templateDir) : templateDir;

      mkdirSync(dir, { recursive: true });
      cpSync(sourceDir, dir, { recursive: true });
      replaceTemplatePlaceholders(dir, name);
      const projectState = info.category === "webdev"
        ? writeProjectState(dir, buildProjectState({ name, template, profile: template as AppProfile }))
        : undefined;

      // Remove metadata files
      const metaFiles = [".manus-template-version", ".DS_Store"];
      for (const meta of metaFiles) {
        const metaPath = join(dir, meta);
        try { if (existsSync(metaPath)) { const { unlinkSync } = await import("node:fs"); unlinkSync(metaPath); } } catch { /* ignore */ }
      }

      const files = countFiles(dir);

      if (initGit) {
        const { execSync } = await import("node:child_process");
        execSync("git init", { cwd: dir, encoding: "utf-8" });
      }

      const devServer = startDev ? installAndStartDevServer(dir) : null;
      emitCreateSuccess({ name, template, category: info.category, directory: dir, files, projectState, devServer });
      return;
    }

    // Inline templates (node, api, cli, plugin) — generated on the fly
    const dir = resolveCreateDirectory(parsed, name, `./${name}`);
    const prepared = prepareOutputDirectory(dir, { reuse, force });
    if (prepared.reused) {
      const devServer = startDev ? installAndStartDevServer(dir) : null;
      emitCreateSuccess({ name, template, category: "inline", directory: dir, files: countFiles(dir), reused: true, devServer });
      return;
    }

    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name,
          version: "0.1.0",
          type: "module",
          scripts: {
            build: "tsc",
            dev: "tsx watch src/index.ts",
            start: "node dist/index.js",
          },
          devDependencies: {
            typescript: "^5.0.0",
            tsx: "^4.0.0",
          },
        },
        null,
        2,
      ) + "\n",
    );

    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "Node16",
            moduleResolution: "Node16",
            outDir: "dist",
            rootDir: "src",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
          },
          include: ["src"],
        },
        null,
        2,
      ) + "\n",
    );

    writeFileSync(join(dir, "src", "index.ts"), `console.log("Hello from ${name}");\n`);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\ndist/\n.env\n");

    const created = ["package.json", "tsconfig.json", "src/index.ts", ".gitignore"];

    if (initGit) {
      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: dir, encoding: "utf-8" });
      created.push(".git/");
    }

    const devServer = startDev ? installAndStartDevServer(dir) : null;
    emitCreateSuccess({ name, template, category: "inline", directory: dir, files: created.length, devServer });
  },
};

interface PrepareOptions {
  reuse: boolean;
  force: boolean;
}

function resolveCreateDirectory(parsed: ReturnType<typeof parseArgs>, name: string, defaultDir: string): string {
  const dir = flagStr(parsed, "dir", "");
  const parentDir = flagStr(parsed, "parent-dir", "");

  if (dir && parentDir) {
    fail("Use either --dir for an exact output directory or --parent-dir to create under a parent, not both.");
  }

  if (dir) return resolve(dir);
  if (parentDir) return resolve(parentDir, name);
  return resolve(defaultDir);
}

function prepareOutputDirectory(dir: string, options: PrepareOptions): { reused: boolean } {
  if (!existsSync(dir)) return { reused: false };

  if (options.force) {
    rmSync(dir, { recursive: true, force: true });
    return { reused: false };
  }

  // Existing valid projects are idempotent by default. App-builder agents often
  // retry the same scaffold command after partial progress; returning success
  // lets the workflow continue to install/build instead of looping on E_EXISTS.
  if (isValidProjectDirectory(dir)) {
    return { reused: true };
  }

  failExistingDirectory(dir);
}

function isValidProjectDirectory(dir: string): boolean {
  return existsSync(join(dir, "package.json")) ||
    existsSync(join(dir, "requirements.txt")) ||
    existsSync(join(dir, "pyproject.toml")) ||
    existsSync(join(dir, "Cargo.toml")) ||
    existsSync(join(dir, "go.mod")) ||
    existsSync(join(dir, "src")) ||
    existsSync(join(dir, "index.html"));
}

function failExistingDirectory(dir: string): never {
  failWithDetails(
    `Directory already exists: "${dir}"`,
    {
      errorCode: "E_EXISTS",
      directory: dir,
      suggestions: [
        "Pass --reuse to reuse an existing valid project directory.",
        "Pass --force to delete and recreate the directory.",
        "Pass --dir <path> to choose a different exact output directory.",
        "Pass --parent-dir <path> to create <path>/<name>.",
      ],
    },
  );
}

function installAndStartDevServer(dir: string): DetachedDevServer {
  const logFile = getProjectDevLogFile(dir);
  const installCommand = detectInstallCommand(dir);
  if (installCommand) {
    const install = runLoggedCommand(installCommand, dir, logFile);
    if (install.status !== 0) {
      failWithDetails(
        `Failed to install dependencies for "${dir}". See log for details.`,
        { errorCode: "E_INSTALL", directory: dir, logFile, status: install.status },
      );
    }
  }

  const startCommand = detectDevCommand(dir);
  if (!startCommand) {
    failWithDetails(
      `Cannot detect dev server command for "${dir}".`,
      { errorCode: "E_DEV_COMMAND", directory: dir, logFile, suggestions: ["Add a package.json dev script or start the server with jeriko dev start --dir <path> --cmd <command>."] },
    );
  }

  return startDetachedDevServer(startCommand, dir);
}

function detectInstallCommand(dir: string): string | null {
  if (existsSync(join(dir, "requirements.txt"))) {
    return "python3 -m venv venv && ./venv/bin/pip install -r requirements.txt";
  }
  if (!existsSync(join(dir, "package.json"))) return null;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm install --no-frozen-lockfile";
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun install";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn install";
  return "npm install";
}

function runLoggedCommand(command: string, dir: string, logFile: string): { status: number } {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    writeSync(fd, `\n[${new Date().toISOString()}] running: ${command}\n`);
    const result = spawnSync(command, [], {
      cwd: dir,
      shell: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
    });
    return { status: result.status ?? 1 };
  } finally {
    closeSync(fd);
  }
}

function emitCreateSuccess(args: {
  name: string;
  template: string;
  category: TemplateInfo["category"];
  directory: string;
  files: number;
  projectState?: string;
  reused?: boolean;
  devServer: DetachedDevServer | null;
}): never {
  const base = {
    name: args.name,
    template: args.template,
    category: args.category,
    directory: args.directory,
    files: args.files,
    ...(args.projectState ? { projectState: args.projectState } : {}),
    ...(args.reused ? { reused: true } : {}),
  };

  if (!args.devServer) {
    ok(base);
  }

  ok({
    ...base,
    pid: args.devServer.pid,
    logFile: args.devServer.logFile,
    dev: args.devServer,
  });
}

function countFiles(dir: string): number {
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isDirectory()) {
        count += countFiles(join(dir, entry.name));
      } else {
        count++;
      }
    }
  } catch { /* ignore */ }
  return count;
}

export interface RepairGeneratedProjectOptions {
  projectName?: string;
  runPackageManager?: boolean;
}

export interface RepairGeneratedProjectResult {
  directory: string;
  projectName: string;
  changedFiles: string[];
  lockfileNeedsRefresh: boolean;
  lockfileRefreshed: boolean;
  actions: string[];
}

export function repairGeneratedProject(dir: string, options: RepairGeneratedProjectOptions = {}): RepairGeneratedProjectResult {
  if (!existsSync(dir)) {
    failWithDetails(`Project directory not found: "${dir}"`, { errorCode: "E_NOT_FOUND", directory: dir });
  }

  const projectName = options.projectName || inferProjectName(dir);
  const changedFiles = replaceTemplatePlaceholdersWithReport(dir, projectName);
  const lockfileNeedsRefresh = hasPnpmPatchedDependencyDrift(dir);
  let lockfileRefreshed = false;
  const actions = changedFiles.length > 0 ? ["placeholders_replaced"] : [];

  if (lockfileNeedsRefresh) {
    actions.push("pnpm_lockfile_needs_refresh");
    if (options.runPackageManager !== false) {
      const result = spawnSync("pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile", [], {
        cwd: dir,
        shell: true,
        stdio: "ignore",
        env: process.env,
      });
      lockfileRefreshed = (result.status ?? 1) === 0;
      if (lockfileRefreshed) actions.push("pnpm_lockfile_refreshed");
    }
  }

  return { directory: dir, projectName, changedFiles, lockfileNeedsRefresh, lockfileRefreshed, actions };
}

export function replaceTemplatePlaceholders(dir: string, projectName: string): void {
  replaceTemplatePlaceholdersWithReport(dir, projectName);
}

function replaceTemplatePlaceholdersWithReport(dir: string, projectName: string): string[] {
  const values = buildTemplatePlaceholderValues(projectName);
  const changedFiles: string[] = [];
  walkFiles(dir, (file) => {
    try {
      const buffer = readFileSync(file);
      if (!buffer.includes("{{")) return;
      // Do not try to template binary files.
      if (buffer.includes(0)) return;

      const original = buffer.toString("utf8");
      const replaced = original.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) => values[key] ?? match);
      if (replaced !== original) {
        writeFileSync(file, replaced);
        changedFiles.push(file);
      }
    } catch {
      // Best effort: unreadable files should not make scaffolding fail.
    }
  });
  return changedFiles;
}

function inferProjectName(dir: string): string {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof pkg.name === "string" && pkg.name.trim() && !pkg.name.includes("{{")) {
        return pkg.name;
      }
    } catch { /* ignore */ }
  }
  return dir.split(/[\\/]+/).filter(Boolean).at(-1) || "app";
}

function hasPnpmPatchedDependencyDrift(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  const lockPath = join(dir, "pnpm-lock.yaml");
  if (!existsSync(pkgPath) || !existsSync(lockPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const packagePatches = Boolean(pkg?.pnpm?.patchedDependencies && Object.keys(pkg.pnpm.patchedDependencies).length > 0);
    const lockHasPatches = /^patchedDependencies:/m.test(readFileSync(lockPath, "utf8"));
    return lockHasPatches && !packagePatches;
  } catch {
    return false;
  }
}

function walkFiles(dir: string, visit: (file: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visit);
    } else if (entry.isFile()) {
      visit(fullPath);
    }
  }
}

function buildTemplatePlaceholderValues(projectName: string): Record<string, string> {
  const projectSlug = slugifyProjectName(projectName);
  const projectTitle = projectSlug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "App";

  const bundleName = projectSlug.replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "app";
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

  return {
    project_name: projectSlug,
    project_title: projectTitle,
    bundle_id: `space.manus.${bundleName}.t${timestamp}`,
  };
}

function slugifyProjectName(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_.]{2,}/g, "-") || "app";
}
