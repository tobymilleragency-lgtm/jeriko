import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { fail, failWithDetails, ok } from "../../../shared/output.js";
import { existsSync, readFileSync, readdirSync, accessSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { readProjectState, writeProjectState, type AppProfile, type ProjectState } from "./project-state.js";

export { readProjectState } from "./project-state.js";

export interface VerificationGate {
  name: string;
  ok: boolean;
  command?: string;
  status?: number;
  output?: string;
}

export interface PlaceholderHit {
  file: string;
  line: number;
  token: string;
}

export interface UnsafeEnvHit {
  file: string;
  line: number;
  token: string;
  reason: string;
}

export interface DependencyStatus {
  packageJson: boolean;
  nodeModules: boolean;
  missingNodeModules: boolean;
  message: string;
}

export interface CrawlerHtmlStatus {
  checked: boolean;
  ok: boolean;
  file?: string;
  output: string;
}

const PLACEHOLDER_PATTERN = /\{\{[a-zA-Z0-9_]+\}\}|__PLACEHOLDER__|<%=?\s*[^%]+%>/g;
const UNSAFE_ENV_PATTERN = /\bVITE_SUPABASE_(URL|ANON_KEY)\b/g;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".svelte-kit", "coverage"]);
const MAX_OUTPUT = 12_000;

