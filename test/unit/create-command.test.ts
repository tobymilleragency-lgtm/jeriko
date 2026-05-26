import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { applyCrawlerPrerenderSupport, command as createCommand, repairGeneratedProject, replaceTemplatePlaceholders, sanitizeStaticWebProject } from "../../src/cli/commands/dev/create.js";
import { scanPremiumMarketingSiteQuality, scanPublicBuilderMetaCopy } from "../../src/cli/commands/dev/verify-app.js";
import { detectDevCommand, parseDevInvocation } from "../../src/cli/commands/dev/dev.js";
import { buildProjectState } from "../../src/cli/commands/dev/project-state.js";
import { setOutputFormat } from "../../src/shared/output.js";

const repoRoot = process.cwd();

describe("create command templates", () => {
  it("infers full-stack product workflow contracts from FlipScout-style prompts", () => {
    const state = buildProjectState({
      name: "FlipScout",
      template: "web-db-user",
      profile: "web-db-user",
      prompt: "Build FlipScout, an AI resale scanner with photo upload, paste item details, item cost, shipping cost, platform fees, scan item, save inventory, and profit estimates.",
    });

    expect(state.verification.requiredGates).toEqual(expect.arrayContaining(["workflow_contract", "primary_action_wiring", "business_math_realness"]));
    expect(state.appSpec?.pages.map((page) => page.path)).toEqual(expect.arrayContaining(["/", "/scanner", "/inventory"]));
    expect(state.appSpec?.features).toEqual(expect.arrayContaining(["photo upload", "paste/manual item input", "cost/profit calculator", "database-backed inventory"]));
    expect(state.appSpec?.workflows?.[0]).toMatchObject({
      id: "resale-scanner",
      inputs: expect.arrayContaining(["upload", "paste", "cost"]),
      actions: expect.arrayContaining(["scan", "save", "list"]),
      outputs: expect.arrayContaining(["price", "profit", "decision"]),
      persistence: expect.arrayContaining(["items", "scans", "inventory"]),
    });
  });

  it("requires full marketing sites to declare and ship routable premium pages", () => {
    const state = buildProjectState({
      name: "Go Alpha Marketing",
      template: "web-static",
      profile: "web-static",
      prompt: "Build a full Go Alpha Marketing web app/site for contractor marketing with services, industries, case studies, process, pricing, resources, and contact pages.",
    });

    const paths = state.appSpec?.pages.map((page) => page.path) ?? [];
    expect(paths).toEqual(expect.arrayContaining(["/", "/services", "/industries", "/case-studies", "/process", "/pricing", "/resources", "/contact"]));
    expect(paths.length).toBeGreaterThanOrEqual(8);
    expect(state.verification.requiredGates).toContain("premium_marketing_site_scan");
    expect(state.verification.requiredGates).toContain("public_builder_meta_scan");
    expect(state.appSpec?.features).toEqual(expect.arrayContaining(["multi-page marketing site", "conversion-focused contact path", "customer-ready marketing content", "premium contractor conversion system"]));
    expect(state.appSpec?.successCriteria).toContain("Operator build discipline followed: target lock, plan, real implementation, verify_app, checkpoint, persistent local preview, and exact blocker reporting");
    expect(state.appSpec?.successCriteria).toContain("Every appSpec page is implemented as a routable page, not collapsed into a single landing page");

    const templateApp = fs.readFileSync(path.join(repoRoot, "templates", "webdev", "web-static", "client", "src", "App.tsx"), "utf8");
    for (const requiredRoute of ["/services", "/industries", "/case-studies", "/process", "/pricing", "/about", "/service-areas", "/gallery", "/contact"]) {
      expect(templateApp).toContain(`path=\"${requiredRoute}\"`);
    }
    expect(templateApp).toContain('path="/service-area"');
  });

  it("writes an executable app-builder control plan into generated project-state", () => {
    const state = buildProjectState({
      name: "Brothers Remodeling OKC",
      template: "web-static",
      profile: "web-static",
      prompt: "Build a complete contractor website for Brothers Remodeling OKC with services, service areas, process, projects, reviews, FAQ, contact, privacy, and terms.",
      seoProfile: "local-service",
    });

    expect(state.appBuilderPlan?.mode).toBe("controlled-app-build");
    expect(state.appBuilderPlan?.mandatorySkills).toEqual(expect.arrayContaining(["operator-build-discipline", "app-builder-production-sites", "premium-ui-motion", "contractor-site-autonomous-build"]));
    expect(state.appBuilderPlan?.phases.map((phase: any) => phase.id)).toEqual([
      "target-lock",
      "skill-bind",
      "appspec-plan",
      "scaffold",
      "implement-routes",
      "implement-workflows",
      "verify",
      "repair",
      "checkpoint-preview",
      "evidence-report",
    ]);
    expect(state.appBuilderPlan?.repairRouters).toEqual(expect.arrayContaining([
      expect.objectContaining({ failedGate: "premium_marketing_site_scan", action: expect.stringContaining("premium") }),
      expect.objectContaining({ failedGate: "app_spec_verifier", action: expect.stringContaining("missing appSpec routes") }),
      expect.objectContaining({ failedGate: "workflow_contract", action: expect.stringContaining("UI/API/persistence") }),
    ]));
    expect(state.verification.requiredGates).toContain("app_builder_control_plan");
  });

  it("keeps the web-static production starter free of public builder/operator residue", () => {
    const templateText = [
      fs.readFileSync(path.join(repoRoot, "templates", "webdev", "web-static", "client", "src", "App.tsx"), "utf8"),
      fs.readFileSync(path.join(repoRoot, "templates", "webdev", "web-static", "client", "src", "pages", "Home.tsx"), "utf8"),
    ].join("\n");

    expect(templateText).not.toMatch(/DEMO SYSTEM|Lead-flow path|Visitors see a serious operator|Operator process|Operator standard|crawlable fallback|search engines and assistive technology|SEO page|route page|flat brochure|Premium contractor marketing site starter/i);
    expect(templateText).toContain("Project Readiness Visual");
    expect(templateText).toContain("Request a Project Review");
  });

  it("fails premium marketing site quality when a full-site contract is implemented as plain brochureware", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-premium-site-scan-"));
    try {
      fs.mkdirSync(path.join(dir, "client", "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "client", "src", "App.tsx"), `
        import { Route, Switch } from "wouter";
        export default function App(){return <Switch><Route path="/" component={() => <main><h1>Site</h1><a href="/contact">Contact</a></main>} /><Route path="/services" component={() => <main/>} /><Route path="/pricing" component={() => <main/>} /><Route path="/contact" component={() => <main/>} /></Switch>}
      `);
      fs.writeFileSync(path.join(dir, "client", "index.html"), '<html><head></head><body><div id="root"></div></body></html>');
      fs.writeFileSync(path.join(dir, "vercel.json"), JSON.stringify({ outputDirectory: "dist" }));
      const state = buildProjectState({ name: "Plain Contractor Site", template: "web-static", profile: "web-static", prompt: "Build a full contractor marketing website with services pricing and contact pages" });
      if (state.appSpec) state.appSpec.pages = [{ path: "/", title: "Home" }];

      const issues = scanPremiumMarketingSiteQuality(dir, state);
      expect(issues.map((issue) => issue.token)).toEqual(expect.arrayContaining(["function AppLink", "LeadFlowLineSection", "LeadLeakAudit", "BeforeAfterComparison", "StickyAuditRail", "body-background", "vercel-outputDirectory", "appSpec.pages"]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails public builder meta copy when generated sites expose guide depth or word counts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-builder-meta-scan-"));
    try {
      fs.mkdirSync(path.join(dir, "client", "src", "pages"), { recursive: true });
      fs.writeFileSync(path.join(dir, "client", "src", "pages", "Home.tsx"), `
        export function CitySeoPage(){
          const wordCount = 1033;
          return <aside><p>Guide depth</p><p>{wordCount} words</p></aside>;
        }
      `);
      const state = buildProjectState({ name: "Cody Realtor Site", template: "web-static", profile: "web-static", prompt: "Build a premium realtor area guide site" });

      const issues = scanPublicBuilderMetaCopy(dir, state);
      expect(issues.map((issue) => issue.token)).toEqual(expect.arrayContaining(["Guide depth", "wordCount"]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes stale static auth/runtime residue during repair", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-static-sanitize-"));
    try {
      fs.mkdirSync(path.join(dir, "client", "src", "components"), { recursive: true });
      fs.writeFileSync(path.join(dir, "client", "src", "const.ts"), 'export const getLoginUrl = () => new URL(`${import.meta.env.VITE_OAUTH_PORTAL_URL}/app-auth`).toString();\n');
      fs.writeFileSync(path.join(dir, "client", "src", "components", "ManusDialog.tsx"), 'export function ManusDialog(){ return <p>Please login with Manus to continue</p>; }\n');
      fs.writeFileSync(path.join(dir, "vite.config.ts"), 'import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";\nimport { vitePluginManusRuntime } from "vite-plugin-jeriko-runtime";\nconst plugins = [jsxLocPlugin(), vitePluginManusRuntime()];\n');
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "stale-static",
        type: "module",
        scripts: { build: "vite build", check: "tsc --noEmit" },
        devDependencies: {
          "@builder.io/vite-plugin-jsx-loc": "^0.1.1",
          "vite-plugin-jeriko-runtime": "file:/tmp/runtime",
          vite: "^7.1.7",
        },
      }, null, 2));

      const repair = repairGeneratedProject(dir, { projectName: "Stale Static", runPackageManager: false });
      const allText = collectTextFiles(dir).join("\n");
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));

      expect(repair.actions).toEqual(expect.arrayContaining([
        "removed_static_oauth_const_residue",
        "removed_manus_dialog_residue",
        "rewrote_static_vite_config_without_manus_runtime",
        "package_json_removed_static_auth_runtime_deps",
      ]));
      expect(repair.lockfileNeedsRefresh).toBe(true);
      expect(allText).not.toContain("VITE_OAUTH_PORTAL_URL");
      expect(allText).not.toContain("vitePluginManusRuntime");
      expect(allText).not.toContain("Please login with Manus");
      expect(fs.existsSync(path.join(dir, "client", "src", "components", "ManusDialog.tsx"))).toBe(false);
      expect(pkg.devDependencies["@builder.io/vite-plugin-jsx-loc"]).toBeUndefined();
      expect(pkg.devDependencies["vite-plugin-jeriko-runtime"]).toBeUndefined();
      expect(fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8")).toContain("jerikoDebug");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the Jeriko debug collector out of production builds during static repair", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-static-debug-build-"));
    try {
      fs.writeFileSync(path.join(dir, "template.json"), JSON.stringify({ files: { "client/src/pages/Home.tsx": "Example Page" } }));
      fs.writeFileSync(path.join(dir, "vite.config.ts"), `import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { defineConfig } from "vite";
import jerikoDebug from "./vite-plugin-jeriko-debug";

export default defineConfig({
  plugins: [react(), tailwindcss(), jerikoDebug()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "client", "src") } },
});
`);

      const actions = sanitizeStaticWebProject(dir);
      const viteConfig = fs.readFileSync(path.join(dir, "vite.config.ts"), "utf8");

      expect(actions).toEqual(expect.arrayContaining(["limited_static_debug_plugin_to_dev_server", "removed_template_metadata_residue"]));
      expect(viteConfig).toContain("command === \"serve\" ? jerikoDebug() : null");
      expect(viteConfig).toContain("defineConfig(({ command }) => ({");
      expect(fs.existsSync(path.join(dir, "template.json"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds production starter pages instead of demo residue", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-production-starter-"));
    const staticDir = path.join(dir, "static-site");
    const dbDir = path.join(dir, "db-app");
    try {
      const staticResult = await runCreateCommand(["web-static", "Acme Service Site", "--dir", staticDir]);
      const dbResult = await runCreateCommand(["web-db-user", "Acme Portal", "--dir", dbDir]);
      const combined = [
        fs.readFileSync(path.join(staticDir, "client", "src", "pages", "Home.tsx"), "utf8"),
        fs.readFileSync(path.join(dbDir, "client", "src", "pages", "Home.tsx"), "utf8"),
      ].join("\n");

      expect(staticResult.ok).toBe(true);
      expect(dbResult.ok).toBe(true);
      expect(combined).toContain("Acme Service Site");
      expect(combined).toContain("Acme Portal");
      expect(combined).toContain("Launch-ready");
      expect(combined).not.toContain("Example Page");
      expect(combined).not.toContain("Any **markdown** content");
      expect(combined).not.toContain("Example Button");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("includes dormant Supabase Google auth scaffolding in every web deployment template", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-supabase-auth-"));
    const staticDir = path.join(dir, "static-site");
    const dbDir = path.join(dir, "db-app");
    try {
      const staticResult = await runCreateCommand(["web-static", "Acme Service Site", "--dir", staticDir]);
      const dbResult = await runCreateCommand(["web-db-user", "Acme Portal", "--dir", dbDir]);

      expect(staticResult.ok).toBe(true);
      expect(dbResult.ok).toBe(true);

      for (const projectDir of [staticDir, dbDir]) {
        const envExample = fs.readFileSync(path.join(projectDir, ".env.example"), "utf8");
        const supabaseAuth = fs.readFileSync(path.join(projectDir, "client", "src", "lib", "supabaseAuth.ts"), "utf8");
        const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
        const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".jeriko", "project-state.json"), "utf8"));

        expect(envExample).toContain("VITE_APP_SUPABASE_URL");
        expect(envExample).toContain("VITE_APP_SUPABASE_ANON_KEY");
        expect(envExample).toContain("/auth/v1/callback");
        expect(supabaseAuth).toContain("createClient");
        expect(supabaseAuth).toContain("signInWithOAuth");
        expect(supabaseAuth).toContain("provider: \"google\"");
        expect(pkg.dependencies["@supabase/supabase-js"]).toBeDefined();
        expect(state.appSpec.integrations.allowed).toContain("supabase");
        expect(state.appSpec.integrations.forbidden).toContain("stripe");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds Supabase database and storage foundations for inventory/photo product apps", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-supabase-product-"));
    const dbDir = path.join(dir, "flipscout");
    try {
      const result = await runCreateCommand([
        "web-db-user",
        "FlipScout",
        "--dir",
        dbDir,
        "--prompt",
        "Build FlipScout with Google login, photo upload, inventory, scans, listings, orders, shipments, and profit tracking.",
      ]);

      expect(result.ok).toBe(true);

      const envExample = fs.readFileSync(path.join(dbDir, ".env.example"), "utf8");
      const schema = fs.readFileSync(path.join(dbDir, "drizzle", "schema.ts"), "utf8");
      const storage = fs.readFileSync(path.join(dbDir, "server", "supabaseStorage.ts"), "utf8");
      const state = JSON.parse(fs.readFileSync(path.join(dbDir, ".jeriko", "project-state.json"), "utf8"));

      expect(envExample).toContain("FLIPSCOUT_SUPABASE_STORAGE_BUCKET=inventory-photos");
      expect(envExample).toContain("SUPABASE_SERVICE_ROLE_KEY");
      expect(envExample).toContain("storage.buckets");
      expect(schema).toContain("inventoryItems");
      expect(schema).toContain("inventoryPhotos");
      expect(schema).toContain("scans");
      expect(schema).toContain("listings");
      expect(schema).toContain("orders");
      expect(schema).toContain("shipments");
      expect(storage).toContain("createClient");
      expect(storage).toContain("storage.from");
      expect(storage).toContain("FLIPSCOUT_SUPABASE_STORAGE_BUCKET");
      expect(state.appSpec.prompt).toContain("Google login");
      expect(state.appSpec.features).toEqual(expect.arrayContaining(["Supabase Auth foundation", "Supabase Storage photo uploads", "database-backed inventory"]));
      expect(state.verification.requiredGates).toContain("supabase_product_foundation");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists and scaffolds the existing mobile app template", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-mobile-"));
    const appDir = path.join(dir, "field-app");
    try {
      const list = spawnSync(process.execPath, ["src/index.ts", "create", "--list"], { cwd: repoRoot, encoding: "utf8" });
      const result = await runCreateCommand(["app", "Field App", "--dir", appDir]);
      const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));

      expect(list.status).toBe(0);
      expect(list.stdout).toContain("Mobile Apps");
      expect(list.stdout).toContain("app");
      expect(result.ok).toBe(true);
      expect(result.data.template).toBe("app");
      expect(pkg.name).toBe("field-app");
      expect(fs.existsSync(path.join(appDir, "app", "(tabs)", "index.tsx"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces webdev placeholders with safe package/app values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-template-"));
    const projectDir = path.join(dir, "generated app");

    try {
      fs.cpSync(path.join(repoRoot, "templates", "webdev", "web-static"), projectDir, { recursive: true });
      replaceTemplatePlaceholders(projectDir, "My \"Client\" App");

      const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
      const indexHtml = fs.readFileSync(path.join(projectDir, "client", "index.html"), "utf8");
      const generatedText = collectTextFiles(projectDir).join("\n");

      expect(packageJson.name).toBe("my-client-app");
      expect(indexHtml).toContain("<title>My Client App</title>");
      expect(generatedText).not.toContain("{{project_name}}");
      expect(generatedText).not.toContain("{{project_title}}");
      expect(generatedText).not.toContain("{{bundle_id}}");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates under --parent-dir using the project name", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-parent-"));
    try {
      const result = await runCreateCommand(["node", "demo-app", "--parent-dir", dir]);
      const projectDir = path.join(dir, "demo-app");

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(projectDir);
      expect(fs.existsSync(path.join(projectDir, "package.json"))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-initializes git for generated apps under ~/.jeriko/projects", async () => {
    const name = `jeriko-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const projectsDir = path.join(os.homedir(), ".jeriko", "projects");
    const projectDir = path.join(projectsDir, name);
    try {
      const result = await runCreateCommand(["node", name, "--parent-dir", projectsDir]);

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(projectDir);
      expect(result.data.gitInitialized).toBe(true);
      expect(fs.existsSync(path.join(projectDir, ".git"))).toBe(true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("writes project-state for webdev generated apps", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-state-"));
    const projectDir = path.join(dir, "state-app");
    try {
      const result = await runCreateCommand(["web-db-user", "State App", "--dir", projectDir]);
      const statePath = path.join(projectDir, ".jeriko", "project-state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));

      expect(result.ok).toBe(true);
      expect(result.data.projectState).toBe(statePath);
      expect(state.name).toBe("State App");
      expect(state.template).toBe("web-db-user");
      expect(state.profile).toBe("web-db-user");
      expect(state.packageManager).toBe("pnpm");
      expect(state.commands.install).toBe("pnpm install --frozen-lockfile --ignore-scripts");
      expect(state.commands.check).toBe("pnpm run check");
      expect(state.commands.build).toBe("pnpm run build");
      expect(state.routes.health).toBe("/api/health");
      expect(state.routes.home).toBe("/");
      expect(state.verification.requiredGates).toContain("browser_smoke");
      expect(state.verification.requiredGates).toContain("primary_persistence_scan");
      expect(state.verification.requiredGates).toContain("production_artifact_scan");
      expect(state.verification.requiredGates).toContain("auth_runtime_config_scan");
      expect(state.verification.requiredGates).toContain("vercel_api_packaging_scan");
      expect(state.verification.requiredGates).toContain("app_spec_contract");
      expect(state.verification.requiredGates).toContain("forbidden_integration_scan");
      expect(state.verification.requiredGates).toContain("app_spec_verifier");
      expect(state.appSpec.prompt).toContain("State App");
      expect(state.appSpec.pages).toEqual([{ path: "/", title: "Home" }]);
      expect(state.appSpec.integrations.allowed).toEqual(["supabase"]);
      expect(state.appSpec.integrations.forbidden).toContain("stripe");
      expect(state.appSpec.successCriteria).toContain("Full required verify-app gate passes");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns structured E_EXISTS failure for existing non-project directories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-exists-"));
    fs.writeFileSync(path.join(dir, "stray.txt"), "not a project");
    try {
      const result = await runCreateCommand(["node", "demo-app", "--dir", dir]);

      expect(result.ok).toBe(false);
      expect(result.code).toBe(1);
      expect(result.errorCode).toBe("E_EXISTS");
      expect(result.error).toContain("Directory already exists");
      expect(result.directory).toBe(dir);
      expect(result.suggestions).toContain("Pass --force to delete and recreate the directory.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses an existing valid project by default to avoid retry loops", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-idempotent-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "existing" }));
    try {
      const result = await runCreateCommand(["node", "demo-app", "--dir", dir]);

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(dir);
      expect(result.data.reused).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("existing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses an existing valid project with --reuse", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-reuse-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "existing" }));
    try {
      const result = await runCreateCommand(["node", "demo-app", "--dir", dir, "--reuse"]);

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(dir);
      expect(result.data.reused).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("existing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes and recreates an existing directory only with --force", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-force-"));
    const marker = path.join(dir, "marker.txt");
    fs.writeFileSync(marker, "old");
    try {
      const result = await runCreateCommand(["node", "demo-app", "--dir", dir, "--force"]);

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(dir);
      expect(fs.existsSync(marker)).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name).toBe("demo-app");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds crawler-visible prerender support to generated Vite apps", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-prerender-"));
    const projectDir = path.join(dir, "seo-app");
    try {
      const result = await runCreateCommand(["web-static", "SEO App", "--dir", projectDir]);
      const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
      const scriptPath = path.join(projectDir, "scripts", "jeriko-prerender-seo.mjs");

      expect(result.ok).toBe(true);
      expect(result.data.crawlerPrerender).toBe(true);
      expect(packageJson.scripts.build).toContain("vite build && node scripts/jeriko-prerender-seo.mjs");
      expect(fs.existsSync(scriptPath)).toBe(true);

      const script = fs.readFileSync(scriptPath, "utf8");
      const syntaxCheck = spawnSync(process.execPath, ["--check", scriptPath], { cwd: projectDir, encoding: "utf8" });
      expect(syntaxCheck.status).toBe(0);
      expect(script).toContain("data-jeriko-prerender");
      expect(script).toContain("robots.txt");
      expect(script).toContain("sitemap.xml");
      expect(script).toContain("llms.txt");
      expect(script).toContain("google-site-verification");
      expect(script).toContain("msvalidate.01");

      const siteConfig = fs.readFileSync(path.join(projectDir, "client", "src", "site.config.ts"), "utf8");
      const analytics = fs.readFileSync(path.join(projectDir, "client", "src", "lib", "analytics.ts"), "utf8");
      const imageGuide = fs.readFileSync(path.join(projectDir, "client", "src", "assets", "image-prompts.md"), "utf8");
      expect(siteConfig).toContain("googleSiteVerification");
      expect(siteConfig).toContain("bingSiteVerification");
      expect(siteConfig).toContain("ga4MeasurementId");
      expect(siteConfig).toContain("analyticsProvider");
      expect(siteConfig).toContain("seoProfile");
      expect(siteConfig).toContain("imagePrompts");
      expect(siteConfig).toContain("hero photo");
      expect(imageGuide).toContain("generate_image");
      expect(imageGuide).toContain("Hero photo");
      expect(analytics).toContain("trackFormSubmit");
      expect(analytics).toContain("trackPhoneClick");
      expect(analytics).toContain("trackBookingClick");
      expect(analytics).toContain("trackEmailClick");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports local-service SEO profile and image guidance for generated business sites", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-local-seo-"));
    const projectDir = path.join(dir, "roofing-site");
    try {
      const result = await runCreateCommand(["web-static", "Tulsa Roofing", "--dir", projectDir, "--seo-profile", "local-service"]);
      const script = fs.readFileSync(path.join(projectDir, "scripts", "jeriko-prerender-seo.mjs"), "utf8");
      const siteConfig = fs.readFileSync(path.join(projectDir, "client", "src", "site.config.ts"), "utf8");

      expect(result.ok).toBe(true);
      expect(result.data.seoProfile).toBe("local-service");
      expect(script).toContain("LocalBusiness");
      expect(script).toContain("serviceArea");
      expect(script).toContain("FAQPage");
      expect(siteConfig).toContain("imagePrompts");
      expect(siteConfig).toContain("Generate a realistic hero photo");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes natural-language website prompts to a verified starter template", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-from-prompt-"));
    const projectDir = path.join(dir, "prompt-site");
    try {
      const result = await runCreateCommand(["from-prompt", "Build a roofing contractor website in Tulsa with SEO pages and quote photos", "--name", "Tulsa Roofing", "--dir", projectDir]);

      expect(result.ok).toBe(true);
      expect(result.data.template).toBe("web-static");
      expect(result.data.inferredFromPrompt).toBe(true);
      expect(result.data.seoProfile).toBe("local-service");
      expect(fs.existsSync(path.join(projectDir, "scripts", "jeriko-prerender-seo.mjs"))).toBe(true);
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".jeriko", "project-state.json"), "utf8"));
      expect(state.appSpec.prompt).toBe("Build a roofing contractor website in Tulsa with SEO pages and quote photos");
      expect(state.appSpec.appType).toBe("local-service-site");
      expect(state.appSpec.integrations.forbidden).toContain("stripe");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds local-service contractor prompts with launch-ready route breadth by default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-local-service-route-breadth-"));
    const projectDir = path.join(dir, "brothers-remodeling-okc");
    try {
      const result = await runCreateCommand(["from-prompt", "Build a new site for Brothers Remodeling OKC, a remodeling company in Oklahoma City", "--name", "Brothers Remodeling OKC", "--dir", projectDir]);
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".jeriko", "project-state.json"), "utf8"));
      const paths = state.appSpec.pages.map((page: any) => page.path);

      expect(result.ok).toBe(true);
      expect(result.data.template).toBe("web-static");
      expect(result.data.seoProfile).toBe("local-service");
      expect(paths).toEqual(expect.arrayContaining(["/", "/services", "/services/kitchen-remodeling", "/services/bathroom-remodeling", "/process", "/about", "/service-areas", "/service-areas/oklahoma-city", "/projects", "/gallery", "/reviews", "/faq", "/contact", "/privacy", "/terms"]));
      expect(paths.length).toBeGreaterThanOrEqual(25);
      expect(state.appSpec.successCriteria).toEqual(expect.arrayContaining([
        "Contractor/local-service sites follow contractor-site-autonomous-build: complete route map, service pages, city pages, reviews/FAQ/contact/privacy, sitemap/robots, and honest no-fake-claims copy",
        "Lead/contact forms are either wired to a real API with matching fields or replaced with honest email/phone CTAs",
      ]));
      expect(state.verification.requiredGates).toContain("premium_marketing_site_scan");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails premium local-service quality when routes fall back to home and the lead form is fake", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-sloppy-local-service-scan-"));
    try {
      fs.mkdirSync(path.join(dir, "client", "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "client", "index.html"), '<html><head><style>body{background: #09090b}</style></head><body><div id="root" data-jeriko-prerender></div><script type="module" src="/src/main.tsx"></script></body></html>');
      fs.writeFileSync(path.join(dir, "vercel.json"), JSON.stringify({ outputDirectory: "dist/public", rewrites: [{ source: "/(.*)", destination: "/index.html" }] }));
      fs.writeFileSync(path.join(dir, "client", "src", "main.tsx"), `
        import React from 'react';
        const services = ['Kitchen Remodeling', 'Bathroom Remodeling'];
        function HomePage(){ return <main><h1>Remodel your OKC home</h1><a href="/services">Services</a><a href="/contact">Contact</a></main>; }
        function ServicesPage(){ return <main><h1>Services</h1><LeadForm /></main>; }
        function ContactPage(){ return <main><h1>Contact</h1><LeadForm /></main>; }
        function LeadForm(){ const [sent,setSent]=React.useState(false); return <form onSubmit={(e)=>{e.preventDefault(); setSent(true)}}><input name="name" required /><input name="phone" required /><select name="project">{services.map((s)=><option>{s}</option>)}</select><button type="button" onClick={()=>setSent(true)}>Send My Project</button><small>Lead delivery must be connected before launch.</small>{sent && <p>Project request started.</p>}</form>; }
        function App(){ const path = window.location.pathname.replace(/\\/$/, '') || '/'; if (path === '/services') return <ServicesPage />; if (path === '/contact') return <ContactPage />; return <HomePage />; }
      `);
      const state = buildProjectState({ name: "Brothers Remodeling OKC", template: "web-static", profile: "web-static", prompt: "Build a new site for Brothers Remodeling OKC, a remodeling company in Oklahoma City" });
      const issues = scanPremiumMarketingSiteQuality(dir, state);
      const tokens = issues.map((issue) => issue.token);

      expect(tokens).toEqual(expect.arrayContaining(["local-service-route:/process", "local-service-route:/about", "local-service-route:/service-areas", "local-service-route:/gallery", "fake-lead-form", "placeholder-contact-copy"]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails local-service quality for missing Home nav, glued UI copy, and thin OKC city pages", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-trash-local-service-scan-"));
    try {
      fs.mkdirSync(path.join(dir, "client", "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "client", "index.html"), '<html><head><style>body{background: #09090b}</style></head><body><div id="root" data-jeriko-prerender></div><script type="module" src="/src/App.tsx"></script></body></html>');
      fs.writeFileSync(path.join(dir, "vercel.json"), JSON.stringify({ outputDirectory: "dist/public", rewrites: [{ source: "/(.*)", destination: "/index.html" }] }));
      fs.writeFileSync(path.join(dir, "client", "src", "App.tsx"), `
        import { Route, Switch, Link, useLocation } from 'wouter';
        function AppLink(props:any){ return <Link {...props} /> }
        function LeadOpsVisual(){ return <div>Project pathScope → Visit → Quote → Build</div> }
        function LeadFlowLineSection(){ return <section>lead flow</section> }
        function LeadLeakAudit(){ return <section>audit</section> }
        function BeforeAfterComparison(){ return <section>before after</section> }
        function StickyAuditRail(){ return <aside>Ready to remodel?Request quote</aside> }
        const cities = ['Oklahoma City', 'South Edmond', 'East Yukon'];
        function Shell({children}:any){ return <><nav><AppLink href="/services">Services</AppLink><AppLink href="/process">Process</AppLink><AppLink href="/about">About</AppLink><AppLink href="/gallery">Gallery</AppLink><AppLink href="/service-area">Cities</AppLink><AppLink href="/contact">Contact</AppLink></nav>{children}</> }
        function Home(){ return <Shell><LeadOpsVisual /><LeadFlowLineSection /><LeadLeakAudit /><BeforeAfterComparison /><StickyAuditRail /></Shell> }
        function ServiceArea(){ return <Shell><h1>Oklahoma City and nearby surrounding communities.</h1><b>OKC</b><span>Nearby communities checked by scope, schedule, and service radius.</span>{cities.map(c => <a href={'/service-area/'+c.toLowerCase().replaceAll(' ','-')}>{c}</a>)}</Shell> }
        function City(){ return <Shell><p>Common requests around South Edmond include near-OKC remodel projects checked for schedule, service radius, project scope, and travel radius.</p></Shell> }
        function Gallery(){ return <Shell><p>The gallery explains remodeling categories honestly and can grow as Brothers Remodeling OKC provides additional real project photos.</p></Shell> }
        export default function App(){ return <Switch><Route path="/" component={Home}/><Route path="/services" component={Home}/><Route path="/process" component={Home}/><Route path="/about" component={Home}/><Route path="/gallery" component={Gallery}/><Route path="/service-area" component={ServiceArea}/><Route path="/service-area/:citySlug" component={City}/><Route path="/contact" component={Home}/></Switch> }
      `);
      const state = buildProjectState({ name: "Brothers Remodeling OKC", template: "web-static", profile: "web-static", prompt: "Build a new site for Brothers Remodeling OKC, a remodeling company in Oklahoma City" });
      const tokens = scanPremiumMarketingSiteQuality(dir, state).map((issue) => issue.token);

      expect(tokens).toEqual(expect.arrayContaining(["primary-home-nav", "primary-service-areas-nav", "glued-ui-copy", "partial-metro-city-labels", "thin-city-page-copy", "gallery-placeholder-copy"]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails autonomous contractor sites without complete route, service, city, SEO, claim, form, and mobile proof", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-contractor-hard-gates-"));
    try {
      fs.mkdirSync(path.join(dir, "client", "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "client", "index.html"), '<html><head><style>body{background: #09090b}</style></head><body><div id="root" data-jeriko-prerender></div><script type="module" src="/src/App.tsx"></script></body></html>');
      fs.writeFileSync(path.join(dir, "vercel.json"), JSON.stringify({ outputDirectory: "dist/public", rewrites: [{ source: "/(.*)", destination: "/index.html" }] }));
      fs.writeFileSync(path.join(dir, "client", "src", "App.tsx"), `
        import React from 'react';
        import { Route, Switch, Link, useLocation } from 'wouter';
        function AppLink(props:any){ return <Link {...props} /> }
        function LeadOpsVisual(){ return <div>visual</div> }
        function LeadFlowLineSection(){ return <section>flow</section> }
        function LeadLeakAudit(){ return <section>audit</section> }
        function BeforeAfterComparison(){ return <section>before after</section> }
        function StickyAuditRail(){ return <aside>Request Quote</aside> }
        function Home(){ return <main><nav><AppLink href="/">Home</AppLink><AppLink href="/services">Services</AppLink><AppLink href="/contact">Contact</AppLink></nav><p>Licensed and insured 5-star contractor serving since 1999.</p></main> }
        function ServicePage(){ return <main><h1>Service</h1><p>service title only same copy</p></main> }
        function CityPage(){ return <main><h1>City</h1><p>city name only same copy</p></main> }
        function Contact(){ const [sent,setSent]=React.useState(false); return <form onSubmit={(e)=>{e.preventDefault(); setSent(true)}}><button type="button" onClick={()=>setSent(true)}>Request Quote</button>{sent && <p>Sent</p>}</form> }
        export default function App(){ return <Switch><Route path="/" component={Home}/><Route path="/services" component={Home}/><Route path="/services/kitchen-remodeling" component={ServicePage}/><Route path="/contact" component={Contact}/></Switch> }
      `);
      const state = buildProjectState({ name: "Brothers Remodeling OKC", template: "web-static", profile: "web-static", prompt: "Build a new site for Brothers Remodeling OKC, a remodeling company in Oklahoma City" });
      if (state.appSpec) state.appSpec.pages = [
        { path: "/", title: "Home" },
        { path: "/services", title: "Services" },
        { path: "/services/kitchen-remodeling", title: "Kitchen Remodeling" },
        { path: "/contact", title: "Contact" },
      ];
      const tokens = scanPremiumMarketingSiteQuality(dir, state).map((issue) => issue.token);

      expect(tokens).toEqual(expect.arrayContaining([
        "contractor-route-contract",
        "contractor-false-claim-scan",
        "fake-lead-form",
        "contractor-seo-foundation",
        "contractor-mobile-conversion-smoke",
        "contractor-page-depth-uniqueness",
      ]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails autonomous contractor routes that exist in appSpec but are not implemented", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-contractor-route-implementation-"));
    try {
      fs.mkdirSync(path.join(dir, "client", "src"), { recursive: true });
      fs.mkdirSync(path.join(dir, "public"), { recursive: true });
      fs.writeFileSync(path.join(dir, "public", "sitemap.xml"), '<urlset><url><loc>/</loc></url></urlset>');
      fs.writeFileSync(path.join(dir, "public", "robots.txt"), 'User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n');
      fs.writeFileSync(path.join(dir, "client", "index.html"), '<html><head><title>Contractor</title><meta name="description" content="Contractor site"><link rel="canonical" href="/"><style>body{background: #09090b}</style></head><body><div id="root" data-jeriko-prerender></div><script type="module" src="/src/App.tsx"></script></body></html>');
      fs.writeFileSync(path.join(dir, "vercel.json"), JSON.stringify({ outputDirectory: "dist/public", rewrites: [{ source: "/(.*)", destination: "/index.html" }] }));
      fs.writeFileSync(path.join(dir, "client", "src", "App.tsx"), `
        import { Route, Switch, Link, useLocation } from 'wouter';
        function AppLink(props:any){ return <Link {...props} /> }
        function LeadOpsVisual(){ return <div>visual</div> }
        function LeadFlowLineSection(){ return <section>flow</section> }
        function LeadLeakAudit(){ return <section>audit</section> }
        function BeforeAfterComparison(){ return <section>before after</section> }
        function StickyAuditRail(){ return <aside className="fixed inset-x-0 bottom-0">Request Quote</aside> }
        function Home(){ return <main><nav aria-label="Mobile navigation"><AppLink href="/">Home</AppLink><AppLink href="/services">Services</AppLink><AppLink href="/contact">Contact</AppLink></nav></main> }
        export default function App(){ return <Switch><Route path="/" component={Home}/><Route path="/services" component={Home}/><Route path="/process" component={Home}/><Route path="/about" component={Home}/><Route path="/service-areas" component={Home}/><Route path="/projects" component={Home}/><Route path="/gallery" component={Home}/><Route path="/reviews" component={Home}/><Route path="/faq" component={Home}/><Route path="/contact" component={Home}/><Route path="/privacy" component={Home}/><Route path="/terms" component={Home}/></Switch> }
      `);
      const state = buildProjectState({ name: "Tulsa Roofing", template: "web-static", profile: "web-static", prompt: "Build a roofing contractor website in Tulsa with SEO pages and quote photos" });
      const tokens = scanPremiumMarketingSiteQuality(dir, state).map((issue) => issue.token);

      expect(tokens).toEqual(expect.arrayContaining(["contractor-service-page-implementation", "contractor-city-page-implementation"]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds contractor marketing prompts with premium multi-page SPA and deploy-safe defaults", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-premium-contractor-site-"));
    const projectDir = path.join(dir, "alpha-style-site");
    try {
      const result = await runCreateCommand(["from-prompt", "Build a full contractor marketing website for roofers and remodelers with services, process, proof, pricing, and contact pages", "--name", "Alpha Style Site", "--dir", projectDir]);
      const app = fs.readFileSync(path.join(projectDir, "client", "src", "App.tsx"), "utf8");
      const indexHtml = fs.readFileSync(path.join(projectDir, "client", "index.html"), "utf8");
      const vercelJson = JSON.parse(fs.readFileSync(path.join(projectDir, "vercel.json"), "utf8"));
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".jeriko", "project-state.json"), "utf8"));

      expect(result.ok).toBe(true);
      expect(result.data.template).toBe("web-static");
      expect(app).toContain("function AppLink");
      expect(app).toContain("useLocation");
      expect(app).toContain("<AppLink key={item.href} href={item.href}");
      expect(app).toContain("LeadFlowLineSection");
      expect(app).toContain("LeadLeakAudit");
      expect(app).toContain("BeforeAfterComparison");
      expect(app).toContain("StickyAuditRail");
      expect(app).toContain("Website Cleanup");
      expect(app).toContain("Request System Buildout");
      expect(app).toContain("Monthly Growth Help");
      expect(app).toContain("path=\"/services\"");
      expect(app).toContain("path=\"/pricing\"");
      expect(app).toContain("path=\"/contact\"");
      expect(indexHtml).toContain("background: #09090b");
      expect(indexHtml).toContain("data-jeriko-prerender");
      expect(vercelJson.outputDirectory).toBe("dist/public");
      expect(vercelJson.rewrites).toContainEqual({ source: "/(.*)", destination: "/index.html" });
      expect(state.verification.requiredGates).toContain("premium_marketing_site_scan");
      expect(state.appSpec.features).toEqual(expect.arrayContaining(["premium contractor conversion system", "SPA internal navigation", "deploy-safe Vercel static routing"]));
      expect(state.appSpec.successCriteria).toContain("Premium marketing sites include a hero system visual, lead-flow module, interactive audit, before/after comparison, sticky CTA, and SPA internal navigation");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds realtor prompts with real estate routes instead of contractor pages", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-realtor-site-"));
    const projectDir = path.join(dir, "cody-realtor");
    try {
      const result = await runCreateCommand(["from-prompt", "Build a production-ready realtor website for Cody Chesnutt in Oswego KS with buy, sell, listings, about, area guide, and contact pages", "--name", "Cody Realtor", "--dir", projectDir]);
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".jeriko", "project-state.json"), "utf8"));
      const paths = state.appSpec.pages.map((page: any) => page.path);

      expect(result.ok).toBe(true);
      expect(result.data.template).toBe("web-static");
      expect(result.data.seoProfile).toBe("local-service");
      expect(paths).toEqual(expect.arrayContaining(["/", "/buy", "/sell", "/listings", "/about", "/area-guide", "/contact"]));
      expect(paths).not.toContain("/services");
      expect(paths).not.toContain("/pricing");
      expect(state.appSpec.features).toContain("premium local business conversion system");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes natural-language full-stack product prompts to the database app template", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-from-product-prompt-"));
    const projectDir = path.join(dir, "flipscout");
    try {
      const result = await runCreateCommand(["from-prompt", "Build FlipScout, an AI resale scanner with photo upload, paste item details, item costs, scan item, save inventory, and profit estimates", "--name", "FlipScout", "--dir", projectDir]);

      expect(result.ok).toBe(true);
      expect(result.data.template).toBe("web-db-user");
      expect(result.data.inferredFromPrompt).toBe(true);
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".jeriko", "project-state.json"), "utf8"));
      expect(state.profile).toBe("web-db-user");
      expect(state.appSpec.appType).toBe("full-stack-product-app");
      expect(state.appSpec.workflows[0].id).toBe("resale-scanner");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts direct natural-language create prompts without forcing a template choice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-direct-prompt-"));
    const projectDir = path.join(dir, "direct-roofing-site");
    try {
      const result = await runCreateCommand(["Build a roofing contractor website in Tulsa with service pages, city pages, reviews, FAQ, and quote calls", "--name", "Direct Roofing", "--dir", projectDir]);
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".jeriko", "project-state.json"), "utf8"));
      const paths = state.appSpec.pages.map((page: any) => page.path);

      expect(result.ok).toBe(true);
      expect(result.data.template).toBe("web-static");
      expect(result.data.inferredFromPrompt).toBe(true);
      expect(result.data.seoProfile).toBe("local-service");
      expect(state.appSpec.prompt).toContain("roofing contractor website");
      expect(paths).toEqual(expect.arrayContaining(["/services/roof-replacement", "/service-areas/tulsa", "/reviews", "/faq", "/contact"]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scaffolds generic full-stack product prompts with usable dashboard, intake, records, and API routes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-create-generic-product-"));
    const projectDir = path.join(dir, "jobflow-crm");
    try {
      const result = await runCreateCommand(["from-prompt", "Build JobFlow CRM with login, lead intake, job pipeline, customer records, estimates, and dashboard", "--name", "JobFlow CRM", "--dir", projectDir]);
      const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".jeriko", "project-state.json"), "utf8"));
      const app = fs.readFileSync(path.join(projectDir, "client", "src", "App.tsx"), "utf8");
      const api = fs.readFileSync(path.join(projectDir, "server", "_core", "api-app.ts"), "utf8");

      expect(result.ok).toBe(true);
      expect(result.data.template).toBe("web-db-user");
      expect(state.appSpec.appType).toBe("full-stack-product-app");
      expect(state.appSpec.pages.map((page: any) => page.path)).toEqual(expect.arrayContaining(["/dashboard", "/intake", "/records"]));
      expect(state.appSpec.workflows[0]).toMatchObject({
        id: "business-operations",
        actions: expect.arrayContaining(["create", "update", "advance", "review"]),
        persistence: expect.arrayContaining(["leads", "jobs", "customers", "estimates"]),
      });
      expect(app).toContain('path={"/dashboard"}');
      expect(app).toContain('path={"/intake"}');
      expect(app).toContain('path={"/records"}');
      expect(api).toContain('app.get("/api/records"');
      expect(api).toContain('app.post("/api/intake"');
      expect(api).toContain('app.patch("/api/pipeline/:id"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prerender script auto-adds launch tracking hooks to conversion targets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-prerender-tracking-"));
    try {
      fs.mkdirSync(path.join(dir, "client", "src", "pages"), { recursive: true });
      fs.mkdirSync(path.join(dir, "dist", "public"), { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build && esbuild server/index.ts --outdir=dist" } }, null, 2));
      fs.writeFileSync(path.join(dir, "client", "index.html"), '<html lang="en"><head><title>SEO App</title></head><body><div id="root"></div></body></html>');
      fs.writeFileSync(path.join(dir, "client", "src", "App.tsx"), 'export default function App(){return <div/>}\n');
      fs.writeFileSync(path.join(dir, "client", "src", "pages", "Home.tsx"), 'export default function Home(){return <main><h1>SEO App</h1><p>Useful launch content for homeowners and search crawlers.</p></main>}\n');
      expect(applyCrawlerPrerenderSupport(dir, "SEO App")).toBe(true);
      fs.writeFileSync(path.join(dir, "dist", "public", "index.html"), '<html lang="en"><head><title>SEO App</title></head><body><form><button>Send</button></form><a href="tel:+16201230263">Call</a><a href="mailto:hello@example.com">Email</a><a href="/schedule">Schedule</a><div id="root"></div></body></html>');

      const result = spawnSync(process.execPath, [path.join(dir, "scripts", "jeriko-prerender-seo.mjs")], { cwd: dir, encoding: "utf8" });
      const html = fs.readFileSync(path.join(dir, "dist", "public", "index.html"), "utf8");

      expect(result.status).toBe(0);
      expect(html).toContain('<form data-jeriko-track="form_submit"');
      expect(html).toContain('<a href="tel:+16201230263" data-jeriko-track="call_click"');
      expect(html).toContain('<a href="mailto:hello@example.com" data-jeriko-track="email_click"');
      expect(html).toContain('<a href="/schedule" data-jeriko-track="booking_click"');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prerender script gives short project names crawlable titles and filters Tailwind class strings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-prerender-short-title-"));
    try {
      fs.mkdirSync(path.join(dir, "client", "src", "pages"), { recursive: true });
      fs.mkdirSync(path.join(dir, "dist", "public"), { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build && esbuild server/index.ts --outdir=dist" } }, null, 2));
      fs.writeFileSync(path.join(dir, "client", "index.html"), '<html lang="en"><head><title>Smoke</title></head><body><div id="root"></div></body></html>');
      fs.writeFileSync(path.join(dir, "client", "src", "App.tsx"), 'export default function App(){return <div/>}\n');
      fs.writeFileSync(path.join(dir, "client", "src", "pages", "Home.tsx"), 'export default function Home(){return <main className="min-h-screen bg-background text-foreground"><h1>Launch-ready web app</h1><p className="mt-3 leading-7 text-muted-foreground">Useful launch content for homeowners and search crawlers.</p></main>}\n');
      expect(applyCrawlerPrerenderSupport(dir, "Smoke")).toBe(true);
      fs.writeFileSync(path.join(dir, "dist", "public", "index.html"), '<html lang="en"><head><title>Smoke</title></head><body><div id="root"></div></body></html>');

      const result = spawnSync(process.execPath, [path.join(dir, "scripts", "jeriko-prerender-seo.mjs")], { cwd: dir, encoding: "utf8" });
      const html = fs.readFileSync(path.join(dir, "dist", "public", "index.html"), "utf8");

      expect(result.status).toBe(0);
      expect(html).toContain("<title>Smoke Website</title>");
      expect(html).toContain("Launch-ready web app");
      expect(html).not.toContain("min-h-screen bg-background text-foreground");
      expect(html).not.toContain("mt-3 leading-7 text-muted-foreground");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can apply crawler prerender support idempotently", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-prerender-idempotent-"));
    try {
      fs.mkdirSync(path.join(dir, "client"), { recursive: true });
      fs.writeFileSync(path.join(dir, "client", "index.html"), '<div id="root"></div>');
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { build: "vite build && esbuild server/index.ts --outdir=dist" } }, null, 2));

      expect(applyCrawlerPrerenderSupport(dir, "SEO App")).toBe(true);
      expect(applyCrawlerPrerenderSupport(dir, "SEO App")).toBe(true);
      const packageJson = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      expect(packageJson.scripts.build.match(/jeriko-prerender-seo/g)?.length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dev command aliases", () => {
  it("parses --start <name> under ~/.jeriko/projects/<name>", () => {
    const parsed = parseDevInvocation(["--start", "demo-app"]);

    expect(parsed.action).toBe("start");
    expect(parsed.projectName).toBe("demo-app");
    expect(parsed.directory).toBe(path.join(os.homedir(), ".jeriko", "projects", "demo-app"));
  });

  it("preserves dev start --dir <path> compatibility", () => {
    const dir = path.join(os.tmpdir(), "jeriko-dev-dir");
    const parsed = parseDevInvocation(["start", "--dir", dir, "--port", "4100"]);

    expect(parsed.action).toBe("start");
    expect(parsed.directory).toBe(dir);
    expect(parsed.port).toBe("4100");
  });

  it("parses --logs <name> and --status aliases", () => {
    const logs = parseDevInvocation(["--logs", "demo-app"]);
    const status = parseDevInvocation(["--status"]);

    expect(logs.action).toBe("logs");
    expect(logs.directory).toBe(path.join(os.homedir(), ".jeriko", "projects", "demo-app"));
    expect(status.action).toBe("status");
  });

  it("adds explicit strict port flags for Vite package dev scripts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-dev-vite-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite --host" } }));
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      expect(detectDevCommand(dir, "3941")).toBe("pnpm run dev --port 3941 --strictPort");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps PORT env behavior for non-Vite package dev scripts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-dev-tsx-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { dev: "NODE_ENV=development tsx watch server/_core/index.ts" } }));
      fs.writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");

      expect(detectDevCommand(dir, "3941")).toBe("pnpm run dev");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

});


async function runCreateCommand(args: string[]): Promise<any> {
  setOutputFormat("json");
  let output = "";
  const writeSpy = spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    output += String(chunk);
    return true;
  });
  const exitSpy = spyOn(process, "exit").mockImplementation((() => {
    throw new Error("EXIT");
  }) as never);

  try {
    await createCommand.run(args);
  } catch (error: any) {
    if (error?.message !== "EXIT") throw error;
  } finally {
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  }

  const line = output.trim().split("\n").at(-1);
  if (!line) throw new Error("Command produced no output");
  return JSON.parse(line);
}

function collectTextFiles(dir: string): string[] {
  const chunks: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      chunks.push(...collectTextFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) continue;
    const buffer = fs.readFileSync(fullPath);
    if (buffer.includes(0)) continue;
    chunks.push(buffer.toString("utf8"));
  }
  return chunks;
}
