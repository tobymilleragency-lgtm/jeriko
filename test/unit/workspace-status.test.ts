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
});
