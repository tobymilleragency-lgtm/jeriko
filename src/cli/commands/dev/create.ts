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
  { name: "app", description: "Expo + React Native + NativeWind mobile app", category: "deploy", dir: "webdev/app" },

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
    { label: "Mobile Apps", key: "mobile" },
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
    } else if (cat.key === "mobile") {
      filtered = TEMPLATES.filter((t) => t.name === "app");
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

    let template = parsed.positional[0];
    let name = parsed.positional[1];
    let inferredFromPrompt = false;
    let promptText = "";
    if (!template) fail("Missing template. Run 'jeriko create --list' to see all templates.");

    if (template === "repair") {
      const dir = flagStr(parsed, "dir", "");
      if (!dir) fail("Missing --dir <project> for repair. Usage: jeriko create repair --dir <project> [--name <name>]");
      const result = repairGeneratedProject(resolve(dir), { projectName: flagStr(parsed, "name", "") || undefined });
      ok(result);
      return;
    }

    if (template === "from-prompt") {
      promptText = parsed.positional.slice(1).join(" ");
      if (!promptText) fail('Missing prompt. Usage: jeriko create from-prompt "Build a roofing site..." --name <project>');
      template = inferTemplateFromPrompt(promptText);
      name = flagStr(parsed, "name", "") || inferProjectNameFromPrompt(promptText);
      inferredFromPrompt = true;
    }

    if (!name) fail("Missing project name. Usage: jeriko create <template> <name>");

    const seoProfile = flagStr(parsed, "seo-profile", "") || (inferredFromPrompt ? inferSeoProfileFromPrompt(promptText) : "standard");
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
        emitCreateSuccess({ name, template, category: info.category, directory: dir, files: countFiles(dir), reused: true, devServer, seoProfile, inferredFromPrompt });
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
      const crawlerPrerender = applyCrawlerPrerenderSupport(dir, name, seoProfile);
      const projectState = info.category === "webdev"
        ? writeProjectState(dir, buildProjectState({ name, template, profile: template as AppProfile, prompt: promptText || undefined, seoProfile }))
        : undefined;

      // Remove metadata files
      const metaFiles = [".manus-template-version", ".DS_Store", "template.json"];
      for (const meta of metaFiles) {
        const metaPath = join(dir, meta);
        try { if (existsSync(metaPath)) { const { unlinkSync } = await import("node:fs"); unlinkSync(metaPath); } } catch { /* ignore */ }
      }

      const files = countFiles(dir);

      const gitInitialized = initGit || shouldAutoInitGit(dir);
      if (gitInitialized) {
        initializeGitRepository(dir);
      }

      const devServer = startDev ? installAndStartDevServer(dir) : null;
      emitCreateSuccess({ name, template, category: info.category, directory: dir, files, projectState, gitInitialized, crawlerPrerender, devServer, seoProfile, inferredFromPrompt });
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

    const gitInitialized = initGit || shouldAutoInitGit(dir);
    if (gitInitialized) {
      initializeGitRepository(dir);
      created.push(".git/");
    }

    const devServer = startDev ? installAndStartDevServer(dir) : null;
    emitCreateSuccess({ name, template, category: "inline", directory: dir, files: created.length, gitInitialized, devServer });
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

function shouldAutoInitGit(dir: string): boolean {
  const projectsRoot = resolve(PROJECTS_DIR);
  const resolvedDir = resolve(dir);
  return resolvedDir === projectsRoot || resolvedDir.startsWith(`${projectsRoot}/`);
}

function initializeGitRepository(dir: string): void {
  if (existsSync(join(dir, ".git"))) return;
  const result = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    failWithDetails(`Failed to initialize git repository for "${dir}".`, {
      errorCode: "E_GIT_INIT",
      directory: dir,
      stderr: result.stderr?.toString().trim() ?? "",
    });
  }
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

function inferTemplateFromPrompt(prompt: string): string {
  const text = prompt.toLowerCase();
  if (/mobile|native|expo|ios|android|field app/.test(text)) return "app";
  if (/portal|login|auth|dashboard|account|database|db|user/.test(text)) return "web-db-user";
  if (/service|contractor|roof|remodel|plumb|electric|hvac|local|seo|landing|business|company/.test(text)) return "web-static";
  return "web-static";
}

function inferSeoProfileFromPrompt(prompt: string): string {
  const text = prompt.toLowerCase();
  if (/local|service area|city|near me|contractor|roof|remodel|plumb|electric|hvac|seo/.test(text)) return "local-service";
  return "standard";
}

function inferProjectNameFromPrompt(prompt: string): string {
  const quoted = prompt.match(/["“]([^"”]{2,80})["”]/)?.[1];
  if (quoted) return quoted;
  const cleaned = prompt
    .replace(/\b(build|create|make|a|an|the|website|site|app|application|with|for|and|seo|pages|photos|images)\b/gi, " ")
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.split(" ").slice(0, 4).join(" ") || "Generated App";
}

function emitCreateSuccess(args: {
  name: string;
  template: string;
  category: TemplateInfo["category"];
  directory: string;
  files: number;
  projectState?: string;
  gitInitialized?: boolean;
  crawlerPrerender?: boolean;
  reused?: boolean;
  devServer: DetachedDevServer | null;
  seoProfile?: string;
  inferredFromPrompt?: boolean;
}): never {
  const base = {
    name: args.name,
    template: args.template,
    category: args.category,
    directory: args.directory,
    files: args.files,
    ...(args.projectState ? { projectState: args.projectState } : {}),
    ...(args.gitInitialized ? { gitInitialized: true } : {}),
    ...(args.crawlerPrerender ? { crawlerPrerender: true } : {}),
    ...(args.seoProfile && args.seoProfile !== "standard" ? { seoProfile: args.seoProfile } : {}),
    ...(args.inferredFromPrompt ? { inferredFromPrompt: true } : {}),
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

export function applyCrawlerPrerenderSupport(dir: string, projectName: string, seoProfile = "standard"): boolean {
  const pkgPath = join(dir, "package.json");
  const indexPath = join(dir, "client", "index.html");
  if (!existsSync(pkgPath) || !existsSync(indexPath)) return false;

  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return false;
  }

  const buildScript = typeof pkg?.scripts?.build === "string" ? pkg.scripts.build : "";
  if (!buildScript.includes("vite build")) return false;

  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeWebsiteLaunchKitFiles(dir, projectName, seoProfile);
  const scriptPath = join(dir, "scripts", "jeriko-prerender-seo.mjs");
  writeFileSync(scriptPath, buildCrawlerPrerenderScript(projectName, seoProfile));

  if (!buildScript.includes("scripts/jeriko-prerender-seo.mjs")) {
    pkg.scripts.build = buildScript.replace("vite build", "vite build && node scripts/jeriko-prerender-seo.mjs");
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  return true;
}

function writeWebsiteLaunchKitFiles(dir: string, projectName: string, seoProfile = "standard"): void {
  const srcDir = join(dir, "client", "src");
  const libDir = join(srcDir, "lib");
  const assetsDir = join(srcDir, "assets");
  if (!existsSync(srcDir)) return;
  mkdirSync(libDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  const projectTitle = buildTemplatePlaceholderValues(projectName).project_title;
  const siteConfigPath = join(srcDir, "site.config.ts");
  if (!existsSync(siteConfigPath)) {
    writeFileSync(siteConfigPath, `export const siteConfig = {
  name: ${JSON.stringify(projectTitle)},
  url: import.meta.env.VITE_SITE_URL || "",
  seoProfile: ${JSON.stringify(seoProfile)},
  analyticsProvider: import.meta.env.VITE_ANALYTICS_PROVIDER || "none",
  ga4MeasurementId: import.meta.env.VITE_GA4_MEASUREMENT_ID || "",
  plausibleDomain: import.meta.env.VITE_PLAUSIBLE_DOMAIN || "",
  posthogKey: import.meta.env.VITE_POSTHOG_KEY || "",
  googleSiteVerification: import.meta.env.VITE_GOOGLE_SITE_VERIFICATION || "",
  bingSiteVerification: import.meta.env.VITE_BING_SITE_VERIFICATION || "",
  imagePrompts: {
    hero: ${JSON.stringify(`Generate a realistic hero photo for ${projectTitle}: a trustworthy business team at work, natural light, no text overlay, website-safe composition.`)},
    service: ${JSON.stringify(`Generate a realistic service photo for ${projectTitle}: close-up of professional work, clean background, no logos, no text.`)},
    og: ${JSON.stringify(`Generate a branded open graph image for ${projectTitle}: professional website preview, bold negative space, no readable text.`)},
  },
};

export type SiteConfig = typeof siteConfig;
`);
  }

  const imagePromptPath = join(assetsDir, "image-prompts.md");
  if (!existsSync(imagePromptPath)) {
    writeFileSync(imagePromptPath, `# Website image/photo generation prompts

Use Jeriko's \`generate_image\` tool to create production assets for this site. Call it with an app-local \`output_path\` such as \`client/public/images/hero.png\`, then reference that file from the page and metadata. Do not publish these prompts as customer-facing copy.

## Hero photo
${`Generate a realistic hero photo for ${projectTitle}: a trustworthy business team at work, natural light, no text overlay, website-safe composition.`}

## Service photo
${`Generate a realistic service photo for ${projectTitle}: close-up of professional work, clean background, no logos, no text.`}

## Open Graph image
${`Generate a branded open graph image for ${projectTitle}: professional website preview, bold negative space, no readable text.`}
`);
  }

  const analyticsPath = join(libDir, "analytics.ts");
  if (!existsSync(analyticsPath)) {
    writeFileSync(analyticsPath, `import { siteConfig } from "../site.config";

export type JerikoConversionEvent =
  | "form_submit"
  | "call_click"
  | "booking_click"
  | "email_click";

type EventPayload = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    plausible?: (event: string, options?: { props?: EventPayload }) => void;
    posthog?: { capture?: (event: string, properties?: EventPayload) => void };
  }
}

export function trackEvent(event: JerikoConversionEvent, payload: EventPayload = {}) {
  if (typeof window === "undefined") return;
  const provider = siteConfig.analyticsProvider.toLowerCase();
  if (provider === "ga4" && typeof window.gtag === "function") {
    window.gtag("event", event, payload);
    return;
  }
  if (provider === "plausible" && typeof window.plausible === "function") {
    window.plausible(event, { props: payload });
    return;
  }
  if (provider === "posthog" && typeof window.posthog?.capture === "function") {
    window.posthog.capture(event, payload);
  }
}

export function trackFormSubmit(form: string, payload: EventPayload = {}) {
  trackEvent("form_submit", { form, ...payload });
}

export function trackPhoneClick(location: string, payload: EventPayload = {}) {
  trackEvent("call_click", { location, ...payload });
}

export function trackBookingClick(location: string, payload: EventPayload = {}) {
  trackEvent("booking_click", { location, ...payload });
}

export function trackEmailClick(location: string, payload: EventPayload = {}) {
  trackEvent("email_click", { location, ...payload });
}
`);
  }
}

function buildCrawlerPrerenderScript(projectName: string, seoProfile = "standard"): string {
  const projectTitle = buildTemplatePlaceholderValues(projectName).project_title;
  const schemaType = seoProfile === "local-service" ? "LocalBusiness" : "WebPage";
  return `import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const dist = join(root, "dist", "public");
const templatePath = join(dist, "index.html");
const appPath = join(root, "client", "src", "App.tsx");
const pagesDir = join(root, "client", "src", "pages");
const siteConfigPath = join(root, "client", "src", "site.config.ts");
const siteUrl = (process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || "").replace(new RegExp("^https?://"), "").replace(new RegExp("/$"), "");
const baseUrl = siteUrl ? \`https://\${siteUrl}\` : "";
const projectTitle = ${JSON.stringify(projectTitle)};
const generatedAt = new Date().toISOString();
const siteConfig = readSiteConfig();

if (!existsSync(templatePath)) {
  console.warn("Jeriko SEO prerender skipped: dist/public/index.html not found");
  process.exit(0);
}

const template = readFileSync(templatePath, "utf8");
const routes = discoverRoutes();

for (const route of routes) {
  const html = renderRoute(route);
  const outDir = route.path === "/" ? dist : join(dist, route.path.startsWith("/") ? route.path.slice(1) : route.path);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), html);
}

writeFileSync(join(dist, "robots.txt"), renderRobots());
writeFileSync(join(dist, "sitemap.xml"), renderSitemap());
writeFileSync(join(dist, "llms.txt"), renderLlmsTxt());

console.log(\`Jeriko SEO prerendered \${routes.length} route(s) into \${dist}\`);

function discoverRoutes() {
  const app = existsSync(appPath) ? readFileSync(appPath, "utf8") : "";
  const imports = new Map();
  for (const match of app.matchAll(/import\\s+([A-Za-z0-9_]+)\\s+from\\s+["'](?:@\\/pages|\\.\\/pages)\\/([^"']+)["']/g)) {
    imports.set(match[1], match[2]);
  }

  const routes = [];
  for (const match of app.matchAll(/<Route\\s+([^>]*?)\\/>|<Route\\s+([^>]*?)>/g)) {
    const attrs = match[1] || match[2] || "";
    const pathMatch = attrs.match(/path=\\{?["']([^"'}]+)["']\\}?/);
    const componentMatch = attrs.match(/component=\\{?([A-Za-z0-9_]+)\\}?/);
    if (!pathMatch || !componentMatch) continue;
    const path = pathMatch[1];
    if (!path || path === "/404" || path.includes(":")) continue;
    routes.push({ path, component: componentMatch[1], source: imports.get(componentMatch[1]) || componentMatch[1] });
  }

  if (!routes.some((route) => route.path === "/")) routes.unshift({ path: "/", component: "Home", source: "Home" });
  return uniqueRoutes(routes);
}

function uniqueRoutes(routes) {
  const seen = new Set();
  return routes.filter((route) => {
    if (seen.has(route.path)) return false;
    seen.add(route.path);
    return true;
  });
}

function renderRoute(route) {
  const content = extractPageContent(route);
  const title = route.path === "/" ? projectTitle : \`\${content.heading} | \${projectTitle}\`;
  const description = content.paragraphs.slice(0, 2).join(" ").slice(0, 300) || \`\${projectTitle} page for \${route.path}\`;
  const canonical = baseUrl ? \`\${baseUrl}\${route.path === "/" ? "" : route.path}\` : route.path;
  const nav = routes.map((item) => \`<a href="\${escapeAttr(item.path)}">\${escapeHtml(item.path === "/" ? "Home" : routeLabel(item.path))}</a>\`).join(" | ");
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": ${JSON.stringify(schemaType)},
    name: title,
    url: canonical,
    description,
    isPartOf: { "@type": "WebSite", name: projectTitle, url: baseUrl || "/" },
    ...(siteConfig.seoProfile === "local-service" ? {
      serviceArea: route.path === "/" ? "Primary local service area" : routeLabel(route.path),
      areaServed: routeLabel(route.path),
      makesOffer: { "@type": "Offer", itemOffered: { "@type": "Service", name: content.heading } },
      mainEntity: { "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "How do I get started?", acceptedAnswer: { "@type": "Answer", text: description } }] },
    } : {}),
  }).replaceAll("<", "\\\\u003c");

  const fallback = \`
    <div id="root">
      <noscript>This site works without JavaScript for core content. JavaScript enhances the full app experience.</noscript>
      <nav aria-label="Primary" data-jeriko-prerender="true">\${nav}</nav>
      <article data-jeriko-prerender="true">
        <h1>\${escapeHtml(content.heading)}</h1>
        \${content.paragraphs.map((paragraph) => \`<p>\${escapeHtml(paragraph)}</p>\`).join("\\n        ")}
      </article>
    </div>\`;

  return addLaunchTrackingHooks(injectHead(template, { title, description, canonical, jsonLd })
    .replace(/<div id="root"><\\/div>/, fallback)
    .replace(/<html lang="en">/, \`<html lang="en" data-jeriko-seo-generated-at="\${escapeAttr(generatedAt)}">\`));
}

function addLaunchTrackingHooks(html) {
  return html
    .replace(/<form\\b(?![^>]*\\bdata-jeriko-track=)([^>]*)>/gi, '<form data-jeriko-track="form_submit"$1>')
    .replace(/<a\\b(?![^>]*\\bdata-jeriko-track=)([^>]*\\bhref=["']tel:[^"']*["'][^>]*)>/gi, '<a$1 data-jeriko-track="call_click">')
    .replace(/<a\\b(?![^>]*\\bdata-jeriko-track=)([^>]*\\bhref=["']mailto:[^"']*["'][^>]*)>/gi, '<a$1 data-jeriko-track="email_click">')
    .replace(/<a\\b(?![^>]*\\bdata-jeriko-track=)([^>]*\\bhref=["'][^"']*(?:book|booking|schedule|appointment|calendar)[^"']*["'][^>]*)>/gi, '<a$1 data-jeriko-track="booking_click">');
}

function injectHead(html, page) {
  const head = \`
    <title>\${escapeHtml(page.title)}</title>
    <meta name="description" content="\${escapeAttr(page.description)}" />
    <link rel="canonical" href="\${escapeAttr(page.canonical)}" />
    <meta property="og:title" content="\${escapeAttr(page.title)}" />
    <meta property="og:description" content="\${escapeAttr(page.description)}" />
    <meta property="og:url" content="\${escapeAttr(page.canonical)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="\${escapeAttr(projectTitle)}" />
    <meta name="robots" content="index,follow" />
    \${renderVerificationMeta()}
    \${renderAnalyticsScripts()}
    <script type="application/ld+json">\${page.jsonLd}</script>\`;

  return html
    .replace(/<title>.*?<\\/title>/s, "")
    .replace(/<meta name="description"[^>]*>\\s*/i, "")
    .replace(/<meta property="og:[^>]+>\\s*/gi, "")
    .replace(/<meta name="robots"[^>]*>\\s*/i, "")
    .replace(/<link rel="canonical"[^>]*>\\s*/i, "")
    .replace(/<\\/head>/i, \`\${head}\\n  </head>\`);
}

function readSiteConfig() {
  const source = existsSync(siteConfigPath) ? readFileSync(siteConfigPath, "utf8") : "";
  const fromEnv = (name) => process.env[name] || "";
  return {
    analyticsProvider: fromEnv("VITE_ANALYTICS_PROVIDER") || literalConfigValue(source, "analyticsProvider") || "none",
    seoProfile: literalConfigValue(source, "seoProfile") || "standard",
    ga4MeasurementId: fromEnv("VITE_GA4_MEASUREMENT_ID") || literalConfigValue(source, "ga4MeasurementId") || "",
    plausibleDomain: fromEnv("VITE_PLAUSIBLE_DOMAIN") || literalConfigValue(source, "plausibleDomain") || "",
    googleSiteVerification: fromEnv("VITE_GOOGLE_SITE_VERIFICATION") || literalConfigValue(source, "googleSiteVerification") || "",
    bingSiteVerification: fromEnv("VITE_BING_SITE_VERIFICATION") || literalConfigValue(source, "bingSiteVerification") || "",
  };
}

function literalConfigValue(source, key) {
  const match = source.match(new RegExp(key + "\\\\s*:\\\\s*[\\\"']([^\\\"']*)[\\\"']"));
  return match?.[1] || "";
}

function renderVerificationMeta() {
  const tags = [];
  if (siteConfig.googleSiteVerification) tags.push(\`<meta name="google-site-verification" content="\${escapeAttr(siteConfig.googleSiteVerification)}" />\`);
  if (siteConfig.bingSiteVerification) tags.push(\`<meta name="msvalidate.01" content="\${escapeAttr(siteConfig.bingSiteVerification)}" />\`);
  return tags.join("\\n    ");
}

function renderAnalyticsScripts() {
  const provider = String(siteConfig.analyticsProvider || "none").toLowerCase();
  if (provider === "ga4" && siteConfig.ga4MeasurementId) {
    const id = escapeAttr(siteConfig.ga4MeasurementId);
    return \`<script async src="https://www.googletagmanager.com/gtag/js?id=\${id}"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','\${id}');</script>\`;
  }
  if (provider === "plausible" && siteConfig.plausibleDomain) {
    return \`<script defer data-domain="\${escapeAttr(siteConfig.plausibleDomain)}" src="https://plausible.io/js/script.js"></script>\`;
  }
  return "";
}

function extractPageContent(route) {
  const sourcePath = join(pagesDir, route.source.endsWith(".tsx") ? route.source : \`\${route.source}.tsx\`);
  const text = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : "";
  const candidates = [];

  for (const match of text.matchAll(/>([^<>{}][^<>{}]*)</g)) pushClean(candidates, match[1]);
  for (const match of text.matchAll(/["'\`](.{24,260}?)["'\`]/gs)) pushClean(candidates, match[1]);

  const paragraphs = uniqueStrings(candidates)
    .filter((value) => !looksLikeCode(value))
    .slice(0, 80);
  const heading = paragraphs.find((value) => value.length >= 8) || routeLabel(route.path) || projectTitle;
  return { heading, paragraphs: paragraphs.length ? paragraphs : [\`\${projectTitle} content for \${route.path}\`] };
}

function pushClean(list, value) {
  const cleaned = String(value)
    .replace(/\\{[^}]*\\}/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
  if (cleaned.length >= 4) list.push(cleaned);
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksLikeCode(value) {
  return /^(className|function|return|import|export|const|let|var)\\b/.test(value)
    || /[{}<>]=?|=>|\\.tsx|@\\//.test(value)
    || value.includes("--")
    || value.length > 500;
}

function routeLabel(path) {
  if (path === "/") return "Home";
  return path.replace(/^\\//, "").replace(/[-_]+/g, " ").replace(/\\b\\w/g, (char) => char.toUpperCase());
}

function renderRobots() {
  return \`User-agent: Googlebot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-User
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: *
Allow: /

\${baseUrl ? \`Sitemap: \${baseUrl}/sitemap.xml\\n\` : ""}\`;
}

function renderSitemap() {
  const loc = (path) => baseUrl ? \`\${baseUrl}\${path === "/" ? "" : path}\` : path;
  return \`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
\${routes.map((route) => \`  <url><loc>\${escapeHtml(loc(route.path))}</loc><lastmod>\${generatedAt.slice(0, 10)}</lastmod><changefreq>weekly</changefreq></url>\`).join("\\n")}
</urlset>
\`;
}

function renderLlmsTxt() {
  return \`# \${projectTitle}

This site is generated by Jeriko with crawlable build-time HTML fallbacks for public routes.

## Public routes

\${routes.map((route) => \`- \${routeLabel(route.path)}: \${baseUrl ? \`\${baseUrl}\${route.path === "/" ? "" : route.path}\` : route.path}\`).join("\\n")}

## Crawl policy

Google, Claude, Anthropic, and standard web crawlers are allowed to read public marketing content.
\`;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
`;
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