export const command: CommandHandler = {
  name: "verify-app",
  description: "Run app-factory verification gates for a generated app",
  async run(args: string[]) {
    const parsed = parseArgs(args);
    if (flagBool(parsed, "help")) {
      printHelp();
      process.exit(0);
    }

    const dir = resolve(parsed.positional[0] || flagStr(parsed, "dir", ""));
    if (!parsed.positional[0] && !flagStr(parsed, "dir", "")) {
      fail("Missing app directory. Usage: jeriko verify-app <dir> [--profile web-static|web-db-user]");
    }
    if (!existsSync(dir)) {
      failWithDetails(`App directory not found: "${dir}"`, { errorCode: "E_NOT_FOUND", directory: dir });
    }

    const projectState = readProjectState(dir);
    const profile = parseProfile(flagStr(parsed, "profile", "") || projectState?.profile || inferAppProfile(dir));
    const skipInstall = flagBool(parsed, "skip-install");
    const skipStart = flagBool(parsed, "skip-start");
    const skipBrowser = flagBool(parsed, "skip-browser");
    const explicitPort = Boolean(flagStr(parsed, "port", ""));
    const requestedPort = flagStr(parsed, "port", "4173");
    const port = skipStart
      ? requestedPort
      : await resolveVerificationPort(requestedPort, { strict: explicitPort });
    const route = flagStr(parsed, "route", defaultRouteForProfile(profile, projectState));
    const browserRoute = flagStr(parsed, "browser-route", projectState?.routes?.home || "/");

    const gates: VerificationGate[] = [];
    const placeholders = scanPlaceholders(dir);
    gates.push({ name: "placeholder_scan", ok: placeholders.length === 0 });
    if (placeholders.length > 0) {
      failWithDetails("Generated app still contains raw template placeholders.", {
        errorCode: "E_PLACEHOLDERS",
        directory: dir,
        profile,
        projectState,
        placeholders,
        gates,
      });
    }

    const unsafeEnvRefs = scanUnsafeEnvRefs(dir);
    gates.push({ name: "unsafe_env_scan", ok: unsafeEnvRefs.length === 0 });
    if (unsafeEnvRefs.length > 0) {
      failWithDetails("Generated app uses generic Supabase VITE env names that can couple it to another local app. Use app-specific env names instead.", {
        errorCode: "E_UNSAFE_ENV",
        directory: dir,
        profile,
        projectState,
        unsafeEnvRefs,
        gates,
      });
    }

    const dependencyStatus = getDependencyStatus(dir);
    const mustInstallBeforeVerification = dependencyStatus.packageJson && !dependencyStatus.nodeModules;
    const shouldRunInstall = !skipInstall || mustInstallBeforeVerification;
    if (shouldRunInstall) {
      const installCommand = projectState?.commands?.install || detectFrozenInstallCommand(dir);
      if (installCommand) {
        const gate = runGate("install", installCommand, dir);
        if (skipInstall && mustInstallBeforeVerification) {
          gate.output = `node_modules missing; --skip-install ignored so frozen install runs before check/build.\n${gate.output || ""}`.slice(0, MAX_OUTPUT);
        }
        gates.push(gate);
        if (!gate.ok) return failGate(dir, profile, gates, gate, dependencyStatus);
      } else if (mustInstallBeforeVerification) {
        const gate: VerificationGate = {
          name: "install",
          ok: false,
          status: 1,
          output: "node_modules is missing and no frozen install command could be detected. Cannot run check/build before dependencies are installed.",
        };
        gates.push(gate);
        return failGate(dir, profile, gates, gate, dependencyStatus);
      }
    }

    const postInstallDependencyStatus = getDependencyStatus(dir);
    if (postInstallDependencyStatus.packageJson && !postInstallDependencyStatus.nodeModules) {
      const gate: VerificationGate = {
        name: "dependency_preflight",
        ok: false,
        status: 1,
        output: "node_modules is still missing after the install preflight. Refusing to run check/build because local package binaries (for example tsc/vite) will not exist.",
      };
      gates.push(gate);
      return failGate(dir, profile, gates, gate, postInstallDependencyStatus);
    }

    const checkCommand = projectState?.commands?.check || detectScriptCommand(dir, "check");
    if (checkCommand) {
      const gate = runGate("check", checkCommand, dir);
      gates.push(gate);
      if (!gate.ok) return failGate(dir, profile, gates, gate);
    }

    const buildCommand = projectState?.commands?.build || detectScriptCommand(dir, "build");
    if (buildCommand) {
      const gate = runGate("build", buildCommand, dir);
      gates.push(gate);
      if (!gate.ok) return failGate(dir, profile, gates, gate);

      const crawlerHtmlStatus = scanCrawlerHtml(dir);
      if (crawlerHtmlStatus.checked) {
        const crawlerHtmlGate: VerificationGate = {
          name: "crawler_html",
          ok: crawlerHtmlStatus.ok,
          status: crawlerHtmlStatus.ok ? 0 : 1,
          output: crawlerHtmlStatus.output,
        };
        gates.push(crawlerHtmlGate);
        if (!crawlerHtmlGate.ok) return failGate(dir, profile, gates, crawlerHtmlGate);
      }
    }

    if (!skipStart) {
      const startGate = await runStartRouteGate(dir, profile, port, route, projectState);
      gates.push(startGate);
      if (!startGate.ok) return failGate(dir, profile, gates, startGate);

      if (!skipBrowser) {
        const browserGate = await runBrowserSmokeGate(dir, profile, port, browserRoute);
        gates.push(browserGate);
        if (!browserGate.ok) return failGate(dir, profile, gates, browserGate);
      }
    }

    const finalDependencyStatus = getDependencyStatus(dir);
    const finalProjectState = projectState ? recordSuccessfulVerification(dir, projectState, profile, gates) : projectState;
    ok({ directory: dir, profile, projectState: finalProjectState, dependencyStatus: finalDependencyStatus, gates });
  },
};

function printHelp(): void {
  console.log("Usage: jeriko verify-app <dir> [options]");
  console.log("\nRuns app-factory verification gates against a generated app.");
  console.log("\nFlags:");
  console.log("  --profile <name>    web-static or web-db-user (default: inferred)");
  console.log("  --skip-install      Skip install only if node_modules already exists; missing deps force install before check/build");
  console.log("  --skip-start        Skip start + route HTTP gate");
  console.log("  --skip-browser      Skip browser hydration/console smoke gate");
  console.log("  --port <port>       Port for start/preview gate (default: 4173; auto-advances when default is busy)");
  console.log("  --route <path>      Route to probe after start (default: profile-specific)");
  console.log("  --browser-route <p> Frontend route to smoke in headless Chrome (default: /)");
}

function parseProfile(profile: string): AppProfile {
  if (profile === "web-static" || profile === "web-db-user") return profile;
  fail(`Unknown app profile: ${profile}. Expected web-static or web-db-user.`);
}

export function defaultRouteForProfile(profile: AppProfile, projectState?: ProjectState | null): string {
  return projectState?.routes?.health || (profile === "web-db-user" ? "/api/health" : "/");
}

