import { readProjectState, writeProjectState, type AppBuilderPhaseRun, type AppBuilderPhaseStatus, type AppBuilderRun, type ProjectState } from "./project-state.js";

export interface InitializeAppBuilderRunOptions {
  trigger?: string;
  now?: string;
}

export interface VerificationFailureInput {
  name: string;
  output?: string;
}

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

function mergeEvidence(existing: string[], next: string[]): string[] {
  return Array.from(new Set([...existing, ...next].filter((item) => item.trim().length > 0)));
}

function normalizeFailedGate(failedGate: string): string {
  if (failedGate === "test" || failedGate === "check" || failedGate === "build") return failedGate;
  if (failedGate.endsWith("_scan") || failedGate.endsWith("_contract") || failedGate.endsWith("_verifier")) return failedGate;
  return failedGate;
}
