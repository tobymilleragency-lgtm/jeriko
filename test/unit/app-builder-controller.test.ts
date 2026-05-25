import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildProjectState, readProjectState, writeProjectState } from "../../src/cli/commands/dev/project-state.js";
import { initializeAppBuilderRun, recordAppBuilderPhase, recordAppBuilderVerificationFailure, resolveAppBuilderRepairAction } from "../../src/cli/commands/dev/app-builder-controller.js";

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
});
