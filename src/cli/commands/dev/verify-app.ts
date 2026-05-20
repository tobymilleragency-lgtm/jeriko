import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { fail, failWithDetails, ok } from "../../../shared/output.js";
import { existsSync, readFileSync, readdirSync, accessSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { readProjectState, writeProjectState, computeSourceFingerprint, type AppProfile, type ProjectState } from "./project-state.js";

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
const SCAFFOLD_RESIDUE_TOKENS = ["Example Page", "Any **markdown** content", "Example Button", "demo response", "Lorem ipsum", "BLOCK TO BE DELETED", "Google Fonts here, example"];
const UNSAFE_ENV_PATTERN = /\bVITE_SUPABASE_(URL|ANON_KEY)\b/g;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".svelte-kit", "coverage"]);
const MAX_OUTPUT = 12_000;
const BUSINESS_ENTITY_PATTERN = /\b(orders?|shipments?|inventory|listings?|customers?|buyers?|expenses?|stores?|scans?)\b/i;
const PRIMARY_LOCAL_STORAGE_PATTERN = /(?:window\.)?localStorage\s*\.\s*(?:setItem|getItem|removeItem)/;
const DEBUG_ARTIFACT_TOKENS = ["/__jeriko__/debug-collector.js", "__JERIKO_DEBUG_COLLECTOR__", "/__jeriko__/logs"];
const PUBLIC_MOCK_COPY_TOKENS = ["MVP mock data", "mock data", "prototype only", "demo shell", "BLOCK TO BE DELETED", "Google Fonts here, example"];

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
      for (const token of SCAFFOLD_RESIDUE_TOKENS) {
        if (line.includes(token)) hits.push({ file, line: i + 1, token });
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
    for (const route of routes) {
      const routeFile = routeHtmlPath(publicDir, route.path);
      if (!existsSync(routeFile)) {
        issues.push(`Sitemap route is missing prerendered HTML: ${route.path} (${routeFile})`);
        continue;
      }
      const routeHtml = readFileSync(routeFile, "utf8");
      const routeIssues = auditCrawlerRoute(route.path, route.loc, routeHtml);
      const trackingAudit = auditLaunchTracking(route.path, routeHtml);
      launchTrackingChecked += trackingAudit.checked;
      issues.push(...routeIssues, ...trackingAudit.issues);
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

function auditCrawlerRoute(routePath: string, sitemapLoc: string, html: string): string[] {
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
  return issues;
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

    const { chromium } = await loadPlaywrightCore();
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
          if (!text.startsWith("Failed to load resource:")) consoleErrors.push(`${msg.type()}: ${text}`);
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

async function verifyWorkflowButtonMutation(page: any): Promise<string | null> {
  const candidates = await page.locator("button, [role='button'], a[href]").evaluateAll((elements: any[]) => {
    const workflowPattern = /\b(add|save|create|submit|send|order|checkout|book|schedule|upload|import|scan|approve|complete|mark|delete|remove|update|generate)\b/i;
    const ignorePattern = /\b(theme|menu|nav|close|cancel|back|continue with google|sign in with google|login with google)\b/i;
    return elements
      .map((element, index) => ({
        index,
        text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
      }))
      .filter((item) => item.text && !item.disabled && workflowPattern.test(item.text) && !ignorePattern.test(item.text))
      .slice(0, 1);
  }).catch(() => [] as Array<{ index: number; text: string }>);

  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  for (const candidate of candidates) {
    const locator = page.locator("button, [role='button'], a[href]").nth(candidate.index);
    const beforeUrl = page.url();
    const beforeText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const beforeHtml = await page.content().catch(() => "");
    await locator.click({ timeout: 1_500 }).catch(() => undefined);
    await delay(250);
    const afterUrl = page.url();
    const afterText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const afterHtml = await page.content().catch(() => "");
    const textChanged = normalizeMutationText(beforeText) !== normalizeMutationText(afterText);
    const htmlChanged = beforeHtml !== afterHtml;
    const urlChanged = beforeUrl !== afterUrl;
    if (textChanged || htmlChanged || urlChanged) return null;
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