export function inferAppProfile(dir: string): AppProfile {
  const projectState = readProjectState(dir);
  if (projectState?.profile) return projectState.profile;
  if (existsSync(join(dir, "server")) && (existsSync(join(dir, "drizzle.config.ts")) || existsSync(join(dir, "drizzle.config.js")))) {
    return "web-db-user";
  }
  return "web-static";
}

function recordSuccessfulVerification(dir: string, projectState: ProjectState, profile: AppProfile, gates: VerificationGate[]): ProjectState {
  const slimGates = gates.map((gate) => ({
    name: gate.name,
    ok: gate.ok,
    ...(gate.command ? { command: gate.command } : {}),
    ...(typeof gate.status === "number" ? { status: gate.status } : {}),
  }));
  const updated: ProjectState = {
    ...projectState,
    verification: {
      ...projectState.verification,
      lastSuccessfulVerification: {
        ok: true,
        profile,
        completedAt: new Date().toISOString(),
        command: `jeriko verify-app ${dir}`,
        gates: slimGates,
      },
    },
  };
  writeProjectState(dir, updated);
  return updated;
}

export function getDependencyStatus(dir: string): DependencyStatus {
  const packageJson = existsSync(join(dir, "package.json"));
  const nodeModules = existsSync(join(dir, "node_modules"));
  return {
    packageJson,
    nodeModules,
    missingNodeModules: packageJson && !nodeModules,
    message: packageJson
      ? nodeModules
        ? "node_modules present; local package binaries should be available."
        : "node_modules missing; run frozen install before check/build so local package binaries (for example tsc/vite) exist."
      : "No package.json detected; dependency install is not required for this directory.",
  };
}

export function scanPlaceholders(dir: string): PlaceholderHit[] {
  const hits: PlaceholderHit[] = [];
  walkTextFiles(dir, (file, content) => {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const match of line.matchAll(PLACEHOLDER_PATTERN)) {
        hits.push({ file, line: i + 1, token: match[0] });
      }
    }
  });
  return hits;
}

export function scanUnsafeEnvRefs(dir: string): UnsafeEnvHit[] {
  const hits: UnsafeEnvHit[] = [];
  walkTextFiles(dir, (file, content) => {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const match of line.matchAll(UNSAFE_ENV_PATTERN)) {
        hits.push({
          file,
          line: i + 1,
          token: match[0],
          reason: "Use an app-specific env name such as VITE_<APP>_SUPABASE_URL so local credentials from another app cannot be embedded.",
        });
      }
    }
  });
  return hits;
}

export function scanCrawlerHtml(dir: string): CrawlerHtmlStatus {
  const indexPath = join(dir, "dist", "public", "index.html");
  if (!existsSync(indexPath)) {
    return { checked: false, ok: true, output: "dist/public/index.html not found; crawler HTML gate skipped." };
  }

  const html = readFileSync(indexPath, "utf8");
  const hasPrerenderMarker = html.includes('data-jeriko-prerender="true"') || html.includes("data-jeriko-prerender='true'");
  const hasRootFallback = /<div\s+id=["']root["'][^>]*>\s*\S[\s\S]*?<\/div>/i.test(html);
  const hasMetaDescription = /<meta\s+name=["']description["'][^>]+content=["'][^"']{20,}["']/i.test(html);
  const hasRobots = existsSync(join(dir, "dist", "public", "robots.txt"));
  const hasSitemap = existsSync(join(dir, "dist", "public", "sitemap.xml"));
  const ok = (hasPrerenderMarker || hasRootFallback) && hasMetaDescription && hasRobots && hasSitemap;

  return {
    checked: true,
    ok,
    file: indexPath,
    output: ok
      ? `Crawler-visible HTML found at ${indexPath}`
      : [
        `Crawler-visible HTML gate failed for ${indexPath}.`,
        `hasPrerenderMarker=${hasPrerenderMarker}`,
        `hasRootFallback=${hasRootFallback}`,
        `hasMetaDescription=${hasMetaDescription}`,
        `hasRobots=${hasRobots}`,
        `hasSitemap=${hasSitemap}`,
        "Build output must include prerendered/fallback body content plus robots.txt and sitemap.xml so Google can see public pages without running React.",
      ].join("\n"),
  };
}

function walkTextFiles(dir: string, visit: (file: string, content: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkTextFiles(join(dir, entry.name), visit);
      continue;
    }
    if (!entry.isFile()) continue;
    const file = join(dir, entry.name);
    try {
      const buffer = readFileSync(file);
      if (buffer.includes(0)) continue;
      visit(file, buffer.toString("utf8"));
    } catch {
      // Ignore unreadable files during best-effort scan.
    }
  }
}

function detectFrozenInstallCommand(dir: string): string | null {
  if (!existsSync(join(dir, "package.json"))) return null;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile --ignore-scripts";
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun install --frozen-lockfile";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(join(dir, "package-lock.json"))) return "npm ci --ignore-scripts";
  return "npm install --ignore-scripts";
}

function detectScriptCommand(dir: string, script: string): string | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (!pkg?.scripts?.[script]) return null;
  } catch {
    return null;
  }
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return `pnpm run ${script}`;
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return `bun run ${script}`;
  if (existsSync(join(dir, "yarn.lock"))) return `yarn ${script}`;
  return `npm run ${script}`;
}

