import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export type AppProfile = "web-static" | "web-db-user";

export interface SourceFingerprint {
  sha256: string;
  fileCount: number;
  bytes: number;
}

export interface AppSpecContract {
  version: 1;
  source: "prompt" | "template";
  prompt: string;
  appType: string;
  pages: Array<{ path: string; title: string }>;
  features: string[];
  integrations: {
    allowed: string[];
    forbidden: string[];
  };
  successCriteria: string[];
}

export interface ProjectState {
  version: 1;
  name: string;
  template: string;
  profile: AppProfile;
  packageManager: string;
  generatedAt: string;
  appSpec?: AppSpecContract;
  commands: {
    install?: string;
    check?: string;
    build?: string;
    start?: string;
    dev?: string;
  };
  routes: {
    home: string;
    health?: string;
  };
  verification: {
    requiredGates: string[];
    lastRun?: unknown;
    lastSuccessfulVerification?: {
      ok: true;
      profile: AppProfile;
      completedAt: string;
      command: string;
      gates: Array<{
        name: string;
        ok: boolean;
        command?: string;
        status?: number;
      }>;
      sourceFingerprint?: SourceFingerprint;
    };
  };
}

export interface VerificationStatus {
  hasSuccessfulVerification: boolean;
  fresh: boolean;
  reason: string;
  currentSourceFingerprint: SourceFingerprint;
  verifiedSourceFingerprint?: SourceFingerprint;
  completedAt?: string;
}

const FINGERPRINT_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".svelte-kit", "coverage", ".jeriko"]);

export const REQUIRED_APP_FACTORY_GATES = [
  "app_spec_contract",
  "placeholder_scan",
  "scaffold_residue_scan",
  "unsafe_env_scan",
  "primary_persistence_scan",
  "db_auth_workflow_wiring",
  "mock_data_import_scan",
  "provider_config_scan",
  "image_uniqueness_scan",
  "forbidden_integration_scan",
  "app_spec_verifier",
  "install",
  "check",
  "build",
  "production_artifact_scan",
  "crawler_html",
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
  prompt?: string;
  seoProfile?: string;
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
    appSpec: buildAppSpecContract(args),
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

function buildAppSpecContract(args: {
  name: string;
  template: string;
  profile: AppProfile;
  prompt?: string;
  seoProfile?: string;
}): AppSpecContract {
  const prompt = args.prompt?.trim() || `Create ${args.name} from the ${args.template} template.`;
  const localService = args.seoProfile === "local-service" || /contractor|roof|remodel|plumb|electric|hvac|local|seo|service area|near me/i.test(prompt);
  const fullStack = args.profile === "web-db-user";
  return {
    version: 1,
    source: args.prompt ? "prompt" : "template",
    prompt,
    appType: fullStack ? "authenticated-web-app" : localService ? "local-service-site" : "marketing-site",
    pages: [{ path: "/", title: "Home" }],
    features: fullStack ? ["authenticated user workflow", "database-backed app state"] : ["production homepage", localService ? "local service SEO content" : "customer-ready marketing content"],
    integrations: {
      allowed: [],
      forbidden: ["stripe"],
    },
    successCriteria: [
      "Full required verify-app gate passes",
      "Generated app matches this app spec contract",
      "No forbidden integrations appear unless explicitly allowed in this spec",
    ],
  };
}

export function computeSourceFingerprint(dir: string): SourceFingerprint {
  const files: string[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }

    for (const entry of entries) {
      if (FINGERPRINT_SKIP_DIRS.has(entry)) continue;
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        files.push(fullPath);
      }
    }
  };

  walk(dir);
  files.sort((a, b) => relative(dir, a).localeCompare(relative(dir, b)));

  const hash = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const rel = relative(dir, file).replaceAll("\\", "/");
    const content = readFileSync(file);
    bytes += content.length;
    hash.update(rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }

  return { sha256: hash.digest("hex"), fileCount: files.length, bytes };
}

export function assessVerificationStatus(dir: string, state: ProjectState | null): VerificationStatus {
  const currentSourceFingerprint = computeSourceFingerprint(dir);
  const lastSuccessful = state?.verification?.lastSuccessfulVerification;
  if (!lastSuccessful) {
    return {
      hasSuccessfulVerification: false,
      fresh: false,
      reason: "no successful verify-app run recorded",
      currentSourceFingerprint,
    };
  }

  const verifiedSourceFingerprint = lastSuccessful.sourceFingerprint;
  if (!verifiedSourceFingerprint) {
    return {
      hasSuccessfulVerification: true,
      fresh: false,
      reason: "last successful verify-app run lacks source fingerprint; rerun verify-app",
      currentSourceFingerprint,
      completedAt: lastSuccessful.completedAt,
    };
  }

  const fresh = verifiedSourceFingerprint.sha256 === currentSourceFingerprint.sha256
    && verifiedSourceFingerprint.fileCount === currentSourceFingerprint.fileCount
    && verifiedSourceFingerprint.bytes === currentSourceFingerprint.bytes;

  return {
    hasSuccessfulVerification: true,
    fresh,
    reason: fresh ? "last successful verify-app source fingerprint matches current source" : "source fingerprint changed since last successful verify-app run",
    currentSourceFingerprint,
    verifiedSourceFingerprint,
    completedAt: lastSuccessful.completedAt,
  };
}
