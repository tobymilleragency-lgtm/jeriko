import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { fail, failWithDetails, ok } from "../../../shared/output.js";
import { existsSync, readFileSync, readdirSync, accessSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readProjectState, writeProjectState, computeSourceFingerprint, type AppProfile, type ProjectState, type AppSpecContract } from "./project-state.js";

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

export interface ScaffoldResidueHit {
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

export interface RealnessHit {
  file: string;
  line: number;
  token: string;
  reason: string;
}

export interface AppSpecIssue {
  file: string;
  line: number;
  token: string;
  reason: string;
}

export interface ForbiddenIntegrationHit {
  file: string;
  line: number;
  token: string;
  integration: string;
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
  checkedRoutes?: number;
  issues?: string[];
}

export interface ProductionArtifactStatus {
  checked: boolean;
  ok: boolean;
  output: string;
  hits: RealnessHit[];
}

const PLACEHOLDER_PATTERN = /\{\{[a-zA-Z0-9_]+\}\}|__PLACEHOLDER__|<%=?\s*[^%]+%>/g;
const SCAFFOLD_RESIDUE_TOKENS = [
  "Example Page",
  "Any **markdown** content",
  "Example Button",
  "demo response",
  "Lorem ipsum",
  "BLOCK TO BE DELETED",
  "Google Fonts here, example",
  "the site speaks to",
  "site directs visitors",
  "current site directs",
  "current site says",
  "representative listings",
  "representative residential",
  "Badass",
  "trash site",
  "garbage site",
];
const UNSAFE_ENV_PATTERN = /\bVITE_SUPABASE_(URL|ANON_KEY)\b/g;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".svelte-kit", "coverage"]);
const MAX_OUTPUT = 12_000;
const BUSINESS_ENTITY_PATTERN = /\b(orders?|shipments?|inventory|listings?|customers?|buyers?|expenses?|stores?|scans?)\b/i;
const PRIMARY_LOCAL_STORAGE_PATTERN = /(?:window\.)?localStorage\s*\.\s*(?:setItem|getItem|removeItem)/;
const DEBUG_ARTIFACT_TOKENS = ["/__jeriko__/debug-collector.js", "__JERIKO_DEBUG_COLLECTOR__", "/__jeriko__/logs"];
const PUBLIC_MOCK_COPY_TOKENS = [
  "MVP mock data",
  "mock data",
  "prototype only",
  "demo shell",
  "BLOCK TO BE DELETED",
  "Google Fonts here, example",
  "the site speaks to",
  "site directs visitors",
  "current site directs",
  "current site says",
  "representative listings",
  "representative residential",
];
const PUBLIC_BUILDER_META_COPY_PATTERNS: Array<{ pattern: RegExp; token: string; reason: string }> = [
  {
    pattern: /\bguide\s+depth\b/i,
    token: "Guide depth",
    reason: "Customer-facing pages must not expose builder/SEO production metrics like guide depth.",
  },
  {
    pattern: /\b(?:city|area|seo|location|service|page|route|guide)[A-Za-z0-9_]*WordCount\b|\bwordCount[A-Za-z0-9_]*(?:city|area|seo|location|service|page|route|guide)\b/i,
    token: "wordCount",
    reason: "Generated marketing/site UI must not compute or display content word counts as customer-facing proof.",
  },
  {
    pattern: /\b(?:content|guide|page|route|section|article)\s+(?:depth|length|word\s*count)\b/i,
    token: "content depth/word count",
    reason: "Public copy must describe the customer's offer, not the builder's content metrics.",
  },
  {
    pattern: /\b(?:created|generated|wrote|rendered)\s+\d{2,}\s+words?\b/i,
    token: "generated word count",
    reason: "Do not publish builder progress/word-count claims inside generated customer sites.",
  },
  {
    pattern: /\b(?:SEO|search-engine|crawler|crawlable|sitemap|route|routable|indexed)\s+(?:page|content|coverage|structure|system|route|HTML|signal)s?\b|\b(?:page|route|content)\s+(?:for|to)\s+(?:SEO|search engines|crawlers)\b/i,
    token: "builder SEO/crawler copy",
    reason: "Customer-facing contractor copy must sell the contractor's work, not describe SEO/crawler/page architecture.",
  },
  {
    pattern: /\b(?:service|city|service-area|location)\s+pages?\b|\bevery\s+(?:core\s+)?(?:construction\s+)?service\s+has\s+its\s+own\s+page\b|\beach\s+(?:service|city|service-area|location)\s+page\b/i,
    token: "public page-architecture copy",
    reason: "Public service copy must describe customer problems and outcomes, not explain that Jeriko built separate service/city pages.",
  },
  {
    pattern: /\b(?:lead\s+flow|lead\s+leak|visitor\s+lands|flat\s+brochure|brochure\s+site|generic\s+contractor\s+page|local\s+SEO\s+system|quote\s+path|estimate\s+request\s+workflow)\b/i,
    token: "builder/conversion-system copy",
    reason: "Customer-facing contractor pages must not expose internal marketing-system language such as lead flow, brochure-site comparisons, or quote-path architecture.",
  },
  {
    pattern: /\b\d{2,}\s+words?\b/i,
    token: "visible word count",
    reason: "Visible word counts are builder/SEO metadata unless the app is explicitly a writing/editor product.",
  },
];
const FORBIDDEN_INTEGRATIONS = {
  stripe: [
    "billing.stripe.com",
    "checkout.stripe.com",
    "connect.stripe.com",
    "dashboard.stripe.com",
    "js.stripe.com",
    "api.stripe.com",
    "@stripe/stripe-js",
    "@stripe/react-stripe-js",
    "stripe:",
    "\"stripe\"",
    "'stripe'",
    "Connect Stripe",
    "Stripe Checkout",
    "Stripe billing",
  ],
  supabase: [
    "@supabase/supabase-js",
    "@supabase/auth-js",
    "@supabase/postgrest-js",
    "@supabase/realtime-js",
    "@supabase/storage-js",
    "@supabase/functions-js",
    "supabase:",
    "\"supabase\"",
    "'supabase'",
    "createClient(",
    "from(\"",
    "from('",
  ],
} as const;

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

    const scaffoldResidue = scanScaffoldResidue(dir);
    gates.push({ name: "scaffold_residue_scan", ok: scaffoldResidue.length === 0 });
    if (scaffoldResidue.length > 0) {
      failWithDetails("Generated app still contains scaffold/demo residue.", {
        errorCode: "E_SCAFFOLD_RESIDUE",
        directory: dir,
        profile,
        projectState,
        scaffoldResidue,
        gates,
      });
    }

    const uncontractedContractorSite = scanUncontractedContractorMarketingSite(dir, projectState);
    if (uncontractedContractorSite.length > 0) {
      gates.push({ name: "contractor_site_contract_scan", ok: false });
      failWithDetails("Generated contractor/local-service site is missing Jeriko's appSpec contract or contains obvious launch-blocking business identity/contact defects.", {
        errorCode: "E_CONTRACTOR_SITE_CONTRACT",
        directory: dir,
        profile,
        projectState,
        contractorSiteIssues: uncontractedContractorSite,
        gates,
      });
    }

    const builderMetaCopy = scanPublicBuilderMetaCopy(dir, projectState);
    gates.push({ name: "public_builder_meta_scan", ok: builderMetaCopy.length === 0 });
    if (builderMetaCopy.length > 0) {
      failWithDetails("Generated app exposes builder/SEO meta copy as customer-facing UI. Remove visible word counts, guide-depth labels, generated-content metrics, and other app-builder commentary from public pages.", {
        errorCode: "E_PUBLIC_BUILDER_META_COPY",
        directory: dir,
        profile,
        projectState,
        builderMetaCopy,
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

    const localStoragePersistence = scanPrimaryLocalStoragePersistence(dir);
    gates.push({ name: "primary_persistence_scan", ok: localStoragePersistence.length === 0 });
    if (localStoragePersistence.length > 0) {
      failWithDetails("Generated app persists business workflow data primarily in localStorage. Production apps need backend/database persistence for core entities and workflows.", {
        errorCode: "E_LOCALSTORAGE_PRIMARY_DB",
        directory: dir,
        profile,
        projectState,
        localStoragePersistence,
        gates,
      });
    }

    const dbAuthWorkflowWiring = scanDbAuthWorkflowWiring(dir, profile);
    gates.push({ name: "db_auth_workflow_wiring", ok: dbAuthWorkflowWiring.length === 0 });
    if (dbAuthWorkflowWiring.length > 0) {
      failWithDetails("Generated database app has contradictory auth/database workflow wiring. Do not show live-database copy or expose throwing mutation flows unless a visible sign-in/setup path and real persistence are wired.", {
        errorCode: "E_DB_AUTH_WORKFLOW_WIRING",
        directory: dir,
        profile,
        projectState,
        dbAuthWorkflowWiring,
        gates,
      });
    }

    const authRuntimeConfig = scanAuthRuntimeConfig(dir, profile);
    gates.push({ name: "auth_runtime_config_scan", ok: authRuntimeConfig.length === 0 });
    if (authRuntimeConfig.length > 0) {
      failWithDetails("Generated database app has broken or unsafe auth runtime wiring. OAuth start buttons must resolve to a real server route, SameSite=None cookies must be Secure, JWT secrets must fail closed, and setup logs must name the actual env keys.", {
        errorCode: "E_AUTH_RUNTIME_CONFIG",
        directory: dir,
        profile,
        projectState,
        authRuntimeConfig,
        gates,
      });
    }

    const mockDataImports = scanMockDataImports(dir);
    gates.push({ name: "mock_data_import_scan", ok: mockDataImports.length === 0 });
    if (mockDataImports.length > 0) {
      failWithDetails("Generated production app pages import mock/static business data. Wire pages to generated backend/database state or clearly keep the app in a demo-only profile.", {
        errorCode: "E_MOCK_DATA_IMPORTS",
        directory: dir,
        profile,
        projectState,
        mockDataImports,
        gates,
      });
    }

    const providerConfigDrift = scanMisleadingProviderConfig(dir);
    gates.push({ name: "provider_config_scan", ok: providerConfigDrift.length === 0 });
    if (providerConfigDrift.length > 0) {
      failWithDetails("Generated app has misleading AI-provider setup errors or env names. Error messages must name the actual configured env key so users can fix provider setup.", {
        errorCode: "E_PROVIDER_CONFIG_DRIFT",
        directory: dir,
        profile,
        projectState,
        providerConfigDrift,
        gates,
      });
    }

    const readinessClaims = scanMisleadingReadinessClaims(dir, profile);
    gates.push({ name: "readiness_claim_scan", ok: readinessClaims.length === 0 });
    if (readinessClaims.length > 0) {
      failWithDetails("Generated app has hard-coded production/AI readiness claims. Replace them with live health/setup state and only claim readiness after route/API/browser proof.", {
        errorCode: "E_MISLEADING_READINESS_CLAIMS",
        directory: dir,
        profile,
        projectState,
        readinessClaims,
        gates,
      });
    }

    if (profile === "web-db-user") {
      const vercelApiPackaging = scanVercelApiPackaging(dir, profile);
      gates.push({ name: "vercel_api_packaging_scan", ok: vercelApiPackaging.length === 0 });
      if (vercelApiPackaging.length > 0) {
        failWithDetails("Generated database app has Vercel API handlers that are not production-safe. API functions must be bundled JS, expose API/TRPC/OAuth only, and must not import Vite/static serving.", {
          errorCode: "E_VERCEL_API_PACKAGING",
          directory: dir,
          profile,
          projectState,
          vercelApiPackaging,
          gates,
        });
      }
    }

    const duplicateSectionImages = scanDuplicateSectionImages(dir);
    gates.push({ name: "image_uniqueness_scan", ok: duplicateSectionImages.length === 0 });
    if (duplicateSectionImages.length > 0) {
      failWithDetails("Generated app reuses the same section image in multiple places. Every visible section/card must use a distinct image unless reuse was explicitly requested.", {
        errorCode: "E_DUPLICATE_SECTION_IMAGES",
        directory: dir,
        profile,
        projectState,
        duplicateSectionImages,
        gates,
      });
    }

    const appSpecGatesNeeded = Boolean(projectState?.appSpec) || Boolean(projectState?.verification?.requiredGates?.some((gate) => gate === "app_spec_contract" || gate === "app_builder_control_plan" || gate === "forbidden_integration_scan" || gate === "app_spec_verifier"));
    if (appSpecGatesNeeded) {
      const appBuilderControlPlanIssues = validateAppBuilderControlPlan(projectState);
      gates.push({ name: "app_builder_control_plan", ok: appBuilderControlPlanIssues.length === 0 });
      if (appBuilderControlPlanIssues.length > 0) {
        failWithDetails("Generated app is missing Jeriko's executable app-builder control plan.", {
          errorCode: "E_APP_BUILDER_CONTROL_PLAN",
          directory: dir,
          profile,
          projectState,
          appBuilderControlPlanIssues,
          gates,
        });
      }

      const appSpecContractIssues = validateAppSpecContract(projectState);
      gates.push({ name: "app_spec_contract", ok: appSpecContractIssues.length === 0 });
      if (appSpecContractIssues.length > 0) {
        failWithDetails("Generated app is missing a valid Jeriko app spec contract.", {
          errorCode: "E_APP_SPEC_CONTRACT",
          directory: dir,
          profile,
          projectState,
          appSpecIssues: appSpecContractIssues,
          gates,
        });
      }

      const forbiddenIntegrations = scanForbiddenIntegrations(dir, projectState);
      gates.push({ name: "forbidden_integration_scan", ok: forbiddenIntegrations.length === 0 });
      if (forbiddenIntegrations.length > 0) {
        failWithDetails("Generated app contains a forbidden integration that was not explicitly allowed by its app spec contract.", {
          errorCode: "E_FORBIDDEN_INTEGRATION",
          directory: dir,
          profile,
          projectState,
          forbiddenIntegrations,
          gates,
        });
      }

      const workflowContractIssues = scanWorkflowContract(dir, projectState);
      gates.push({ name: "workflow_contract", ok: workflowContractIssues.length === 0 });
      if (workflowContractIssues.length > 0) {
        failWithDetails("Generated full-stack app is missing required product workflow contract details.", {
          errorCode: "E_WORKFLOW_CONTRACT",
          directory: dir,
          profile,
          projectState,
          workflowContractIssues,
          gates,
        });
      }

      const primaryActionWiring = scanPrimaryActionWiring(dir, profile);
      gates.push({ name: "primary_action_wiring", ok: primaryActionWiring.length === 0 });
      if (primaryActionWiring.length > 0) {
        failWithDetails("Generated app has visible primary action buttons that are not wired to handlers, API calls, state changes, or visible setup-required fallback.", {
          errorCode: "E_PRIMARY_ACTION_WIRING",
          directory: dir,
          profile,
          projectState,
          primaryActionWiring,
          gates,
        });
      }

      const businessMathRealness = scanBusinessMathRealness(dir, profile);
      gates.push({ name: "business_math_realness", ok: businessMathRealness.length === 0 });
      if (businessMathRealness.length > 0) {
        failWithDetails("Generated app hard-codes business pricing/cost/profit outputs. Product apps must calculate these values from user inputs or persisted records.", {
          errorCode: "E_BUSINESS_MATH_REALNESS",
          directory: dir,
          profile,
          projectState,
          businessMathRealness,
          gates,
        });
      }

      const swallowedPrimaryFetchErrors = scanSwallowedPrimaryFetchErrors(dir, profile);
      gates.push({ name: "primary_fetch_error_handling", ok: swallowedPrimaryFetchErrors.length === 0 });
      if (swallowedPrimaryFetchErrors.length > 0) {
        failWithDetails("Generated app swallows primary workflow network or persistence failures. Product actions must surface errors or setup-required state instead of ignoring failed API calls.", {
          errorCode: "E_SWALLOWED_PRIMARY_FETCH_ERRORS",
          directory: dir,
          profile,
          projectState,
          swallowedPrimaryFetchErrors,
          gates,
        });
      }

      const supabaseProductFoundation = scanSupabaseProductFoundation(dir, profile, projectState);
      gates.push({ name: "supabase_product_foundation", ok: supabaseProductFoundation.length === 0 });
      if (supabaseProductFoundation.length > 0) {
        failWithDetails("Generated database app is missing the standard Supabase Auth/database/storage foundation. Web-db-user product apps must scaffold app-scoped Supabase Auth envs, durable product tables, and Supabase Storage helpers before custom product workflows are added.", {
          errorCode: "E_SUPABASE_PRODUCT_FOUNDATION",
          directory: dir,
          profile,
          projectState,
          supabaseProductFoundation,
          gates,
        });
      }

      const premiumMarketingSiteIssues = scanPremiumMarketingSiteQuality(dir, projectState);
      gates.push({ name: "premium_marketing_site_scan", ok: premiumMarketingSiteIssues.length === 0 });
      if (premiumMarketingSiteIssues.length > 0) {
        failWithDetails("Generated marketing site is plain brochureware or deploy-unsafe. Full contractor/local-service sites need premium conversion modules, SPA internal navigation, dark no-flash base styles, and Vercel static routing.", {
          errorCode: "E_PREMIUM_MARKETING_SITE",
          directory: dir,
          profile,
          projectState,
          premiumMarketingSiteIssues,
          gates,
        });
      }

      const appSpecIssues = scanAppSpecCompliance(dir, projectState);
      gates.push({ name: "app_spec_verifier", ok: appSpecIssues.length === 0 });
      if (appSpecIssues.length > 0) {
        failWithDetails("Generated app does not satisfy its app spec contract.", {
          errorCode: "E_APP_SPEC_MISMATCH",
          directory: dir,
          profile,
          projectState,
          appSpecIssues,
          gates,
        });
      }
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

    const testCommand = detectScriptCommand(dir, "test");
    if (testCommand) {
      const gate = runGate("test", testCommand, dir);
      gates.push(gate);
      if (!gate.ok) return failGate(dir, profile, gates, gate);
    }

    const buildCommand = projectState?.commands?.build || detectScriptCommand(dir, "build");
    if (buildCommand) {
      const gate = runGate("build", buildCommand, dir);
      gates.push(gate);
      if (!gate.ok) return failGate(dir, profile, gates, gate);

      const artifactStatus = scanProductionArtifactResidue(dir);
      if (artifactStatus.checked) {
        const artifactGate: VerificationGate = {
          name: "production_artifact_scan",
          ok: artifactStatus.ok,
          status: artifactStatus.ok ? 0 : 1,
          output: artifactStatus.output,
        };
        gates.push(artifactGate);
        if (!artifactGate.ok) return failGate(dir, profile, gates, artifactGate);
      }

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
        const browserGate = await runBrowserSmokeGate(dir, profile, port, browserRoute, projectState);
        gates.push(browserGate);
        if (!browserGate.ok) return failGate(dir, profile, gates, browserGate);
      }
    }

    const finalDependencyStatus = getDependencyStatus(dir);
    const skippedRequiredGates = skippedRequiredVerificationGates(projectState, { skipStart, skipBrowser });
    const finalProjectState = projectState && skippedRequiredGates.length === 0
      ? recordSuccessfulVerification(dir, projectState, profile, gates, buildVerifyCommand(dir, parsed.positional.slice(1), parsed.flags))
      : projectState;
    ok({ directory: dir, profile, projectState: finalProjectState, dependencyStatus: finalDependencyStatus, gates, skippedRequiredGates });
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

function skippedRequiredVerificationGates(projectState: ProjectState | null, options: { skipStart: boolean; skipBrowser: boolean }): string[] {
  const required = projectState?.verification?.requiredGates ?? [];
  const skipped = new Set<string>();
  if (options.skipStart) {
    skipped.add("start_route");
    skipped.add("browser_smoke");
  } else if (options.skipBrowser) {
    skipped.add("browser_smoke");
  }
  return required.filter((gate) => skipped.has(gate));
}

function buildVerifyCommand(dir: string, extraPositionals: string[], flags: Record<string, unknown>): string {
  const parts = ["jeriko", "verify-app", shellQuote(dir)];
  for (const positional of extraPositionals) parts.push(shellQuote(String(positional)));
  for (const [key, value] of Object.entries(flags)) {
    if (value === false || value === undefined || value === null) continue;
    parts.push(`--${key}`);
    if (value !== true) parts.push(shellQuote(String(value)));
  }
  return parts.join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function recordSuccessfulVerification(dir: string, projectState: ProjectState, profile: AppProfile, gates: VerificationGate[], command: string): ProjectState {
  const slimGates = gates.map((gate) => ({
    name: gate.name,
    ok: gate.ok,
    ...(gate.command ? { command: gate.command } : {}),
    ...(typeof gate.status === "number" ? { status: gate.status } : {}),
  }));
  const passedGateNames = gates.filter((gate) => gate.ok).map((gate) => gate.name);
  const requiredGates = Array.from(new Set([...(projectState.verification.requiredGates ?? []), ...passedGateNames]));
  const updated: ProjectState = {
    ...projectState,
    verification: {
      ...projectState.verification,
      requiredGates,
      lastSuccessfulVerification: {
        ok: true,
        profile,
        completedAt: new Date().toISOString(),
        command,
        gates: slimGates,
        sourceFingerprint: computeSourceFingerprint(dir),
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

export function validateAppBuilderControlPlan(projectState: ProjectState | null): AppSpecIssue[] {
  if (!projectState) return [];
  const requiresPlan = projectState.verification?.requiredGates?.includes("app_builder_control_plan") ?? false;
  const plan = projectState.appBuilderPlan;
  if (!plan) {
    return requiresPlan
      ? [{ file: "project-state.json", line: 0, token: "appBuilderPlan", reason: "Missing app-builder control plan. Generated apps need executable build phases, mandatory skills, and failed-gate repair routers." }]
      : [];
  }
  const issues: AppSpecIssue[] = [];
  const phaseIds = Array.isArray(plan.phases) ? plan.phases.map((phase: any) => String(phase?.id ?? "")) : [];
  const requiredPhases = ["target-lock", "skill-bind", "appspec-plan", "scaffold", "implement-routes", "implement-workflows", "verify", "repair", "checkpoint-preview", "evidence-report"];
  if (plan.mode !== "controlled-app-build") issues.push({ file: "project-state.json", line: 0, token: "appBuilderPlan.mode", reason: "App-builder control plan mode must be controlled-app-build." });
  if (!Array.isArray(plan.mandatorySkills) || !plan.mandatorySkills.includes("operator-build-discipline")) {
    issues.push({ file: "project-state.json", line: 0, token: "appBuilderPlan.mandatorySkills", reason: "App-builder control plan must bind operator-build-discipline before implementation." });
  }
  if (isContractorLikeProjectState(projectState) && !plan.mandatorySkills?.includes("contractor-site-autonomous-build")) {
    issues.push({ file: "project-state.json", line: 0, token: "appBuilderPlan.mandatorySkills", reason: "Contractor/local-service sites must bind contractor-site-autonomous-build before implementation." });
  }
  for (const phase of requiredPhases) {
    if (!phaseIds.includes(phase)) issues.push({ file: "project-state.json", line: 0, token: `appBuilderPlan.phase:${phase}`, reason: `Missing app-builder phase: ${phase}.` });
  }
  const routers = Array.isArray(plan.repairRouters) ? plan.repairRouters : [];
  for (const gate of ["app_spec_verifier", "premium_marketing_site_scan", "public_builder_meta_scan", "workflow_contract", "primary_action_wiring", "crawler_html", "build"]) {
    if (!routers.some((router: any) => router?.failedGate === gate && nonEmpty(router?.action))) {
      issues.push({ file: "project-state.json", line: 0, token: `appBuilderPlan.repairRouters:${gate}`, reason: `Missing failed-gate repair router for ${gate}.` });
    }
  }
  return issues;
}

function isContractorLikeProjectState(projectState: ProjectState): boolean {
  const haystack = [projectState.appSpec?.appType, projectState.appSpec?.prompt, ...(projectState.appSpec?.features ?? [])].join(" ");
  return /contractor|construction|roof|remodel|plumb|electric|hvac|local-service|service area|quote|estimate/i.test(haystack);
}

export function validateAppSpecContract(projectState: ProjectState | null): AppSpecIssue[] {
  if (!projectState) return [];
  const spec = projectState.appSpec;
  const requiresSpec = projectState.verification?.requiredGates?.includes("app_spec_contract") ?? false;
  if (!spec) {
    return requiresSpec
      ? [{ file: "project-state.json", line: 0, token: "appSpec", reason: "Missing app spec contract. Generated apps must record the intended pages, features, integrations, and success criteria before verification can pass." }]
      : [];
  }
  const issues: AppSpecIssue[] = [];
  if (spec.version !== 1) issues.push({ file: "project-state.json", line: 0, token: "appSpec.version", reason: "App spec contract version must be 1." });
  if (!nonEmpty(spec.prompt)) issues.push({ file: "project-state.json", line: 0, token: "appSpec.prompt", reason: "App spec contract must include the source prompt or template intent." });
  if (!nonEmpty(spec.appType)) issues.push({ file: "project-state.json", line: 0, token: "appSpec.appType", reason: "App spec contract must include an app type." });
  if (!Array.isArray(spec.pages) || spec.pages.length === 0) issues.push({ file: "project-state.json", line: 0, token: "appSpec.pages", reason: "App spec contract must list required pages/routes." });
  if (!Array.isArray(spec.features)) issues.push({ file: "project-state.json", line: 0, token: "appSpec.features", reason: "App spec contract must list required features." });
  if (!Array.isArray(spec.successCriteria) || spec.successCriteria.length === 0) issues.push({ file: "project-state.json", line: 0, token: "appSpec.successCriteria", reason: "App spec contract must list success criteria." });
  if (!spec.integrations || !Array.isArray(spec.integrations.allowed) || !Array.isArray(spec.integrations.forbidden)) {
    issues.push({ file: "project-state.json", line: 0, token: "appSpec.integrations", reason: "App spec contract must include allowed and forbidden integration lists." });
  }
  if (projectState.profile === "web-db-user" && spec.appType === "full-stack-product-app" && (!Array.isArray(spec.workflows) || spec.workflows.length === 0)) {
    issues.push({ file: "project-state.json", line: 0, token: "appSpec.workflows", reason: "Full-stack product apps must list workflows with inputs, actions, outputs, and persistence requirements." });
  }
  return issues;
}

export function scanForbiddenIntegrations(dir: string, projectState: ProjectState | null): ForbiddenIntegrationHit[] {
  const allowed = new Set((projectState?.appSpec?.integrations?.allowed ?? []).map((item) => item.toLowerCase()));
  const hits: ForbiddenIntegrationHit[] = [];
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (isProjectMetadataFile(dir, file)) return;
    const lines = content.split(/\r?\n/);
    for (const [integration, tokens] of Object.entries(FORBIDDEN_INTEGRATIONS)) {
      if (allowed.has(integration.toLowerCase())) continue;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const token of tokens) {
          if (!line.toLowerCase().includes(token.toLowerCase())) continue;
          hits.push({
            file,
            line: i + 1,
            token,
            integration,
            reason: `${integration} is forbidden unless the current app spec explicitly lists it under integrations.allowed.`,
          });
        }
      }
    }
  });
  return hits;
}

export function scanAppSpecCompliance(dir: string, projectState: ProjectState | null): AppSpecIssue[] {
  const contractIssues = validateAppSpecContract(projectState);
  if (contractIssues.length > 0) return contractIssues;
  if (!projectState?.appSpec) return [];
  const spec = projectState.appSpec as AppSpecContract;
  const sourceIndex = buildSourceIndex(dir);
  const issues: AppSpecIssue[] = [];
  for (const page of spec.pages) {
    const route = normalizeSpecRoute(page.path);
    if (routeImplemented(route, sourceIndex)) continue;
    issues.push({
      file: "project-state.json",
      line: 0,
      token: route,
      reason: `Required page is not implemented: ${route}. Add a route/component/file for this app spec page before verification can pass.`,
    });
  }
  return issues;
}

export function scanWorkflowContract(_dir: string, projectState: ProjectState | null): AppSpecIssue[] {
  const spec = projectState?.appSpec;
  if (!spec) return [];
  const prompt = `${spec.prompt ?? ""}`.toLowerCase();
  const workflowText = (spec.workflows ?? [])
    .flatMap((workflow) => [workflow.label, ...(workflow.inputs ?? []), ...(workflow.actions ?? []), ...(workflow.outputs ?? []), ...(workflow.persistence ?? [])])
    .join(" ")
    .toLowerCase();
  const productWorkflowRequired = projectState.profile === "web-db-user" && /scanner|scan|resale|flip|inventory|listing|profit|upload|paste|photo|cost|order|shipment/.test(`${prompt} ${workflowText}`);
  if (!productWorkflowRequired) return [];

  const issues: AppSpecIssue[] = [];
  const workflows = Array.isArray(spec.workflows) ? spec.workflows : [];
  if (workflows.length === 0) {
    issues.push({ file: "project-state.json", line: 0, token: "appSpec.workflows", reason: "Prompt describes a full-stack product workflow, but appSpec.workflows is missing." });
  }
  const merged = {
    inputs: new Set(workflows.flatMap((workflow) => workflow.inputs ?? []).map((item) => item.toLowerCase())),
    actions: new Set(workflows.flatMap((workflow) => workflow.actions ?? []).map((item) => item.toLowerCase())),
    outputs: new Set(workflows.flatMap((workflow) => workflow.outputs ?? []).map((item) => item.toLowerCase())),
    persistence: new Set(workflows.flatMap((workflow) => workflow.persistence ?? []).map((item) => item.toLowerCase())),
  };
  const requiredInputs = ["upload", "paste", "cost"];
  const requiredActions = ["scan", "save"];
  const requiredOutputs = ["profit", "price", "decision"];
  const requiredPersistence = ["items", "scans", "inventory"];
  for (const input of requiredInputs) if (!merged.inputs.has(input)) issues.push({ file: "project-state.json", line: 0, token: `input:${input}`, reason: `Product workflow must declare ${input} input support.` });
  for (const action of requiredActions) if (!merged.actions.has(action)) issues.push({ file: "project-state.json", line: 0, token: `action:${action}`, reason: `Product workflow must declare ${action} action support.` });
  for (const output of requiredOutputs) if (!merged.outputs.has(output)) issues.push({ file: "project-state.json", line: 0, token: `output:${output}`, reason: `Product workflow must declare ${output} output support.` });
  for (const table of requiredPersistence) if (!merged.persistence.has(table)) issues.push({ file: "project-state.json", line: 0, token: `persistence:${table}`, reason: `Product workflow must declare durable ${table} persistence.` });
  return issues;
}

export function scanSupabaseProductFoundation(dir: string, profile: AppProfile = inferAppProfile(dir), projectState: ProjectState | null = readProjectState(dir)): RealnessHit[] {
  if (profile !== "web-db-user") return [];
  const specText = [
    projectState?.appSpec?.prompt ?? "",
    ...(projectState?.appSpec?.features ?? []),
    ...(projectState?.appSpec?.successCriteria ?? []),
    ...(projectState?.appSpec?.workflows ?? []).flatMap((workflow) => [
      workflow.label,
      ...(workflow.inputs ?? []),
      ...(workflow.actions ?? []),
      ...(workflow.outputs ?? []),
      ...(workflow.persistence ?? []),
    ]),
  ].join(" ").toLowerCase();
  const productWorkflowRequired = /scanner|scan|resale|flip|inventory|listing|profit|upload|photo|order|shipment/.test(specText);
  if (!productWorkflowRequired) return [];

  const hits: RealnessHit[] = [];
  const envExamplePath = join(dir, ".env.example");
  const schemaPath = join(dir, "drizzle", "schema.ts");
  const storagePath = join(dir, "server", "supabaseStorage.ts");
  const clientAuthPath = join(dir, "client", "src", "lib", "supabaseAuth.ts");
  const envExample = existsSync(envExamplePath) ? readFileSync(envExamplePath, "utf8") : "";
  const schema = existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : "";
  const storage = existsSync(storagePath) ? readFileSync(storagePath, "utf8") : "";
  const clientAuth = existsSync(clientAuthPath) ? readFileSync(clientAuthPath, "utf8") : "";

  const requireText = (file: string, content: string, token: string, reason: string) => {
    if (content.includes(token)) return;
    hits.push({ file, line: 0, token, reason });
  };

  requireText(".env.example", envExample, "VITE_APP_SUPABASE_URL", "Supabase Auth URL env is missing from generated app setup docs.");
  requireText(".env.example", envExample, "VITE_APP_SUPABASE_ANON_KEY", "Supabase Auth anon key env is missing from generated app setup docs.");
  requireText(".env.example", envExample, "SUPABASE_SERVICE_ROLE_KEY", "Server-side Supabase service role env is required for storage setup and admin-side workflows.");
  if (!/[A-Z0-9_]+_SUPABASE_STORAGE_BUCKET=inventory-photos/.test(envExample)) {
    hits.push({ file: ".env.example", line: 0, token: "<APP>_SUPABASE_STORAGE_BUCKET", reason: "App-scoped Supabase Storage bucket env must be documented so generated apps do not share another app's bucket by accident." });
  }
  requireText("client/src/lib/supabaseAuth.ts", clientAuth, "signInWithOAuth", "Client Supabase Google auth helper is missing.");
  requireText("client/src/lib/supabaseAuth.ts", clientAuth, "provider: \"google\"", "Supabase Auth helper must default to Google OAuth.");

  for (const table of ["inventoryItems", "inventoryPhotos", "scans", "listings", "orders", "shipments"]) {
    requireText("drizzle/schema.ts", schema, table, `Durable product schema is missing ${table}; product apps must not start from user-only database tables.`);
  }
  requireText("server/supabaseStorage.ts", storage, "createClient", "Server Supabase Storage helper must create a Supabase admin client.");
  requireText("server/supabaseStorage.ts", storage, "storage.from", "Server Supabase Storage helper must upload through Supabase Storage buckets.");
  if (!/[A-Z0-9_]+_SUPABASE_STORAGE_BUCKET/.test(storage)) {
    hits.push({ file: "server/supabaseStorage.ts", line: 0, token: "<APP>_SUPABASE_STORAGE_BUCKET", reason: "Storage helper must read an app-scoped bucket env key, not a generic shared bucket setting." });
  }

  return hits;
}

export function scanPrimaryActionWiring(dir: string, profile: AppProfile = inferAppProfile(dir)): RealnessHit[] {
  if (profile !== "web-db-user") return [];
  const hits: RealnessHit[] = [];
  const allText = buildSourceIndex(dir).text;
  const hasSetupFallback = /setup_required|setup required|database_url|sign in|provider setup|configuration required/.test(allText);
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/").toLowerCase();
    if (!normalized.includes("/client/src/") || normalized.includes("/components/ui/") || normalized.includes("/componentshowcase") || normalized.includes(".test.")) return;
    for (const match of content.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const attrs = match[1] ?? "";
      const rawLabel = stripJsx(match[2] ?? "");
      const label = rawLabel.replace(/\s+/g, " ").trim();
      if (!isPrimaryActionLabel(label)) continue;
      const snippet = content.slice(Math.max(0, (match.index ?? 0) - 700), Math.min(content.length, (match.index ?? 0) + match[0].length + 700));
      if (attrs.includes("onClick=") || /fetch\(|api\.|trpc\.|mutate\(|navigate\(|set[A-Z][A-Za-z0-9_]*\(|formAction=|type=["']submit["']/.test(snippet) || (attrs.includes("disabled") && hasSetupFallback)) continue;
      hits.push({ file, line: lineNumberAt(content, match.index ?? 0), token: label, reason: "Visible primary action button is not wired to a handler/API/state change or explicit setup-required fallback." });
    }
  });
  return hits;
}

export function scanBusinessMathRealness(dir: string, profile: AppProfile = inferAppProfile(dir)): RealnessHit[] {
  if (profile !== "web-db-user") return [];
  const hits: RealnessHit[] = [];
  const mathTerms = /(?:estimatedSalePrice|salePrice|askingPrice|netProfit|profit|grossProfit|platformFee|shippingCost|totalCost)\s*[:=]\s*0\b/g;
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!/\/(client\/src|server)\//.test(normalized) || normalized.includes(".test.")) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const match of line.matchAll(mathTerms)) {
        const context = `${lines[Math.max(0, i - 1)] ?? ""}\n${line}\n${lines[i + 1] ?? ""}`;
        if (/useState\(0\)|defaultValue=\{?0\}?|placeholder=/.test(context)) continue;
        hits.push({ file, line: i + 1, token: match[0], reason: "Business pricing/cost/profit output is hard-coded to 0 instead of calculated from user input, API data, or persisted records." });
      }
    }
  });
  return hits;
}

export function scanSwallowedPrimaryFetchErrors(dir: string, profile: AppProfile = inferAppProfile(dir)): RealnessHit[] {
  if (profile !== "web-db-user") return [];
  const hits: RealnessHit[] = [];
  const primaryApiPattern = /fetch\(\s*(["'`])([^"'`]*(?:\/api\/(?:uploads?|scans?|scan-item|inventory|items?|orders?|shipments?|listings?|expenses?|customers?))[^"'`]*)\1[\s\S]{0,400}?\.catch\s*\(\s*(?:\(\s*(?:error|err)?\s*\)|(?:error|err))?\s*=>\s*(?:undefined|void\s+0|null)\s*\)/g;
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!normalized.includes("/client/src/") || normalized.includes("/components/ui/") || normalized.includes("/componentshowcase") || normalized.includes(".test.")) return;
    for (const match of content.matchAll(primaryApiPattern)) {
      const endpoint = match[2] ?? match[0];
      hits.push({
        file,
        line: lineNumberAt(content, match.index ?? 0),
        token: endpoint,
        reason: "Primary workflow API call swallows network or persistence failures instead of surfacing an error or setup-required state.",
      });
    }
  });
  return hits;
}

function isPrimaryActionLabel(label: string): boolean {
  return /\b(upload|paste|scan|save|add|create|generate|list|sell|delete|edit|submit|analyze)\b/i.test(label);
}

function stripJsx(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\{[^}]+\}/g, " ").replace(/&nbsp;/g, " ");
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}

function collectPublicSourceText(dir: string): string {
  const chunks: string[] = [];
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!/\/(client\/src|client\/index\.html|src|app|pages|api|server)\//.test(normalized) && !normalized.endsWith("client/index.html")) return;
    if (normalized.includes("/components/ui/") || normalized.includes(".test.")) return;
    chunks.push(content);
  });
  return chunks.join("\n");
}

function hasExplicitRouteImplementation(sourceText: string, route: string): boolean {
  const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`path\\s*=\\s*['\"]${escaped}['\"]`),
    new RegExp(`path\\s*:\\s*['\"]${escaped}['\"]`),
    new RegExp(`pathname\\s*===?\\s*['\"]${escaped}['\"]`),
    new RegExp(`path\\s*===?\\s*['\"]${escaped}['\"]`),
    new RegExp(`match\\s*\\(\\s*[/^][^\\n]*${escaped.replace(/^\\\//, "")}[^\\n]*[/]`),
  ];
  return patterns.some((pattern) => pattern.test(sourceText));
}

function hasDynamicRouteImplementation(sourceText: string, baseRoute: string): boolean {
  const escaped = baseRoute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutSlash = baseRoute.replace(/^\//, "");
  const patterns = [
    new RegExp(`path\\s*=\\s*['\"]${escaped}/:[A-Za-z0-9_]+['\"]`),
    new RegExp(`path\\s*:\\s*['\"]${escaped}/:[A-Za-z0-9_]+['\"]`),
    new RegExp(`startsWith\\(\\s*['\"]${escaped}/['\"]\\s*\\)`),
    new RegExp(`match\\s*\\(\\s*[/^][^\\n]*${withoutSlash}\\/[^\\n]*[/]`),
  ];
  return patterns.some((pattern) => pattern.test(sourceText));
}

function hasPrimaryHomeNav(sourceText: string): boolean {
  return /label:\s*["']Home["']/.test(sourceText)
    || /<AppLink[^>]+href=["']\/["'][^>]*>\s*Home\s*<\//i.test(sourceText)
    || /<Link[^>]+href=["']\/["'][^>]*>\s*Home\s*<\//i.test(sourceText)
    || /<a[^>]+href=["']\/["'][^>]*>\s*Home\s*<\//i.test(sourceText);
}

function hasPrimaryServiceAreasNav(sourceText: string): boolean {
  return /label:\s*["']Service Areas["']/.test(sourceText)
    || /<AppLink[^>]+href=["']\/service-areas?["'][^>]*>\s*Service Areas\s*<\//i.test(sourceText)
    || /<Link[^>]+href=["']\/service-areas?["'][^>]*>\s*Service Areas\s*<\//i.test(sourceText)
    || /<a[^>]+href=["']\/service-areas?["'][^>]*>\s*Service Areas\s*<\//i.test(sourceText);
}

export function scanUncontractedContractorMarketingSite(dir: string, projectState: ProjectState | null): AppSpecIssue[] {
  if (projectState?.appSpec) return [];
  const sourceText = collectPublicSourceText(dir);
  if (!sourceText.trim()) return [];
  const packagePath = join(dir, "package.json");
  const packageName = existsSync(packagePath) ? safePackageName(readFileSync(packagePath, "utf8")) : "";
  const combined = `${packageName}\n${sourceText}`;
  const looksLikeContractorSite = /\b(contractor|construction|roof(?:er|ing)?|remodel(?:er|ing)?|general contracting|home additions?|bathroom|kitchen|deck|outdoor living|quote|estimate|service areas?)\b/i.test(combined);
  if (!looksLikeContractorSite) return [];

  const issues: AppSpecIssue[] = [];
  issues.push({
    file: ".jeriko/project-state.json",
    line: 0,
    token: "missing-app-spec-contract",
    reason: "Generated contractor/local-service sites must carry Jeriko's appSpec contract. Without it, verify_app skips route breadth, premium marketing, brand identity, and no-fake-claims gates.",
  });

  const packageWords = packageName
    .split(/[^a-z0-9]+/i)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !/^(site|app|web|static|construction|contractor|remodeling|remodel|build|built)$/.test(word.toLowerCase()));
  const lowerSource = sourceText.toLowerCase();
  const missingBrandWords = packageWords.filter((word) => !lowerSource.includes(word.toLowerCase()));
  if (packageWords.length > 0 && missingBrandWords.length === packageWords.length) {
    issues.push({
      file: "package.json",
      line: 0,
      token: packageName,
      reason: `Generated site package/name suggests brand words ${packageWords.join(", ")}, but public source copy does not contain them. This usually means stale business copy from another site/template was shipped.`,
    });
  }

  const badPhoneMatch = sourceText.match(/(?:tel:|phone|call)[^\n]{0,80}(?:\*{2,}|x{3,}|555[-.\s]?01\d{2})/i);
  if (badPhoneMatch) {
    issues.push({
      file: "client/src",
      line: 0,
      token: badPhoneMatch[0].slice(0, 120),
      reason: "Launch-ready contractor sites must not ship masked, dummy, or placeholder phone numbers in public CTAs.",
    });
  }

  return issues;
}

function safePackageName(packageJson: string): string {
  try {
    const parsed = JSON.parse(packageJson);
    return typeof parsed?.name === "string" ? parsed.name : "";
  } catch {
    return "";
  }
}

export function scanPremiumMarketingSiteQuality(dir: string, projectState: ProjectState | null): AppSpecIssue[] {
  const spec = projectState?.appSpec;
  if (!spec || projectState?.profile !== "web-static") return [];
  const requiresPremium = spec.features?.some((feature) => /premium (?:contractor|local business) conversion system|multi-page marketing site|local service seo content/i.test(feature))
    || spec.successCriteria?.some((criterion) => /Premium marketing sites include/i.test(criterion))
    || projectState.verification?.requiredGates?.includes("premium_marketing_site_scan")
    || /local-service|premium-local-service|contractor/i.test(String(spec.appType ?? ""));
  if (!requiresPremium) return [];

  const appPath = join(dir, "client", "src", "App.tsx");
  const indexPath = join(dir, "client", "index.html");
  const vercelPath = join(dir, "vercel.json");
  const app = existsSync(appPath) ? readFileSync(appPath, "utf8") : "";
  const sourceText = collectPublicSourceText(dir);
  const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  const issues: AppSpecIssue[] = [];
  const contractorSite = /contractor|roof|remodel|plumb|electric|hvac|lead|estimate/i.test([spec.prompt, ...(spec.features ?? [])].join(" "));
  const localServiceSite = /local-service|premium-local-service/i.test(String(spec.appType ?? "")) || spec.features?.some((feature) => /local service seo content|service area/i.test(feature));
  const requiredRoutes = contractorSite ? (localServiceSite ? ["/services", "/contact"] : ["/services", "/pricing", "/contact"]) : ["/contact"];
  const requiredLocalServiceRoutes = contractorSite && localServiceSite ? ["/services", "/process", "/about", "/service-areas", "/gallery", "/contact"] : [];
  const requiredAutonomousContractorRoutes = contractorSite && localServiceSite
    ? ["/services", "/process", "/about", "/service-areas", "/projects", "/gallery", "/reviews", "/faq", "/contact", "/privacy", "/terms"]
    : [];
  const specRoutes = Array.isArray(spec.pages) ? spec.pages.map((page) => normalizeSpecRoute(typeof page === "string" ? page : page.path)) : [];
  const serviceRoutes = specRoutes.filter((route) => route.startsWith("/services/") && route !== "/services/");
  const cityRoutes = specRoutes.filter((route) => route.startsWith("/service-areas/") && route !== "/service-areas/");
  if (specRoutes.length < 5 || requiredRoutes.some((route) => !specRoutes.includes(route))) {
    issues.push({ file: "project-state.json", line: 0, token: "appSpec.pages", reason: contractorSite
      ? (localServiceSite
        ? "Premium contractor/local-service sites must keep a full multi-page appSpec contract, including at least /services, /contact, and local-service routes for process, about, service-area, and gallery. Do not collapse the contract to a one-page brochure."
        : "Premium contractor sites must keep a full multi-page appSpec contract, including at least /services, /pricing, and /contact. Do not collapse the contract to a one-page brochure.")
      : "Premium local business sites must keep a full multi-page appSpec contract with at least five routable pages and /contact. Do not collapse the contract to a one-page brochure." });
  }
  if (contractorSite && localServiceSite) {
    const missingAutonomousRoutes = requiredAutonomousContractorRoutes.filter((route) => !specRoutes.includes(route));
    if (missingAutonomousRoutes.length > 0 || serviceRoutes.length < 4 || cityRoutes.length < 3) {
      issues.push({
        file: "project-state.json",
        line: 0,
        token: "contractor-route-contract",
        reason: `Autonomous contractor sites must declare the full route contract: core pages, at least four service pages, and at least three city pages. Missing/weak: ${[...missingAutonomousRoutes, serviceRoutes.length < 4 ? "service-pages" : "", cityRoutes.length < 3 ? "city-pages" : ""].filter(Boolean).join(", ")}.`,
      });
    }
  }
  for (const route of requiredLocalServiceRoutes) {
    if (!specRoutes.includes(route) || !hasExplicitRouteImplementation(sourceText, route)) {
      issues.push({
        file: "client/src/App.tsx",
        line: 0,
        token: `local-service-route:${route}`,
        reason: `Local-service contractor sites must implement ${route} as a real routed page. Links alone or default homepage fallbacks are not enough.`,
      });
    }
  }
  if (contractorSite && localServiceSite) {
    const missingServiceImplementations = serviceRoutes.filter((route) => !hasExplicitRouteImplementation(sourceText, route) && !hasDynamicRouteImplementation(sourceText, "/services"));
    const missingCityImplementations = cityRoutes.filter((route) => !hasExplicitRouteImplementation(sourceText, route) && !hasDynamicRouteImplementation(sourceText, "/service-areas"));
    if (missingServiceImplementations.length > 0) {
      issues.push({
        file: "client/src/App.tsx",
        line: 0,
        token: "contractor-service-page-implementation",
        reason: `Every service route in appSpec must render through a real service page implementation, not homepage fallback. Missing: ${missingServiceImplementations.slice(0, 6).join(", ")}.`,
      });
    }
    if (missingCityImplementations.length > 0) {
      issues.push({
        file: "client/src/App.tsx",
        line: 0,
        token: "contractor-city-page-implementation",
        reason: `Every city route in appSpec must render through a real city/service-area page implementation, not homepage fallback. Missing: ${missingCityImplementations.slice(0, 6).join(", ")}.`,
      });
    }
  }
  if (localServiceSite && !hasPrimaryHomeNav(sourceText)) {
    issues.push({
      file: "client/src/App.tsx",
      line: 0,
      token: "primary-home-nav",
      reason: "Local-service contractor sites must include a visible Home item in the primary nav; logo-only home navigation is not enough for generated production sites.",
    });
  }
  if (localServiceSite && !hasPrimaryServiceAreasNav(sourceText)) {
    issues.push({
      file: "client/src/App.tsx",
      line: 0,
      token: "primary-service-areas-nav",
      reason: "Local-service contractor sites must label the primary service-area navigation as Service Areas; vague labels like Cities are not enough for production contractor nav.",
    });
  }
  if (/OKCNearby|Ready to remodel\?Request|pathScope|requestsPhotos|notesMaterials|levelScheduling|<b>OKC<\/b>\s*<span>Nearby|<span>Ready to remodel\?<\/span>\s*<AppLink/i.test(sourceText)) {
    issues.push({
      file: "client/src/App.tsx",
      line: 0,
      token: "glued-ui-copy",
      reason: "Generated UI must not ship concatenated/glued labels such as OKCNearby, Ready to remodel?Request, or collapsed hero-process text.",
    });
  }
  if (localServiceSite && /\b(?:South Edmond|East Yukon)\b/.test(sourceText) && /Oklahoma City|OKC/i.test(sourceText)) {
    issues.push({
      file: "client/src/App.tsx",
      line: 0,
      token: "partial-metro-city-labels",
      reason: "OKC-area local pages should use clear real city/community labels and explain service-radius limits; do not invent awkward partial-city pages like South Edmond or East Yukon as thin SEO targets.",
    });
  }
  if (localServiceSite && /checked (?:for|by) (?:schedule|scope|service radius)|travel radius|near-OKC remodel projects|Nearby communities checked by scope/i.test(sourceText)) {
    issues.push({
      file: "client/src/App.tsx",
      line: 0,
      token: "thin-city-page-copy",
      reason: "City/service-area pages need homeowner-useful local content, not formulaic service-radius filler or doorway-page copy.",
    });
  }
  if (localServiceSite && /gallery explains remodeling categories honestly|can grow as .*real project photos|portfolio grows/i.test(sourceText)) {
    issues.push({
      file: "client/src/App.tsx",
      line: 0,
      token: "gallery-placeholder-copy",
      reason: "Gallery/project-proof pages must not describe future portfolio growth or substitute category explanations for useful proof/expectation content.",
    });
  }
  if (/Lead delivery must be connected before launch|Business phone can be added here when ready|portfolio grows|phone can be added/i.test(sourceText)) {
    issues.push({
      file: "client/src/App.tsx",
      line: 0,
      token: "placeholder-contact-copy",
      reason: "Launch-ready local-service sites must not expose placeholder contact, portfolio, or lead-delivery setup copy to customers.",
    });
  }
  if (/<button[^>]*type=["']button["'][\s\S]{0,240}(?:Send My Project|Request Quote|Send project)/i.test(sourceText)
    || (/preventDefault\(\)[\s\S]{0,200}setSent\(true\)/i.test(sourceText) && !/fetch\(\s*["']\/api\//i.test(sourceText))) {
    issues.push({
      file: "client/src/App.tsx",
      line: 0,
      token: "fake-lead-form",
      reason: "Quote/contact forms must either submit to a real API with matching fields or be replaced with honest email/phone CTAs; local setSent-only forms are not launch-ready.",
    });
  }
  if (/Oklahoma Remodel Consulting|advisory service|not the contractor|contractor matching|bid review/i.test(sourceText)) {
    issues.push({
      file: "client/src/App.tsx",
      line: 0,
      token: "stale-business-copy",
      reason: "Generated contractor/local-service sites must not retain stale business-model copy from another company or advisory template.",
    });
  }
  if (contractorSite && localServiceSite) {
    if (/\b(?:licensed|insured|bonded|certified|bbb accredited|5[- ]star|five[- ]star|award[- ]winning|#[ ]?1|number one|family[- ]owned|veteran[- ]owned|financing available|24\/7|hundreds of|thousands of|serving since|in business since)\b/i.test(sourceText)
      && !/setup[- ]required|provided|verified|when supplied|once supplied|add proof|placeholder/i.test(sourceText)) {
      issues.push({
        file: "client/src/App.tsx",
        line: 0,
        token: "contractor-false-claim-scan",
        reason: "Contractor sites must not publish license/insurance/review/award/years/financing/24-7 claims unless supplied or verified; use neutral trust language instead.",
      });
    }
    const hasMetadataSignals = /<title>|metaDescription|description:|<meta\s+name=["']description|canonical|rel=["']canonical|og:title|twitter:card|JSON-LD|application\/ld\+json|schema/i.test(sourceText + "\n" + indexHtml);
    const hasSitemap = existsAny(dir, ["public/sitemap.xml", "client/public/sitemap.xml", "dist/public/sitemap.xml", "dist/sitemap.xml"]);
    const hasRobots = existsAny(dir, ["public/robots.txt", "client/public/robots.txt", "dist/public/robots.txt", "dist/robots.txt"]);
    if (!hasSitemap || !hasRobots || !hasMetadataSignals) {
      issues.push({
        file: "client/src/App.tsx",
        line: 0,
        token: "contractor-seo-foundation",
        reason: `Contractor sites require sitemap.xml, robots.txt, and page metadata/schema/canonical signals before launch. Missing: ${[!hasSitemap ? "sitemap.xml" : "", !hasRobots ? "robots.txt" : "", !hasMetadataSignals ? "metadata/schema" : ""].filter(Boolean).join(", ")}.`,
      });
    }
    const hasMobileNavSignal = /Mobile|menuOpen|Menu|hamburger|aria-label=["'][^"']*(menu|navigation)|md:hidden|lg:hidden|sm:hidden/i.test(sourceText);
    const hasStickyCtaSignal = /StickyAuditRail|fixed\s+inset-x-0\s+bottom-0|position:\s*fixed|sticky\s+bottom|Call|Request|Quote/i.test(sourceText);
    if (!hasMobileNavSignal || !hasStickyCtaSignal) {
      issues.push({
        file: "client/src/App.tsx",
        line: 0,
        token: "contractor-mobile-conversion-smoke",
        reason: "Contractor sites need mobile navigation and a reachable call/quote CTA; desktop-only nav is not production-ready.",
      });
    }
    if (/\b(?:same copy|generic service|service title only|city name only)\b/i.test(sourceText)
      || repeatedShortPageComponent(sourceText, ["ServicePage", "CityPage", "ServiceAreaPage"])) {
      issues.push({
        file: "client/src/App.tsx",
        line: 0,
        token: "contractor-page-depth-uniqueness",
        reason: "Service and city pages must contain useful unique sections/copy; repeated thin page components or title-swap pages are not complete contractor sites.",
      });
    }
  }
  const requireAppToken = (token: string, reason: string) => {
    if (!app.includes(token)) issues.push({ file: "client/src/App.tsx", line: 0, token, reason });
  };

  const anyAppToken = (tokens: string[], reason: string) => {
    if (!tokens.some((token) => app.includes(token))) issues.push({ file: "client/src/App.tsx", line: 0, token: tokens.join("|"), reason });
  };

  requireAppToken("function AppLink", "Internal links must use SPA navigation so mobile taps do not flash the prerender fallback between pages.");
  requireAppToken("useLocation", "SPA navigation must route through wouter location state instead of full page reloads.");
  if (contractorSite) {
    requireAppToken("LeadOpsVisual", "Premium contractor sites need a hero system/command-center visual near the fold.");
    requireAppToken("LeadFlowLineSection", "Premium contractor sites need an animated lead-flow module, not a flat brochure page.");
    requireAppToken("LeadLeakAudit", "Premium contractor sites need an interactive lead-leak audit/checklist module.");
    requireAppToken("BeforeAfterComparison", "Premium contractor sites need a before/after comparison showing brochure site vs lead system.");
    requireAppToken("StickyAuditRail", "Premium contractor sites need a restrained sticky CTA for conversion.");
  } else {
    anyAppToken(["LeadOpsVisual", "HeroVisual", "CommandCenter", "MarketVisual", "ListingVisual"], "Premium local business sites need a strong hero visual or command/market panel near the fold.");
    anyAppToken(["LeadFlowLineSection", "PathwaySection", "ValueFlow", "MarketPathway"], "Premium local business sites need an animated/value-flow or pathway module, not a flat brochure page.");
    anyAppToken(["LeadLeakAudit", "InquiryCard", "Qualification", "HomeValue", "Buyer inquiry", "Seller home value"], "Premium local business sites need an interactive conversion or qualification module.");
    anyAppToken(["BeforeAfterComparison", "TrustSection", "ProofSection", "SourceSection", "Verified details"], "Premium local business sites need proof/source/trust content, not thin generic copy.");
    anyAppToken(["StickyAuditRail", "MobileSticky", "fixed inset-x-0 bottom-0", "position: fixed"], "Premium local business sites need a restrained sticky CTA for conversion.");
  }

  if (/\b(redo|redesign|replace|current site|existing site|look it up|research)\b/i.test(spec.prompt) && !hasReferencedLocalImageAsset(dir, app)) {
    issues.push({ file: "client/src/App.tsx", line: 0, token: "local-source-images", reason: "Redesign/research prompts must use verified source/local image assets or explicitly document that no safe public assets were found; do not ship only remote stock placeholders." });
  }

  if (/<a\s+[^>]*href=["']\//.test(app.replace(/function AppLink[\s\S]*?\n}\n/, ""))) {
    issues.push({ file: "client/src/App.tsx", line: 0, token: "raw-internal-anchor", reason: "Internal route anchors outside AppLink cause full page reloads and mobile white/prerender flashes." });
  }
  if (!/background:\s*#09090b/i.test(indexHtml) || !/data-jeriko-prerender/.test(indexHtml)) {
    issues.push({ file: "client/index.html", line: 0, token: "body-background", reason: "Template must include dark critical base/prerender styles to prevent white flashes before hydration." });
  }
  if (!existsSync(vercelPath)) {
    issues.push({ file: "vercel.json", line: 0, token: "vercel.json", reason: "Generated Vite sites must include Vercel static output and SPA fallback config." });
  } else {
    try {
      const vercel = JSON.parse(readFileSync(vercelPath, "utf8"));
      if (vercel.outputDirectory !== "dist/public") issues.push({ file: "vercel.json", line: 0, token: "vercel-outputDirectory", reason: "Vercel must serve dist/public for generated Vite apps." });
      const rewrites = Array.isArray(vercel.rewrites) ? vercel.rewrites : [];
      if (!rewrites.some((rewrite: any) => rewrite?.source === "/(.*)" && rewrite?.destination === "/index.html")) {
        issues.push({ file: "vercel.json", line: 0, token: "vercel-spa-rewrite", reason: "Vercel must rewrite client routes to /index.html so subroutes do not 404." });
      }
    } catch {
      issues.push({ file: "vercel.json", line: 0, token: "vercel-json", reason: "vercel.json must be valid JSON." });
    }
  }

  return issues;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSpecRoute(route: string): string {
  if (!route || route === "home") return "/";
  return route.startsWith("/") ? route : `/${route}`;
}

function existsAny(root: string, candidates: string[]): boolean {
  return candidates.some((candidate) => existsSync(join(root, candidate)));
}

function repeatedShortPageComponent(sourceText: string, names: string[]): boolean {
  for (const name of names) {
    const matches = Array.from(sourceText.matchAll(new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]{0,900}?)\\n\\}`, "g")));
    for (const match of matches) {
      const body = match[1] ?? "";
      const readableWords = Array.from(body.replace(/<[^>]+>/g, " ").matchAll(/\b[A-Za-z][A-Za-z'-]{3,}\b/g)).length;
      const sectionCount = (body.match(/<section|<h2|<h3|faq|process|scope|include|expect|problem|material/gi) ?? []).length;
      if (readableWords > 0 && (readableWords < 80 || sectionCount < 3)) return true;
    }
  }
  return false;
}

function isProjectMetadataFile(root: string, file: string): boolean {
  const rel = relative(root, file).replace(/\\/g, "/");
  return rel === ".jeriko" || rel.startsWith(".jeriko/");
}

function hasReferencedLocalImageAsset(dir: string, app: string): boolean {
  const localRefs = Array.from(app.matchAll(/["'`]([^"'`]*(?:\/images\/|\/assets\/)[^"'`]*\.(?:png|jpe?g|webp|gif|svg))[^"'`]*["'`]/gi))
    .map((match) => match[1] ?? "")
    .filter((value) => value.startsWith("/") || value.startsWith("./") || value.startsWith("../"));
  if (localRefs.length === 0) return false;
  return localRefs.some((ref) => {
    const relativePath = ref.replace(/^\.\.\//, "").replace(/^\.\//, "").replace(/^\//, "");
    return existsSync(join(dir, "client", "public", relativePath))
      || existsSync(join(dir, "public", relativePath))
      || existsSync(join(dir, "client", "src", relativePath));
  });
}

function buildSourceIndex(dir: string): { files: Set<string>; text: string } {
  const files = new Set<string>();
  const chunks: string[] = [];
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (isProjectMetadataFile(dir, file)) return;
    if (!/\/(client\/src|src|app|pages|server)\//.test(normalized) && !normalized.endsWith("package.json")) return;
    files.add(normalized.toLowerCase());
    chunks.push(content);
  });
  return { files, text: chunks.join("\n").toLowerCase() };
}

function routeImplemented(route: string, index: { files: Set<string>; text: string }): boolean {
  if (route === "/") {
    for (const file of index.files) {
      if (/\/(home|index|app)\.(tsx|ts|jsx|js)$/.test(file)) return true;
    }
    return index.text.includes('path="/"') || index.text.includes("path='/'") || index.text.includes('path: "/"') || index.text.includes("path: '/'");
  }
  const slug = route.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  for (const file of index.files) {
    if (file.includes(`/${slug}.`) || file.includes(`/${slug}/`) || file.includes(`/${slug.replace(/-/g, "")}.`)) return true;
  }
  return index.text.includes(`path="${route}"`) ||
    index.text.includes(`path='${route}'`) ||
    index.text.includes(`path: "${route}"`) ||
    index.text.includes(`path: '${route}'`) ||
    index.text.includes(`href="${route}"`) ||
    index.text.includes(`href='${route}'`);
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

export function scanScaffoldResidue(dir: string): ScaffoldResidueHit[] {
  const hits: ScaffoldResidueHit[] = [];
  walkTextFiles(dir, (file, content) => {
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lowerLine = line.toLowerCase();
      for (const token of SCAFFOLD_RESIDUE_TOKENS) {
        if (lowerLine.includes(token.toLowerCase())) hits.push({ file, line: i + 1, token });
      }
    }
  });
  return hits;
}

export function scanPublicBuilderMetaCopy(dir: string, projectState: ProjectState | null = readProjectState(dir)): RealnessHit[] {
  const hits: RealnessHit[] = [];
  const appText = [projectState?.appSpec?.prompt, ...(projectState?.appSpec?.features ?? []), projectState?.appSpec?.appType]
    .filter(Boolean)
    .join(" ");
  const explicitWritingProduct = /\b(writing|editor|document|word processor|transcription|transcript|content editor|copywriter)\b/i.test(appText);
  walkTextFiles(dir, (file, content) => {
    if (!isPublicGeneratedUiSource(dir, file)) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (explicitWritingProduct && /\b\d{2,}\s+words?\b/i.test(line) && !/\bguide\s+depth\b/i.test(line)) continue;
      for (const rule of PUBLIC_BUILDER_META_COPY_PATTERNS) {
        if (!rule.pattern.test(line)) continue;
        hits.push({
          file,
          line: i + 1,
          token: rule.token,
          reason: rule.reason,
        });
        break;
      }
      if (/\bwordCount\b/.test(line) && /\b(?:guide|citySeo|seo|area-guide|location)\b/i.test(content) && !hits.some((hit) => hit.file === file && hit.line === i + 1)) {
        hits.push({
          file,
          line: i + 1,
          token: "wordCount",
          reason: "Generated guide/location pages must not compute public word-count proof for customers.",
        });
      }
    }
  });
  return hits;
}

function isPublicGeneratedUiSource(root: string, file: string): boolean {
  const rel = relative(root, file).replace(/\\/g, "/");
  if (!/^(client\/src|src|app|pages)\//.test(rel)) return false;
  if (/\/(components\/ui|assets)\//.test(rel)) return false;
  if (/\.(test|spec)\.[tj]sx?$/.test(rel)) return false;
  return /\.(tsx|jsx|ts|js|mdx?)$/i.test(rel);
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

export function scanPrimaryLocalStoragePersistence(dir: string): RealnessHit[] {
  const hits: RealnessHit[] = [];
  walkTextFiles(dir, (file, content) => {
    if (isAllowedLocalStorageFile(file)) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!PRIMARY_LOCAL_STORAGE_PATTERN.test(line)) continue;
      const context = `${lines[Math.max(0, i - 2)] ?? ""}\n${line}\n${lines[i + 1] ?? ""}\n${lines[i + 2] ?? ""}`;
      if (!isBusinessLocalStorageContext(context)) continue;
      hits.push({
        file,
        line: i + 1,
        token: line.trim().slice(0, 180),
        reason: "Business workflow data is stored in localStorage. Use backend/database persistence for orders, inventory, listings, shipments, customers, expenses, and similar core entities.",
      });
    }
  });
  return hits;
}

export function scanDbAuthWorkflowWiring(dir: string, profile: AppProfile = inferAppProfile(dir)): RealnessHit[] {
  if (profile !== "web-db-user") return [];
  const hits: RealnessHit[] = [];
  let hasSetupRequiredState = false;
  let hasThrowingDbMutations = false;
  let hasVisibleSetupSurface = false;
  let hasVisibleAuthSurface = false;

  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!normalized.includes("/client/src/")) return;
    if (normalized.includes("/client/src/_core/") || normalized.includes("/client/src/components/ui/")) return;

    if (/dataMode\s*:\s*[^\n]*setup_required|setup_required|setupMessage/.test(content)) {
      hasSetupRequiredState = true;
    }
    if (/failUntilDatabase|requires sign-in and a configured DATABASE_URL/.test(content)) {
      hasThrowingDbMutations = true;
    }
    if (/state\.setupMessage|setupMessage|state\.dataMode|dataMode/.test(content) && /Alert|banner|Sign in|DATABASE_URL|setup_required|setup required/i.test(content)) {
      hasVisibleSetupSurface = true;
    }
    if (/getLoginUrl|useAuth|Sign in|Login|logout|isAuthenticated/.test(content)) {
      hasVisibleAuthSurface = true;
    }

    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (/Live database/.test(line) && /AppShell|layout|header|badge|span|div/i.test(normalized + line) && (hasSetupRequiredState || file.includes("AppShell"))) {
        hits.push({
          file,
          line: i + 1,
          token: "Live database",
          reason: "Do not hard-code live-database status in a database app that can also be unauthenticated/setup-required. Render the real data mode and setup/sign-in state instead.",
        });
      }
      if (/saveScan\s*:\s*\([^=]*\)\s*=>\s*\(\{/.test(line)) {
        hits.push({
          file,
          line: i + 1,
          token: "saveScan",
          reason: "Scan decisions are returned from a function but not persisted. Save scan workflows must update durable app state/database or be clearly disabled until setup is complete.",
        });
      }
    }
  });

  if ((hasSetupRequiredState || hasThrowingDbMutations) && !hasVisibleSetupSurface) {
    hits.push({
      file: dir,
      line: 0,
      token: "setup_required",
      reason: "The app tracks setup-required/database-unavailable state but does not surface it in user-facing UI before mutation buttons are usable.",
    });
  }
  if (hasThrowingDbMutations && !hasVisibleAuthSurface) {
    hits.push({
      file: dir,
      line: 0,
      token: "auth_setup",
      reason: "Database mutations can throw for unauthenticated users, but no visible login/setup flow is wired into the active client app.",
    });
  }
  return hits;
}


export function scanAuthRuntimeConfig(dir: string, profile: AppProfile = inferAppProfile(dir)): RealnessHit[] {
  if (profile !== "web-db-user") return [];
  const hits: RealnessHit[] = [];
  let clientReferencesGoogleStart = false;
  let serverRegistersGoogleStart = false;

  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (normalized.includes("/node_modules/") || normalized.includes("/dist/") || normalized.includes("/.jeriko/logs/")) return;
    const lines = content.split(/\r?\n/);

    if (/\/api\/oauth\/google\/start|getGoogleLoginUrl|GOOGLE_LOGIN_PATH/.test(content) && /\/client\/src\//.test(normalized)) {
      clientReferencesGoogleStart = true;
    }
    if (/app\.get\(["'`]\/api\/oauth\/google\/start["'`]/.test(content) && /\/server\//.test(normalized)) {
      serverRegistersGoogleStart = true;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const nearby = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 5)).join("\n");
      if (/sameSite\s*:\s*["'`]none["'`]/.test(line) && /secure\s*:\s*isSecureRequest\s*\(/.test(nearby)) {
        hits.push({
          file,
          line: i + 1,
          token: line.trim().slice(0, 180),
          reason: "SameSite=None cookies are rejected by modern browsers unless Secure is always true. Use SameSite='lax' on HTTP and SameSite='none' only for secure requests.",
        });
      }
      if (/cookieSecret\s*:\s*process\.env\.JWT_SECRET\s*\?\?\s*["'`]["'`]/.test(line)) {
        hits.push({
          file,
          line: i + 1,
          token: "JWT_SECRET ?? empty string",
          reason: "Session signing falls back to an empty JWT secret. Production auth must fail closed when JWT_SECRET is missing.",
        });
      }
      if (/OAUTH_SERVER_URL is not configured|Set OAUTH_SERVER_URL environment variable/.test(line)) {
        const appScopedEnvNearby = /[A-Z0-9]+_OAUTH_SERVER_URL|FLIPSCOUT_OAUTH_SERVER_URL|ENV\.oAuthServerUrl/.test(content);
        hits.push({
          file,
          line: i + 1,
          token: line.trim().slice(0, 180),
          reason: appScopedEnvNearby
            ? "OAuth setup log names generic OAUTH_SERVER_URL even though the app uses an app-scoped OAuth server env key. Logs must name the real configured key."
            : "OAuth setup log names generic OAUTH_SERVER_URL. Generated apps should keep OAuth setup messages aligned with the env names they read.",
        });
      }
      if (/Set VITE_OAUTH_PORTAL_URL and VITE_APP_ID/.test(line)) {
        hits.push({
          file,
          line: i + 1,
          token: line.trim().slice(0, 180),
          reason: "Login UI setup copy names old client-side VITE OAuth env vars instead of the server-side OAuth setup keys used by generated full-stack apps.",
        });
      }
    }
  });

  if (clientReferencesGoogleStart && !serverRegistersGoogleStart) {
    hits.push({
      file: dir,
      line: 0,
      token: "/api/oauth/google/start",
      reason: "Client Google login points at /api/oauth/google/start, but the Express server does not register that route. The button will hit SPA fallback or 404 instead of starting OAuth.",
    });
  }

  return hits;
}

export function scanMockDataImports(dir: string): RealnessHit[] {
  const hits: RealnessHit[] = [];
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!normalized.includes("/client/src/")) return;
    if (normalized.includes("/components/ui/") || normalized.includes("/test") || normalized.includes(".test.")) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!/from\s+["'][^"']*(mockData|mock-data|seedData|demoData)[^"']*["']/.test(line)) continue;
      hits.push({
        file,
        line: i + 1,
        token: line.trim().slice(0, 180),
        reason: "Production app page imports mock/static business data instead of using generated backend/database state.",
      });
    }
  });
  return hits;
}

export function scanMisleadingProviderConfig(dir: string): RealnessHit[] {
  const hits: RealnessHit[] = [];
  let usesBuiltInForgeKey = false;
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!/\/(server|src)\//.test(normalized) && !normalized.endsWith("/env.ts") && !normalized.endsWith("/llm.ts")) return;
    if (/BUILT_IN_FORGE_API_KEY|forgeApiKey|forgeApiUrl/.test(content)) usesBuiltInForgeKey = true;
  });

  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!/\/(server|src)\//.test(normalized) && !normalized.endsWith("/llm.ts")) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!/OPENAI_API_KEY is not configured/.test(line)) continue;
      if (!usesBuiltInForgeKey) continue;
      hits.push({
        file,
        line: i + 1,
        token: "OPENAI_API_KEY is not configured",
        reason: "Template reads BUILT_IN_FORGE_API_KEY/forgeApiKey but tells users OPENAI_API_KEY is missing. Error text must name the real env key.",
      });
    }
  });
  return hits;
}

export function scanMisleadingReadinessClaims(dir: string, profile: AppProfile = inferAppProfile(dir)): RealnessHit[] {
  const hits: RealnessHit[] = [];
  const hardClaimPattern = /\b(production[- ]ready|ready for production|AI connected|live AI connected|database connected)\b/gi;
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!normalized.includes("/client/src/")) return;
    if (normalized.includes("/components/ui/") || normalized.includes("/test") || normalized.includes(".test.")) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const matches = [...line.matchAll(hardClaimPattern)];
      if (matches.length === 0) continue;
      const lowerLine = line.toLowerCase();
      const dynamicStateNearby = /dataMode|setup|required|aiConfigured|health|isAuthed|statusLabel|connected\s*\?|\?\s*["'`][^"'`]*(connected|setup|required)/i.test(line);
      if (dynamicStateNearby) continue;
      if (profile === "web-db-user" && lowerLine.includes("database connected") && /dataMode|statusLabel|setup/i.test(content)) continue;
      for (const match of matches) {
        hits.push({
          file,
          line: i + 1,
          token: match[0],
          reason: "Hard-coded readiness copy is not proof. Render live setup/auth/provider health state, or replace the claim with setup-required copy until verified by route/API/browser evidence.",
        });
      }
    }
  });
  return hits;
}

export function scanVercelApiPackaging(dir: string, profile: AppProfile = inferAppProfile(dir)): RealnessHit[] {
  if (profile !== "web-db-user") return [];
  const apiDir = join(dir, "api");
  if (!existsSync(apiDir)) return [];

  const hits: RealnessHit[] = [];
  let hasHealthRoute = false;
  const forbiddenPatterns: Array<{ pattern: RegExp; token: string; reason: string }> = [
    {
      pattern: /\.\.\/server\/_core\/app(?:\.ts)?|server\/_core\/app(?:\.ts)?/,
      token: "../server/_core/app.ts",
      reason: "Vercel API handlers must not import the production app/static wrapper; bundle an API-only Express/TRPC handler instead.",
    },
    {
      pattern: /\bcreateProductionApp\b/,
      token: "createProductionApp",
      reason: "createProductionApp pulls static serving into the serverless API bundle. API functions must expose only API/TRPC/OAuth routes.",
    },
    {
      pattern: /server\/_core\/vite|\.\/vite|\.\.\/server\/_core\/vite/,
      token: "server/_core/vite",
      reason: "Vite/static serving code must not be imported by Vercel API functions.",
    },
    {
      pattern: /from\s+["']vite["']|require\(["']vite["']\)|createViteServer/,
      token: "vite",
      reason: "Vite/Rollup runtime dependencies do not belong in serverless API handlers.",
    },
    {
      pattern: /from\s+["']rollup["']|require\(["']rollup["']\)|@rollup\/rollup-/,
      token: "rollup",
      reason: "Rollup optional native packages can be absent in Vercel functions. Keep Rollup out of API handlers.",
    },
    {
      pattern: /@vitejs\/plugin-react|@tailwindcss\/vite/,
      token: "vite plugin",
      reason: "Build-time Vite plugins must not be bundled into API serverless functions.",
    },
  ];

  walkTextFiles(apiDir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(normalized)) return;
    if (/\/api\//.test(normalized) && content.includes("/api/health")) hasHealthRoute = true;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      for (const check of forbiddenPatterns) {
        if (!check.pattern.test(line)) continue;
        hits.push({ file, line: i + 1, token: check.token, reason: check.reason });
      }
    }
  });

  if (!hasHealthRoute) {
    hits.push({
      file: apiDir,
      line: 0,
      token: "/api/health",
      reason: "Vercel API packaging must include a production-safe /api/health route so deploy smoke tests can prove the serverless API is wired.",
    });
  }
  return hits;
}

export function scanDuplicateSectionImages(dir: string): RealnessHit[] {
  const refs = new Map<string, Array<{ file: string; line: number }>>();
  walkTextFiles(dir, (file, content) => {
    const normalized = file.replace(/\\/g, "/");
    if (!normalized.includes("/client/src/")) return;
    if (normalized.endsWith("/site.config.ts") || normalized.endsWith("/site.config.tsx")) return;
    if (normalized.includes("/components/ui/") || normalized.includes("/test") || normalized.includes(".test.")) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const matches = [
        ...line.matchAll(/["'`](\/images\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp|gif|avif|svg))["'`]/gi),
        ...line.matchAll(/url\(["']?(\/images\/[A-Za-z0-9_./-]+\.(?:png|jpe?g|webp|gif|avif|svg))["']?\)/gi),
      ];
      for (const match of matches) {
        const ref = match[1];
        if (!ref || /(?:logo|icon|favicon|sprite|badge)/i.test(ref)) continue;
        const entries = refs.get(ref) ?? [];
        entries.push({ file, line: i + 1 });
        refs.set(ref, entries);
      }
    }
  });

  const hits: RealnessHit[] = [];
  for (const [ref, entries] of refs) {
    const uniqueLocations = new Set(entries.map((entry) => `${entry.file}:${entry.line}`));
    if (uniqueLocations.size <= 1) continue;
    for (const entry of entries.slice(1)) {
      hits.push({
        file: entry.file,
        line: entry.line,
        token: ref,
        reason: "The same generated/site image URL is reused across multiple visible sections. Generate or wire a distinct section-specific image.",
      });
    }
  }

  const hashOwners = new Map<string, { ref: string; file: string; line: number }>();
  for (const [ref, entries] of refs) {
    const assetPath = join(dir, "client", "public", ref.replace(/^\//, ""));
    if (!existsSync(assetPath)) continue;
    const hash = createHash("sha256").update(readFileSync(assetPath)).digest("hex");
    const firstEntry = entries[0];
    if (!firstEntry) continue;
    const owner = hashOwners.get(hash);
    if (!owner) {
      hashOwners.set(hash, { ref, file: firstEntry.file, line: firstEntry.line });
      continue;
    }
    if (owner.ref === ref) continue;
    for (const entry of entries) {
      hits.push({
        file: entry.file,
        line: entry.line,
        token: `${ref} duplicates ${owner.ref}`,
        reason: "Different section image paths resolve to the same file bytes. Generate or wire genuinely distinct assets, not renamed duplicates.",
      });
    }
  }
  return hits;
}

export function scanProductionArtifactResidue(dir: string): ProductionArtifactStatus {
  const roots = [join(dir, "dist", "public"), join(dir, "dist"), join(dir, "build"), join(dir, ".vercel", "output", "static")]
    .filter((root, index, values) => existsSync(root) && values.indexOf(root) === index);
  if (roots.length === 0) {
    return { checked: false, ok: true, hits: [], output: "No production artifact directory found; production artifact scan skipped." };
  }

  const hits: RealnessHit[] = [];
  for (const root of roots) {
    walkTextFilesIncludingBuild(root, (file, content) => {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        for (const token of DEBUG_ARTIFACT_TOKENS) {
          if (line.includes(token)) {
            hits.push({ file, line: i + 1, token, reason: "Jeriko debug collector/logging endpoint must not be present in production artifacts." });
          }
        }
        for (const token of PUBLIC_MOCK_COPY_TOKENS) {
          if (line.toLowerCase().includes(token.toLowerCase())) {
            hits.push({ file, line: i + 1, token, reason: "Public production artifact still exposes mock/prototype copy." });
          }
        }
      }
    });
  }

  const ok = hits.length === 0;
  return {
    checked: true,
    ok,
    hits,
    output: ok
      ? "Production artifact scan passed: no Jeriko debug collector or public mock/prototype copy found."
      : [
        "Production artifact contains Jeriko/debug or mock/prototype residue.",
        ...hits.slice(0, 20).map((hit) => `${hit.file}:${hit.line} ${hit.token} — ${hit.reason}`),
      ].join("\n").slice(0, MAX_OUTPUT),
  };
}

function isAllowedLocalStorageFile(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return /ThemeContext|theme-customizer|useResponsiveSidebar|DashboardLayout|useAuth|auth\.(ts|tsx|js|jsx)$|_core\/auth/.test(normalized);
}

function isBusinessLocalStorageContext(context: string): boolean {
  if (/\.mvp\.state|mvp\.state|appState|seedOrders|seedInventory/i.test(context)) return true;
  return BUSINESS_ENTITY_PATTERN.test(context) && /JSON\.stringify|JSON\.parse|setItem|getItem|removeItem/i.test(context);
}

export function scanCrawlerHtml(dir: string): CrawlerHtmlStatus {
  const publicDir = join(dir, "dist", "public");
  const indexPath = join(publicDir, "index.html");
  if (!existsSync(indexPath)) {
    return { checked: false, ok: true, output: "dist/public/index.html not found; crawler HTML gate skipped." };
  }

  const html = readFileSync(indexPath, "utf8");
  const hasPrerenderMarker = hasCrawlerMarker(html);
  const hasRootFallback = hasCrawlerBody(html);
  const hasMetaDescription = hasUsableMetaDescription(html);
  const hasRobots = existsSync(join(publicDir, "robots.txt"));
  const sitemapPath = join(publicDir, "sitemap.xml");
  const hasSitemap = existsSync(sitemapPath);
  const issues: string[] = [];

  if (!(hasPrerenderMarker || hasRootFallback)) issues.push("Root route lacks crawler-visible body content.");
  if (!hasMetaDescription) issues.push("Root route lacks a usable meta description.");
  if (!hasRobots) issues.push("Build output is missing robots.txt.");
  if (!hasSitemap) issues.push("Build output is missing sitemap.xml.");

  let checkedRoutes = 0;
  let launchTrackingChecked = 0;
  if (hasSitemap) {
    const sitemap = readFileSync(sitemapPath, "utf8");
    const routes = sitemapRoutes(sitemap);
    checkedRoutes = routes.length;
    const routeBodyFingerprints = new Map<string, string[]>();
    for (const route of routes) {
      const routeFile = routeHtmlPath(publicDir, route.path);
      if (!existsSync(routeFile)) {
        issues.push(`Sitemap route is missing prerendered HTML: ${route.path} (${routeFile})`);
        continue;
      }
      const routeHtml = readFileSync(routeFile, "utf8");
      const routeIssues = auditCrawlerRoute(route.path, route.loc, routeHtml, { largeSitemap: routes.length >= 8 });
      const bodyFingerprint = crawlerBodyFingerprint(routeHtml);
      if (bodyFingerprint) {
        const existing = routeBodyFingerprints.get(bodyFingerprint) ?? [];
        existing.push(route.path);
        routeBodyFingerprints.set(bodyFingerprint, existing);
      }
      const trackingAudit = auditLaunchTracking(route.path, routeHtml);
      launchTrackingChecked += trackingAudit.checked;
      issues.push(...routeIssues, ...trackingAudit.issues);
    }
    if (routes.length >= 8) {
      for (const duplicateRoutes of routeBodyFingerprints.values()) {
        if (duplicateRoutes.length >= 3) {
          issues.push(`Crawler HTML duplicates the same visible body across ${duplicateRoutes.length} sitemap routes: ${duplicateRoutes.slice(0, 6).join(", ")}. Generated service/city pages need route-specific crawler content, not one generic fallback.`);
        }
      }
    }
  }

  const ok = issues.length === 0;
  return {
    checked: true,
    ok,
    file: indexPath,
    checkedRoutes,
    issues,
    output: ok
      ? `Crawler-visible HTML found at ${indexPath}; checked ${checkedRoutes} sitemap route(s); launch tracking checked ${launchTrackingChecked} conversion target(s).`
      : [
        `Crawler-visible HTML gate failed for ${indexPath}.`,
        `hasPrerenderMarker=${hasPrerenderMarker}`,
        `hasRootFallback=${hasRootFallback}`,
        `hasMetaDescription=${hasMetaDescription}`,
        `hasRobots=${hasRobots}`,
        `hasSitemap=${hasSitemap}`,
        ...issues,
        "Build output must include prerendered/fallback body content plus robots.txt and sitemap.xml so Google can see public pages without running React.",
      ].join("\n"),
  };
}

function hasCrawlerMarker(html: string): boolean {
  return html.includes('data-jeriko-prerender="true"')
    || html.includes("data-jeriko-prerender='true'")
    || html.includes('data-seo-prerender="true"')
    || html.includes("data-seo-prerender='true'");
}

function hasCrawlerBody(html: string): boolean {
  const rootMatch = html.match(/<div\s+id=["']root["'][^>]*>([\s\S]*?)<\/div>/i);
  if (!rootMatch) return false;
  const bodyText = stripHtml(rootMatch[1] ?? "");
  return bodyText.length >= 20;
}

function hasUsableMetaDescription(html: string): boolean {
  return /<meta\s+name=["']description["'][^>]+content=["'][^"']{20,}["']/i.test(html);
}

function sitemapRoutes(sitemap: string): Array<{ loc: string; path: string }> {
  const routes: Array<{ loc: string; path: string }> = [];
  const locPattern = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  for (const match of sitemap.matchAll(locPattern)) {
    const loc = decodeXml(match[1] ?? "").trim();
    if (!loc) continue;
    routes.push({ loc, path: pathFromLoc(loc) });
  }
  return routes;
}

function pathFromLoc(loc: string): string {
  try {
    const url = new URL(loc);
    return normalizePath(url.pathname);
  } catch {
    return normalizePath(loc);
  }
}

function routeHtmlPath(publicDir: string, routePath: string): string {
  const normalized = normalizePath(routePath);
  return normalized === "/" ? join(publicDir, "index.html") : join(publicDir, normalized.replace(/^\//, ""), "index.html");
}

function auditCrawlerRoute(routePath: string, sitemapLoc: string, html: string, options: { largeSitemap?: boolean } = {}): string[] {
  const issues: string[] = [];
  const robots = metaContent(html, "robots");
  if (robots && /\b(noindex|none)\b/i.test(robots)) {
    issues.push(`Sitemap route is not indexable: ${routePath} meta robots=${robots}`);
  }
  if (!hasUsableMetaDescription(html)) {
    issues.push(`Sitemap route lacks a usable meta description: ${routePath}`);
  }
  const title = titleText(html);
  if (title.length < 8) {
    issues.push(`Sitemap route lacks a usable title: ${routePath}`);
  }
  const canonical = canonicalHref(html);
  if (!canonical) {
    issues.push(`Sitemap route lacks canonical URL: ${routePath}`);
  } else if (normalizeUrl(canonical) !== normalizeUrl(sitemapLoc)) {
    issues.push(`Sitemap route canonical mismatch: ${routePath} canonical=${canonical} sitemap=${sitemapLoc}`);
  }
  if (!hasCrawlerBody(html)) {
    issues.push(`Sitemap route lacks crawler-visible body content: ${routePath}`);
  }
  if (options.largeSitemap) {
    const bodyText = crawlerBodyText(html);
    const wordCount = (bodyText.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? []).length;
    if (wordCount < 120) {
      issues.push(`Sitemap route has thin crawler-visible body content: ${routePath} (${wordCount} words). Multi-page contractor/local-service sites need substantial route-specific crawler copy.`);
    }
    if (/\b(this page|recent work|client reviews|free estimate|crawler|prerender|route|sitemap|SEO page|service page|city page|lead flow|flat brochure)\b/i.test(bodyText)) {
      issues.push(`Sitemap route exposes builder/meta or generic crawler fallback copy: ${routePath}`);
    }
  }
  issues.push(...auditCrawlerCodeLeaks(routePath, html));
  return issues;
}

function crawlerBodyText(html: string): string {
  const rootMatch = html.match(/<div\s+id=["']root["'][^>]*>([\s\S]*?)<\/div>/i);
  return stripHtml(rootMatch?.[1] ?? html);
}

function crawlerBodyFingerprint(html: string): string {
  const bodyText = crawlerBodyText(html)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(parsons|altamont|oswego|erie|chanute|cherryvale|independence|coffeyville|pittsburg|neodesha|chetopa|girard|columbus|st\.\s*paul)\b/g, "{city}")
    .replace(/\b(general contracting|remodeling|kitchen remodeling|bathroom remodeling|whole-home remodeling|home additions|exterior remodeling|decks and outdoor living|concrete and flatwork|repairs and punch-list work|light commercial construction)\b/g, "{service}")
    .replace(/\s+/g, " ")
    .trim();
  return bodyText.length >= 80 ? bodyText : "";
}

function auditCrawlerCodeLeaks(routePath: string, html: string): string[] {
  const bodyText = stripHtml(html);
  const leaks = [
    /\breact["']?;\s*import\s+from\b/i,
    /\bimport\s+from\b/i,
    /\bconst\s+[A-Za-z_$][\w$]*\s*=/,
    /\b(?:import|export)\s+[A-Za-z_$*{]/,
    /\b(?:client\/src|\.tsx|\.jsx)\b/i,
    /[,;]\s*[A-Za-z_$][\w$]*\s*:/,
    /["'`],\s*["'`]/,
    /\/(?:images|assets)\/[^\s<]+\.(?:png|jpe?g|webp|svg|gif)\b/i,
  ];
  const hit = leaks.find((pattern) => pattern.test(bodyText));
  if (!hit) return [];
  return [`Sitemap route crawler-visible body appears to leak source code or asset constants: ${routePath}`];
}

function auditLaunchTracking(routePath: string, html: string): { checked: number; issues: string[] } {
  const issues: string[] = [];
  let checked = 0;
  const forms = html.match(/<form\b[^>]*>/gi) ?? [];
  for (const tag of forms) {
    checked += 1;
    if (!hasTrackHook(tag, "form_submit")) issues.push(`Conversion target lacks Jeriko tracking hook: form_submit on ${routePath} tag=${tagSummary(tag)}`);
  }
  const anchors = html.match(/<a\b[^>]*>/gi) ?? [];
  for (const tag of anchors) {
    const href = attrValue(tag, "href") ?? "";
    const expected = conversionEventForHref(href);
    if (!expected) continue;
    checked += 1;
    if (!hasTrackHook(tag, expected)) issues.push(`Conversion target lacks Jeriko tracking hook: ${expected} on ${routePath} href=${href}`);
  }
  return { checked, issues: uniqueIssueMessages(issues) };
}

function conversionEventForHref(href: string): string | null {
  if (/^tel:/i.test(href)) return "call_click";
  if (/^mailto:/i.test(href)) return "email_click";
  if (/(book|booking|schedule|appointment|calendar)/i.test(href)) return "booking_click";
  return null;
}

function tagSummary(tag: string): string {
  const name = tag.match(/^<\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase() ?? "tag";
  const id = attrValue(tag, "id");
  const nameAttr = attrValue(tag, "name");
  const action = attrValue(tag, "action");
  const parts = [`<${name}`];
  if (id) parts.push(`id=${id}`);
  if (nameAttr) parts.push(`name=${nameAttr}`);
  if (action) parts.push(`action=${action}`);
  return `${parts.join(" ")}>`;
}

function hasTrackHook(tag: string, event: string): boolean {
  const track = attrValue(tag, "data-jeriko-track") || attrValue(tag, "data-conversion") || attrValue(tag, "data-track");
  return track === event;
}

function uniqueIssueMessages(values: string[]): string[] {
  return Array.from(new Set(values));
}

function metaContent(html: string, name: string): string | null {
  const pattern = new RegExp(`<meta\\s+[^>]*name=["']${escapeRegExp(name)}["'][^>]*>`, "i");
  const tag = html.match(pattern)?.[0];
  if (!tag) return null;
  return attrValue(tag, "content");
}

function canonicalHref(html: string): string | null {
  const tag = html.match(/<link\s+[^>]*rel=["']canonical["'][^>]*>/i)?.[0];
  if (!tag) return null;
  return attrValue(tag, "href");
}

function titleText(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripHtml(match?.[1] ?? "");
}

function attrValue(tag: string, attr: string): string | null {
  const pattern = new RegExp(`${escapeRegExp(attr)}=["']([^"']*)["']`, "i");
  const value = tag.match(pattern)?.[1];
  return value ? decodeXml(value.trim()) : null;
}

function stripHtml(html: string): string {
  return decodeXml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function normalizePath(pathname: string): string {
  const raw = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const noHash = raw.split("#")[0]?.split("?")[0] ?? "/";
  const noTrailing = noHash.length > 1 ? noHash.replace(/\/+$/, "") : noHash;
  return noTrailing || "/";
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${normalizePath(url.pathname)}`;
  } catch {
    return normalizePath(value);
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function walkTextFilesIncludingBuild(dir: string, visit: (file: string, content: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walkTextFilesIncludingBuild(join(dir, entry.name), visit);
      continue;
    }
    if (!entry.isFile()) continue;
    const file = join(dir, entry.name);
    if (!/\.(html|js|mjs|cjs|css|json|txt|xml)$/i.test(file)) continue;
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
  if (existsSync(join(dir, "package-lock.json"))) return "npm ci --ignore-scripts --workspaces=false";
  return "npm install --ignore-scripts --workspaces=false";
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


async function runBrowserSmokeGate(dir: string, profile: AppProfile, port: string, route: string, projectState?: ProjectState | null): Promise<VerificationGate> {
  const command = projectState?.commands?.start ? projectState.commands.start.replace(/\$\{PORT\}/g, port) : detectStartCommand(dir, profile, port);
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

    const { chromium } = await loadPlaywrightCore();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          if (!isIgnorableBrowserConsoleError(text)) consoleErrors.push(`${msg.type()}: ${text}`);
        }
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForSelector("#root, body", { timeout: 10_000 });
      const bodyText = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 4_000);
      const html = (await page.content()).slice(0, 20_000);
      const overlayProblem = detectFrontendOverlay(html, bodyText);
      const productionProblem = detectProductionRuntimeProblem(html, bodyText);
      const googleOAuthProblem = await verifyGoogleOAuthButton(page, url, dir);
      const workflowProblem = await verifyWorkflowButtonMutation(page);
      const problems = [...pageErrors, ...consoleErrors];
      if (overlayProblem) problems.push(overlayProblem);
      if (productionProblem) problems.push(productionProblem);
      if (googleOAuthProblem) problems.push(googleOAuthProblem);
      if (workflowProblem) problems.push(workflowProblem);
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
    const { chromium } = await loadPlaywrightCore();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      page.on("console", (msg) => {
        if (msg.type() === "error") {
          const text = msg.text();
          if (!isIgnorableBrowserConsoleError(text)) consoleErrors.push(`${msg.type()}: ${text}`);
        }
      });
      page.on("pageerror", (err) => pageErrors.push(err.message));
      await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForSelector("#root, body", { timeout: 10_000 });
      const bodyText = (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")).slice(0, 4_000);
      const html = (await page.content()).slice(0, 20_000);
      const overlayProblem = detectFrontendOverlay(html, bodyText);
      const productionProblem = detectProductionRuntimeProblem(html, bodyText);
      const googleOAuthProblem = await verifyGoogleOAuthButton(page, url, dir);
      const workflowProblem = await verifyWorkflowButtonMutation(page);
      const problems = [...pageErrors, ...consoleErrors];
      if (overlayProblem) problems.push(overlayProblem);
      if (productionProblem) problems.push(productionProblem);
      if (googleOAuthProblem) problems.push(googleOAuthProblem);
      if (workflowProblem) problems.push(workflowProblem);
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
  const pidSet = new Set<number>();
  const lsof = spawnSync("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], { timeout: 5_000, encoding: "utf8" });
  for (const rawPid of (lsof.stdout || "").trim().split("\n")) {
    const pid = Number(rawPid.trim());
    if (Number.isInteger(pid) && pid > 0) pidSet.add(pid);
  }

  // Minimal Linux installs often do not ship lsof. fuser is available on Toby's
  // desktop and gives the same listener PID, so use it as a fallback before
  // declaring an occupied verification port "unrelated".
  if (pidSet.size === 0) {
    const fuser = spawnSync("fuser", ["-n", "tcp", String(port)], { timeout: 5_000, encoding: "utf8" });
    const combined = `${fuser.stdout || ""}\n${fuser.stderr || ""}`;
    for (const match of combined.matchAll(/\b\d+\b/g)) {
      const pid = Number(match[0]);
      if (Number.isInteger(pid) && pid > 0) pidSet.add(pid);
    }
  }

  const cwds: string[] = [];
  for (const pid of pidSet) {
    const readlink = spawnSync("readlink", ["-f", `/proc/${pid}/cwd`], { timeout: 2_000, encoding: "utf8" });
    const cwd = readlink.status === 0 ? readlink.stdout.trim() : "";
    if (cwd && !cwds.includes(cwd)) cwds.push(cwd);
  }
  return cwds;
}

function isIgnorableBrowserConsoleError(text: string): boolean {
  return text.startsWith("Failed to load resource:")
    || /WebSocket connection to .+\/_next\/webpack-hmr\b[\s\S]*ERR_INVALID_HTTP_RESPONSE/i.test(text);
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

async function verifyWorkflowButtonMutation(page: any): Promise<string | null> {
  const currentUrl = page.url();
  const candidates = await page.locator("button, [role='button'], a[href]").evaluateAll((elements: any[], currentUrl: string) => {
    const workflowPattern = /\b(add|save|create|submit|send|order|checkout|book|schedule|upload|import|scan|approve|complete|mark|delete|remove|update|generate)\b/i;
    const ignorePattern = /\b(theme|menu|nav|close|cancel|back|continue with google|sign in with google|login with google)\b/i;
    return elements
      .map((element, index) => {
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        const href = String((element as { href?: string }).href || "");
        const currentPageLink = Boolean(href && href === currentUrl);
        return {
          index,
          text,
          disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true" || currentPageLink,
        };
      })
      .filter((item) => item.text && !item.disabled && workflowPattern.test(item.text) && !ignorePattern.test(item.text))
      .slice(0, 1);
  }, currentUrl).catch(() => [] as Array<{ index: number; text: string }>);

  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  for (const candidate of candidates) {
    const locator = page.locator("button, [role='button'], a[href]").nth(candidate.index);
    const beforeUrl = page.url();
    const beforeText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const beforeHtml = await page.content().catch(() => "");
    await locator.click({ timeout: 1_500 }).catch(() => undefined);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await delay(150);
      const afterUrl = page.url();
      const afterText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      const afterHtml = await page.content().catch(() => "");
      const textChanged = normalizeMutationText(beforeText) !== normalizeMutationText(afterText);
      const htmlChanged = beforeHtml !== afterHtml;
      const urlChanged = beforeUrl !== afterUrl;
      if (textChanged || htmlChanged || urlChanged) return null;
    }
  }

  return `Workflow button mutation check failed: visible workflow control(s) did not change URL, DOM, or page text after click: ${candidates.map((candidate) => candidate.text).join(", ")}. Wire buttons to real state/server actions before claiming the app works.`;
}

function normalizeMutationText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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

function detectProductionRuntimeProblem(html: string, bodyText: string): string | null {
  const combined = `${html}\n${bodyText}`;
  const problems: string[] = [];
  for (const token of DEBUG_ARTIFACT_TOKENS) {
    if (combined.includes(token)) problems.push(`Jeriko debug collector/runtime endpoint exposed: ${token}`);
  }
  for (const token of PUBLIC_MOCK_COPY_TOKENS) {
    if (combined.toLowerCase().includes(token.toLowerCase())) problems.push(`Public page still exposes mock/prototype copy: ${token}`);
  }
  return problems.length > 0 ? problems.join("\n") : null;
}

async function loadPlaywrightCore(): Promise<typeof import("playwright-core")> {
  try {
    return await import("playwright-core");
  } catch (error) {
    try {
      const require = createRequire(import.meta.url);
      return require("playwright-core") as typeof import("playwright-core");
    } catch {
      throw error;
    }
  }
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
