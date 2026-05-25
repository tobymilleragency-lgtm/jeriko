import { readProjectState, writeProjectState, type AppBuilderActiveRepair, type AppBuilderLastVerification, type AppBuilderPhaseRun, type AppBuilderPhaseStatus, type AppBuilderRun, type ProjectState } from "./project-state.js";

export interface InitializeAppBuilderRunOptions {
  trigger?: string;
  now?: string;
}

export interface VerificationFailureInput {
  name: string;
  output?: string;
}

export interface AppBuilderVerificationResult {
  ok: boolean;
  output?: string;
  failedGate?: VerificationFailureInput;
}

export interface AppBuilderRepairTask {
  projectDir: string;
  failedGate: string;
  repairAction: string;
  attempt: number;
  maxRepairAttempts: number;
  prompt: string;
  verificationOutput?: string;
}

export interface AppBuilderRepairResult {
  ok: boolean;
  output?: string;
}

export interface RunAppBuilderControlledRepairOptions {
  maxRepairAttempts?: number;
  now?: () => string;
  verify: (attempt: number) => Promise<AppBuilderVerificationResult> | AppBuilderVerificationResult;
  repair: (task: AppBuilderRepairTask) => Promise<AppBuilderRepairResult> | AppBuilderRepairResult;
}

export type AppBuilderControlledRepairResult =
  | { ok: true; attempts: number; repairAttempts: number; run: AppBuilderRun }
  | { ok: false; errorCode: "E_APP_BUILDER_REPAIR_EXHAUSTED" | "E_APP_BUILDER_REPAIR_FAILED"; attempts: number; repairAttempts: number; blocker: string; run: AppBuilderRun };

export function initializeAppBuilderRun(dir: string, options: InitializeAppBuilderRunOptions = {}): AppBuilderRun {
  const state = requireProjectState(dir);
  const plan = state.appBuilderPlan;
  if (!plan || plan.mode !== "controlled-app-build" || !Array.isArray(plan.phases) || plan.phases.length === 0) {
    throw new Error("Project is missing a valid appBuilderPlan; cannot initialize app-builder run.");
  }
  const now = options.now ?? new Date().toISOString();
  const phases = plan.phases.map((phase, index): AppBuilderPhaseRun => ({
    id: phase.id,
    status: index === 0 ? "in_progress" : "pending",
    description: phase.description,
    requiredEvidence: [...phase.requiredEvidence],
    evidence: [],
    ...(index === 0 ? { startedAt: now } : {}),
  }));
  const run: AppBuilderRun = {
    status: "running",
    trigger: options.trigger ?? "manual",
    startedAt: now,
    updatedAt: now,
    currentPhaseId: phases[0]?.id ?? "",
    mandatorySkillsLoaded: [...plan.mandatorySkills],
    phases,
    failures: [],
  };
  writeProjectState(dir, { ...state, appBuilderRun: run });
  return run;
}

export function recordAppBuilderPhase(dir: string, phaseId: string, status: AppBuilderPhaseStatus, evidence: string[] = [], options: { now?: string } = {}): AppBuilderRun {
  const state = requireProjectState(dir);
  const existing = state.appBuilderRun ?? initializeRunFromState(state, options);
  const now = options.now ?? new Date().toISOString();
  const phases = existing.phases.map((phase) => {
    if (phase.id !== phaseId) return phase;
    return {
      ...phase,
      status,
      evidence: mergeEvidence(phase.evidence, evidence),
      ...(status === "completed" ? { completedAt: now } : {}),
      ...(status === "blocked" ? { blockedAt: now } : {}),
      ...(!phase.startedAt ? { startedAt: now } : {}),
    };
  });
  const blocked = status === "blocked";
  const nextPhaseId = blocked ? phaseId : nextRunnablePhaseId(phases);
  const advancedPhases = blocked ? phases : markCurrentPhaseInProgress(phases, nextPhaseId, now);
  const run: AppBuilderRun = {
    ...existing,
    status: blocked ? "blocked" : nextPhaseId ? "running" : "completed",
    updatedAt: now,
    currentPhaseId: nextPhaseId ?? phaseId,
    phases: advancedPhases,
  };
  writeProjectState(dir, { ...state, appBuilderRun: run });
  return run;
}

