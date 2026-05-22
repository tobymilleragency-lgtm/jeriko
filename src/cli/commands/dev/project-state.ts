import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export type AppProfile = "web-static" | "web-db-user";

export interface SourceFingerprint {
  sha256: string;
  fileCount: number;
  bytes: number;
}

export interface AppSpecWorkflow {
  id: string;
  label: string;
  inputs: string[];
  actions: string[];
  outputs: string[];
  persistence: string[];
}

export interface AppSpecContract {
  version: 1;
  source: "prompt" | "template";
  prompt: string;
  appType: string;
  pages: Array<{ path: string; title: string }>;
  features: string[];
  workflows?: AppSpecWorkflow[];
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
  "auth_runtime_config_scan",
  "mock_data_import_scan",
  "provider_config_scan",
  "image_uniqueness_scan",
  "forbidden_integration_scan",
  "workflow_contract",
  "primary_action_wiring",
  "business_math_realness",
  "primary_fetch_error_handling",
  "supabase_product_foundation",
  "premium_marketing_site_scan",
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
      requiredGates: fullStack
        ? [...REQUIRED_APP_FACTORY_GATES, "vercel_api_packaging_scan"]
        : [...REQUIRED_APP_FACTORY_GATES],
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
  const localService = args.seoProfile === "local-service" || /contractor|roof|remodel|plumb|electric|hvac|realtor|real estate|realty|homes for sale|brokerage|local|seo|service area|near me/i.test(prompt);
  const fullStack = args.profile === "web-db-user";
  return buildPromptAppSpecContract(args, prompt, localService, fullStack);
}

function buildPromptAppSpecContract(args: {
  name: string;
  template: string;
  profile: AppProfile;
  prompt?: string;
  seoProfile?: string;
}, prompt: string, localService: boolean, fullStack: boolean): AppSpecContract {
  const productWorkflow = inferProductWorkflow(prompt, fullStack);
  const marketingPages = inferMarketingPages(prompt, { fullStack, localService, hasExplicitPrompt: Boolean(args.prompt) });
  const pages = [{ path: "/", title: "Home" }, ...productWorkflow.pages, ...marketingPages];
  const hasMultiPageMarketing = !fullStack && marketingPages.length > 0;
  const contractorMarketing = /contractor|roof|remodel|plumb|electric|hvac|estimate|quote/i.test(prompt);
  const features = fullStack
    ? uniqueStrings(["authenticated user workflow", "Supabase Auth foundation", "database-backed app state", "Supabase Storage photo uploads", ...productWorkflow.features])
    : uniqueStrings([
      "production homepage",
      "customer-ready marketing content",
      ...(hasMultiPageMarketing ? ["multi-page marketing site", "conversion-focused contact path", contractorMarketing ? "premium contractor conversion system" : "premium local business conversion system", "SPA internal navigation", "deploy-safe Vercel static routing"] : []),
      ...(localService ? ["local service SEO content"] : []),
    ]);
  return {
    version: 1,
    source: args.prompt ? "prompt" : "template",
    prompt,
    appType: fullStack ? productWorkflow.appType : localService ? "local-service-site" : "marketing-site",
    pages: uniquePages(pages),
    features,
    ...(productWorkflow.workflow ? { workflows: [productWorkflow.workflow] } : {}),
    integrations: {
      allowed: [],
      forbidden: ["stripe"],
    },
    successCriteria: [
      "Full required verify-app gate passes",
      "Generated app matches this app spec contract",
      "No forbidden integrations appear unless explicitly allowed in this spec",
      ...(hasMultiPageMarketing ? ["Every appSpec page is implemented as a routable page, not collapsed into a single landing page"] : []),
      ...(hasMultiPageMarketing ? [contractorMarketing
        ? "Premium marketing sites include a hero system visual, lead-flow module, interactive audit, before/after comparison, sticky CTA, and SPA internal navigation"
        : "Premium marketing sites include a hero system visual, animated value-flow module, interactive conversion/qualification module, proof/comparison section, sticky CTA, and SPA internal navigation"] : []),
      ...(productWorkflow.workflow ? ["Every primary workflow action is wired to UI, API, and durable state or visible setup-required fallback"] : []),
      ...(fullStack ? ["Supabase Auth, database schema, and storage foundation are scaffolded before product-specific data/photo workflows are added"] : []),
    ],
  };
}

