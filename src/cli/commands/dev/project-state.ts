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

export interface AppBuilderPhase {
  id: string;
  description: string;
  requiredEvidence: string[];
}

export interface AppBuilderRepairRouter {
  failedGate: string;
  action: string;
}

export type AppBuilderPhaseStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export type AppBuilderRunStatus = "running" | "blocked" | "completed";

export interface AppBuilderControlPlan {
  mode: "controlled-app-build";
  mandatorySkills: string[];
  phases: AppBuilderPhase[];
  repairRouters: AppBuilderRepairRouter[];
}

export interface AppBuilderPhaseRun {
  id: string;
  status: AppBuilderPhaseStatus;
  description: string;
  requiredEvidence: string[];
  evidence: string[];
  startedAt?: string;
  completedAt?: string;
  blockedAt?: string;
}

export interface AppBuilderFailure {
  failedGate: string;
  output?: string;
  repairAction: string;
  recordedAt: string;
}

export interface AppBuilderRun {
  status: AppBuilderRunStatus;
  trigger: string;
  startedAt: string;
  updatedAt: string;
  currentPhaseId: string;
  mandatorySkillsLoaded: string[];
  phases: AppBuilderPhaseRun[];
  failures: AppBuilderFailure[];
}

export interface ProjectState {
  version: 1;
  name: string;
  template: string;
  profile: AppProfile;
  packageManager: string;
  generatedAt: string;
  appSpec?: AppSpecContract;
  appBuilderPlan?: AppBuilderControlPlan;
  appBuilderRun?: AppBuilderRun;
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
  "app_builder_control_plan",
  "placeholder_scan",
  "scaffold_residue_scan",
  "public_builder_meta_scan",
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
    appBuilderPlan: buildAppBuilderControlPlan(args),
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

function buildAppBuilderControlPlan(args: {
  name: string;
  template: string;
  profile: AppProfile;
  prompt?: string;
  seoProfile?: string;
}): AppBuilderControlPlan {
  const prompt = args.prompt ?? args.name;
  const contractorSite = isContractorSitePrompt(prompt) || args.seoProfile === "local-service";
  const fullStack = args.profile === "web-db-user";
  return {
    mode: "controlled-app-build",
    mandatorySkills: uniqueStrings([
      "operator-build-discipline",
      ...(contractorSite ? ["contractor-site-autonomous-build"] : []),
    ]),
    phases: [
      { id: "target-lock", description: "Confirm target directory, package name, template, and appSpec identity before writing.", requiredEvidence: ["pwd/package name", "project-state path"] },
      { id: "skill-bind", description: "Load lane-specific skills before implementation work starts.", requiredEvidence: ["use_skill operator-build-discipline", ...(contractorSite ? ["use_skill contractor-site-autonomous-build"] : [])] },
      { id: "appspec-plan", description: "Convert appSpec pages, workflows, integrations, and success criteria into implementation tasks.", requiredEvidence: ["route/workflow task list"] },
      { id: "scaffold", description: "Create the starter from the selected template and remove template/demo metadata.", requiredEvidence: ["jeriko create result", "template residue scan"] },
      { id: "implement-routes", description: "Implement every required appSpec route as a distinct routable page with nav, sitemap, and crawler-visible content.", requiredEvidence: ["ROUTE_BREADTH_OK", "sitemap routes"] },
      { id: "implement-workflows", description: "Wire primary actions to UI, API, durable state, or explicit setup-required fallback.", requiredEvidence: [fullStack ? "PRODUCT_WORKFLOW_OK or READ_AFTER_WRITE_OK" : "contact/CTA smoke"] },
      { id: "verify", description: "Run verify_app with install/check/build/start/browser gates.", requiredEvidence: ["verify_app gates"] },
      { id: "repair", description: "Map any failed gate to a targeted repair action, change files, and rerun verify once.", requiredEvidence: ["failed gate", "repair diff", "rerun verify_app"] },
      { id: "checkpoint-preview", description: "Save a checkpoint and start a persistent local preview after green verification.", requiredEvidence: ["git checkpoint", "localhost URL"] },
      { id: "evidence-report", description: "Final report must cite verified gates, changed files, checkpoint, preview URL, and exact blockers if any.", requiredEvidence: ["evidence summary"] },
    ],
    repairRouters: [
      { failedGate: "app_spec_verifier", action: "Implement missing appSpec routes/workflows and update sitemap/navigation before rerunning verify_app." },
      { failedGate: "premium_marketing_site_scan", action: "Restore premium conversion modules, complete contractor route breadth, remove fake claims/forms, and preserve premium visual direction." },
      { failedGate: "public_builder_meta_scan", action: "Rewrite public copy to customer-facing business language; remove builder, crawler, route, SEO-page, and operator commentary." },
      { failedGate: "workflow_contract", action: "Wire required UI/API/persistence workflow pieces or mark exact setup-required blockers visibly." },
      { failedGate: "primary_action_wiring", action: "Connect visible buttons/forms to handlers, API calls, state changes, or honest disabled/setup-required behavior." },
      { failedGate: "crawler_html", action: "Generate route-specific prerendered HTML, sitemap, robots, canonical, and substantial visible body copy per route." },
      { failedGate: "build", action: "Fix the first compiler/bundler error, then rerun the build and verify_app." },
    ],
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
  const contractorMarketing = isContractorMarketingPrompt(prompt);
  const contractorSite = isContractorSitePrompt(prompt);
  const marketingPages = inferMarketingPages(prompt, { fullStack, localService, hasExplicitPrompt: Boolean(args.prompt), contractorSite });
  const pages = [{ path: "/", title: "Home" }, ...productWorkflow.pages, ...marketingPages];
  const hasMultiPageMarketing = !fullStack && marketingPages.length > 0;
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
      allowed: ["supabase"],
      forbidden: ["stripe"],
    },
    successCriteria: [
      "Full required verify-app gate passes",
      "Generated app matches this app spec contract",
      "Operator build discipline followed: target lock, plan, real implementation, verify_app, checkpoint, persistent local preview, and exact blocker reporting",
      "No forbidden integrations appear unless explicitly allowed in this spec",
      ...(hasMultiPageMarketing ? ["Every appSpec page is implemented as a routable page, not collapsed into a single landing page"] : []),
      ...(hasMultiPageMarketing ? [contractorMarketing
        ? "Premium marketing sites include a hero system visual, lead-flow module, interactive audit, before/after comparison, sticky CTA, and SPA internal navigation"
        : "Premium marketing sites include a hero system visual, animated value-flow module, interactive conversion/qualification module, proof/comparison section, sticky CTA, and SPA internal navigation"] : []),
      ...(localService && contractorSite ? [
        "Contractor/local-service sites follow contractor-site-autonomous-build: complete route map, service pages, city pages, reviews/FAQ/contact/privacy, sitemap/robots, and honest no-fake-claims copy",
        "Lead/contact forms are either wired to a real API with matching fields or replaced with honest email/phone CTAs",
      ] : []),
      ...(productWorkflow.workflow ? ["Every primary workflow action is wired to UI, API, and durable state or visible setup-required fallback"] : []),
      ...(fullStack ? ["Supabase Auth, database schema, and storage foundation are scaffolded before product-specific data/photo workflows are added"] : []),
    ],
  };
}

