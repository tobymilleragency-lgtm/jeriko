import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { command as verifyAppCommand, scanPlaceholders, inferAppProfile, defaultRouteForProfile } from "../../src/cli/commands/dev/verify-app.js";
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

  it("infers web-db-user profile when server and drizzle files exist", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-verify-profile-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
      fs.mkdirSync(path.join(dir, "server"), { recursive: true });
      fs.writeFileSync(path.join(dir, "drizzle.config.ts"), "export default {}\n");

      expect(inferAppProfile(dir)).toBe("web-db-user");
      expect(defaultRouteForProfile("web-db-user")).toBe("/api/health");
      expect(defaultRouteForProfile("web-static")).toBe("/");
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
      fs.writeFileSync(path.join(dir, "server.mjs"), `
        import http from 'node:http';
        const port = Number(process.env.PORT || 0);
        const server = http.createServer((req, res) => {
          if (req.url === '/api/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(404);
          res.end('not found');
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
