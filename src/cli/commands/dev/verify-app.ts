import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { fail, failWithDetails, ok } from "../../../shared/output.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

export type AppProfile = "web-static" | "web-db-user";

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

    const profile = parseProfile(flagStr(parsed, "profile", "") || inferAppProfile(dir));
    const skipInstall = flagBool(parsed, "skip-install");
    const skipStart = flagBool(parsed, "skip-start");
    const route = flagStr(parsed, "route", "/");
    const port = flagStr(parsed, "port", "4173");

    const gates: VerificationGate[] = [];
    const placeholders = scanPlaceholders(dir);
    gates.push({ name: "placeholder_scan", ok: placeholders.length === 0 });
    if (placeholders.length > 0) {
      failWithDetails("Generated app still contains raw template placeholders.", {
        errorCode: "E_PLACEHOLDERS",
        directory: dir,
        profile,
        placeholders,
        gates,
      });
    }

    if (!skipInstall) {
      const installCommand = detectFrozenInstallCommand(dir);
      if (installCommand) {
        const gate = runGate("install", installCommand, dir);
        gates.push(gate);
        if (!gate.ok) return failGate(dir, profile, gates, gate);
      }
    }

    const checkCommand = detectScriptCommand(dir, "check");
    if (checkCommand) {
      const gate = runGate("check", checkCommand, dir);
      gates.push(gate);
      if (!gate.ok) return failGate(dir, profile, gates, gate);
    }

    const buildCommand = detectScriptCommand(dir, "build");
    if (buildCommand) {
      const gate = runGate("build", buildCommand, dir);
      gates.push(gate);
      if (!gate.ok) return failGate(dir, profile, gates, gate);
    }

    if (!skipStart) {
      const startGate = await runStartRouteGate(dir, profile, port, route);
      gates.push(startGate);
      if (!startGate.ok) return failGate(dir, profile, gates, startGate);
    }

    ok({ directory: dir, profile, gates });
  },
};

function printHelp(): void {
  console.log("Usage: jeriko verify-app <dir> [options]");
  console.log("\nRuns app-factory verification gates against a generated app.");
  console.log("\nFlags:");
  console.log("  --profile <name>    web-static or web-db-user (default: inferred)");
  console.log("  --skip-install      Skip frozen dependency install gate");
  console.log("  --skip-start        Skip start + route HTTP gate");
  console.log("  --port <port>       Port for start/preview gate (default: 4173)");
  console.log("  --route <path>      Route to probe after start (default: /)");
}

function parseProfile(profile: string): AppProfile {
  if (profile === "web-static" || profile === "web-db-user") return profile;
  fail(`Unknown app profile: ${profile}. Expected web-static or web-db-user.`);
}

export function inferAppProfile(dir: string): AppProfile {
  if (existsSync(join(dir, "server")) && (existsSync(join(dir, "drizzle.config.ts")) || existsSync(join(dir, "drizzle.config.js")))) {
    return "web-db-user";
  }
  return "web-static";
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

async function runStartRouteGate(dir: string, profile: AppProfile, port: string, route: string): Promise<VerificationGate> {
  const command = detectStartCommand(dir, profile, port);
  if (!command) return { name: "start_route", ok: false, output: "No package start/preview script found." };
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
          const body = await response.text();
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
    if (!closed) {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else {
        child.kill("SIGTERM");
      }
      await Promise.race([new Promise((resolve) => child.once("close", resolve)), delay(2_000)]);
      if (!closed) {
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        } else {
          child.kill("SIGKILL");
        }
      }
    }
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

function failGate(directory: string, profile: AppProfile, gates: VerificationGate[], gate: VerificationGate): never {
  failWithDetails(`App verification gate failed: ${gate.name}`, {
    errorCode: "E_VERIFY_GATE",
    directory,
    profile,
    failedGate: gate,
    gates,
  });
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
