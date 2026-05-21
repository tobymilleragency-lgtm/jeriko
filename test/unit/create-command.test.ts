import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { applyCrawlerPrerenderSupport, command as createCommand, repairGeneratedProject, replaceTemplatePlaceholders } from "../../src/cli/commands/dev/create.js";
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

        expect(envExample).toContain("VITE_APP_SUPABASE_URL");
        expect(envExample).toContain("VITE_APP_SUPABASE_ANON_KEY");
        expect(envExample).toContain("/auth/v1/callback");
        expect(supabaseAuth).toContain("createClient");
        expect(supabaseAuth).toContain("signInWithOAuth");
        expect(supabaseAuth).toContain("provider: \"google\"");
        expect(pkg.dependencies["@supabase/supabase-js"]).toBeDefined();
      }
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
      expect(state.appSpec.integrations.allowed).toEqual([]);
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
