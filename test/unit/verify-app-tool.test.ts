import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyAppTool } from "../../src/daemon/agent/tools/verify-app.js";

let tempDirs: string[] = [];

afterEach(() => {
  delete process.env.JERIKO_BIN;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("verify_app agent tool", () => {
  test("runs jeriko verify-app with app-factory gates and returns JSON", async () => {
    const root = tempDir("jeriko-verify-tool-");
    const app = join(root, "app");
    mkdirSync(app);
    const bin = join(root, "fake-jeriko");
    writeFileSync(bin, `#!/usr/bin/env bash\nprintf '%s\n' "$*" > ${JSON.stringify(join(root, "argv.txt"))}\nprintf '{"ok":true,"data":{"gates":[{"name":"browser_smoke","ok":true}]}}\\n'\n`);
    chmodSync(bin, 0o755);
    process.env.JERIKO_BIN = bin;

    const raw = await verifyAppTool.execute({ dir: app, profile: "web-db-user", port: "4555" });
    const result = JSON.parse(raw);

    expect(result.ok).toBe(true);
    expect(result.data.gates[0].name).toBe("browser_smoke");
  });

  test("requires dir or project", async () => {
    const raw = await verifyAppTool.execute({});
    const result = JSON.parse(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("dir or project is required");
  });
});