function inferMarketingPages(prompt: string, args: { fullStack: boolean; localService: boolean; hasExplicitPrompt: boolean; contractorSite: boolean }): Array<{ path: string; title: string }> {
  if (args.fullStack) return [];
  const text = prompt.toLowerCase();
  const asksForFullSite = /\b(full|multi[- ]page|complete|entire)\b/.test(text)
    || /\b(site|website|web app)\b/.test(text)
    || /\b(services?|industries|case studies|proof|process|pricing|packages?|resources?|blog|contact|service areas?|locations?|gallery|portfolio)\b/.test(text);
  if (!args.localService && !args.hasExplicitPrompt && !asksForFullSite) return [];
  if (!args.localService && !asksForFullSite) return [];

  if (args.contractorSite) {
    return inferContractorSitePages(prompt);
  }

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
  if (args.localService || /\babout|company|team|crew\b/.test(text)) add("/about", "About");
  if (args.localService || /\bservice areas?|locations?|near me|local\b/.test(text)) add("/service-area", "Service Area");
  if (args.localService || /\bgallery|photos?|portfolio|projects?\b/.test(text)) add("/gallery", "Gallery");
  add("/contact", "Contact");

  return uniquePages(pages);
}

function isContractorMarketingPrompt(prompt: string): boolean {
  return /\b(contractor|construction|home service|trade|trades|roof|roofing|remodel|remodeling|plumb|plumbing|electric|electrical|hvac|concrete|landscap|painting|flooring|deck|patio|gutter|siding|window|estimate|quote)\b/i.test(prompt);
}