function runGate(name: string, command: string, dir: string): VerificationGate {
  const result = spawnSync(command, [], {
    cwd: dir,
    shell: true,
    encoding: "utf8",
    env: process.env,
    timeout: 180_000,
    maxBuffer: 2_000_000,
  });
  const output = `${result.stdout || ""}${result.stderr ? `\n[stderr]\n${result.stderr}` : ""}`.slice(0, MAX_OUTPUT);
  return { name, command, ok: (result.status ?? 1) === 0, status: result.status ?? 1, output };
}

async function runStartRouteGate(dir: string, profile: AppProfile, port: string, route: string, projectState?: ProjectState | null): Promise<VerificationGate> {
  const command = projectState?.commands?.start ? projectState.commands.start.replace(/\$\{PORT\}/g, port) : detectStartCommand(dir, profile, port);
  if (!command) return { name: "start_route", ok: false, output: "No package start/preview script found." };
  const portPreflight = await verifyPortAvailable(port);
  const url = `http://127.0.0.1:${port}${route.startsWith("/") ? route : `/${route}`}`;
  if (!portPreflight.ok) {
    const reuse = await tryReuseExistingProjectServer(dir, url, route);
    if (reuse.ok) return { name: "start_route", command, ok: true, status: 0, output: reuse.output };
    return { name: "start_route", command, ok: false, status: 1, output: `${portPreflight.output}\n${reuse.output}`.slice(0, MAX_OUTPUT) };
  }
  const child = spawn(command, [], {
    cwd: dir,
    shell: true,
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let closed = false;
  let status: number | null = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-MAX_OUTPUT); });
  child.stderr.on("data", (chunk) => { output = (output + `\n[stderr]\n${String(chunk)}`).slice(-MAX_OUTPUT); });
  child.on("close", (code) => {
    closed = true;
    status = code ?? 1;
  });

  try {
    for (let i = 0; i < 40; i++) {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const contentType = response.headers.get("content-type") || "";
          const body = await response.text();
          const responseProblem = validateRouteResponse(route, contentType, body);
          if (responseProblem) {
            return { name: "start_route", command, ok: false, status: 1, output: responseProblem.slice(0, MAX_OUTPUT) };
          }
          return { name: "start_route", command, ok: true, status: 0, output: body.slice(0, MAX_OUTPUT) };
        }
      } catch {
        // Not ready yet.
      }
      if (closed) {
        return { name: "start_route", command, ok: false, status: status ?? 1, output: `Server exited before route became reachable.\n${output}`.slice(0, MAX_OUTPUT) };
      }
      await delay(500);
    }
    return { name: "start_route", command, ok: false, status: 1, output: `Route probe timed out: ${url}\n${output}`.slice(0, MAX_OUTPUT) };
  } finally {
    await stopProcessGroup(child, () => closed);
  }
}


