import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AppProfile = "web-static" | "web-db-user";

export interface ProjectState {
  version: 1;
  name: string;
  template: string;
  profile: AppProfile;
  packageManager: string;
  generatedAt: string;
  commands: {
    install: string;
    check: string;
    build: string;
    start: string;
    dev: string;
  };
  routes: {
    home: string;
    health?: string;
  };
  verification: {
    requiredGates: string[];
    lastRun?: unknown;
  };
}

export const REQUIRED_APP_FACTORY_GATES = [
  "placeholder_scan",
  "install",
  "check",
  "build",
  "start_route",
  "browser_smoke",
];

export function projectStatePath(dir: string): string {
  return join(dir, ".jeriko", "project-state.json");
}

export function readProjectState(dir: string): ProjectState | null {
  const file = projectStatePath(dir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.profile !== "web-static" && parsed?.profile !== "web-db-user") return null;
    return parsed as ProjectState;
  } catch {
    return null;
  }
}

export function writeProjectState(dir: string, state: ProjectState): string {
  const file = projectStatePath(dir);
  mkdirSync(join(dir, ".jeriko"), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
  return file;
}

export function buildProjectState(args: {
  name: string;
  template: string;
  profile: AppProfile;
}): ProjectState {
  const packageManager = "pnpm";
  const fullStack = args.profile === "web-db-user";
  return {
    version: 1,
    name: args.name,
    template: args.template,
    profile: args.profile,
    packageManager,
    generatedAt: new Date().toISOString(),
    commands: {
      install: "pnpm install --frozen-lockfile --ignore-scripts",
      check: "pnpm run check",
      build: "pnpm run build",
      start: fullStack ? "PORT=${PORT} pnpm run start" : "pnpm run preview --port ${PORT} --strictPort",
      dev: "pnpm run dev",
    },
    routes: {
      home: "/",
      ...(fullStack ? { health: "/api/health" } : {}),
    },
    verification: {
      requiredGates: [...REQUIRED_APP_FACTORY_GATES],
    },
  };
}
