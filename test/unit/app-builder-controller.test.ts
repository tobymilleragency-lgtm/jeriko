import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildProjectState, readProjectState, writeProjectState } from "../../src/cli/commands/dev/project-state.js";
import { initializeAppBuilderRun, recordAppBuilderPhase, recordAppBuilderVerificationFailure, resolveAppBuilderRepairAction, runAppBuilderControlledRepair } from "../../src/cli/commands/dev/app-builder-controller.js";

describe("app-builder controller", () => {
  it("initializes executable phase state from the appBuilderPlan", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-builder-controller-"));
    try {
      writeProjectState(dir, buildProjectState({
        name: "brothers-remodeling-okc",
        template: "web-static",
        profile: "web-static",
        prompt: "Build a complete contractor website for Brothers Remodeling OKC with services, service areas, process, projects, reviews, FAQ, contact, privacy, and terms.",
        seoProfile: "local-service",
      }));

      const run = initializeAppBuilderRun(dir, { trigger: "create" });
      const state = readProjectState(dir);

      expect(run.status).toBe("running");
      expect(run.currentPhaseId).toBe("target-lock");
      expect(run.phases.map((phase) => phase.id)).toEqual(state?.appBuilderPlan?.phases.map((phase) => phase.id));
      expect(run.phases[0]).toEqual(expect.objectContaining({ id: "target-lock", status: "in_progress" }));
      expect(run.phases.slice(1).every((phase) => phase.status === "pending")).toBe(true);
      expect(state?.appBuilderRun?.mandatorySkillsLoaded).toEqual(expect.arrayContaining(["operator-build-discipline", "contractor-site-autonomous-build"]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records phase evidence and advances the next pending phase", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-builder-controller-phase-"));
    try {
      writeProjectState(dir, buildProjectState({ name: "field-app", template: "web-db-user", profile: "web-db-user", prompt: "Build a field inventory scanner app." }));
      initializeAppBuilderRun(dir, { trigger: "create" });

      const updated = recordAppBuilderPhase(dir, "target-lock", "completed", ["directory locked", "project-state written"]);

      expect(updated.currentPhaseId).toBe("skill-bind");
      expect(updated.phases.find((phase) => phase.id === "target-lock")).toEqual(expect.objectContaining({
        status: "completed",
        evidence: ["directory locked", "project-state written"],
      }));
      expect(updated.phases.find((phase) => phase.id === "skill-bind")?.status).toBe("in_progress");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps failed verify gates to deterministic repair actions and records blocked repair state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-builder-controller-repair-"));
    try {
      writeProjectState(dir, buildProjectState({ name: "contractor-site", template: "web-static", profile: "web-static", prompt: "Build a contractor website with services and service areas", seoProfile: "local-service" }));
      initializeAppBuilderRun(dir, { trigger: "create" });

      const action = resolveAppBuilderRepairAction(readProjectState(dir), "premium_marketing_site_scan");
      const run = recordAppBuilderVerificationFailure(dir, { name: "premium_marketing_site_scan", output: "Missing premium conversion modules" });

      expect(action).toContain("premium");
      expect(run.status).toBe("blocked");
      expect(run.currentPhaseId).toBe("repair");
      expect(run.failures.at(-1)).toEqual(expect.objectContaining({
        failedGate: "premium_marketing_site_scan",
        repairAction: expect.stringContaining("premium"),
      }));
      expect(run.phases.find((phase) => phase.id === "repair")?.status).toBe("blocked");
      expect(readProjectState(dir)?.appBuilderRun?.failures.at(-1)?.output).toContain("Missing premium conversion modules");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("performs a bounded repair cycle, reruns verification, and records visible repair state", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-builder-controller-cycle-"));
    try {
      writeProjectState(dir, buildProjectState({ name: "contractor-site", template: "web-static", profile: "web-static", prompt: "Build a contractor website with services and service areas", seoProfile: "local-service" }));
      initializeAppBuilderRun(dir, { trigger: "create" });
      const repairTasks: any[] = [];
      let verifyCalls = 0;

      const result = await runAppBuilderControlledRepair(dir, {
        maxRepairAttempts: 2,
        verify: async () => {
          verifyCalls += 1;
          if (verifyCalls === 1) {
            return { ok: false, failedGate: { name: "premium_marketing_site_scan", output: "Missing premium conversion modules" } };
          }
          return { ok: true, output: "VERIFY_OK" };
        },
        repair: async (task) => {
          repairTasks.push(task);
          return { ok: true, output: "patched premium modules" };
        },
      });

      const state = readProjectState(dir);
      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(2);
      expect(repairTasks).toHaveLength(1);
      expect(repairTasks[0]).toEqual(expect.objectContaining({
        projectDir: dir,
        failedGate: "premium_marketing_site_scan",
        attempt: 1,
        maxRepairAttempts: 2,
      }));
      expect(repairTasks[0].repairAction).toContain("premium");
      expect(repairTasks[0].prompt).toContain("rerun verify-app");
      expect(state?.appBuilderRun?.status).toBe("completed");
      expect(state?.appBuilderRun?.repairAttemptCount).toBe(1);
      expect(state?.appBuilderRun?.lastVerification).toEqual(expect.objectContaining({ ok: true, attempt: 2 }));
      expect(state?.appBuilderRun?.activeRepair).toEqual(expect.objectContaining({ status: "completed", failedGate: "premium_marketing_site_scan" }));
      expect(state?.appBuilderRun?.phases.find((phase) => phase.id === "verify")?.status).toBe("completed");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats no-progress child repair output as a failed repair even when the process exits zero", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-builder-controller-no-progress-"));
    try {
      writeProjectState(dir, buildProjectState({ name: "blocked-repair-app", template: "web-db-user", profile: "web-db-user", prompt: "Build an inventory scanner app." }));
      initializeAppBuilderRun(dir, { trigger: "create" });

      const result = await runAppBuilderControlledRepair(dir, {
        maxRepairAttempts: 1,
        verify: async () => ({ ok: false, failedGate: { name: "db_auth_workflow_wiring", output: "Missing durable auth workflow" } }),
        repair: async () => ({ ok: true, output: "No-progress guard stopped the run.\nRepeated no-progress tool round blocked after 3 matching rounds.\nWhat Jeriko did not finish / did not prove:\n- latest verify_app result was not fully green\n- db_auth_workflow_wiring: FAILED" }),
      });

      const state = readProjectState(dir);
      expect(result.ok).toBe(false);
      const failedResult = result as Extract<typeof result, { ok: false }>;
      expect(failedResult.errorCode).toBe("E_APP_BUILDER_REPAIR_FAILED");
      expect(failedResult.blocker).toContain("No-progress guard stopped");
      expect(state?.appBuilderRun?.status).toBe("blocked");
      expect(state?.appBuilderRun?.activeRepair).toEqual(expect.objectContaining({ status: "blocked", failedGate: "db_auth_workflow_wiring", attempt: 1 }));
      expect(state?.appBuilderRun?.phases.find((phase) => phase.id === "repair")?.status).toBe("blocked");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops after max repair attempts with an exact blocker and persisted failed gate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-builder-controller-blocked-"));
    try {
      writeProjectState(dir, buildProjectState({ name: "inventory-app", template: "web-db-user", profile: "web-db-user", prompt: "Build an inventory scanner app." }));
      initializeAppBuilderRun(dir, { trigger: "create" });

      const result = await runAppBuilderControlledRepair(dir, {
        maxRepairAttempts: 1,
        verify: async () => ({ ok: false, failedGate: { name: "build", output: "TypeScript compile error" } }),
        repair: async () => ({ ok: true, output: "attempted compiler fix" }),
      });

      const state = readProjectState(dir);
      expect(result.ok).toBe(false);
      const failedResult = result as Extract<typeof result, { ok: false }>;
      expect(failedResult.errorCode).toBe("E_APP_BUILDER_REPAIR_EXHAUSTED");
      expect(failedResult.blocker).toContain("build");
      expect(failedResult.blocker).toContain("TypeScript compile error");
      expect(state?.appBuilderRun?.status).toBe("blocked");
      expect(state?.appBuilderRun?.repairAttemptCount).toBe(1);
      expect(state?.appBuilderRun?.lastVerification).toEqual(expect.objectContaining({ ok: false, failedGate: "build" }));
      expect(state?.appBuilderRun?.activeRepair).toEqual(expect.objectContaining({ status: "blocked", failedGate: "build", attempt: 1 }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
