import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

import { command as verifyAppCommand, scanPlaceholders, scanUnsafeEnvRefs, scanCrawlerHtml, inferAppProfile, defaultRouteForProfile, readProjectState, getDependencyStatus, resolveVerificationPort } from "../../src/cli/commands/dev/verify-app.js";
import { setOutputFormat } from "../../src/shared/output.js";

describe("verify-app command", () => {
  it("fails before running commands when generated placeholders remain", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-placeholder-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), '{"name":"{{project_name}}","scripts":{"check":"echo check","build":"echo build"}}\n');

      const result = await runVerifyAppCommand([dir, "--skip-install"]);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("E_PLACEHOLDERS");
      expect(result.placeholders[0].file).toBe(path.join(dir, "package.json"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-advances the default verification port when it is already occupied", async () => {
    const server = createServer((_req, res) => res.end("occupied"));
    const occupiedPort = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address) resolve(address.port);
      });
    });

    try {
      const resolved = await resolveVerificationPort(String(occupiedPort), { maxAttempts: 2 });
      expect(resolved).toBe(String(occupiedPort + 1));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps explicit busy verification ports strict", async () => {
    const server = createServer((_req, res) => res.end("occupied"));
    const occupiedPort = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address) resolve(address.port);
      });
    });

    try {
      const resolved = await resolveVerificationPort(String(occupiedPort), { strict: true, maxAttempts: 2 });
      expect(resolved).toBe(String(occupiedPort));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails before running commands when generic Supabase env names remain", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-unsafe-env-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "package.json"), '{"name":"unsafe-env","scripts":{"check":"echo should-not-run"}}\n');
      fs.writeFileSync(path.join(dir, "src", "supabase.ts"), 'const url = import.meta.env.VITE_SUPABASE_URL;\nconst key = import.meta.env.VITE_SUPABASE_ANON_KEY;\n');

      const hits = scanUnsafeEnvRefs(dir);
      const result = await runVerifyAppCommand([dir, "--skip-install"]);

      expect(hits.map((hit) => hit.token)).toEqual(["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"]);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("E_UNSAFE_ENV");
      expect(result.unsafeEnvRefs.length).toBe(2);
      expect(result.gates.map((gate: any) => gate.name)).toEqual(["placeholder_scan", "unsafe_env_scan"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects crawler-visible built HTML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-crawler-html-"));
    try {
      const publicDir = path.join(dir, "dist", "public");
      fs.mkdirSync(publicDir, { recursive: true });
      fs.writeFileSync(path.join(publicDir, "index.html"), '<html><head><meta name="description" content="A long enough public marketing description for crawlers."></head><body><div id="root"><article data-jeriko-prerender="true">Public content</article></div></body></html>');
      fs.writeFileSync(path.join(publicDir, "robots.txt"), "User-agent: *\nAllow: /\n");
      fs.writeFileSync(path.join(publicDir, "sitemap.xml"), "<urlset></urlset>\n");

      const result = scanCrawlerHtml(dir);

      expect(result.checked).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.output).toContain("Crawler-visible HTML found");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails crawler HTML scan for empty SPA shells", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-empty-shell-"));
    try {
      const publicDir = path.join(dir, "dist", "public");
      fs.mkdirSync(publicDir, { recursive: true });
      fs.writeFileSync(path.join(publicDir, "index.html"), '<html><head><title>Old</title></head><body><div id="root"></div></body></html>');

      const result = scanCrawlerHtml(dir);

      expect(result.checked).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Build output must include prerendered/fallback body content");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails crawler HTML scan when a sitemap route is noindex", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-sitemap-noindex-"));
    try {
      writeCrawlerRoute(dir, "/", { body: "Home crawler content for search." });
      writeCrawlerRoute(dir, "/services/kitchen-remodel-consulting", {
        robots: "noindex,nofollow",
        body: "Kitchen remodel consulting crawler content for search.",
      });
      writeCrawlerSitemap(dir, ["/", "/services/kitchen-remodel-consulting"]);
      writeCrawlerRobots(dir);

      const result = scanCrawlerHtml(dir);

      expect(result.checked).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Sitemap route is not indexable");
      expect(result.output).toContain("/services/kitchen-remodel-consulting");
      expect(result.output).toContain("noindex,nofollow");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails crawler HTML scan when a sitemap route lacks route-specific raw content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-sitemap-empty-route-"));
    try {
      writeCrawlerRoute(dir, "/", { body: "Home crawler content for search." });
      writeCrawlerRoute(dir, "/serving/pittsburg-ks", { body: "" });
      writeCrawlerSitemap(dir, ["/", "/serving/pittsburg-ks"]);
      writeCrawlerRobots(dir);

      const result = scanCrawlerHtml(dir);

      expect(result.checked).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Sitemap route lacks crawler-visible body content");
      expect(result.output).toContain("/serving/pittsburg-ks");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails crawler HTML scan when sitemap route canonical points elsewhere", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-canonical-mismatch-"));
    try {
      writeCrawlerRoute(dir, "/", { body: "Home crawler content for search." });
      writeCrawlerRoute(dir, "/contact", {
        canonical: "https://example.com/about",
        body: "Contact crawler content for search.",
      });
      writeCrawlerSitemap(dir, ["/", "/contact"]);
      writeCrawlerRobots(dir);

      const result = scanCrawlerHtml(dir);

      expect(result.checked).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("Sitemap route canonical mismatch");
      expect(result.output).toContain("/contact");
      expect(result.output).toContain("https://example.com/about");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs install/check/build gates and reports success", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-pass-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "verify-pass",
        scripts: {
          check: "node -e \"console.log('CHECK_OK')\"",
          build: "node -e \"console.log('BUILD_OK')\"",
        },
      }, null, 2));
      fs.mkdirSync(path.join(dir, "node_modules"));

      const result = await runVerifyAppCommand([dir, "--skip-install", "--skip-start"]);

      expect(result.ok).toBe(true);
      expect(result.data.directory).toBe(dir);
      expect(result.data.profile).toBe("web-static");
      expect(result.data.gates.map((gate: any) => gate.name)).toEqual(["placeholder_scan", "unsafe_env_scan", "check", "build"]);
      expect(result.data.gates.every((gate: any) => gate.ok)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records lastSuccessfulVerification in project-state after a passing run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-last-success-"));
    try {
      fs.mkdirSync(path.join(dir, ".jeriko"));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "verify-last-success",
        scripts: {
          check: "node -e \"console.log('CHECK_OK')\"",
          build: "node -e \"console.log('BUILD_OK')\"",
        },
      }, null, 2));
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, ".jeriko", "project-state.json"), JSON.stringify({
        version: 1,
        name: "verify-last-success",
        template: "web-static",
        profile: "web-static",
        packageManager: "pnpm",
        generatedAt: "2026-01-01T00:00:00.000Z",
        commands: { check: "pnpm run check", build: "pnpm run build" },
        routes: { home: "/" },
        verification: { requiredGates: ["placeholder_scan", "unsafe_env_scan", "check", "build"] },
      }, null, 2));

      const result = await runVerifyAppCommand([dir, "--skip-install", "--skip-start"]);
      const state = readProjectState(dir);

      expect(result.ok).toBe(true);
      expect(state?.verification.lastSuccessfulVerification).toBeDefined();
      expect((state?.verification.lastSuccessfulVerification as any).ok).toBe(true);
      expect((state?.verification.lastSuccessfulVerification as any).profile).toBe("web-static");
      expect((state?.verification.lastSuccessfulVerification as any).gates.map((gate: any) => gate.name)).toEqual(["placeholder_scan", "unsafe_env_scan", "check", "build"]);
      expect((state?.verification.lastSuccessfulVerification as any).completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect((state?.verification.lastSuccessfulVerification as any).command).toContain("verify-app");
      expect((state?.verification.lastSuccessfulVerification as any).sourceFingerprint.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((state?.verification.lastSuccessfulVerification as any).sourceFingerprint.fileCount).toBeGreaterThan(0);
      expect(result.data.projectState.verification.lastSuccessfulVerification.ok).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs install before check/build when node_modules is missing even with skip-install", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-install-first-"));
    const orderFile = path.join(dir, "order.txt");
    try {
      fs.mkdirSync(path.join(dir, ".jeriko"));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "verify-install-first",
        scripts: {
          check: "node -e \"const fs=require('fs'); if(!fs.existsSync('node_modules')) process.exit(7); fs.appendFileSync('order.txt','check\\n')\"",
          build: "node -e \"const fs=require('fs'); if(!fs.existsSync('node_modules')) process.exit(8); fs.appendFileSync('order.txt','build\\n')\"",
        },
      }, null, 2));
      fs.writeFileSync(path.join(dir, ".jeriko", "project-state.json"), JSON.stringify({
        version: 1,
        name: "verify-install-first",
        template: "web-static",
        profile: "web-static",
        packageManager: "pnpm",
        generatedAt: "2026-01-01T00:00:00.000Z",
        commands: {
          install: "node -e \"const fs=require('fs'); fs.mkdirSync('node_modules'); fs.appendFileSync('order.txt','install\\n')\"",
          check: "node -e \"const fs=require('fs'); if(!fs.existsSync('node_modules')) process.exit(7); fs.appendFileSync('order.txt','check\\n')\"",
          build: "node -e \"const fs=require('fs'); if(!fs.existsSync('node_modules')) process.exit(8); fs.appendFileSync('order.txt','build\\n')\"",
        },
        routes: { home: "/" },
        verification: { requiredGates: ["placeholder_scan", "unsafe_env_scan", "install", "check", "build"] },
      }, null, 2));

      const result = await runVerifyAppCommand([dir, "--skip-install", "--skip-start"]);

      expect(result.ok).toBe(true);
      expect(result.data.dependencyStatus.nodeModules).toBe(true);
      expect(result.data.gates.map((gate: any) => gate.name)).toEqual(["placeholder_scan", "unsafe_env_scan", "install", "check", "build"]);
      expect(fs.readFileSync(orderFile, "utf8")).toBe("install\ncheck\nbuild\n");
      expect(result.data.gates.find((gate: any) => gate.name === "install").output).toContain("node_modules missing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses check/build when node_modules remains missing after install preflight", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-missing-deps-"));
    try {
      fs.mkdirSync(path.join(dir, ".jeriko"));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "verify-missing-deps", scripts: { check: "node -e \"process.exit(99)\"" } }, null, 2));
      fs.writeFileSync(path.join(dir, ".jeriko", "project-state.json"), JSON.stringify({
        version: 1,
        name: "verify-missing-deps",
        template: "web-static",
        profile: "web-static",
        packageManager: "pnpm",
        generatedAt: "2026-01-01T00:00:00.000Z",
        commands: { install: "node -e \"console.log('INSTALL_WITHOUT_NODE_MODULES')\"", check: "node -e \"process.exit(99)\"" },
        routes: { home: "/" },
        verification: { requiredGates: ["placeholder_scan", "unsafe_env_scan", "install", "check"] },
      }, null, 2));

      const result = await runVerifyAppCommand([dir, "--skip-install", "--skip-start"]);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("E_VERIFY_GATE");
      expect(result.failedGate.name).toBe("dependency_preflight");
      expect(result.failedGate.output).toContain("node_modules is still missing");
      expect(result.dependencyStatus.missingNodeModules).toBe(true);
      expect(result.gates.map((gate: any) => gate.name)).toEqual(["placeholder_scan", "unsafe_env_scan", "install", "dependency_preflight"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports dependency status for missing node_modules", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-dep-status-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "verify-dep-status" }));
      const status = getDependencyStatus(dir);
      expect(status.packageJson).toBe(true);
      expect(status.nodeModules).toBe(false);
      expect(status.missingNodeModules).toBe(true);
      expect(status.message).toContain("node_modules missing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("infers web-db-user profile when server and drizzle files exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-profile-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      fs.mkdirSync(path.join(dir, "server"));
      fs.writeFileSync(path.join(dir, "drizzle.config.ts"), "export default {};\n");

      expect(inferAppProfile(dir)).toBe("web-db-user");
      expect(defaultRouteForProfile("web-db-user")).toBe("/api/health");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses project-state to infer profile and default routes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-state-"));
    try {
      fs.mkdirSync(path.join(dir, ".jeriko"));
      fs.writeFileSync(path.join(dir, ".jeriko", "project-state.json"), JSON.stringify({
        profile: "web-db-user",
        routes: { health: "/custom-health", home: "/dashboard" },
        commands: { install: "pnpm install --frozen-lockfile --ignore-scripts", check: "pnpm run check", build: "pnpm run build" }
      }));

      const state = readProjectState(dir);
      expect(state?.profile).toBe("web-db-user");
      expect(inferAppProfile(dir)).toBe("web-db-user");
      expect(defaultRouteForProfile("web-db-user", state)).toBe("/custom-health");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts web-db-user apps and probes the default health route", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-health-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "verify-health",
        scripts: {
          start: "node server.mjs",
        },
      }, null, 2));
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, "server.mjs"), `
        import http from 'node:http';
        const port = Number(process.env.PORT || 0);
        const server = http.createServer((req, res) => {
          if (req.url === '/api/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><html><body><div id="root">App</div></body></html>');
        });
        server.listen(port);
      `);
      fs.mkdirSync(path.join(dir, "server"), { recursive: true });
      fs.writeFileSync(path.join(dir, "drizzle.config.ts"), "export default {}\n");

      const result = await runVerifyAppCommand([dir, "--profile", "web-db-user", "--skip-install", "--port", "4291"]);

      expect(result.ok).toBe(true);
      expect(result.data.gates.map((gate: any) => gate.name)).toContain("start_route");
      const startGate = result.data.gates.find((gate: any) => gate.name === "start_route");
      expect(startGate.ok).toBe(true);
      expect(startGate.output).toContain('"ok":true');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects HTML SPA fallback responses for API start routes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-api-html-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "verify-api-html",
        scripts: { start: "node server.mjs" },
      }, null, 2));
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, "server.mjs"), `
        import http from 'node:http';
        const port = Number(process.env.PORT || 0);
        const html = '<!doctype html><html><body><div id="root">SPA fallback</div></body></html>';
        http.createServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
          res.end(html);
        }).listen(port);
      `);
      fs.mkdirSync(path.join(dir, "server"), { recursive: true });
      fs.writeFileSync(path.join(dir, "drizzle.config.ts"), "export default {}\n");

      const result = await runVerifyAppCommand([dir, "--profile", "web-db-user", "--skip-install", "--skip-browser", "--port", "4296"]);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("E_VERIFY_GATE");
      expect(result.failedGate.name).toBe("start_route");
      expect(result.failedGate.output).toContain("API route returned HTML");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a browser smoke gate and fails on frontend console errors", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-browser-error-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "verify-browser-error",
        scripts: {
          start: "node server.mjs",
        },
      }, null, 2));
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, "server.mjs"), `
        import http from 'node:http';
        const port = Number(process.env.PORT || 0);
        const html = '<!doctype html><html><body><div id="root">App</div><script>console.error("BROKEN_BROWSER_SMOKE")</script></body></html>';
        const server = http.createServer((req, res) => {
          res.writeHead(200, { 'content-type': req.url === '/api/health' ? 'application/json' : 'text/html' });
          res.end(req.url === '/api/health' ? JSON.stringify({ ok: true }) : html);
        });
        server.listen(port);
      `);
      fs.mkdirSync(path.join(dir, "server"), { recursive: true });
      fs.writeFileSync(path.join(dir, "drizzle.config.ts"), "export default {}\n");

      const result = await runVerifyAppCommand([dir, "--profile", "web-db-user", "--skip-install", "--port", "4292"]);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("E_VERIFY_GATE");
      expect(result.failedGate.name).toBe("browser_smoke");
      expect(result.failedGate.output).toContain("BROKEN_BROWSER_SMOKE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("browser smoke fails when a visible Google OAuth button lands on redirect_uri_mismatch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-google-oauth-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "verify-google-oauth",
        scripts: {
          start: "node server.mjs",
        },
      }, null, 2));
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, "server.mjs"), `
        import http from 'node:http';
        const port = Number(process.env.PORT || 0);
        const html = '<!doctype html><html><body><div id="root"><button onclick="document.body.innerText=\\'redirect_uri_mismatch https://demo-ref.supabase.co/auth/v1/callback\\'">Continue with Google</button></div></body></html>';
        const server = http.createServer((req, res) => {
          res.writeHead(200, { 'content-type': req.url === '/api/health' ? 'application/json' : 'text/html' });
          res.end(req.url === '/api/health' ? JSON.stringify({ ok: true }) : html);
        });
        server.listen(port);
      `);
      fs.mkdirSync(path.join(dir, "server"), { recursive: true });
      fs.writeFileSync(path.join(dir, "drizzle.config.ts"), "export default {}\n");

      const result = await runVerifyAppCommand([dir, "--profile", "web-db-user", "--skip-install", "--port", "4297"]);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("E_VERIFY_GATE");
      expect(result.failedGate.name).toBe("browser_smoke");
      expect(result.failedGate.output).toContain("Google OAuth redirect_uri_mismatch detected");
      expect(result.failedGate.output).toContain("https://demo-ref.supabase.co/auth/v1/callback");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses an already-running server owned by the same project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-reuse-project-server-"));
    let child: ReturnType<typeof spawn> | null = null;
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "verify-reuse-project-server",
        scripts: { start: "node server.mjs" },
      }, null, 2));
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, "server.mjs"), `
        import http from 'node:http';
        const port = Number(process.env.PORT || 0);
        http.createServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><html><body><div id="root">Existing project server</div></body></html>');
        }).listen(port, '127.0.0.1');
      `);

      const port = await getFreePort();
      child = spawn(process.execPath, ["server.mjs"], {
        cwd: dir,
        env: { ...process.env, PORT: String(port) },
        stdio: "ignore",
      });
      await waitForUrl(`http://127.0.0.1:${port}/`);

      const result = await runVerifyAppCommand([dir, "--profile", "web-static", "--skip-install", "--skip-browser", "--port", String(port)]);

      expect(result.ok).toBe(true);
      const startGate = result.data.gates.find((gate: any) => gate.name === "start_route");
      expect(startGate.ok).toBe(true);
      expect(startGate.output).toContain("Reused existing project server");
    } finally {
      if (child?.pid) child.kill("SIGTERM");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to verify when the requested port is already occupied by another project", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-port-busy-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<!doctype html><html><body><div id="root">Stale unrelated server</div></body></html>');
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test server port");
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
        name: "verify-port-busy",
        scripts: { start: "node server.mjs" },
      }, null, 2));
      fs.mkdirSync(path.join(dir, "node_modules"));
      fs.writeFileSync(path.join(dir, "server.mjs"), "import http from 'node:http'; http.createServer((_req,res)=>res.end('new app')).listen(process.env.PORT);\n");

      const result = await runVerifyAppCommand([dir, "--profile", "web-static", "--skip-install", "--skip-browser", "--port", String(address.port)]);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("E_VERIFY_GATE");
      expect(result.failedGate.name).toBe("start_route");
      expect(result.failedGate.output).toContain("already in use");
      expect(result.failedGate.output).toContain("stale or unrelated server");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("placeholder scanner ignores node_modules and binary files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-scan-"));
    try {
      fs.mkdirSync(path.join(dir, "node_modules", "bad"), { recursive: true });
      fs.writeFileSync(path.join(dir, "node_modules", "bad", "package.json"), "{{project_name}}\n");
      fs.writeFileSync(path.join(dir, "image.bin"), Buffer.from([0, 123, 123]));
      fs.writeFileSync(path.join(dir, "index.html"), "<title>Clean</title>\n");

      expect(scanPlaceholders(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeCrawlerRoute(dir: string, route: string, options: { body: string; robots?: string; canonical?: string; title?: string; description?: string }): void {
  const publicDir = path.join(dir, "dist", "public");
  const routeDir = route === "/" ? publicDir : path.join(publicDir, route.replace(/^\//, ""));
  fs.mkdirSync(routeDir, { recursive: true });
  const canonical = options.canonical ?? `https://example.com${route === "/" ? "" : route}`;
  const title = options.title ?? (route === "/" ? "Home" : route.split("/").filter(Boolean).join(" "));
  const description = options.description ?? "A long enough public marketing description for crawler verification.";
  fs.writeFileSync(path.join(routeDir, "index.html"), `<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}"><link rel="canonical" href="${canonical}"><meta name="robots" content="${options.robots ?? "index,follow"}"></head><body><div id="root"><article data-jeriko-prerender="true">${options.body}</article></div></body></html>`);
}

function writeCrawlerSitemap(dir: string, routes: string[]): void {
  const publicDir = path.join(dir, "dist", "public");
  fs.mkdirSync(publicDir, { recursive: true });
  const urls = routes.map((route) => `<url><loc>https://example.com${route === "/" ? "" : route}</loc></url>`).join("\n");
  fs.writeFileSync(path.join(publicDir, "sitemap.xml"), `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`);
}

function writeCrawlerRobots(dir: string): void {
  const publicDir = path.join(dir, "dist", "public");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "robots.txt"), "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml\n");
}

async function getFreePort(): Promise<number> {
  const server = createServer((_req, res) => res.end("reserved"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing free port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForUrl(url: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function runVerifyAppCommand(args: string[]): Promise<any> {
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
    await verifyAppCommand.run(args);
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