function isContractorSitePrompt(prompt: string): boolean {
  const text = prompt.toLowerCase();
  if (/\b(marketing|agency|lead gen|lead generation|seo|advertising|website cleanup|growth help)\b/.test(text)
    && /\b(for|serving|helps?)\s+(contractors?|roofers?|remodelers?|trades?)\b/.test(text)) {
    return false;
  }
  return /\b(?:roofing|roofers?|remodel(?:ing|ers?)?|plumbing|plumbers?|electrical|electricians?|hvac|concrete|landscaping|painting|flooring|general contractor|contractor|construction|home service|trade|trades)\b/.test(text)
    && /\b(?:site|website|service area|service areas|city pages?|near me|quote|estimate|inspection|company|business)\b/.test(text);
}

function inferContractorSitePages(prompt: string): Array<{ path: string; title: string }> {
  const pages: Array<{ path: string; title: string }> = [];
  const add = (path: string, title: string) => pages.push({ path, title });
  const services = inferContractorServices(prompt);
  const cities = inferContractorCities(prompt);

  add("/services", "Services");
  for (const service of services) add(`/services/${service.slug}`, service.title);
  add("/process", "Process");
  add("/about", "About");
  add("/service-areas", "Service Areas");
  add("/service-area", "Service Area");
  for (const city of cities) add(`/service-areas/${city.slug}`, city.title);
  add("/projects", "Projects");
  add("/gallery", "Gallery");
  add("/reviews", "Reviews");
  add("/faq", "FAQ");
  add("/contact", "Contact");
  add("/privacy", "Privacy Policy");
  add("/terms", "Terms");

  return uniquePages(pages);
}

