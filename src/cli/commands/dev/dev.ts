import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { ok, fail } from "../../../shared/output.js";
import { execSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

const PROJECTS_DIR = join(homedir(), ".jeriko", "projects");
type DevAction = "start" | "stop" | "status" | "logs";

export interface DevInvocation {
  action: DevAction;
  directory: string;
  projectName?: string;
  port: string;
}

export interface DetachedDevServer {
  command: string;
  directory: string;
  logFile: string;
  pid?: number;
}

export const command: CommandHandler = {
  name: "dev",
  description: "Dev server management (start, stop, status)",
  async run(args: string[]) {
    const parsed = parseArgs(args);

    if (flagBool(parsed, "help")) {
      console.log("Usage: jeriko dev <action> [options]");
      console.log("       jeriko dev --start <name> | --stop <name> | --logs <name> | --status");
      console.log("\nActions:");
      console.log("  start             Start dev server (detects framework)");
      console.log("  stop              Stop dev server");
      console.log("  status            Show running dev servers");
      console.log("  logs              Show debug logs (console, network, UI events)");
      console.log("  logs --clear      Clear debug logs");
      console.log("\nFlags:");
      console.log("  --start <name>    Alias for start under ~/.jeriko/projects/<name>");
      console.log("  --stop <name>     Alias for stop under ~/.jeriko/projects/<name>");
      console.log("  --logs <name>     Alias for logs under ~/.jeriko/projects/<name>");
      console.log("  --status          Alias for status");
      console.log("  --port <n>        Port number (default: 3000)");
      console.log("  --dir <path>      Project directory (default: .)");
      console.log("  --cmd <command>   Custom start command");
      console.log("  --errors          Show only errors (with logs)");
      console.log("  --network         Show only network requests (with logs)");
      console.log("  --ui              Show only UI events (with logs)");
      process.exit(0);
    }

    const invocation = parseDevInvocation(args);
    const { action, directory: dir, port } = invocation;

    switch (action) {
      case "start": {
        const customCmd = flagStr(parsed, "cmd", "");
        const startCmd = customCmd || detectDevCommand(dir, port);

        if (!startCmd) {
          fail("Cannot detect project type. Use --cmd to specify the start command.");
        }

        const started = startDetachedDevServer(startCmd, dir, port);

        ok({
          action: "start",
          command: started.command,
          port: parseInt(port, 10),
          pid: started.pid,
          directory: started.directory,
          logFile: started.logFile,
        });
        break;
      }
      case "stop": {
        try {
          const output = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: "utf-8" }).trim();
          if (output) {
            const pids = output.split("\n");
            for (const pid of pids) {
              process.kill(parseInt(pid, 10));
            }
            ok({ action: "stop", port: parseInt(port, 10), directory: dir, killed: pids.map(Number) });
          } else {
            ok({ action: "stop", directory: dir, message: `No process on port ${port}` });
          }
        } catch {
          ok({ action: "stop", directory: dir, message: `No process on port ${port}` });
        }
        break;
      }
      case "status": {
        try {
          const output = execSync(`lsof -iTCP:${port} -sTCP:LISTEN -P -n | head -20`, { encoding: "utf-8" }).trim();
          if (output) {
            ok({ action: "status", port: parseInt(port, 10), directory: dir, running: true, output });
          }
          ok({ action: "status", port: parseInt(port, 10), directory: dir, running: false });
        } catch {
          ok({ action: "status", port: parseInt(port, 10), directory: dir, running: false });
        }
        break;
      }
      case "logs": {
        const clear = flagBool(parsed, "clear");
        const errorsOnly = flagBool(parsed, "errors");
        const networkOnly = flagBool(parsed, "network");
        const uiOnly = flagBool(parsed, "ui");

        const logsFile = "/tmp/jeriko-debug-logs.json";
        const projectLogFile = getProjectDevLogFile(dir);

        if (clear) {
          try {
            const { unlinkSync } = await import("node:fs");
            if (existsSync(logsFile)) unlinkSync(logsFile);
            if (existsSync(projectLogFile)) unlinkSync(projectLogFile);
            ok({ action: "logs-clear", directory: dir, message: "Debug logs cleared" });
          } catch (e: any) {
            fail(`Failed to clear logs: ${e.message}`);
          }
          break;
        }

        // Try reading from dev server first (live), fall back to file
        let logs: any = null;

        try {
          const res = await fetch(`http://localhost:${port}/__jeriko__/logs`);
          if (res.ok) logs = await res.json();
        } catch {
          // Dev server not running or no debug plugin — try file
        }

        if (!logs && existsSync(logsFile)) {
          try {
            logs = JSON.parse(readFileSync(logsFile, "utf-8"));
          } catch { /* corrupt */ }
        }

        if (!logs) {
          ok({
            action: "logs",
            directory: dir,
            logFile: existsSync(projectLogFile) ? projectLogFile : undefined,
            output: existsSync(projectLogFile) ? tailTextFile(projectLogFile) : undefined,
            message: "No debug logs found. Start a dev server with the jeriko debug plugin enabled.",
            consoleLogs: [],
            networkRequests: [],
            uiEvents: [],
          });
          break;
        }

        // Filter by category if requested
        const result: any = { action: "logs", directory: dir, lastUpdated: logs.lastUpdated };

        if (errorsOnly) {
          result.consoleLogs = (logs.consoleLogs ?? []).filter((l: any) => l.level === "ERROR" || l.level === "WARN");
          result.networkRequests = (logs.networkRequests ?? []).filter((r: any) => r.response?.status >= 400 || r.error);
        } else if (networkOnly) {
          result.networkRequests = logs.networkRequests ?? [];
        } else if (uiOnly) {
          result.uiEvents = logs.uiEvents ?? [];
        } else {
          result.consoleLogs = logs.consoleLogs ?? [];
          result.networkRequests = logs.networkRequests ?? [];
          result.uiEvents = logs.uiEvents ?? [];
        }

        ok(result);
        break;
      }
      default:
        fail(`Unknown action: "${action}". Use start, stop, status, or logs.`);
    }
  },
};