function inferMarketingPages(prompt: string, args: { fullStack: boolean; localService: boolean; hasExplicitPrompt: boolean }): Array<{ path: string; title: string }> {
  if (args.fullStack) return [];
  const text = prompt.toLowerCase();
  const asksForFullSite = /\b(full|multi[- ]page|complete|entire)\b/.test(text)
    || /\b(site|website|web app)\b/.test(text)
    || /\b(services?|industries|case studies|proof|process|pricing|packages?|resources?|blog|contact|service areas?|locations?|gallery|portfolio)\b/.test(text);
  if (!args.localService && !args.hasExplicitPrompt && !asksForFullSite) return [];
  if (!args.localService && !asksForFullSite) return [];

  const pages: Array<{ path: string; title: string }> = [];
  const add = (path: string, title: string) => pages.push({ path, title });

  if (/\b(realtor|real estate|realty|brokerage|homes? for sale|listings?)\b/.test(text)) {
    add("/buy", "Buy");
    add("/sell", "Sell");
    add("/listings", "Listings");
    if (/\babout|agent|realtor|team\b/.test(text)) add("/about", "About");
    add("/area-guide", "Area Guide");
    add("/contact", "Contact");
    return uniquePages(pages);
  }

  add("/services", "Services");
  if (/\bindustr(y|ies)|contractors?|trades?|niches?|markets?\b/.test(text)) add("/industries", "Industries");
  if (/\bcase studies|case-studies|proof|results?|portfolio|projects?\b/.test(text)) add("/case-studies", "Case Studies");
  add("/process", "Process");
  if (/\bpricing|packages?|plans?|offers?\b/.test(text)) add("/pricing", "Pricing");
  if (/\bresources?|blog|guides?|articles?\b/.test(text)) add("/resources", "Resources");
  if (/\babout|company|team|crew\b/.test(text)) add("/about", "About");
  if (args.localService || /\bservice areas?|locations?|near me|local\b/.test(text)) add("/service-areas", "Service Areas");
  if (args.localService || /\bgallery|photos?|portfolio|projects?\b/.test(text)) add("/gallery", "Gallery");
  add("/contact", "Contact");

  return uniquePages(pages);
}

function inferProductWorkflow(prompt: string, fullStack: boolean): { appType: string; pages: Array<{ path: string; title: string }>; features: string[]; workflow?: NonNullable<AppSpecContract["workflows"]>[number] } {
  const text = prompt.toLowerCase();
  const scanner = /scanner|scan|resale|flip|inventory|listing|profit|upload|paste|photo/.test(text);
  if (!fullStack || !scanner) return { appType: fullStack ? "authenticated-web-app" : "marketing-site", pages: [], features: [] };

  return {
    appType: "full-stack-product-app",
    pages: [
      { path: "/scanner", title: "Scanner" },
      { path: "/inventory", title: "Inventory" },
    ],
    features: [
      "photo upload",
      "paste/manual item input",
      "cost/profit calculator",
      "database-backed inventory",
      "AI-assisted scan workflow",
    ],
    workflow: {
      id: "resale-scanner",
      label: "Resale scanner workflow",
      inputs: ["upload", "paste", "cost", "shipping", "fees"],
      actions: ["upload", "paste", "scan", "save", "list", "edit", "delete"],
      outputs: ["price", "profit", "decision", "confidence"],
      persistence: ["items", "photos", "scans", "inventory", "uploads", "listings", "orders", "shipments"],
    },
  };
}

function uniquePages(pages: Array<{ path: string; title: string }>): Array<{ path: string; title: string }> {
  const seen = new Set<string>();
  return pages.filter((page) => {
    if (seen.has(page.path)) return false;
    seen.add(page.path);
    return true;
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
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