async function runBrowserSmokeGate(dir: string, profile: AppProfile, port: string, route: string): Promise<VerificationGate> {
  const command = detectStartCommand(dir, profile, port);
  if (!command) return { name: "browser_smoke", ok: false, output: "No package start/preview script found." };
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    return { name: "browser_smoke", command, ok: false, status: 1, output: "No Chrome/Chromium executable found for browser smoke verification." };
  }
  const url = `http://127.0.0.1:${port}${route.startsWith("/") ? route : `/${route}`}`;
  const portPreflight = await verifyPortAvailable(port);
  if (!portPreflight.ok) {
    const reuse = await tryReuseExistingProjectServer(dir, url, route);
    if (!reuse.ok) return { name: "browser_smoke", command, ok: false, status: 1, output: `${portPreflight.output}\n${reuse.output}`.slice(0, MAX_OUTPUT) };
    return runBrowserSmokeAgainstUrl(command, url, dir);
  }
  const child = spawn(command, [], {
    cwd: dir,
    shell: true,
    detached: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let closed = false;
  let status: number | null = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-MAX_OUTPUT); });
  child.stderr.on("data", (chunk) => { output = (output + `\n[stderr]\n${String(chunk)}`).slice(-MAX_OUTPUT); });
  child.on("close", (code) => {
    closed = true;
    status = code ?? 1;
  });

  try {
    const routeReady = await waitForHttp(url, () => closed, 40);
    if (!routeReady.ok) {
      return { name: "browser_smoke", command, ok: false, status: status ?? 1, output: `${routeReady.output}\n${output}`.slice(0, MAX_OUTPUT) };
    }

    const { chromium } = await import("playwright-core");
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          if (!text.startsWith("Failed to load resource:")) consoleErrors.push(`${msg.type()}: ${text}`);
        }
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForSelector("#root, body", { timeout: 10_000 });
      const bodyText = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 4_000);
      const html = (await page.content()).slice(0, 20_000);
      const overlayProblem = detectFrontendOverlay(html, bodyText);
      const googleOAuthProblem = await verifyGoogleOAuthButton(page, url, dir);
      const problems = [...pageErrors, ...consoleErrors];
      if (overlayProblem) problems.push(overlayProblem);
      if (googleOAuthProblem) problems.push(googleOAuthProblem);
      if (problems.length > 0) {
        return { name: "browser_smoke", command, ok: false, status: 1, output: problems.join("\n").slice(0, MAX_OUTPUT) };
      }
      return { name: "browser_smoke", command, ok: true, status: 0, output: `loaded ${url}` };
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    return { name: "browser_smoke", command, ok: false, status: 1, output: String(error).slice(0, MAX_OUTPUT) };
  } finally {
    await stopProcessGroup(child, () => closed);
  }
}


async function runBrowserSmokeAgainstUrl(command: string, url: string, dir: string): Promise<VerificationGate> {
  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    return { name: "browser_smoke", command, ok: false, status: 1, output: "No Chrome/Chromium executable found for browser smoke verification." };
  }

  try {
    const { chromium } = await import("playwright-core");
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          if (!text.startsWith("Failed to load resource:")) consoleErrors.push(`${msg.type()}: ${text}`);
        }
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForSelector("#root, body", { timeout: 10_000 });
      const bodyText = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 4_000);
      const html = (await page.content()).slice(0, 20_000);
      const overlayProblem = detectFrontendOverlay(html, bodyText);
      const googleOAuthProblem = await verifyGoogleOAuthButton(page, url, dir);
      const problems = [...pageErrors, ...consoleErrors];
      if (overlayProblem) problems.push(overlayProblem);
      if (googleOAuthProblem) problems.push(googleOAuthProblem);
      if (problems.length > 0) {
        return { name: "browser_smoke", command, ok: false, status: 1, output: problems.join("\n").slice(0, MAX_OUTPUT) };
      }
      return { name: "browser_smoke", command, ok: true, status: 0, output: `loaded ${url}` };
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    return { name: "browser_smoke", command, ok: false, status: 1, output: String(error).slice(0, MAX_OUTPUT) };
  }
}

