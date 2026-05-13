import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";

import { command as verifyAppCommand, scanPlaceholders, inferAppProfile, defaultRouteForProfile, readProjectState, getDependencyStatus } from "../../src/cli/commands/dev/verify-app.js";
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
      expect(result.data.gates.map((gate: any) => gate.name)).toEqual(["placeholder_scan", "check", "build"]);
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
        verification: { requiredGates: ["placeholder_scan", "check", "build"] },
      }, null, 2));

      const result = await runVerifyAppCommand([dir, "--skip-install", "--skip-start"]);
      const state = readProjectState(dir);

      expect(result.ok).toBe(true);
      expect(state?.verification.lastSuccessfulVerification).toBeDefined();
      expect((state?.verification.lastSuccessfulVerification as any).ok).toBe(true);
      expect((state?.verification.lastSuccessfulVerification as any).profile).toBe("web-static");
      expect((state?.verification.lastSuccessfulVerification as any).gates.map((gate: any) => gate.name)).toEqual(["placeholder_scan", "check", "build"]);
      expect((state?.verification.lastSuccessfulVerification as any).completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect((state?.verification.lastSuccessfulVerification as any).command).toContain("verify-app");
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
        verification: { requiredGates: ["placeholder_scan", "install", "check", "build"] },
      }, null, 2));

      const result = await runVerifyAppCommand([dir, "--skip-install", "--skip-start"]);

      expect(result.ok).toBe(true);
      expect(result.data.dependencyStatus.nodeModules).toBe(true);
      expect(result.data.gates.map((gate: any) => gate.name)).toEqual(["placeholder_scan", "install", "check", "build"]);
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
        verification: { requiredGates: ["placeholder_scan", "install", "check"] },
      }, null, 2));

      const result = await runVerifyAppCommand([dir, "--skip-install", "--skip-start"]);

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("E_VERIFY_GATE");
      expect(result.failedGate.name).toBe("dependency_preflight");
      expect(result.failedGate.output).toContain("node_modules is still missing");
      expect(result.dependencyStatus.missingNodeModules).toBe(true);
      expect(result.gates.map((gate: any) => gate.name)).toEqual(["placeholder_scan", "install", "dependency_preflight"]);
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

  it("refuses to verify when the requested port is already occupied", async () => {
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
