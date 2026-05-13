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

export interface DependencyStatus {
  packageJson: boolean;
  nodeModules: boolean;
  missingNodeModules: boolean;
  message: string;
}

const PLACEHOLDER_PATTERN = /\{\{[a-zA-Z0-9_]+\}\}|__PLACEHOLDER__|<%=?\s*[^%]+%>/g;
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
    const port = flagStr(parsed, "port", "4173");
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
  console.log("  --port <port>       Port for start/preview gate (default: 4173)");
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
  if (!portPreflight.ok) return { name: "start_route", command, ok: false, status: 1, output: portPreflight.output };
  const url = `http://127.0.0.1:${port}${route.startsWith("/") ? route : `/${route}`}`;
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
  if (!portPreflight.ok) return { name: "browser_smoke", command, ok: false, status: 1, output: portPreflight.output };
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
      const problems = [...pageErrors, ...consoleErrors];
      if (overlayProblem) problems.push(overlayProblem);
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