async function tryReuseExistingProjectServer(dir: string, url: string, route: string): Promise<{ ok: boolean; output: string }> {
  const port = Number(new URL(url).port);
  const owners = portOwnerCwds(port);
  const normalizedDir = resolve(dir);
  const ownsPort = owners.some((owner) => owner === normalizedDir || owner.startsWith(`${normalizedDir}/`));
  if (!ownsPort) {
    return { ok: false, output: owners.length > 0
      ? `Busy port is owned by another cwd: ${owners.join(", ")}`
      : "Busy port owner could not be tied to this project." };
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, output: `Existing project server returned HTTP ${response.status}: ${url}` };
    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();
    const responseProblem = validateRouteResponse(route, contentType, body);
    if (responseProblem) return { ok: false, output: responseProblem.slice(0, MAX_OUTPUT) };
    return { ok: true, output: `Reused existing project server already listening at ${url}\n${body.slice(0, MAX_OUTPUT)}`.slice(0, MAX_OUTPUT) };
  } catch (error) {
    return { ok: false, output: `Existing project server was not reachable at ${url}: ${String(error)}` };
  }
}

function portOwnerCwds(port: number): string[] {
  const lsof = spawnSync("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], { timeout: 5_000, encoding: "utf8" });
  const pids = (lsof.stdout || "").trim().split("\n").filter(Boolean).map((pid) => Number(pid)).filter((pid) => Number.isInteger(pid));
  const cwds: string[] = [];
  for (const pid of pids) {
    const readlink = spawnSync("readlink", ["-f", `/proc/${pid}/cwd`], { timeout: 2_000, encoding: "utf8" });
    const cwd = readlink.status === 0 ? readlink.stdout.trim() : "";
    if (cwd && !cwds.includes(cwd)) cwds.push(cwd);
  }
  return cwds;
}

async function verifyGoogleOAuthButton(page: any, appUrl: string, dir: string): Promise<string | null> {
  const googleButton = page.getByText(/continue with google|sign in with google|login with google|connect with google/i).first();
  const count = await googleButton.count().catch(() => 0);
  if (count === 0) return null;

  await googleButton.click({ timeout: 5_000 }).catch((error: unknown) => {
    throw new Error(`Google OAuth button is visible but could not be clicked: ${String(error)}`);
  });
  await Promise.race([
    page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined),
    page.waitForURL(/accounts\.google\.com|supabase\.co|oauth|auth/i, { timeout: 10_000 }).catch(() => undefined),
    delay(2_000),
  ]);

  const currentUrl = page.url();
  const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  const combined = `${currentUrl}\n${bodyText}`;
  if (/redirect_uri_mismatch/i.test(combined)) {
    const callbackMatch = combined.match(/https:\/\/[a-z0-9-]+\.supabase\.co\/auth\/v1\/callback/i);
    const envCallback = detectSupabaseAuthCallbackFromEnv(dir);
    const redirectUriMatch = currentUrl.match(/[?&]redirect_uri=([^&]+)/);
    const redirectUri = callbackMatch?.[0] || envCallback || (redirectUriMatch ? decodeURIComponent(redirectUriMatch[1]) : "the Supabase auth callback URI shown by Google");
    return [
      "Google OAuth redirect_uri_mismatch detected after clicking the app's Google sign-in button.",
      `App URL: ${appUrl}`,
      `Current URL: ${currentUrl}`,
      `Required Google Cloud authorized redirect URI: ${redirectUri}`,
      "Fix the Google OAuth client before claiming this generated app's Google auth works.",
    ].join("\n");
  }

  return null;
}