function inferContractorServices(prompt: string): Array<{ slug: string; title: string }> {
  const text = prompt.toLowerCase();
  if (/\b(roof|roofing|roofer)\b/.test(text)) {
    return [
      { slug: "roof-replacement", title: "Roof Replacement" },
      { slug: "roof-repair", title: "Roof Repair" },
      { slug: "storm-damage-restoration", title: "Storm Damage Restoration" },
      { slug: "roof-inspections", title: "Roof Inspections" },
      { slug: "gutter-installation", title: "Gutter Installation" },
      { slug: "metal-roofing", title: "Metal Roofing" },
    ];
  }
  if (/\b(hvac|air conditioning|furnace|heat pump)\b/.test(text)) {
    return [
      { slug: "ac-repair", title: "AC Repair" },
      { slug: "ac-installation", title: "AC Installation" },
      { slug: "heating-repair", title: "Heating Repair" },
      { slug: "furnace-installation", title: "Furnace Installation" },
      { slug: "heat-pumps", title: "Heat Pumps" },
      { slug: "maintenance", title: "Maintenance" },
    ];
  }
  if (/\b(plumb|plumbing)\b/.test(text)) {
    return [
      { slug: "leak-repair", title: "Leak Repair" },
      { slug: "drain-cleaning", title: "Drain Cleaning" },
      { slug: "water-heaters", title: "Water Heaters" },
      { slug: "sewer-line-repair", title: "Sewer Line Repair" },
      { slug: "fixture-installation", title: "Fixture Installation" },
      { slug: "repiping", title: "Repiping" },
    ];
  }
  if (/\b(electric|electrical|electrician)\b/.test(text)) {
    return [
      { slug: "panel-upgrades", title: "Panel Upgrades" },
      { slug: "lighting-installation", title: "Lighting Installation" },
      { slug: "outlet-switch-repair", title: "Outlet and Switch Repair" },
      { slug: "rewiring", title: "Rewiring" },
      { slug: "ev-chargers", title: "EV Chargers" },
      { slug: "generator-installation", title: "Generator Installation" },
    ];
  }
  if (/\b(concrete|flatwork|driveway|patio|sidewalk)\b/.test(text)) {
    return [
      { slug: "driveways", title: "Driveways" },
      { slug: "patios", title: "Patios" },
      { slug: "sidewalks", title: "Sidewalks" },
      { slug: "slabs-foundations", title: "Slabs and Foundations" },
      { slug: "decorative-concrete", title: "Decorative Concrete" },
      { slug: "concrete-repair", title: "Concrete Repair" },
    ];
  }
  if (/\b(landscap|lawn|hardscap|irrigation)\b/.test(text)) {
    return [
      { slug: "landscape-design", title: "Landscape Design" },
      { slug: "lawn-care", title: "Lawn Care" },
      { slug: "hardscaping", title: "Hardscaping" },
      { slug: "irrigation", title: "Irrigation" },
      { slug: "drainage-solutions", title: "Drainage Solutions" },
      { slug: "outdoor-living", title: "Outdoor Living" },
    ];
  }
  return [
    { slug: "kitchen-remodeling", title: "Kitchen Remodeling" },
    { slug: "bathroom-remodeling", title: "Bathroom Remodeling" },
    { slug: "whole-home-remodeling", title: "Whole-Home Remodeling" },
    { slug: "home-additions", title: "Home Additions" },
    { slug: "exterior-remodeling", title: "Exterior Remodeling" },
    { slug: "decks-patios-porches", title: "Decks, Patios, and Porches" },
  ];
}

function inferContractorCities(prompt: string): Array<{ slug: string; title: string }> {
  const text = prompt.toLowerCase();
  if (/\btulsa\b/.test(text)) {
    return ["Tulsa", "Broken Arrow", "Owasso", "Bixby", "Jenks", "Sand Springs", "Sapulpa", "Claremore"].map(cityPage);
  }
  if (/\boklahoma city\b|\bokc\b/.test(text)) {
    return ["Oklahoma City", "Edmond", "Yukon", "Moore", "Norman", "Bethany", "Mustang", "Midwest City"].map(cityPage);
  }
  if (/\boswego\b/.test(text)) {
    return ["Oswego", "Parsons", "Chetopa", "Altamont", "Columbus", "Baxter Springs", "Miami", "Joplin"].map(cityPage);
  }
  if (/\bjoplin\b/.test(text)) {
    return ["Joplin", "Webb City", "Carl Junction", "Carthage", "Neosho", "Galena", "Pittsburg", "Miami"].map(cityPage);
  }
  if (/\bpittsburg\b/.test(text)) {
    return ["Pittsburg", "Frontenac", "Girard", "Arma", "Mulberry", "Parsons", "Joplin", "Fort Scott"].map(cityPage);
  }
  return ["Primary Service Area", "North Service Area", "South Service Area", "East Service Area", "West Service Area", "Nearby Communities"].map(cityPage);
}

function cityPage(title: string): { slug: string; title: string } {
  return { slug: slugifySegment(title), title };
}

function slugifySegment(value: string): string {
  return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
  if (!state) {
    return {
      hasSuccessfulVerification: false,
      fresh: false,
      reason: "no project-state.json detected; verify-app status is not available for this directory",
      currentSourceFingerprint: { sha256: "", fileCount: 0, bytes: 0 },
    };
  }
  const currentSourceFingerprint = computeSourceFingerprint(dir);
  const lastSuccessful = state.verification?.lastSuccessfulVerification;
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
