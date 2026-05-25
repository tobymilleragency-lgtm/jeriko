import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { spawnSync } from "node:child_process";

import { buildProjectState, writeProjectState } from "../../src/cli/commands/dev/project-state.js";
import { buildWorkspaceStatus } from "../../src/daemon/diagnostics/session.js";

function git(dir: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
}

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

  it("flags a generated project copy when another local repo has the same Git remote", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-workspace-target-"));
    const generated = path.join(root, ".jeriko", "projects", "relax-remodel-consulting");
    const realRepo = path.join(root, "relax-remodel-consulting-site");
    try {
      fs.mkdirSync(generated, { recursive: true });
      fs.mkdirSync(realRepo, { recursive: true });
      fs.writeFileSync(path.join(generated, "package.json"), JSON.stringify({ name: "relax-remodel-consulting" }));
      fs.writeFileSync(path.join(realRepo, "package.json"), JSON.stringify({ name: "relax-remodel-consulting" }));
      for (const dir of [generated, realRepo]) {
        git(dir, ["init"]);
        git(dir, ["remote", "add", "origin", "https://github.com/tobymilleragency-lgtm/relax-remodel-consulting-site.git"]);
      }

      const status = buildWorkspaceStatus({ cwd: generated, sessionId: "missing-session", projectSearchRoot: root });

      expect((status.workspaceTarget as any).classification).toBe("generated_copy_with_real_repo_match");
      expect((status.workspaceTarget as any).generatedCopyPath).toBe(generated);
      expect((status.workspaceTarget as any).realRepoPath).toBe(realRepo);
      expect((status.workspaceTarget as any).warning).toContain("real local repo with the same git remote");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
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

  it("surfaces app-builder run visibility for daemon and UI status panels", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-workspace-app-builder-status-"));
    try {
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "repair-visible-app" }));
      const state = buildProjectState({
        name: "repair-visible-app",
        template: "web-static",
        profile: "web-static",
        prompt: "Build a contractor website with services and service areas.",
        seoProfile: "local-service",
      });
      writeProjectState(dir, {
        ...state,
        appBuilderRun: {
          status: "blocked",
          trigger: "app-builder-run",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:03:00.000Z",
          currentPhaseId: "repair",
          mandatorySkillsLoaded: ["operator-build-discipline", "contractor-site-autonomous-build"],
          repairAttemptCount: 2,
          lastVerification: {
            ok: false,
            attempt: 3,
            completedAt: "2026-01-01T00:03:00.000Z",
            failedGate: "premium_marketing_site_scan",
            output: "Missing premium conversion modules",
          },
          activeRepair: {
            status: "blocked",
            attempt: 2,
            maxRepairAttempts: 2,
            failedGate: "premium_marketing_site_scan",
            repairAction: "Restore premium conversion modules.",
            prompt: "repair prompt",
            startedAt: "2026-01-01T00:02:00.000Z",
            output: "still missing conversion modules",
          },
          phases: state.appBuilderPlan!.phases.map((phase) => ({
            id: phase.id,
            status: phase.id === "repair" ? "blocked" : phase.id === "verify" ? "completed" : "pending",
            description: phase.description,
            requiredEvidence: phase.requiredEvidence,
            evidence: phase.id === "repair" ? ["failed gate: premium_marketing_site_scan"] : [],
          })),
          failures: [{
            failedGate: "premium_marketing_site_scan",
            output: "Missing premium conversion modules",
            repairAction: "Restore premium conversion modules.",
            recordedAt: "2026-01-01T00:03:00.000Z",
          }],
        },
      });

      const status = buildWorkspaceStatus({ cwd: dir, sessionId: "missing-session" });
      const appBuilder = status.appBuilderStatus as any;

      expect(appBuilder.status).toBe("blocked");
      expect(appBuilder.currentPhase.id).toBe("repair");
      expect(appBuilder.failedGate).toBe("premium_marketing_site_scan");
      expect(appBuilder.repairAction).toBe("Restore premium conversion modules.");
      expect(appBuilder.attempts).toEqual({ repair: 2, maxRepairAttempts: 2, lastVerification: 3 });
      expect(appBuilder.lastVerification).toEqual(expect.objectContaining({ ok: false, failedGate: "premium_marketing_site_scan" }));
      expect(appBuilder.preview).toEqual(expect.objectContaining({ captured: false, url: null }));
      expect(appBuilder.checkpoint).toEqual(expect.objectContaining({ captured: false, hash: null }));
      expect(appBuilder.phases.find((phase: any) => phase.id === "repair")).toEqual(expect.objectContaining({ status: "blocked" }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
