import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { command as appBuilderCommand } from "../../src/cli/commands/dev/app-builder.js";
import { buildProjectState, writeProjectState } from "../../src/cli/commands/dev/project-state.js";
import { setOutputFormat } from "../../src/shared/output.js";

describe("app-builder command", () => {
  it("status returns UI-ready app-builder status summary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-app-builder-command-status-"));
    try {
      const state = buildProjectState({ name: "command-visible-app", template: "web-static", profile: "web-static", prompt: "Build a contractor website", seoProfile: "local-service" });
      writeProjectState(dir, {
        ...state,
        appBuilderRun: {
          status: "blocked",
          trigger: "app-builder-run",
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          currentPhaseId: "repair",
          mandatorySkillsLoaded: ["operator-build-discipline"],
          repairAttemptCount: 1,
          lastVerification: { ok: false, attempt: 2, completedAt: "2026-01-01T00:01:00.000Z", failedGate: "build", output: "compile error" },
          activeRepair: { status: "blocked", attempt: 1, maxRepairAttempts: 1, failedGate: "build", repairAction: "Fix compiler error.", prompt: "repair", startedAt: "2026-01-01T00:01:00.000Z" },
          phases: state.appBuilderPlan!.phases.map((phase) => ({ ...phase, status: phase.id === "repair" ? "blocked" : "pending", evidence: [] })),
          failures: [{ failedGate: "build", output: "compile error", repairAction: "Fix compiler error.", recordedAt: "2026-01-01T00:01:00.000Z" }],
        },
      });

      const result = await runAppBuilderCommand(["status", dir]);

      expect(result.ok).toBe(true);
      expect(result.data.appBuilderStatus).toEqual(expect.objectContaining({
        status: "blocked",
        failedGate: "build",
        repairAction: "Fix compiler error.",
      }));
      expect(result.data.appBuilderStatus.attempts).toEqual({ repair: 1, maxRepairAttempts: 1, lastVerification: 2 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("status initializes run state from legacy control plans that only store phase ids", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jeriko-app-builder-command-status-legacy-"));
    try {
      const state = buildProjectState({ name: "legacy-plan-app", template: "web-static", profile: "web-static", prompt: "Build a contractor website", seoProfile: "local-service" });
      writeProjectState(dir, {
        ...state,
        appBuilderPlan: {
          mode: "controlled-app-build",
          mandatorySkills: state.appBuilderPlan!.mandatorySkills,
          phases: state.appBuilderPlan!.phases.map((phase) => ({ id: phase.id, status: "complete" })) as any,
          repairRouters: state.appBuilderPlan!.repairRouters,
        },
      });

      const result = await runAppBuilderCommand(["status", dir]);
      const stored = JSON.parse(fs.readFileSync(path.join(dir, ".jeriko", "project-state.json"), "utf8"));

      expect(result.ok).toBe(true);
      expect(result.data.appBuilderRun.status).toBe("completed");
      expect(result.data.appBuilderRun.currentPhaseId).toBe("evidence-report");
      expect(result.data.appBuilderRun.phases[0]).toEqual(expect.objectContaining({ id: "target-lock", status: "completed", requiredEvidence: [] }));
      expect(stored.appBuilderRun.phases[0].requiredEvidence).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function runAppBuilderCommand(args: string[]): Promise<any> {
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
    await appBuilderCommand.run(args);
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
