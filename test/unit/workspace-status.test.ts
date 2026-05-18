import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildWorkspaceStatus } from "../../src/daemon/diagnostics/session.js";

describe("workspace status project-state", () => {
  it("includes .jeriko/project-state.json when present", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-workspace-state-"));
    try {
      fs.mkdirSync(path.join(dir, ".jeriko"));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "state-app" }));
      fs.writeFileSync(path.join(dir, ".jeriko", "project-state.json"), JSON.stringify({
        name: "State App",
        template: "web-db-user",
        profile: "web-db-user",
        packageManager: "pnpm",
        commands: { install: "pnpm install --frozen-lockfile --ignore-scripts", check: "pnpm run check", build: "pnpm run build" },
        routes: { home: "/", health: "/api/health" },
      }));

      const status = buildWorkspaceStatus({ cwd: dir, sessionId: "missing-session" });

      expect((status.projectState as any).profile).toBe("web-db-user");
      expect((status.projectState as any).routes.health).toBe("/api/health");
      expect((status.projectState as any).commands.build).toBe("pnpm run build");
      expect((status.dependencyStatus as any).missingNodeModules).toBe(true);
      expect((status.dependencyStatus as any).message).toContain("node_modules missing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports stale verification when source files changed after the last successful verify-app run", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-workspace-stale-"));
    try {
      fs.mkdirSync(path.join(dir, ".jeriko"));
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "stale-app" }));
      fs.writeFileSync(path.join(dir, "src", "App.tsx"), "export const version = 1;\n");
      fs.writeFileSync(path.join(dir, ".jeriko", "project-state.json"), JSON.stringify({
        version: 1,
        name: "stale-app",
        template: "web-static",
        profile: "web-static",
        packageManager: "pnpm",
        generatedAt: "2026-01-01T00:00:00.000Z",
        commands: { check: "pnpm run check", build: "pnpm run build" },
        routes: { home: "/" },
        verification: {
          requiredGates: ["placeholder_scan", "unsafe_env_scan", "check", "build"],
          lastSuccessfulVerification: {
            ok: true,
            profile: "web-static",
            completedAt: "2026-01-01T00:00:00.000Z",
            command: "jeriko verify-app /tmp/stale-app",
            gates: [{ name: "check", ok: true }],
            sourceFingerprint: { sha256: "0".repeat(64), fileCount: 2 },
          },
        },
      }, null, 2));

      const status = buildWorkspaceStatus({ cwd: dir, sessionId: "missing-session" });

      expect((status.verificationStatus as any).hasSuccessfulVerification).toBe(true);
      expect((status.verificationStatus as any).fresh).toBe(false);
      expect((status.verificationStatus as any).reason).toContain("source fingerprint changed");
      expect((status.verificationStatus as any).currentSourceFingerprint.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((status.verificationStatus as any).verifiedSourceFingerprint.sha256).toBe("0".repeat(64));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