export function resolveAppBuilderRepairAction(projectState: ProjectState | null, failedGate: string): string {
  const routers = projectState?.appBuilderPlan?.repairRouters ?? [];
  const direct = routers.find((router) => router.failedGate === failedGate || router.failedGate === normalizeFailedGate(failedGate));
  if (direct?.action) return direct.action;
  const normalized = normalizeFailedGate(failedGate);
  const fallback = routers.find((router) => router.failedGate === normalized);
  if (fallback?.action) return fallback.action;
  return `Inspect failed gate ${failedGate}, fix the first concrete blocker, then rerun verify_app before reporting done.`;
}

export function recordAppBuilderVerificationFailure(dir: string, failedGate: VerificationFailureInput, options: { now?: string } = {}): AppBuilderRun {
  const state = requireProjectState(dir);
  const existing = state.appBuilderRun ?? initializeRunFromState(state, options);
  const now = options.now ?? new Date().toISOString();
  const repairAction = resolveAppBuilderRepairAction(state, failedGate.name);
  const failure = {
    failedGate: failedGate.name,
    output: failedGate.output,
    repairAction,
    recordedAt: now,
  };
  const phases = markCurrentPhaseInProgress(existing.phases, "repair", now).map((phase) => {
    if (phase.id !== "repair") return phase;
    return {
      ...phase,
      status: "blocked" as const,
      evidence: mergeEvidence(phase.evidence, [`failed gate: ${failedGate.name}`, repairAction]),
      blockedAt: now,
      startedAt: phase.startedAt ?? now,
    };
  });
  const run: AppBuilderRun = {
    ...existing,
    status: "blocked",
    updatedAt: now,
    currentPhaseId: "repair",
    phases,
    failures: [...existing.failures, failure],
  };
  writeProjectState(dir, { ...state, appBuilderRun: run });
  return run;
}

