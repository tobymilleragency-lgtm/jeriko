import { registerTool } from "./registry.js";
import type { ToolDefinition } from "./registry.js";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const MAX_OUTPUT = 80_000;

function resolveProjectDir(args: Record<string, unknown>): string | null {
  const dir = typeof args.dir === "string" ? args.dir : undefined;
  if (dir) return resolve(dir);
  const project = typeof args.project === "string" ? args.project : undefined;
  if (project) return join(homedir(), ".jeriko", "projects", project);
  return null;
}

function findJerikoBin(): string {
  const candidates = [
    process.env.JERIKO_BIN,
    process.argv[1]?.endsWith("jeriko") ? process.argv[1] : undefined,
    join(homedir(), ".local", "bin", "jeriko"),
    "jeriko",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (candidate === "jeriko" || existsSync(candidate)) return candidate;
  }
  return "jeriko";
}

async function execute(args: Record<string, unknown>): Promise<string> {
  const dir = resolveProjectDir(args);
  if (!dir) return JSON.stringify({ ok: false, error: "dir or project is required" });
  if (!existsSync(dir)) return JSON.stringify({ ok: false, error: `Project directory not found: ${dir}` });

  const cliArgs = ["--format", "json", "verify-app", dir];
  if (typeof args.profile === "string") cliArgs.push("--profile", args.profile);
  if (typeof args.port === "number" || typeof args.port === "string") cliArgs.push("--port", String(args.port));
  if (typeof args.route === "string") cliArgs.push("--route", args.route);
  if (typeof args.browser_route === "string") cliArgs.push("--browser-route", args.browser_route);
  if (args.skip_install === true) cliArgs.push("--skip-install");
  if (args.skip_start === true) cliArgs.push("--skip-start");
  if (args.skip_browser === true) cliArgs.push("--skip-browser");

  const result = spawnSync(findJerikoBin(), cliArgs, {
    cwd: dir,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 4_000_000,
    env: process.env,
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const combined = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`.slice(0, MAX_OUTPUT);
  if (stdout.trim().startsWith("{")) return stdout.slice(0, MAX_OUTPUT);
  return JSON.stringify({
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    command: `jeriko ${cliArgs.join(" ")}`,
    output: combined,
  }, null, 2);
}

export const verifyAppTool: ToolDefinition = {
  id: "verify_app",
  name: "verify_app",
  description: "Run Jeriko's required app-factory verification gate for generated apps. This proves scaffolded apps have a valid app spec contract, match required spec pages, reject forbidden integrations such as Stripe unless explicitly allowed, have no placeholders or scaffold residue, avoid unsafe shared env names, do not use localStorage as the primary database for business workflow data, reject contradictory web-db-user auth/database setup wiring, reject production pages backed by mock/static data imports, reject misleading AI-provider env errors, install with frozen lockfile, typecheck, build, ship production artifacts without Jeriko debug collector/mock copy, expose crawler-visible HTML, start, expose health/home route, and pass browser smoke including real workflow button mutation. Use before any final 'done' report for generated app/scaffold work.",
  parameters: {
    type: "object",
    properties: {
      dir: { type: "string", description: "Absolute or relative generated app directory." },
      project: { type: "string", description: "Project name under ~/.jeriko/projects/. Alternative to dir." },
      profile: { type: "string", enum: ["web-static", "web-db-user"], description: "Verification profile. Inferred if omitted." },
      port: { type: "string", description: "Port for start/browser gates. Optional." },
      route: { type: "string", description: "Backend/HTTP route for start_route. Defaults by profile." },
      browser_route: { type: "string", description: "Frontend route for browser smoke. Default /." },
      skip_install: { type: "boolean", description: "Skip install only when dependencies are already present; verify-app will still install if node_modules is missing." },
      skip_start: { type: "boolean", description: "Skip start route and browser gates. Avoid for final verification." },
      skip_browser: { type: "boolean", description: "Skip browser smoke. Avoid for final verification." },
    },
    required: [],
  },
  execute,
  aliases: ["verify-app", "app_factory_verify", "verify_generated_app"],
};

registerTool(verifyAppTool);
