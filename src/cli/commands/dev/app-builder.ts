import type { CommandHandler } from "../../dispatcher.js";
import { parseArgs, flagBool, flagStr } from "../../../shared/args.js";
import { fail, failWithDetails, ok } from "../../../shared/output.js";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readProjectState } from "./project-state.js";
import { buildWorkspaceStatus } from "../../../daemon/diagnostics/session.js";
import { runAppBuilderControlledRepair, type AppBuilderRepairTask, type AppBuilderVerificationResult } from "./app-builder-controller.js";

export const command: CommandHandler = {
  name: "app-builder",
  description: "Run controlled app-builder repair cycles and inspect app-builder state",
  async run(args: string[]) {
    const parsed = parseArgs(args);
    const subcommand = parsed.positional[0];
    if (flagBool(parsed, "help") || !subcommand) {
      printHelp();
      process.exit(0);
    }

    if (subcommand === "status") {
      const dir = resolve(parsed.positional[1] || flagStr(parsed, "dir", ""));
      requireDir(dir);
      const state = readProjectState(dir);
      if (!state?.appBuilderRun) failWithDetails("Project has no appBuilderRun state.", { errorCode: "E_APP_BUILDER_RUN_MISSING", directory: dir });
      const workspaceStatus = buildWorkspaceStatus({ cwd: dir, sessionId: "missing-session" });
      ok({ directory: dir, appBuilderStatus: workspaceStatus.appBuilderStatus, appBuilderRun: state.appBuilderRun, appBuilderPlan: state.appBuilderPlan });
    }

    if (subcommand === "run") {
      const dir = resolve(parsed.positional[1] || flagStr(parsed, "dir", ""));
      requireDir(dir);
      const maxRepairAttempts = Number.parseInt(flagStr(parsed, "max-repair-attempts", "2"), 10);
      const skipInstall = flagBool(parsed, "skip-install");
      const skipStart = flagBool(parsed, "skip-start");
      const skipBrowser = flagBool(parsed, "skip-browser");
      const profile = flagStr(parsed, "profile", "");
      const result = await runAppBuilderControlledRepair(dir, {
        maxRepairAttempts: Number.isFinite(maxRepairAttempts) ? maxRepairAttempts : 2,
        verify: () => runVerifyApp(dir, { skipInstall, skipStart, skipBrowser, profile }),
        repair: (task) => runAgentRepair(task),
      });
      if (result.ok) ok({ directory: dir, ...result });
      failWithDetails(result.blocker, { directory: dir, ...result }, 1);
    }

    fail(`Unknown app-builder subcommand: ${subcommand}`);
  },
};

function printHelp(): void {
  console.log("Usage: jeriko app-builder <status|run> <project-dir> [options]");
  console.log("");
  console.log("Subcommands:");
  console.log("  status <dir>                         Show appBuilderPlan/appBuilderRun state");
  console.log("  run <dir> [--max-repair-attempts N]   Verify, repair failed gates, and rerun verify");
  console.log("");
  console.log("Run options pass through to verify-app: --profile, --skip-install, --skip-start, --skip-browser");
}

function requireDir(dir: string): void {
  if (!dir || dir === resolve("")) fail("Missing project directory. Usage: jeriko app-builder <status|run> <project-dir>");
  if (!existsSync(dir)) failWithDetails(`Project directory not found: ${dir}`, { errorCode: "E_NOT_FOUND", directory: dir });
}

function runVerifyApp(dir: string, options: { skipInstall: boolean; skipStart: boolean; skipBrowser: boolean; profile: string }): AppBuilderVerificationResult {
  const args = ["--format", "json", "verify-app", dir];
  if (options.profile) args.push("--profile", options.profile);
  if (options.skipInstall) args.push("--skip-install");
  if (options.skipStart) args.push("--skip-start");
  if (options.skipBrowser) args.push("--skip-browser");
  const result = spawnSync("jeriko", args, { cwd: dir, encoding: "utf8", maxBuffer: 1024 * 1024 * 8 });
  const parsed = parseLastJsonLine(result.stdout);
  if (result.status === 0 && parsed?.ok) return { ok: true, output: result.stdout };
  const failedGate = parsed?.failedGate?.name
    ? { name: String(parsed.failedGate.name), output: String(parsed.failedGate.output ?? parsed.error ?? result.stdout ?? result.stderr ?? "") }
    : { name: String(parsed?.errorCode ?? "verify-app"), output: String(parsed?.error ?? result.stderr ?? result.stdout ?? "verify-app failed") };
  return { ok: false, failedGate, output: result.stdout || result.stderr };
}

function runAgentRepair(task: AppBuilderRepairTask): { ok: boolean; output?: string } {
  const result = spawnSync("jeriko", ["ask", task.prompt], { cwd: task.projectDir, encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
  return {
    ok: result.status === 0,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n"),
  };
}

function parseLastJsonLine(output: string): any | null {
  const line = output.trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
