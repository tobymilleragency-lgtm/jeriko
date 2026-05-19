import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { applyCrawlerPrerenderSupport, command as createCommand, replaceTemplatePlaceholders } from "../../src/cli/commands/dev/create.js";
import { detectDevCommand, parseDevInvocation } from "../../src/cli/commands/dev/dev.js";
import { setOutputFormat } from "../../src/shared/output.js";

const repoRoot = process.cwd();

describe("create command templates", () => {
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
      expect(script).toContain("data-jeriko-prerender");
      expect(script).toContain("robots.txt");
      expect(script).toContain("sitemap.xml");
      expect(script).toContain("llms.txt");
      expect(script).toContain("google-site-verification");
      expect(script).toContain("msvalidate.01");

      const siteConfig = fs.readFileSync(path.join(projectDir, "client", "src", "site.config.ts"), "utf8");
      const analytics = fs.readFileSync(path.join(projectDir, "client", "src", "lib", "analytics.ts"), "utf8");
      expect(siteConfig).toContain("googleSiteVerification");
      expect(siteConfig).toContain("bingSiteVerification");
      expect(siteConfig).toContain("ga4MeasurementId");
      expect(siteConfig).toContain("analyticsProvider");
      expect(analytics).toContain("trackFormSubmit");
      expect(analytics).toContain("trackPhoneClick");
      expect(analytics).toContain("trackBookingClick");
      expect(analytics).toContain("trackEmailClick");
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