export async function runAppBuilderControlledRepair(dir: string, options: RunAppBuilderControlledRepairOptions): Promise<AppBuilderControlledRepairResult> {
  const maxRepairAttempts = Math.max(0, options.maxRepairAttempts ?? 2);
  const now = options.now ?? (() => new Date().toISOString());
  let state = requireProjectState(dir);
  let run = state.appBuilderRun ?? initializeRunFromState(state, { now: now(), trigger: "app-builder-run" });
  persistRun(dir, state, run);

  let verificationAttempts = 0;
  let repairAttempts = run.repairAttemptCount ?? 0;

  while (true) {
    verificationAttempts += 1;
    const verification = await options.verify(verificationAttempts);
    const verifiedAt = now();
    const lastVerification: AppBuilderLastVerification = verification.ok
      ? { ok: true, attempt: verificationAttempts, completedAt: verifiedAt, output: verification.output }
      : { ok: false, attempt: verificationAttempts, completedAt: verifiedAt, failedGate: verification.failedGate?.name ?? "unknown", output: verification.failedGate?.output ?? verification.output };

    state = requireProjectState(dir);
    run = state.appBuilderRun ?? run;
    run = { ...run, lastVerification, updatedAt: verifiedAt };

    if (verification.ok) {
      run = completeRepairCycleRun(run, verifiedAt, verification.output);
      persistRun(dir, state, run);
      return { ok: true, attempts: verificationAttempts, repairAttempts, run };
    }

    const failedGate = verification.failedGate ?? { name: "unknown", output: verification.output };
    const repairAction = resolveAppBuilderRepairAction(state, failedGate.name);
    const failure = { failedGate: failedGate.name, output: failedGate.output, repairAction, recordedAt: verifiedAt };
    run = {
      ...run,
      status: "blocked",
      currentPhaseId: "repair",
      failures: [...run.failures, failure],
      phases: markRepairPhase(run.phases, "blocked", verifiedAt, [`failed gate: ${failedGate.name}`, repairAction]),
      updatedAt: verifiedAt,
    };

    if (repairAttempts >= maxRepairAttempts) {
      const blocker = exactRepairBlocker(failedGate, repairAction, maxRepairAttempts);
      run = {
        ...run,
        activeRepair: run.activeRepair ? { ...run.activeRepair, status: "blocked", output: blocker } : undefined,
        updatedAt: verifiedAt,
      };
      persistRun(dir, state, run);
      return { ok: false, errorCode: "E_APP_BUILDER_REPAIR_EXHAUSTED", attempts: verificationAttempts, repairAttempts, blocker, run };
    }

    repairAttempts += 1;
    const task = buildRepairTask(dir, failedGate, repairAction, repairAttempts, maxRepairAttempts);
    const repairStartedAt = now();
    const activeRepair: AppBuilderActiveRepair = {
      status: "in_progress",
      attempt: repairAttempts,
      maxRepairAttempts,
      failedGate: failedGate.name,
      repairAction,
      prompt: task.prompt,
      startedAt: repairStartedAt,
    };
    run = {
      ...run,
      status: "running",
      currentPhaseId: "repair",
      repairAttemptCount: repairAttempts,
      activeRepair,
      phases: markRepairPhase(run.phases, "in_progress", repairStartedAt, [`repair attempt ${repairAttempts}/${maxRepairAttempts}`, repairAction]),
      updatedAt: repairStartedAt,
    };
    persistRun(dir, state, run);

    const repair = await options.repair(task);
    const repairCompletedAt = now();
    state = requireProjectState(dir);
    run = state.appBuilderRun ?? run;
    if (!repair.ok) {
      const blocker = `Repair attempt ${repairAttempts}/${maxRepairAttempts} failed for ${failedGate.name}: ${repair.output ?? "no repair output"}`;
      run = {
        ...run,
        status: "blocked",
        activeRepair: { ...activeRepair, status: "blocked", completedAt: repairCompletedAt, output: repair.output },
        phases: markRepairPhase(run.phases, "blocked", repairCompletedAt, [blocker]),
        updatedAt: repairCompletedAt,
      };
      persistRun(dir, state, run);
      return { ok: false, errorCode: "E_APP_BUILDER_REPAIR_FAILED", attempts: verificationAttempts, repairAttempts, blocker, run };
    }

    run = {
      ...run,
      status: "running",
      activeRepair: { ...activeRepair, status: "completed", completedAt: repairCompletedAt, output: repair.output },
      phases: markRepairPhase(run.phases, "completed", repairCompletedAt, [repair.output ?? "repair completed", "rerun verify-app"]),
      updatedAt: repairCompletedAt,
    };
    persistRun(dir, state, run);
  }
}

function requireProjectState(dir: string): ProjectState {
  const state = readProjectState(dir);
  if (!state) throw new Error(`Project state not found: ${dir}`);
  return state;
}

function initializeRunFromState(state: ProjectState, options: { now?: string; trigger?: string } = {}): AppBuilderRun {
  const plan = state.appBuilderPlan;
  if (!plan || plan.phases.length === 0) throw new Error("Project is missing appBuilderPlan phases.");
  const now = options.now ?? new Date().toISOString();
  const phases = plan.phases.map((phase, index): AppBuilderPhaseRun => ({
    id: phase.id,
    status: index === 0 ? "in_progress" : "pending",
    description: phase.description,
    requiredEvidence: [...phase.requiredEvidence],
    evidence: [],
    ...(index === 0 ? { startedAt: now } : {}),
  }));
  return {
    status: "running",
    trigger: options.trigger ?? "manual",
    startedAt: now,
    updatedAt: now,
    currentPhaseId: phases[0]?.id ?? "",
    mandatorySkillsLoaded: [...plan.mandatorySkills],
    phases,
    failures: [],
  };
}