export function parseDevInvocation(args: string[]): DevInvocation {
  const parsed = parseArgs(args);
  const alias = getAliasAction(parsed.flags);
  const positionalAction = parsed.positional[0];
  const action = normalizeAction(alias?.action ?? positionalAction ?? "status");
  const projectName = getProjectName(parsed, alias?.value);
  const directory = resolveDevDirectory(parsed, projectName);

  return {
    action,
    directory,
    projectName,
    port: flagStr(parsed, "port", "3000"),
  };
}

export function startDetachedDevServer(command: string, dir: string, port = "3000"): DetachedDevServer {
  const logFile = getProjectDevLogFile(dir);
  mkdirSync(join(dir, ".jeriko", "logs"), { recursive: true });
  const fd = openSync(logFile, "a");

  try {
    writeSync(fd, `\n[${new Date().toISOString()}] starting: ${command}\n`);
    const child = spawn(command, [], {
      cwd: dir,
      shell: true,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, PORT: port },
    });
    child.unref();
    return { command, directory: dir, logFile, pid: child.pid };
  } finally {
    closeSync(fd);
  }
}

export function getProjectDevLogFile(dir: string): string {
  return join(dir, ".jeriko", "logs", "dev.log");
}

/** Detect the right dev command based on project files. */
export function detectDevCommand(dir: string, port = "3000"): string | null {
  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.dev) return buildPackageScriptCommand(dir, "dev", String(pkg.scripts.dev), port);
      if (pkg.scripts?.start) return buildPackageScriptCommand(dir, "start", String(pkg.scripts.start), port);
    } catch { /* ignore */ }
  }

  // Python
  if (existsSync(join(dir, "manage.py"))) return "python manage.py runserver";
  if (existsSync(join(dir, "src", "main.py"))) return "./venv/bin/python src/main.py";
  if (existsSync(join(dir, "app.py"))) return "python app.py";

  // Go
  if (existsSync(join(dir, "main.go"))) return "go run .";

  // Rust
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo run";

  return null;
}

function getAliasAction(flags: Record<string, string | boolean>): { action: DevAction; value?: string | boolean } | null {
  for (const action of ["start", "stop", "logs", "status"] as const) {
    if (flags[action] !== undefined) return { action, value: flags[action] };
  }
  return null;
}

function normalizeAction(action: string): DevAction {
  if (action === "start" || action === "stop" || action === "status" || action === "logs") return action;
  fail(`Unknown action: "${action}". Use start, stop, status, or logs.`);
}

function getProjectName(parsed: ReturnType<typeof parseArgs>, aliasValue: string | boolean | undefined): string | undefined {
  if (typeof aliasValue === "string") return aliasValue;
  if (!parsed.flags.dir && parsed.positional[1]) return parsed.positional[1];
  return undefined;
}

function resolveDevDirectory(parsed: ReturnType<typeof parseArgs>, projectName: string | undefined): string {
  const dirFlag = flagStr(parsed, "dir", "");
  if (dirFlag) return resolve(dirFlag);
  if (projectName) return resolve(join(PROJECTS_DIR, projectName));
  return resolve(".");
}

function buildPackageScriptCommand(dir: string, scriptName: "dev" | "start", scriptBody: string, port: string): string {
  const runner = detectPackageRunner(dir);
  const base = `${runner} run ${scriptName}`;

  // Vite does not honor the PORT environment variable. Pass the requested
  // port explicitly and require it, otherwise Jeriko can report port N while
  // Vite silently falls forward to 3001/3002 when 3000 is busy.
  if (/\bvite(\s|$)/.test(scriptBody)) {
    return appendScriptArgs(base, runner, `--port ${shellArg(port)} --strictPort`);
  }

  return base;
}

function appendScriptArgs(base: string, runner: string, args: string): string {
  // pnpm and bun pass args directly after the script name. npm and yarn need
  // the separator so the package manager does not consume the flags itself.
  if (runner === "pnpm" || runner === "bun") return `${base} ${args}`;
  return `${base} -- ${args}`;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function detectPackageRunner(dir: string): string {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

function tailTextFile(file: string, maxBytes = 20000): string {
  const text = readFileSync(file, "utf-8");
  return text.length > maxBytes ? text.slice(-maxBytes) : text;
}
