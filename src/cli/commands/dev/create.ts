import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { ok, fail, failWithDetails } from "../../../shared/output.js";
import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { detectDevCommand, getProjectDevLogFile, startDetachedDevServer, type DetachedDevServer } from "./dev.js";
import { buildProjectState, readProjectState, writeProjectState, type AppProfile, type ProjectState } from "./project-state.js";
import { initializeAppBuilderRun, recordAppBuilderPhase } from "./app-builder-controller.js";

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
const STATIC_WEB_VITE_CONFIG = `import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";
import jerikoDebug from "./vite-plugin-jeriko-debug";

export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss(), command === "serve" ? jerikoDebug() : null].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: false,
    host: true,
    allowedHosts: true,
  },
}));
`;

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
    } else if (!TEMPLATE_MAP.has(template) && looksLikeNaturalLanguagePrompt(parsed.positional.join(" "))) {
      promptText = parsed.positional.join(" ");
      template = inferTemplateFromPrompt(promptText);
      name = flagStr(parsed, "name", "") || inferProjectNameFromPrompt(promptText);
      inferredFromPrompt = true;
    } else {
      promptText = flagStr(parsed, "prompt", "");
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
      const scaffoldSanitizerActions = template === "web-static" ? sanitizeStaticWebProject(dir) : [];
      const crawlerPrerender = applyCrawlerPrerenderSupport(dir, name, seoProfile);
      const effectivePromptText = promptText || name;
      if (info.category === "webdev" && template === "web-db-user" && effectivePromptText) {
        applyFullStackProductPromptSupport(dir, effectivePromptText);
      }
      const projectState = info.category === "webdev"
        ? writeProjectState(dir, buildProjectState({ name, template, profile: template as AppProfile, prompt: promptText || undefined, seoProfile }))
        : undefined;
      if (info.category === "webdev" && template === "web-static" && seoProfile === "local-service") {
        const createdState = readProjectState(dir);
        const contractorLocalService = createdState?.appSpec?.successCriteria?.some((criterion) => /Contractor\/local-service sites/i.test(criterion));
        if (contractorLocalService) {
          applyLocalServiceStarterContent(dir);
          applyCrawlerPrerenderSupport(dir, name, seoProfile);
        }
      }
      if (info.category === "webdev") {
        initializeAppBuilderRun(dir, { trigger: "create" });
        recordAppBuilderPhase(dir, "target-lock", "completed", [`directory: ${dir}`, `template: ${template}`, `project: ${name}`]);
        recordAppBuilderPhase(dir, "skill-bind", "completed", ["mandatory skills recorded in appBuilderRun"]);
        recordAppBuilderPhase(dir, "appspec-plan", "completed", ["appSpec and appBuilderPlan written to .jeriko/project-state.json"]);
        recordAppBuilderPhase(dir, "scaffold", "completed", ["template copied", ...scaffoldSanitizerActions, ...(crawlerPrerender ? ["crawler prerender support applied"] : [])]);
      }

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
      emitCreateSuccess({ name, template, category: info.category, directory: dir, files, projectState, gitInitialized, crawlerPrerender, scaffoldSanitizerActions, devServer, seoProfile, inferredFromPrompt });
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

function looksLikeNaturalLanguagePrompt(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (!text.includes(" ")) return false;
  return /\b(build|create|make|generate|scaffold|launch)\b/.test(text)
    && /\b(site|website|app|application|portal|dashboard|crm|contractor|business|service|product|workflow)\b/.test(text);
}

function inferTemplateFromPrompt(prompt: string): string {
  const text = prompt.toLowerCase();
  if (/mobile|native|expo|ios|android|field app/.test(text)) return "app";
  if (/portal|login|auth|dashboard|account|database|db|user|scanner|scan|resale|inventory|profit|crm|pipeline|records?|estimates?|jobs?|customers?|leads?|workflow|operations|admin/.test(text) || (/\blisting\b/.test(text) && /\b(product|inventory|resale|marketplace|order|seller dashboard)\b/.test(text)) || (/(upload|paste|photo)/.test(text) && /\b(item|cost|price|scan|resale|inventory)\b/.test(text))) return "web-db-user";
  if (/service|contractor|roof|remodel|plumb|electric|hvac|realtor|real estate|realty|brokerage|homes for sale|local|seo|landing|business|company/.test(text)) return "web-static";
  return "web-static";
}

function applyFullStackProductPromptSupport(dir: string, prompt: string): boolean {
  const scannerWorkflow = /scanner|scan|resale|inventory|listing|profit|upload|paste|photo|item cost/i.test(prompt);
  const genericProductWorkflow = /crm|pipeline|records?|estimates?|jobs?|customers?|leads?|dashboard|workflow|operations|admin|portal/i.test(prompt);
  if (!scannerWorkflow && !genericProductWorkflow) return false;
  const appPath = join(dir, "client", "src", "App.tsx");
  if (existsSync(appPath)) {
    let app = readFileSync(appPath, "utf8");
    if (scannerWorkflow && !app.includes("./pages/Scanner")) {
      app = app.replace('import Home from "./pages/Home";\n', 'import Home from "./pages/Home";\nimport Scanner from "./pages/Scanner";\nimport Inventory from "./pages/Inventory";\n');
      app = app.replace('      <Route path={"/"} component={Home} />\n', '      <Route path={"/"} component={Home} />\n      <Route path={"/scanner"} component={Scanner} />\n      <Route path={"/inventory"} component={Inventory} />\n');
    }
    if (genericProductWorkflow && !app.includes("./pages/Dashboard")) {
      app = app.replace('import Home from "./pages/Home";\n', 'import Home from "./pages/Home";\nimport Dashboard from "./pages/Dashboard";\nimport Intake from "./pages/Intake";\nimport Records from "./pages/Records";\n');
      app = app.replace('      <Route path={"/"} component={Home} />\n', '      <Route path={"/"} component={Home} />\n      <Route path={"/dashboard"} component={Dashboard} />\n      <Route path={"/intake"} component={Intake} />\n      <Route path={"/records"} component={Records} />\n');
    }
    writeFileSync(appPath, app);
  }

  const pagesDir = join(dir, "client", "src", "pages");
  mkdirSync(pagesDir, { recursive: true });
  if (scannerWorkflow) {
    writeFileSync(join(pagesDir, "Scanner.tsx"), `import { useMemo, useState } from "react";

type ScanResult = {
  estimatedSalePrice: number;
  platformFee: number;
  netProfit: number;
  decision: string;
};

function calculateNetProfit(price: number, cost: number, shipping: number, fee: number): number {
  return Math.round((price - cost - shipping - fee) * 100) / 100;
}

export default function Scanner() {
  const [details, setDetails] = useState("");
  const [cost, setCost] = useState(0);
  const [shippingCost, setShippingCost] = useState(0);
  const [platformFee, setPlatformFee] = useState(0);
  const [photoName, setPhotoName] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null);
  const [workflowError, setWorkflowError] = useState("");

  const ready = details.trim().length > 0 || photoName.length > 0;
  const projectedPrice = useMemo(() => Math.max(25, Math.round((cost + shippingCost + platformFee) * 1.8)), [cost, shippingCost, platformFee]);

  async function requireOk(response: Response, action: string) {
    if (!response.ok) throw new Error(action + " failed with HTTP " + response.status);
    return response;
  }

  async function uploadPhoto(file?: File) {
    if (!file) return;
    setWorkflowError("");
    try {
      await requireOk(await fetch("/api/uploads", { method: "POST", body: file }), "Photo upload");
      setPhotoName(file.name);
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "Photo upload failed");
    }
  }

  async function pasteDetails(text: string) {
    const next = text || details;
    setDetails(next);
    setWorkflowError("");
    try {
      await requireOk(await fetch("/api/scans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: next, cost, shippingCost, platformFee }) }), "Scan draft save");
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "Scan draft save failed");
    }
  }

  async function scanItem() {
    if (!ready) return;
    const nextFee = platformFee || Math.round(projectedPrice * 0.13 * 100) / 100;
    const netProfit = calculateNetProfit(projectedPrice, cost, shippingCost, nextFee);
    const next = { estimatedSalePrice: projectedPrice, platformFee: nextFee, netProfit, decision: netProfit > 10 ? "List it" : "Skip it" };
    setWorkflowError("");
    try {
      await requireOk(await fetch("/api/scan-item", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ details, photoName, cost, shippingCost, platformFee: nextFee, result: next }) }), "AI scan");
      setResult(next);
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "AI scan failed");
    }
  }

  async function saveInventory() {
    if (!result) return;
    setWorkflowError("");
    try {
      await requireOk(await fetch("/api/inventory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ details, photoName, cost, shippingCost, result }) }), "Inventory save");
    } catch (error) {
      setWorkflowError(error instanceof Error ? error.message : "Inventory save failed");
    }
  }

  return <main className="mx-auto max-w-5xl space-y-6 p-8">
    <header><h1 className="text-3xl font-bold">Resale scanner</h1><p>Upload photos, paste item details, enter costs, scan profit, and save inventory.</p></header>
    {workflowError ? <section role="alert" className="rounded border border-red-300 p-3 text-red-700">{workflowError}</section> : null}
    <section className="grid gap-4 md:grid-cols-2">
      <label>Photo<input type="file" accept="image/*" onChange={(event) => void uploadPhoto(event.target.files?.[0])} /></label>
      <label>Details<textarea value={details} onPaste={(event) => void pasteDetails(event.clipboardData.getData("text"))} onChange={(event) => setDetails(event.target.value)} /></label>
      <label>Item cost<input type="number" value={cost} onChange={(event) => setCost(Number(event.target.value))} /></label>
      <label>Shipping cost<input type="number" value={shippingCost} onChange={(event) => setShippingCost(Number(event.target.value))} /></label>
      <label>Platform fee<input type="number" value={platformFee} onChange={(event) => setPlatformFee(Number(event.target.value))} /></label>
    </section>
    <section className="flex gap-3"><button onClick={() => void scanItem()}>Scan item</button><button onClick={() => void saveInventory()} disabled={!result}>Save to inventory</button></section>
    {result ? <section><h2>Profit estimate</h2><p>Price: ${"$"}{result.estimatedSalePrice}</p><p>Net profit: ${"$"}{result.netProfit}</p><p>Decision: {result.decision}</p></section> : null}
  </main>;
}
`);
    writeFileSync(join(pagesDir, "Inventory.tsx"), `export default function Inventory() {
  return <main className="mx-auto max-w-5xl space-y-6 p-8"><h1 className="text-3xl font-bold">Inventory</h1><p>Saved scans and resale listings are persisted through the generated API inventory workflow.</p><a href="/scanner">Scan another item</a></main>;
}
`);
  }

  if (genericProductWorkflow) {
    writeFileSync(join(pagesDir, "Dashboard.tsx"), `export default function Dashboard() {
  return <main className="mx-auto max-w-6xl space-y-6 p-8"><h1 className="text-3xl font-bold">Operations dashboard</h1><p>Track active leads, job pipeline movement, customer records, and estimates from one authenticated workspace.</p><a href="/intake">Create intake</a><a className="ml-4" href="/records">View records</a></main>;
}
`);
    writeFileSync(join(pagesDir, "Intake.tsx"), `import { useState } from "react";

export default function Intake() {
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  async function submitLead(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    const response = await fetch("/api/intake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!response.ok) { setError("Intake save failed"); return; }
    setSaved(true);
  }
  return <main className="mx-auto max-w-4xl space-y-6 p-8"><h1 className="text-3xl font-bold">Lead intake</h1><form className="grid gap-4" onSubmit={(event) => void submitLead(event)}><input name="name" placeholder="Customer name" required /><input name="phone" placeholder="Phone" required /><input name="project" placeholder="Project or job type" required /><button type="submit">Save intake</button></form>{saved ? <p>Lead saved to the pipeline.</p> : null}{error ? <p role="alert">{error}</p> : null}</main>;
}
`);
    writeFileSync(join(pagesDir, "Records.tsx"), `import { useEffect, useState } from "react";

type RecordRow = { id: string; name: string; status: string };

export default function Records() {
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [error, setError] = useState("");
  useEffect(() => { void fetch("/api/records").then(async (response) => {
    if (!response.ok) throw new Error("Records load failed");
    const data = await response.json();
    setRecords(data.records ?? []);
  }).catch((err) => setError(err instanceof Error ? err.message : "Records load failed")); }, []);
  return <main className="mx-auto max-w-5xl space-y-6 p-8"><h1 className="text-3xl font-bold">Customer records</h1>{error ? <p role="alert">{error}</p> : null}<ul>{records.map((record) => <li key={record.id}>{record.name} — {record.status}</li>)}</ul><a href="/intake">Add another record</a></main>;
}
`);
  }

  const apiPath = join(dir, "server", "_core", "api-app.ts");
  if (existsSync(apiPath)) {
    const routes = [
      ...(scannerWorkflow ? ['  app.post("/api/uploads", (_req, res) => res.json({ ok: true, stored: true }));', '  app.post("/api/scans", (req, res) => res.json({ ok: true, scan: req.body ?? {} }));', '  app.post("/api/scan-item", (req, res) => res.json({ ok: true, result: req.body?.result ?? null }));', '  app.post("/api/inventory", (req, res) => res.json({ ok: true, item: req.body ?? {} }));'] : []),
      ...(genericProductWorkflow ? ['  app.get("/api/records", (_req, res) => res.json({ ok: true, records: [{ id: "lead-1", name: "Sample customer", status: "new" }] }));', '  app.post("/api/intake", (req, res) => res.json({ ok: true, lead: { id: "lead-" + Date.now(), ...req.body } }));', '  app.patch("/api/pipeline/:id", (req, res) => res.json({ ok: true, id: req.params.id, updates: req.body ?? {} }));'] : []),
    ];
    insertApiRoutes(apiPath, routes);
  }
  return true;
}

function insertApiRoutes(apiPath: string, routes: string[]): void {
  if (routes.length === 0) return;
  let api = readFileSync(apiPath, "utf8");
  const missingRoutes = routes.filter((route) => {
    const routeMatch = route.match(/app\.(get|post|patch|put|delete)\("([^"]+)"/);
    return routeMatch ? !api.includes(`app.${routeMatch[1]}("${routeMatch[2]}"`) : !api.includes(route);
  });
  if (missingRoutes.length === 0) return;

  const block = `\n${missingRoutes.join("\n")}\n`;
  if (api.includes("  registerOAuthRoutes(app);")) {
    api = api.replace("  registerOAuthRoutes(app);", `${block}\n  registerOAuthRoutes(app);`);
  } else {
    api = api.replace("  return app;", `${block}\n  return app;`);
  }
  writeFileSync(apiPath, api);
}

function inferSeoProfileFromPrompt(prompt: string): string {
  const text = prompt.toLowerCase();
  if (/local|service area|city|near me|contractor|roof|remodel|plumb|electric|hvac|realtor|real estate|realty|brokerage|homes for sale|seo/.test(text)) return "local-service";
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
  scaffoldSanitizerActions?: string[];
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
    ...(args.scaffoldSanitizerActions?.length ? { scaffoldSanitizerActions: args.scaffoldSanitizerActions } : {}),
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

function applyLocalServiceStarterContent(dir: string): void {
  const state = readProjectState(dir);
  const spec = state?.appSpec;
  if (!state || !spec) return;
  const appPath = join(dir, "client", "src", "App.tsx");
  rmSync(join(dir, "client", "src", "pages"), { recursive: true, force: true });
  const pages = Array.isArray(spec.pages) ? spec.pages.map((page) => ({ path: typeof page.path === "string" ? page.path : String(page), title: typeof page.title === "string" ? page.title : routeTitle(typeof page.path === "string" ? page.path : String(page)) })) : [];
  const services = pages.filter((page) => page.path.startsWith("/services/")).map((page) => ({ slug: page.path.split("/").filter(Boolean).at(-1) ?? "service", title: page.title }));
  const cities = pages.filter((page) => page.path.startsWith("/service-areas/")).map((page) => ({ slug: page.path.split("/").filter(Boolean).at(-1) ?? "area", title: page.title }));
  const projectTitle = buildTemplatePlaceholderValues(state.name).project_title;
  writeFileSync(appPath, `import { type ReactNode, useState } from "react";
import { Route, Switch, useLocation } from "wouter";
import { ArrowRight, CheckCircle2, Menu, PhoneCall, ShieldCheck, Star, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const projectTitle = ${JSON.stringify(projectTitle)};
const services = ${JSON.stringify(services.length ? services : [{ slug: "project-review", title: "Project Review" }], null, 2)};
const cities = ${JSON.stringify(cities.length ? cities : [{ slug: "primary-service-area", title: "Primary Service Area" }], null, 2)};
const navItems = [
  { href: "/", label: "Home" },
  { href: "/services", label: "Services" },
  { href: "/process", label: "Process" },
  { href: "/about", label: "About" },
  { href: "/service-areas", label: "Service Areas" },
  { href: "/projects", label: "Projects" },
  { href: "/reviews", label: "Reviews" },
  { href: "/faq", label: "FAQ" },
  { href: "/contact", label: "Contact" },
];

function AppLink({ href, className, children, onClick }: { href: string; className?: string; children: ReactNode; onClick?: () => void }) {
  const [, setLocation] = useLocation();
  return <a href={href} className={className} onClick={(event) => { if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return; event.preventDefault(); onClick?.(); setLocation(href); window.scrollTo(0, 0); }}>{children}</a>;
}

function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const close = () => setMenuOpen(false);
  return <div className="min-h-screen bg-zinc-950 text-white"><header className="fixed top-0 z-50 w-full border-b border-white/10 bg-zinc-950/95 backdrop-blur"><div className="container mx-auto flex h-20 items-center justify-between px-5"><AppLink href="/" className="text-xl font-black" onClick={close}>{projectTitle}</AppLink><nav className="hidden items-center gap-5 text-sm font-bold text-zinc-300 xl:flex">{navItems.map((item) => <AppLink key={item.href} href={item.href} className="hover:text-white">{item.label}</AppLink>)}</nav><AppLink href="/contact" className="hidden md:block"><Button className="bg-blue-600 font-bold hover:bg-blue-700">Request project review</Button></AppLink><button className="xl:hidden" aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X /> : <Menu />}</button></div>{menuOpen && <nav className="grid gap-3 border-t border-white/10 p-5 xl:hidden">{navItems.map((item) => <AppLink key={item.href} href={item.href} onClick={close} className="rounded-xl border border-white/10 p-3">{item.label}</AppLink>)}</nav>}</header><main className="pt-20">{children}</main><StickyAuditRail /><footer className="border-t border-white/10 bg-black px-6 py-12 text-sm text-zinc-400"><div className="container mx-auto grid gap-8 md:grid-cols-3"><div><strong className="text-white">{projectTitle}</strong><p className="mt-3 leading-7">Customer-ready service details, local coverage, project-review CTAs, and honest next-step copy.</p></div><div><strong className="text-white">Service Areas</strong><div className="mt-3 grid gap-2">{cities.slice(0, 5).map((city) => <AppLink key={city.slug} href={"/service-areas/" + city.slug} className="hover:text-white">{city.title}</AppLink>)}</div></div><div><strong className="text-white">Next step</strong><p className="mt-3">Call, email, or send project details for review. No sales pressure, just honest advice.</p></div></div></footer></div>;
}

function HeroBand({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return <section className="relative overflow-hidden px-6 py-20 sm:py-28"><div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(37,99,235,0.28),transparent_34%),linear-gradient(135deg,#0c1224,#09090b)]" /><div className="container mx-auto grid max-w-7xl gap-12 xl:grid-cols-[1fr_0.85fr] xl:items-center"><div><Badge className="mb-6 border-blue-500/30 bg-blue-500/10 text-blue-200">{eyebrow}</Badge><h1 className="max-w-5xl text-5xl font-black leading-tight tracking-tight sm:text-6xl">{title}</h1><p className="mt-6 max-w-3xl text-lg leading-8 text-zinc-300">{body}</p><div className="mt-9 flex flex-col gap-4 sm:flex-row"><AppLink href="/contact"><Button size="lg" className="bg-blue-600 font-bold hover:bg-blue-700">Request project review <ArrowRight className="ml-2 h-5 w-5" /></Button></AppLink><AppLink href="/services"><Button size="lg" variant="outline" className="border-white/15 bg-white/5 text-white hover:bg-white/10">Review services</Button></AppLink></div></div><LeadOpsVisual /></div></section>;
}

function LeadOpsVisual() { return <div className="rounded-[2rem] border border-blue-400/20 bg-white/[0.06] p-6 shadow-2xl shadow-blue-950/40"><p className="font-black text-blue-100">Project Readiness Visual</p><div className="mt-5 grid gap-4">{["Problem", "Photos", "Urgency", "Follow-up"].map((item) => <div key={item} className="rounded-2xl border border-white/10 bg-black/30 p-4"><span className="text-sm text-zinc-400">Captured</span><p className="text-2xl font-black">{item}</p></div>)}</div><p className="mt-5 rounded-2xl border border-blue-300/20 bg-blue-500/10 p-4 text-sm leading-6 text-blue-100">Clear service details, honest proof, and a review path before anyone promises timing or price.</p></div>; }
function LeadFlowLineSection() { return <section className="px-6 py-24"><SectionIntro badge="Project request path" title="One clean line from project details to next steps." body="Visitors need to know what problem fits, what information to send, what happens after the request, and how to reach the business without guessing." /><div className="container mx-auto grid gap-4 md:grid-cols-5">{["Problem", "Photos", "Review", "Questions", "Schedule"].map((step, index) => <div key={step} className="rounded-2xl border border-white/10 bg-zinc-900 p-5"><span className="text-sm font-black text-blue-300">0{index + 1}</span><h3 className="mt-2 text-xl font-black">{step}</h3></div>)}</div></section>; }
function LeadLeakAudit() { const [active, setActive] = useState(services[0]?.title || "Project Review"); return <section className="px-6 py-24"><div className="container mx-auto rounded-[2rem] border border-blue-400/20 bg-blue-500/10 p-8"><SectionIntro badge="Fit check" title="Help the homeowner identify the right service before they reach out." body="A useful page sorts urgent work from planned work and asks for the details needed for a real first conversation." /><div className="grid gap-3 md:grid-cols-2">{services.slice(0, 6).map((service) => <button key={service.slug} onClick={() => setActive(service.title)} className={\`rounded-2xl border p-4 text-left font-bold \${active === service.title ? "border-blue-300 bg-blue-500/20" : "border-white/10 bg-black/20"}\`}>{service.title}</button>)}</div><p className="mt-6 text-lg font-bold text-blue-100">Selected review path: {active}</p></div></section>; }
function BeforeAfterComparison() { return <section className="px-6 py-24"><SectionIntro badge="Before / after" title="Generic inquiry versus a useful project request." body="The better version gathers context, photos, timing, and preferred follow-up so the next conversation is productive." /><div className="container mx-auto grid gap-6 lg:grid-cols-2"><CardBlock title="Weak request" items={["Only a name and phone", "No urgency", "No project type", "No photos", "No clear next step"]} /><CardBlock title="Useful request" items={["Service selected", "Problem described", "Photos encouraged", "Email follow-up available", "Warm thank-you copy"]} /></div></section>; }
function StickyAuditRail() { return <AppLink href="/contact" className="fixed bottom-6 right-6 z-40 hidden rounded-full bg-blue-600 px-5 py-3 text-sm font-black shadow-2xl shadow-blue-900/40 lg:inline-flex">Request review <ArrowRight className="ml-2 h-4 w-4" /></AppLink>; }
function SectionIntro({ badge, title, body }: { badge: string; title: string; body: string }) { return <div className="container mx-auto mb-12 max-w-3xl"><Badge className="mb-4 border-white/10 bg-white/5 text-zinc-300">{badge}</Badge><h2 className="text-4xl font-black tracking-tight sm:text-5xl">{title}</h2><p className="mt-5 text-lg leading-8 text-zinc-400">{body}</p></div>; }
function CardBlock({ title, items }: { title: string; items: string[] }) { return <Card className="border-white/10 bg-zinc-900 text-white"><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><ul className="grid gap-3">{items.map((item) => <li key={item} className="flex gap-2 text-zinc-300"><CheckCircle2 className="h-5 w-5 text-blue-300" />{item}</li>)}</ul></CardContent></Card>; }
function ServicesIndex() { return <><HeroBand eyebrow="Services" title={"Services " + projectTitle + " can explain clearly"} body="Each service detail should help a homeowner understand the problem, what information to gather, and how to request a review without fake promises." /><section className="px-6 py-20"><div className="container mx-auto grid gap-5 md:grid-cols-2 xl:grid-cols-3">{services.map((service) => <AppLink key={service.slug} href={"/services/" + service.slug} className="rounded-2xl border border-white/10 bg-zinc-900 p-6 hover:border-blue-400/40"><Wrench className="mb-4 h-7 w-7 text-blue-300" /><h2 className="text-2xl font-black">{service.title}</h2><p className="mt-3 leading-7 text-zinc-400">Problem details, photos, urgency, and preferred follow-up help make the first conversation useful.</p></AppLink>)}</div></section><LeadLeakAudit /><CTA /></>; }
function ServicePage() { const [location] = useLocation(); const slug = location.split("/").filter(Boolean).at(-1); const service = services.find((item) => item.slug === slug) || services[0]; return <><HeroBand eyebrow="Service" title={service.title + " review and next steps"} body="Tell visitors what problems fit this service, what to collect before reaching out, and what happens after the request is reviewed." /><section className="px-6 py-20"><div className="container mx-auto grid gap-6 lg:grid-cols-3"><CardBlock title="What to send" items={["Photos when safe", "Where the issue is", "When it started", "How urgent it feels"]} /><CardBlock title="What we avoid" items={["Fake 24/7 claims", "Unsupported license claims", "Instant-price promises", "Pressure-heavy sales copy"]} /><CardBlock title="Next step" items={["Review the details", "Ask clarifying questions", "Confirm fit and timing", "Schedule or advise honestly"]} /></div></section><CTA /></>; }
function ServiceAreasIndex() { return <><HeroBand eyebrow="Service Areas" title="Local coverage with useful homeowner context." body="Good area content connects real services to what the visitor needs to know before calling instead of swapping city names into generic copy." /><section className="px-6 py-20"><div className="container mx-auto grid gap-5 md:grid-cols-2 xl:grid-cols-3">{cities.map((city) => <AppLink key={city.slug} href={"/service-areas/" + city.slug} className="rounded-2xl border border-white/10 bg-zinc-900 p-6 hover:border-blue-400/40"><h2 className="text-2xl font-black">{city.title}</h2><p className="mt-3 leading-7 text-zinc-400">Service requests in this area should include address context, photos, urgency, and preferred follow-up.</p></AppLink>)}</div></section><CTA /></>; }
function CityPage() { const [location] = useLocation(); const slug = location.split("/").filter(Boolean).at(-1); const city = cities.find((item) => item.slug === slug) || cities[0]; return <><HeroBand eyebrow="Local service" title={projectTitle + " project reviews in " + city.title} body="Use this page to explain service fit, local context, request details, photos, and honest next steps." /><section className="px-6 py-20"><div className="container mx-auto grid gap-6 lg:grid-cols-3"><CardBlock title="Useful details" items={["Address or nearby area", "Project type", "Photos if available", "Urgency and timing"]} /><CardBlock title="Common services" items={services.slice(0, 4).map((service) => service.title)} /><CardBlock title="Follow-up" items={["Email encouraged", "Phone available", "Review before advice", "Booking link can be added when connected"]} /></div></section><CTA /></>; }
function Process() { return <><HeroBand eyebrow="Process" title="Review first. Advise honestly. Schedule when it fits." body="The flow should set expectations without pretending instant dispatch, AI review, or same-day service exists unless the business supplied it." /><LeadFlowLineSection /><CTA /></>; }
function About() { return <><HeroBand eyebrow="About" title={projectTitle + " should sound like a real local business."} body="The page explains service fit, proof, and next steps in plain language without unsupported claims." /><BeforeAfterComparison /><CTA /></>; }
function Projects() { return <><HeroBand eyebrow="Proof" title="Project proof should be real or clearly absent." body="Use real photos, real reviews, and real credentials when supplied. Do not invent proof." /><section className="px-6 py-20"><div className="container mx-auto grid gap-5 md:grid-cols-3">{["Photos", "Reviews", "Scope notes"].map((item) => <CardBlock key={item} title={item} items={["Add only when supplied", "Keep claims neutral", "Explain what matters"]} />)}</div></section><CTA /></>; }
function Reviews() { return <><HeroBand eyebrow="Reviews" title="Trust proof belongs here when supplied." body="If reviews are not supplied yet, this page should explain the review standard without fake counts or ratings." /><CTA /></>; }
function FAQ() { return <><HeroBand eyebrow="FAQ" title="Answer the questions that block the first call." body="Helpful FAQs cover fit, photos, timing, quote expectations, follow-up, and what not to promise before review." /><section className="px-6 py-20"><div className="container mx-auto grid gap-5 md:grid-cols-2">{["Should I call or send photos?", "What happens after I submit?", "Can I book online?", "Do you promise emergency service?"].map((q) => <CardBlock key={q} title={q} items={["Send the safest useful details.", "The project is reviewed before advice.", "Booking can be added when connected.", "No unsupported response-time promises."]} />)}</div></section></>; }
function Contact() { return <><HeroBand eyebrow="Contact" title="Send project details for a real review." body="Thanks — Toby or the business owner will personally review your project and reach out. No sales pressure, just honest advice." /><section className="px-6 py-20"><div className="container mx-auto grid gap-6 lg:grid-cols-3"><CardBlock title="Send these details" items={["Name and phone", "Email for follow-up", "Service needed", "Photos if safe", "Urgency and location"]} /><CardBlock title="Contact options" items={["Call the business", "Email project details", "Use booking link when connected", "No fake instant-response claim"]} /><CardBlock title="Thank-you copy" items={["Warm confirmation", "Personal review", "Next steps", "No pressure"]} /></div></section></>; }
function PolicyPage({ title }: { title: string }) { return <><HeroBand eyebrow="Policy" title={title} body="Keep legal and privacy copy accurate for the actual business before launch." /></>; }
function CTA() { return <aside className="px-6 py-24"><div className="container mx-auto rounded-[2rem] border border-blue-500/20 bg-blue-600/10 p-8 sm:p-12"><strong className="block text-4xl font-black">Ready for a cleaner project request path?</strong><p className="mt-4 max-w-3xl leading-8 text-zinc-300">Ask for the details, review them personally, and add self-booking when the calendar is connected.</p><AppLink href="/contact" className="mt-8 inline-flex"><Button size="lg" className="bg-blue-600 font-bold hover:bg-blue-700">Request review <ArrowRight className="ml-2 h-5 w-5" /></Button></AppLink></div></aside>; }
function Home() { return <><HeroBand eyebrow="Local service website" title={projectTitle + " built around useful project requests"} body="The site should help homeowners choose the right service, send the right details, and understand what happens next without fake urgency or unsupported claims." /><LeadFlowLineSection /><LeadLeakAudit /><BeforeAfterComparison /><ServicesIndex /><CTA /></>; }
function NotFound() { return <HeroBand eyebrow="404" title="Page not found." body="Use the navigation to get back to the site." />; }

export default function App() { return <Shell><Switch><Route path="/" component={Home} /><Route path="/services" component={ServicesIndex} /><Route path="/services/:slug" component={ServicePage} /><Route path="/process" component={Process} /><Route path="/about" component={About} /><Route path="/service-areas" component={ServiceAreasIndex} /><Route path="/service-area" component={ServiceAreasIndex} /><Route path="/service-areas/:slug" component={CityPage} /><Route path="/projects" component={Projects} /><Route path="/gallery" component={Projects} /><Route path="/reviews" component={Reviews} /><Route path="/faq" component={FAQ} /><Route path="/contact" component={Contact} /><Route path="/privacy" component={() => <PolicyPage title="Privacy Policy" />} /><Route path="/terms" component={() => <PolicyPage title="Terms" />} /><Route component={NotFound} /></Switch></Shell>; }
`);
}

function routeTitle(pathValue: string): string {
  const last = pathValue.split("/").filter(Boolean).at(-1) || "Home";
  return last.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function repairGeneratedProject(dir: string, options: RepairGeneratedProjectOptions = {}): RepairGeneratedProjectResult {
  if (!existsSync(dir)) {
    failWithDetails(`Project directory not found: "${dir}"`, { errorCode: "E_NOT_FOUND", directory: dir });
  }

  const stateBeforeRepair = readProjectState(dir);
  const projectName = options.projectName || stateBeforeRepair?.name || inferProjectName(dir);
  const scaffoldActions = repairMismatchedWebStaticScaffold(dir, projectName, stateBeforeRepair);
  if ((stateBeforeRepair?.template === "web-static" || stateBeforeRepair?.profile === "web-static") && scaffoldActions.length === 0) {
    const seoProfile = stateBeforeRepair?.appSpec?.appType && /local-service|contractor/i.test(String(stateBeforeRepair.appSpec.appType)) ? "local-service" : "standard";
    applyCrawlerPrerenderSupport(dir, projectName, seoProfile);
  }
  const changedFiles = replaceTemplatePlaceholdersWithReport(dir, projectName);
  const titleSanitizerActions = sanitizePublicProjectTitle(dir, projectName);
  const sanitizerActions = sanitizeStaticWebProject(dir);
  const lockfileNeedsRefresh = hasPnpmPatchedDependencyDrift(dir) || sanitizerActions.includes("package_json_removed_static_auth_runtime_deps");
  let lockfileRefreshed = false;
  const actions = [
    ...scaffoldActions,
    ...(changedFiles.length > 0 ? ["placeholders_replaced"] : []),
    ...titleSanitizerActions,
    ...sanitizerActions,
  ];

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

function repairMismatchedWebStaticScaffold(dir: string, projectName: string, projectState = readProjectState(dir)): string[] {
  if (projectState?.template !== "web-static" && projectState?.profile !== "web-static") return [];
  const appPath = join(dir, "client", "src", "App.tsx");
  const packagePath = join(dir, "package.json");
  const packageJson = existsSync(packagePath) ? readFileSync(packagePath, "utf8") : "";
  const looksLikeMobileScaffold = /expo-router\/entry|expo\s+start|react-native|nativewind|app\.config\.ts/i.test(packageJson)
    || existsSync(join(dir, "app.config.ts"))
    || existsSync(join(dir, "metro.config.js"))
    || existsSync(join(dir, "app", "(tabs)", "index.tsx"));
  if (existsSync(appPath) && !looksLikeMobileScaffold) return [];

  const templateDir = findTemplateDir("webdev/web-static");
  if (!templateDir) {
    failWithDetails("Cannot repair web-static project: web-static template not found on disk.", {
      errorCode: "E_TEMPLATE_NOT_FOUND",
      directory: dir,
      template: "web-static",
    });
  }

  const backupDir = join(dir, ".jeriko", `mismatched-scaffold-backup-${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`);
  mkdirSync(backupDir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === ".jeriko") continue;
    const from = join(dir, entry);
    const to = join(backupDir, entry);
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }

  cpSync(templateDir, dir, { recursive: true });
  replaceTemplatePlaceholders(dir, projectName);
  const seoProfile = projectState?.appSpec?.appType && /local-service|contractor/i.test(String(projectState.appSpec.appType)) ? "local-service" : "standard";
  applyCrawlerPrerenderSupport(dir, projectName, seoProfile);
  writeProjectState(dir, normalizeRepairedWebStaticProjectState(projectState, projectName, seoProfile));
  initializeAppBuilderRun(dir, { trigger: "repair" });
  recordAppBuilderPhase(dir, "target-lock", "completed", [`directory: ${dir}`, "template: web-static", `project: ${projectName}`]);
  recordAppBuilderPhase(dir, "scaffold", "completed", ["replaced mismatched non-web-static scaffold with web-static starter", `backup: ${backupDir}`]);
  return ["replaced_mismatched_web_static_scaffold", `mismatched_scaffold_backup:${backupDir}`];
}

function normalizeRepairedWebStaticProjectState(projectState: ProjectState | null, projectName: string, seoProfile: string): ProjectState {
  const fallback = buildProjectState({ name: projectName, template: "web-static", profile: "web-static", prompt: projectState?.appSpec?.prompt, seoProfile });
  const next: ProjectState = projectState ? JSON.parse(JSON.stringify(projectState)) : fallback;
  next.name = projectName;
  next.template = "web-static";
  next.profile = "web-static";
  next.packageManager = "pnpm";
  next.commands = {
    ...(fallback.commands ?? {}),
    ...(next.commands ?? {}),
    install: "pnpm install --frozen-lockfile --ignore-scripts",
    check: "pnpm run check",
    build: "pnpm run build",
    start: seoProfile === "local-service" ? "node scripts/jeriko-static-server.mjs --port ${PORT}" : "pnpm run preview --port ${PORT} --strictPort",
    dev: "pnpm run dev",
  };
  next.appBuilderPlan = next.appBuilderPlan ?? fallback.appBuilderPlan;
  const requiredGates = new Set([...(fallback.verification?.requiredGates ?? []), ...(next.verification?.requiredGates ?? [])]);
  next.verification = { ...(fallback.verification ?? { requiredGates: [] }), ...(next.verification ?? {}), requiredGates: Array.from(requiredGates) };
  if (next.appSpec) {
    next.appSpec.pages = next.appSpec.pages.map((page) => ({
      ...page,
      path: page.path.replace(/^\/areas(?=\/|$)/, "/service-areas"),
    }));
    const allowed = new Set([...(next.appSpec.integrations?.allowed ?? []), "supabase"].map((item) => item.toLowerCase()));
    const forbidden = new Set((next.appSpec.integrations?.forbidden ?? ["stripe"]).filter((item) => item.toLowerCase() !== "supabase").map((item) => item.toLowerCase()));
    forbidden.add("stripe");
    next.appSpec.integrations = {
      allowed: Array.from(allowed),
      forbidden: Array.from(forbidden),
    };
  }
  return next;
}

function sanitizePublicProjectTitle(dir: string, projectName: string): string[] {
  const rawTitle = titleCaseProjectSlug(slugifyProjectName(projectName));
  const safeTitle = buildTemplatePlaceholderValues(projectName).project_title;
  if (!rawTitle || rawTitle === safeTitle) return [];
  const touched: string[] = [];
  walkGeneratedTextFiles(dir, (file, content) => {
    if (!content.includes(rawTitle)) return;
    writeFileSync(file, content.split(rawTitle).join(safeTitle));
    touched.push(file);
  });
  return touched.length > 0 ? ["sanitized_public_project_title"] : [];
}

function walkGeneratedTextFiles(dir: string, visit: (file: string, content: string) => void): void {
  const ignored = new Set([".git", "node_modules", "dist", ".next"]);
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(tsx?|jsx?|html|md|json|svg|txt|css)$/.test(entry.name)) continue;
      visit(full, readFileSync(full, "utf8"));
    }
  }
}