function nextRunnablePhaseId(phases: AppBuilderPhaseRun[]): string | null {
  const next = phases.find((phase) => phase.status === "pending");
  return next?.id ?? null;
}

function markCurrentPhaseInProgress(phases: AppBuilderPhaseRun[], phaseId: string | null, now: string): AppBuilderPhaseRun[] {
  if (!phaseId) return phases;
  return phases.map((phase) => {
    if (phase.id !== phaseId || phase.status !== "pending") return phase;
    return { ...phase, status: "in_progress", startedAt: phase.startedAt ?? now };
  });
}

function markRepairPhase(phases: AppBuilderPhaseRun[], status: AppBuilderPhaseStatus, now: string, evidence: string[]): AppBuilderPhaseRun[] {
  return markCurrentPhaseInProgress(phases, "repair", now).map((phase) => {
    if (phase.id !== "repair") return phase;
    return {
      ...phase,
      status,
      evidence: mergeEvidence(phase.evidence, evidence),
      startedAt: phase.startedAt ?? now,
      ...(status === "completed" ? { completedAt: now } : {}),
      ...(status === "blocked" ? { blockedAt: now } : {}),
    };
  });
}

function completeRepairCycleRun(run: AppBuilderRun, now: string, output?: string): AppBuilderRun {
  const phases = run.phases.map((phase) => {
    if (phase.id === "verify") {
      return {
        ...phase,
        status: "completed" as const,
        evidence: mergeEvidence(phase.evidence, [output ?? "verify-app passed"]),
        startedAt: phase.startedAt ?? now,
        completedAt: now,
      };
    }
    if (phase.id === "repair" && (phase.status === "blocked" || phase.status === "in_progress")) {
      return {
        ...phase,
        status: "completed" as const,
        evidence: mergeEvidence(phase.evidence, ["repair cycle resolved by verification"]),
        startedAt: phase.startedAt ?? now,
        completedAt: phase.completedAt ?? now,
      };
    }
    return phase;
  });
  return {
    ...run,
    status: "completed",
    currentPhaseId: "verify",
    phases,
    activeRepair: run.activeRepair ? { ...run.activeRepair, status: "completed", completedAt: run.activeRepair.completedAt ?? now } : undefined,
    updatedAt: now,
  };
}

function buildRepairTask(dir: string, failedGate: VerificationFailureInput, repairAction: string, attempt: number, maxRepairAttempts: number): AppBuilderRepairTask {
  return {
    projectDir: dir,
    failedGate: failedGate.name,
    repairAction,
    attempt,
    maxRepairAttempts,
    verificationOutput: failedGate.output,
    prompt: [
      `You are repairing a Jeriko controlled app build in ${dir}.`,
      `Failed gate: ${failedGate.name}`,
      failedGate.output ? `Gate output: ${failedGate.output}` : "Gate output: not provided",
      `Repair action: ${repairAction}`,
      "Make the smallest concrete source changes needed for this gate.",
      "Do not claim done. After repairing, rerun verify-app and report exact evidence or blocker.",
    ].join("\n"),
  };
}

function exactRepairBlocker(failedGate: VerificationFailureInput, repairAction: string, maxRepairAttempts: number): string {
  const output = failedGate.output ? ` Output: ${failedGate.output}` : "";
  return `App-builder repair exhausted after ${maxRepairAttempts} attempt(s). Failed gate: ${failedGate.name}.${output} Required repair action: ${repairAction}`;
}

function persistRun(dir: string, state: ProjectState, run: AppBuilderRun): void {
  writeProjectState(dir, { ...state, appBuilderRun: run });
}

function mergeEvidence(existing: string[], next: string[]): string[] {
  return Array.from(new Set([...existing, ...next].filter((item) => item.trim().length > 0)));
}

function normalizeFailedGate(failedGate: string): string {
  if (failedGate === "test" || failedGate === "check" || failedGate === "build") return failedGate;
  if (failedGate.endsWith("_scan") || failedGate.endsWith("_contract") || failedGate.endsWith("_verifier")) return failedGate;
  return failedGate;
}