function detectSupabaseAuthCallbackFromEnv(dir: string): string | null {
  for (const name of [".env.local", ".env", ".env.development", ".env.production"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, "utf8");
      const match = content.match(/^\s*[A-Z0-9_]*SUPABASE_URL\s*=\s*['"]?(https:\/\/[a-z0-9-]+\.supabase\.co)\/?['"]?\s*$/im);
      if (match?.[1]) return `${match[1]}/auth/v1/callback`;
    } catch {
      // Best effort only.
    }
  }
  return null;
}

function detectStartCommand(dir: string, profile: AppProfile, port: string): string | null {
  const previewCommand = detectScriptCommand(dir, "preview");
  if (previewCommand) {
    if (previewCommand.startsWith("pnpm ")) return `${previewCommand} --port ${port} --strictPort`;
    if (previewCommand.startsWith("npm ") || previewCommand.startsWith("yarn ")) return `${previewCommand} -- --port ${port} --strictPort`;
    return `${previewCommand} --port ${port} --strictPort`;
  }
  const startCommand = detectScriptCommand(dir, "start");
  if (!startCommand) return null;
  if (profile === "web-db-user" || startCommand.includes("node ")) return `PORT=${port} ${startCommand}`;
  return startCommand;
}

function failGate(directory: string, profile: AppProfile, gates: VerificationGate[], gate: VerificationGate, dependencyStatus = getDependencyStatus(directory)): never {
  failWithDetails(`App verification gate failed: ${gate.name}`, {
    errorCode: "E_VERIFY_GATE",
    directory,
    profile,
    dependencyStatus,
    failedGate: gate,
    gates,
  });
}
function validateRouteResponse(route: string, contentType: string, body: string): string | null {
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  if (!normalizedRoute.startsWith("/api/")) return null;

  const normalizedContentType = contentType.toLowerCase();
  const bodyStart = body.trimStart().slice(0, 300).toLowerCase();
  const looksLikeHtml = normalizedContentType.includes("text/html") ||
    bodyStart.startsWith("<!doctype html") ||
    bodyStart.startsWith("<html") ||
    bodyStart.includes("<div id=\"root\"") ||
    bodyStart.includes("<div id='root'");

  if (looksLikeHtml) {
    return [
      `API route returned HTML instead of an API response: ${normalizedRoute}`,
      `content-type: ${contentType || "unknown"}`,
      body.slice(0, 1_000),
    ].join("\n");
  }

  if (!normalizedContentType.includes("application/json")) {
    return [
      `API route did not return JSON: ${normalizedRoute}`,
      `content-type: ${contentType || "unknown"}`,
      body.slice(0, 1_000),
    ].join("\n");
  }

  try {
    JSON.parse(body);
  } catch {
    return [
      `API route returned invalid JSON: ${normalizedRoute}`,
      body.slice(0, 1_000),
    ].join("\n");
  }

  return null;
}

export async function resolveVerificationPort(
  requestedPortText: string,
  options: { strict?: boolean; maxAttempts?: number } = {},
): Promise<string> {
  const requestedPort = Number(requestedPortText);
  if (!Number.isInteger(requestedPort) || requestedPort <= 0 || requestedPort > 65535) {
    return requestedPortText;
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? 20);
  for (let offset = 0; offset < maxAttempts; offset++) {
    const candidate = requestedPort + offset;
    if (candidate > 65535) break;
    const availability = await verifyPortAvailable(String(candidate));
    if (availability.ok) return String(candidate);
    if (options.strict) return requestedPortText;
  }

  return requestedPortText;
}

async function verifyPortAvailable(portText: string): Promise<{ ok: true } | { ok: false; output: string }> {
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, output: `Invalid verification port: ${portText}` };
  }

  return await new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; output: string }) => {
      if (settled) return;
      settled = true;
      try { server.close(() => undefined); } catch { /* server was never listening */ }
      resolve(result);
    };
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        finish({ ok: false, output: `Verification port ${port} is already in use before start. Refusing to verify against a stale or unrelated server.` });
        return;
      }
      finish({ ok: false, output: `Verification port ${port} is not available: ${error.message}` });
    });
    server.listen({ host: "127.0.0.1", port }, () => finish({ ok: true }));
  });
}

async function stopProcessGroup(child: ReturnType<typeof spawn>, isClosed: () => boolean): Promise<void> {
  if (isClosed()) return;
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(2_000)]);
  if (!isClosed()) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    } else {
      child.kill("SIGKILL");
    }
  }
}

async function waitForHttp(url: string, isClosed: () => boolean, attempts: number): Promise<{ ok: boolean; output: string }> {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return { ok: true, output: "" };
    } catch {
      // Not ready yet.
    }
    if (isClosed()) return { ok: false, output: "Server exited before route became reachable." };
    await delay(500);
  }
  return { ok: false, output: `Route probe timed out: ${url}` };
}

function detectFrontendOverlay(html: string, bodyText: string): string | null {
  const combined = `${html}\n${bodyText}`;
  const markers = ["[plugin:vite", "Uncaught ", "ReferenceError", "SyntaxError", "Internal server error", "Error Overlay"];
  for (const marker of markers) {
    if (combined.includes(marker)) return `frontend overlay/error marker detected: ${marker}`;
  }
  return null;
}

function findBrowserExecutable(): string | null {
  const candidates = [
    process.env.JERIKO_CHROME_PATH,
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try { accessSync(candidate); return candidate; } catch { /* try next */ }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