export function sanitizeStaticWebProject(dir: string): string[] {
  const actions: string[] = [];

  const constPath = join(dir, "client", "src", "const.ts");
  if (existsSync(constPath)) {
    const current = readFileSync(constPath, "utf8");
    if (/VITE_OAUTH_PORTAL_URL|VITE_APP_ID|app-auth|getLoginUrl/.test(current)) {
      writeFileSync(constPath, 'export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";\n');
      actions.push("removed_static_oauth_const_residue");
    }
  }

  const manusDialogPath = join(dir, "client", "src", "components", "ManusDialog.tsx");
  if (existsSync(manusDialogPath)) {
    rmSync(manusDialogPath, { force: true });
    actions.push("removed_manus_dialog_residue");
  }

  const viteConfigPath = join(dir, "vite.config.ts");
  if (existsSync(viteConfigPath)) {
    const current = readFileSync(viteConfigPath, "utf8");
    if (/vitePluginManusRuntime|vite-plugin-jeriko-runtime|jsxLocPlugin|@builder\.io\/vite-plugin-jsx-loc|manuspre\.computer|manus\.computer|manusvm\.computer/.test(current)) {
      writeFileSync(viteConfigPath, STATIC_WEB_VITE_CONFIG);
      actions.push("rewrote_static_vite_config_without_manus_runtime");
    } else if (/jerikoDebug\s*\(\s*\)/.test(current) && !/command\s*===\s*["']serve["']/.test(current)) {
      const repaired = current
        .replace(/export\s+default\s+defineConfig\s*\(\s*\{/, "export default defineConfig(({ command }) => ({")
        .replace(/plugins:\s*\[react\(\),\s*tailwindcss\(\),\s*jerikoDebug\(\)\]/, 'plugins: [react(), tailwindcss(), command === "serve" ? jerikoDebug() : null].filter(Boolean)')
        .replace(/\}\s*\)\s*;\s*$/, "}));\n");
      writeFileSync(viteConfigPath, repaired);
      actions.push("limited_static_debug_plugin_to_dev_server");
    }
  }

  const staleTemplateJsonPath = join(dir, "template.json");
  if (existsSync(staleTemplateJsonPath)) {
    rmSync(staleTemplateJsonPath, { force: true });
    actions.push("removed_template_metadata_residue");
  }

  const debugPluginPath = join(dir, "vite-plugin-jeriko-debug.ts");
  if (existsSync(viteConfigPath) && !existsSync(debugPluginPath)) {
    const templateDebugPlugin = findTemplateDir("webdev/web-static");
    const sourceDebugPlugin = templateDebugPlugin ? join(templateDebugPlugin, "vite-plugin-jeriko-debug.ts") : "";
    if (sourceDebugPlugin && existsSync(sourceDebugPlugin)) {
      writeFileSync(debugPluginPath, readFileSync(sourceDebugPlugin, "utf8"));
      actions.push("restored_static_debug_plugin");
    }
  }

  const packageJsonPath = join(dir, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, any>;
      let changed = false;
      for (const section of ["dependencies", "devDependencies"] as const) {
        const deps = pkg[section];
        if (!deps || typeof deps !== "object") continue;
        for (const dep of ["vite-plugin-jeriko-runtime", "@builder.io/vite-plugin-jsx-loc"]) {
          if (dep in deps) {
            delete deps[dep];
            changed = true;
          }
        }
      }
      if (changed) {
        writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
        actions.push("package_json_removed_static_auth_runtime_deps");
      }
    } catch {
      // Leave malformed package files to the existing package/check gates.
    }
  }

  return actions;
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
  if (seoProfile === "local-service") writeStaticRouteServerScript(dir);
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
  const publicDir = join(dir, "client", "public");
  if (!existsSync(srcDir)) return;
  mkdirSync(libDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(publicDir, { recursive: true });
  const projectTitle = buildTemplatePlaceholderValues(projectName).project_title ?? projectName;
  const siteConfigPath = join(srcDir, "site.config.ts");
  const robotsPath = join(publicDir, "robots.txt");
  const sitemapPath = join(publicDir, "sitemap.xml");
  const ogImagePath = join(publicDir, "og-image.svg");
  if (!existsSync(robotsPath)) writeFileSync(robotsPath, "User-agent: *\nAllow: /\n");
  if (!existsSync(sitemapPath)) writeFileSync(sitemapPath, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url></urlset>\n`);
  if (!existsSync(ogImagePath)) writeFileSync(ogImagePath, `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-label="${escapeXmlText(projectTitle)} social preview"><rect width="1200" height="630" fill="#09090b"/><rect x="70" y="70" width="1060" height="490" rx="36" fill="#171717" stroke="#f59e0b" stroke-width="4"/><text x="100" y="250" fill="#f8fafc" font-family="Inter, Arial, sans-serif" font-size="64" font-weight="800">${escapeXmlText(projectTitle)}</text><text x="102" y="330" fill="#fbbf24" font-family="Inter, Arial, sans-serif" font-size="34">Services • Proof • Process • Request</text></svg>\n`);
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
    hero: ${JSON.stringify(`Generate a realistic hero photo for ${projectTitle}: a trustworthy business team at work, natural light, no text overlay, website-safe composition. This must be unique to the hero and not reused in cards, services, projects, or galleries.`)},
    service: ${JSON.stringify(`Generate separate realistic service photos for ${projectTitle}: one distinct image per service type, different scene/composition/trade detail for each card, clean background, no logos, no text. Do not crop or rename the same photo for multiple cards.`)},
    project: ${JSON.stringify(`Generate distinct project/gallery photos for ${projectTitle}: each project card needs a unique job-site scene and different visual subject. Do not reuse a hero/service/photo with query-string crops.`)},
    og: ${JSON.stringify(`Generate a branded open graph image for ${projectTitle}: professional website preview, bold negative space, no readable text. This is only for social metadata and should not be reused as visible site photography.`)},
  },
};

export type SiteConfig = typeof siteConfig;
`);
  }

  const imagePromptPath = join(assetsDir, "image-prompts.md");
  if (!existsSync(imagePromptPath)) {
    writeFileSync(imagePromptPath, `# Website image/photo generation prompts

Use Jeriko's \`generate_image\` tool to create production assets for this site. Call it with an app-local \`output_path\` such as \`client/public/images/hero.png\`, then reference that file from the page and metadata. Do not publish these prompts as customer-facing copy. Never reuse the same photo inside one site; hero, service cards, project cards, and gallery items need distinct files and distinct visual subjects.

## Hero photo
${`Generate a realistic hero photo for ${projectTitle}: a trustworthy business team at work, natural light, no text overlay, website-safe composition. Unique hero asset only; do not reuse in cards or gallery.`}

## Service photos
${`Generate one distinct realistic service photo per service type for ${projectTitle}: different scene/composition/trade detail for each visible card, clean background, no logos, no text. Do not crop or rename the same source image for multiple services.`}

## Project/gallery photos
${`Generate distinct project/gallery photos for ${projectTitle}: each card needs a different job-site scene and visual subject. Do not reuse hero or service photos.`}

## Open Graph image
${`Generate a branded open graph image for ${projectTitle}: professional website preview, bold negative space, no readable text. Metadata use only; not visible site photography.`}
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

function writeStaticRouteServerScript(dir: string): void {
  const scriptsDir = join(dir, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  const serverPath = join(scriptsDir, "jeriko-static-server.mjs");
  if (existsSync(serverPath)) return;
  writeFileSync(serverPath, `import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const portArg = process.argv.find((arg, index) => process.argv[index - 1] === "--port");
const port = Number(portArg || process.env.PORT || 4173);
const root = join(process.cwd(), "dist", "public");
const types = new Map([[".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"], [".xml", "application/xml; charset=utf-8"], [".txt", "text/plain; charset=utf-8"], [".svg", "image/svg+xml"], [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"]]);

function resolvePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0] || "/")).replace(/^\\.\\.(?:\\/|$)/, "");
  const candidates = [join(root, clean), join(root, clean, "index.html")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return join(root, "index.html");
}

createServer((req, res) => {
  const file = resolvePath(req.url || "/");
  const type = types.get(extname(file)) || "application/octet-stream";
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => {
  console.log("Jeriko static route server listening on http://127.0.0.1:" + port);
});
`);
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
const projectState = readProjectState();
const siteConfig = readSiteConfig();
const localServiceModel = buildLocalServiceContentModel(projectState);

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
  const stateRoutes = discoverProjectStateRoutes();
  if (siteConfig.seoProfile === "local-service" && stateRoutes.length > 0) return uniqueRoutes(stateRoutes);
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

function discoverProjectStateRoutes() {
  const pages = Array.isArray(projectState?.appSpec?.pages) ? projectState.appSpec.pages : [];
  const routes = [];
  for (const page of pages) {
    const path = typeof page?.path === "string" ? page.path.trim() : "";
    if (!path || !path.startsWith("/") || path.includes(":")) continue;
    routes.push({ path, component: routeLabel(path), source: routeLabel(path) });
  }
  if (routes.length > 0 && !routes.some((route) => route.path === "/")) routes.unshift({ path: "/", component: "Home", source: "Home" });
  return routes;
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
  const title = pageTitleFor(route, content);
  const description = descriptionFor(route, content);
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
    <meta property="og:image" content="\${escapeAttr(baseUrl ? baseUrl + "/og-image.svg" : "/og-image.svg")}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="\${escapeAttr(page.title)}" />
    <meta name="twitter:description" content="\${escapeAttr(page.description)}" />
    <meta name="twitter:image" content="\${escapeAttr(baseUrl ? baseUrl + "/og-image.svg" : "/og-image.svg")}" />
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

function readProjectState() {
  const statePath = join(root, ".jeriko", "project-state.json");
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
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
  if (siteConfig.seoProfile === "local-service") return localServiceCrawlerContent(route);
  const sourcePath = join(pagesDir, route.source.endsWith(".tsx") ? route.source : \`\${route.source}.tsx\`);
  const text = existsSync(sourcePath) ? readFileSync(sourcePath, "utf8") : (existsSync(appPath) ? readFileSync(appPath, "utf8") : "");
  const candidates = [];

  for (const match of text.matchAll(/>([^<>{}][^<>{}]*)</g)) pushClean(candidates, match[1]);
  for (const match of text.matchAll(/["']([^"'\\n]{24,260})["']/g)) pushClean(candidates, match[1]);

  const paragraphs = uniqueStrings(candidates)
    .filter((value) => !looksLikeCode(value))
    .slice(0, 80);
  const heading = paragraphs.find((value) => value.length >= 8) || routeLabel(route.path) || projectTitle;
  return { heading, paragraphs: paragraphs.length ? paragraphs : [\`\${projectTitle} content for \${route.path}\`] };
}

function localServiceCrawlerContent(route) {
  const label = routeLabel(route.path);
  const serviceSlug = route.path.startsWith("/services/") ? route.path.split("/").filter(Boolean).at(-1) : "";
  const area = route.path.startsWith("/service-areas/");
  const service = localServiceModel.services.find((item) => item.slug === serviceSlug) || (serviceSlug ? { slug: serviceSlug, title: label, problem: \`\${label.toLowerCase()} project\`, emergencyAdvice: "document the issue and avoid making the damage worse", evidence: "photos, access notes, and timing" } : null);
  const coreServices = localServiceModel.services.slice(0, 5).map((item) => item.title.toLowerCase()).join(", ");
  const primaryService = localServiceModel.services[0]?.title.toLowerCase() || "service";
  const heading = route.path === "/"
    ? \`\${projectTitle} \${localServiceModel.tradeLabel} help for real home problems\`
    : service
      ? \`\${service.title} from \${projectTitle}\`
      : area
        ? \`\${projectTitle} service calls in \${label}\`
        : \`\${label} for \${projectTitle}\`;

  if (service) {
    const paragraphs = [
      \`\${service.title} starts with the problem the homeowner can see: \${service.problem}. The request asks what changed, when it started, whether water, heat, power, or access is affected, and how urgent the visit is.\`,
      \`Before the appointment, the homeowner needs the safest next step: \${service.emergencyAdvice}. Photos, fixture or equipment details, location in the home, and a preferred call or email follow-up make the first conversation less guesswork.\`,
      \`Strong \${service.title.toLowerCase()} guidance explains common causes, what the technician will check, what can change the scope, and what information helps price the work honestly. No license, warranty, 24/7, same-day, or emergency-response claim appears unless the business supplied it.\`,
      \`Useful proof for this work is specific: \${service.evidence}. The call to action stays human: ask for project details, promise review and next steps, and avoid fake instant automation claims.\`,
    ];
    return { heading, paragraphs };
  }

  if (area) {
    const paragraphs = [
      \`\${projectTitle} explains what service calls in \${label} usually need: address context, access notes, photos when safe, project timing, and whether the issue is urgent or planned.\`,
      \`Local coverage connects the area to real services like \${coreServices}. The guidance needs enough detail for a homeowner to act before calling, not thin city-name swaps.\`,
      \`Coverage in \${label} works best when the homeowner shares address context, parking or access notes, photos when safe, and whether the work is urgent or planned.\`,
      \`Honest local copy avoids invented coverage claims. If the business has not supplied license numbers, exact response windows, financing, or review counts, those claims stay out.\`,
      \`The next step is simple: call, send project details, or request a review. If a booking calendar is connected later, self-booking can appear after the request without pretending it exists today.\`,
    ];
    return { heading, paragraphs };
  }

  const paragraphs = route.path === "/"
    ? [
      \`\${projectTitle} leads with the actual \${localServiceModel.tradeLabel} problems homeowners recognize: \${coreServices}. Urgent and planned work are easy to sort before anyone fills out a form.\`,
      \`A strong request path asks for name, phone, email, address or area, project type, urgency, photos if available, and a short description. Email is encouraged because it carries automated follow-up when SMS is not active.\`,
      \`The thank-you message sounds human: Toby or the business owner will review the project details and reach out with next steps. No fake instant dispatch, no fake AI review, and no unsupported response-time promise.\`,
      \`The next conversation for \${primaryService} starts with review of the details, clarifying questions, fit and timing, then scheduling or honest advice.\`,
    ]
    : [
      \`\${label} supports the homeowner's decision with specific \${localServiceModel.tradeLabel} context instead of generic marketing filler. It ties back to common services like \${coreServices}.\`,
      \`The content answers practical questions: what problem fits, what information to gather, what photos help, what could affect scope, and when a call is better than a form.\`,
      \`Trust proof belongs here only when supplied: real reviews, real photos, real credentials, real coverage areas, and real contact options. Placeholder proof is worse than no proof.\`,
      \`The next step is visible and honest: call, email, or send project details for review. If self-booking is wired later, add the booking link to the thank-you flow.\`,
    ];
  return { heading, paragraphs };
}

function buildLocalServiceContentModel(state) {
  const prompt = String(state?.appSpec?.prompt || projectTitle).toLowerCase();
  const pageServices = Array.isArray(state?.appSpec?.pages)
    ? state.appSpec.pages.filter((page) => typeof page?.path === "string" && page.path.startsWith("/services/")).map((page) => ({ slug: page.path.split("/").filter(Boolean).at(-1), title: String(page.title || routeLabel(page.path)) }))
    : [];
  const catalog = inferTradeServiceCatalog(prompt);
  const bySlug = new Map(catalog.services.map((service) => [service.slug, service]));
  const services = uniqueServiceModels([...catalog.services, ...pageServices.map((service) => ({ ...fallbackServiceModel(service.slug, service.title), ...bySlug.get(service.slug) }))]);
  return { tradeLabel: catalog.tradeLabel, services: services.length ? services : catalog.services };
}

function inferTradeServiceCatalog(prompt) {
  if (/plumb|drain|water heater|sewer|leak/.test(prompt)) {
    return { tradeLabel: "plumbing", services: [
      { slug: "leak-repair", title: "Leak Repair", problem: "water stains, dripping pipes, wet cabinets, soft flooring, or a fixture that will not shut off", emergencyAdvice: "use the nearest shutoff valve if water is active, keep people away from electrical hazards, and take photos only when it is safe", evidence: "photos of the leak area, shutoff location, affected room, and any recent repair history" },
      { slug: "drain-cleaning", title: "Drain Cleaning", problem: "slow drains, backups, sewer odor, gurgling fixtures, or repeated clogs", emergencyAdvice: "stop using backed-up fixtures and avoid chemical drain cleaners that can damage pipes or expose the technician to hazards", evidence: "which fixtures are affected, when the backup happens, and whether multiple drains are involved" },
      { slug: "water-heaters", title: "Water Heaters", problem: "no hot water, leaking tanks, rusty water, pilot or ignition trouble, or inconsistent temperature", emergencyAdvice: "avoid touching hot water or electrical/gas controls if there is visible damage, and document the model label when safe", evidence: "unit photos, model and age, fuel type, leak location, and hot-water symptoms" },
      { slug: "sewer-line-repair", title: "Sewer Line Repair", problem: "yard soft spots, sewer smell, multiple fixture backups, or recurring main-line clogs", emergencyAdvice: "limit water use until the issue is reviewed and keep children and pets away from contaminated areas", evidence: "cleanout location, backup pattern, exterior photos, and any camera or previous service notes" },
      { slug: "fixture-installation", title: "Fixture Installation", problem: "new faucets, toilets, sinks, disposals, shutoffs, or supply lines that need installed or replaced", emergencyAdvice: "confirm product fit, access, and existing shutoff condition before removing the old fixture", evidence: "photos of the existing fixture, product box/model, shutoff valves, and surrounding cabinet or wall access" },
      { slug: "repiping", title: "Repiping", problem: "aging supply lines, recurring leaks, low pressure, discolored water, or remodel-driven pipe replacement", emergencyAdvice: "note active leaks and avoid opening walls until the scope is reviewed", evidence: "pipe material photos, affected rooms, pressure symptoms, and remodel timing" },
    ] };
  }
  if (/roof|shingle|storm|gutter/.test(prompt)) {
    return { tradeLabel: "roofing", services: [
      { slug: "roof-replacement", title: "Roof Replacement", problem: "aged shingles, repeated leaks, storm wear, or a roof near the end of service life", emergencyAdvice: "avoid climbing on the roof and document visible damage from the ground when safe", evidence: "exterior photos, attic leak signs, age estimate, insurance status, and storm date" },
      { slug: "roof-repair", title: "Roof Repair", problem: "localized leaks, missing shingles, flashing trouble, or storm damage", emergencyAdvice: "protect interior belongings from active water and avoid temporary roof work in unsafe weather", evidence: "leak location, ceiling photos, roof slope area, and weather timing" },
      { slug: "storm-damage-restoration", title: "Storm Damage Restoration", problem: "hail, wind, fallen limbs, or sudden exterior damage", emergencyAdvice: "take ground-level photos and avoid signing rushed repair agreements before the damage is reviewed", evidence: "storm date, photos, insurance claim status, and affected elevations" },
      { slug: "roof-inspections", title: "Roof Inspections", problem: "unknown roof condition before buying, selling, repairing, or planning replacement", emergencyAdvice: "do not climb onto the roof; gather age, leak history, and accessible attic photos", evidence: "roof age, known leaks, property photos, and inspection deadline" },
      { slug: "gutter-installation", title: "Gutter Installation", problem: "overflow, drainage damage, missing gutters, or roofline water control", emergencyAdvice: "note where water pools and avoid ladder work during storms", evidence: "fascia photos, downspout locations, drainage problem areas, and roofline measurements if available" },
    ] };
  }
  if (/hvac|air conditioning|furnace|heat pump/.test(prompt)) {
    return { tradeLabel: "HVAC", services: [
      { slug: "ac-repair", title: "AC Repair", problem: "warm air, frozen lines, short cycling, noise, or sudden cooling loss", emergencyAdvice: "turn the system off if it is frozen or making unsafe noises and note thermostat readings", evidence: "equipment photos, thermostat settings, error codes, and when cooling stopped" },
      { slug: "ac-installation", title: "AC Installation", problem: "old equipment, poor comfort, high bills, or replacement planning", emergencyAdvice: "gather current equipment details and comfort issues before choosing a size", evidence: "model labels, home size, comfort complaints, and replacement goals" },
      { slug: "heating-repair", title: "Heating Repair", problem: "no heat, burner trouble, odd smells, cycling, or uneven rooms", emergencyAdvice: "leave the system off if there is a gas smell and follow emergency utility guidance", evidence: "equipment photos, fuel type, thermostat status, and error lights" },
      { slug: "maintenance", title: "Maintenance", problem: "seasonal tune-up, filter issues, weak airflow, or reliability concerns", emergencyAdvice: "replace accessible filters if appropriate and note recurring symptoms", evidence: "system age, filter size, maintenance history, and comfort notes" },
    ] };
  }
  return { tradeLabel: "home service", services: [
    { slug: "project-review", title: "Project Review", problem: "a homeowner needs scope, timing, photos, and next steps reviewed", emergencyAdvice: "document the issue clearly and avoid unsafe temporary work", evidence: "photos, address or area, project type, urgency, budget range, and preferred follow-up" },
    { slug: "repair-service", title: "Repair Service", problem: "something needs diagnosed and repaired before it gets worse", emergencyAdvice: "make the area safe and gather photos before requesting help", evidence: "symptom notes, photos, timing, and access details" },
    { slug: "installation-service", title: "Installation Service", problem: "a product, fixture, or project needs proper installation", emergencyAdvice: "confirm product fit and site access before scheduling", evidence: "product details, current condition, measurements, and desired timing" },
  ] };
}

function fallbackServiceModel(slug, title) {
  return { slug, title, problem: \`a \${String(title).toLowerCase()} request that needs clear scope and timing\`, emergencyAdvice: "document the condition, avoid unsafe temporary work, and collect photos when safe", evidence: "photos, location, urgency, measurements, and preferred contact details" };
}

function uniqueServiceModels(services) {
  const seen = new Set();
  return services.filter((service) => {
    if (!service?.slug || seen.has(service.slug)) return false;
    seen.add(service.slug);
    return true;
  });
}

function pageTitleFor(route, content) {
  const base = route.path === "/" ? projectTitle : \`\${content.heading} | \${projectTitle}\`;
  const trimmed = String(base || "").trim();
  return trimmed.length >= 8 ? trimmed : \`\${trimmed || "Home"} Website\`;
}

function descriptionFor(route, content) {
  const label = routeLabel(route.path);
  const body = content.paragraphs.join(" ").replace(/\\s+/g, " ").trim();
  const prefix = route.path === "/"
    ? \`\${projectTitle} helps visitors understand services, service area, proof, process, and request steps.\`
    : \`\${label}: \${projectTitle} explains this route with specific service details, local context, proof, process, and estimate request steps.\`;
  return \`\${prefix} \${body}\`.slice(0, 300);
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
  return looksLikeCssClassList(value)
    || /^(className|function|return|import|export|const|let|var)\\b/.test(value)
    || /\\b(import|export|const|let|var)\\s+[A-Za-z_$][\\w$]*\\b/.test(value)
    || /;\\s*import\\s+from\\b/.test(value)
    || /^\\/?(?:images|assets)\\//.test(value)
    || /\\.(?:png|jpe?g|webp|svg|gif)\\b/i.test(value)
    || /^(tel:|mailto:|https?:)/i.test(value)
    || /(^[,;:]|["'],|:\\s*$)/.test(value)
    || /[{}<>]=?|=>|\\.tsx|@\\//.test(value)
    || value.includes("--")
    || value.length > 500;
}

function looksLikeCssClassList(value) {
  const parts = String(value).trim().split(/\\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  const classLike = parts.filter((part) => /^(?:[a-z]+:)*-?[a-z][a-z0-9]*(?:-[a-z0-9/[\\].()#%]+|\\[[^\\]]+\\]|\\/\\d+)+$/i.test(part)).length;
  return classLike >= Math.max(2, Math.ceil(parts.length * 0.6));
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

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildTemplatePlaceholderValues(projectName: string): Record<string, string> {
  const projectSlug = slugifyProjectName(projectName);
  const projectTitle = publicProjectTitle(projectSlug);

  const bundleName = projectSlug.replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "") || "app";
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

  return {
    project_name: projectSlug,
    project_title: projectTitle,
    app_env_prefix: projectSlug.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "APP",
    bundle_id: `space.manus.${bundleName}.t${timestamp}`,
  };
}

function publicProjectTitle(projectSlug: string): string {
  const cleanedSlug = projectSlug
    .replace(/^(?:production[-_ ]*)?ready[-_ ]*/i, "")
    .replace(/^demo[-_ ]*/i, "")
    .replace(/^sample[-_ ]*/i, "")
    .replace(/^test[-_ ]*/i, "")
    .replace(/^site[-_ ]*/i, "")
    .replace(/^website[-_ ]*/i, "")
    .replace(/^app[-_ ]*/i, "")
    || projectSlug;
  return titleCaseProjectSlug(cleanedSlug);
}

function titleCaseProjectSlug(projectSlug: string): string {
  return projectSlug
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "App";
}

function slugifyProjectName(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_.]{2,}/g, "-") || "app";
}
