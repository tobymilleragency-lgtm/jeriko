// Tool — Shell execution via the exec gateway.

import { registerTool } from "./registry.js";
import { createLease, validateLease } from "../../exec/lease.js";
import { auditAllow, auditDeny } from "../../exec/audit.js";
import type { ToolDefinition } from "./registry.js";
import { spawn } from "node:child_process";
import { detectSnapshotIntegrityProblems, restoreSnapshotFiles, snapshotCodeFiles } from "./code-integrity-guard.js";
import { generatedCopyMutationBlock, isReadOnlyShellCommand } from "./generated-copy-guard.js";

function malformedPackageManagerViteArgs(command: string): { ok: false; guard: string; error: string; suggestedCommand: string } | null {
  if (!/\b(?:pnpm|npm|yarn|bun)\s+run\s+dev\s+--\s+--host\b/.test(command)) return null;
  const host = command.match(/--host\s+([^\s;&|]+)/)?.[1] ?? "127.0.0.1";
  const port = command.match(/--port\s+(\d+)/)?.[1] ?? "6001";
  return {
    ok: false,
    guard: "malformed_vite_dev_command",
    error: "Refusing malformed Vite dev command. `pnpm/npm/yarn/bun run dev -- --host ... --port ...` passes a literal `--` through to Vite in generated projects, so Vite ignores the intended port and falls back to 3000/3001/3002/3003. Start Vite directly or use the webdev restart tool.",
    suggestedCommand: `pnpm exec vite --host ${host} --port ${port} --strictPort`,
  };
}

async function execute(args: Record<string, unknown>): Promise<string> {
  const command = args.command as string;
  const timeout = (args.timeout as number) ?? 30_000;
  const cwd = (args.cwd as string) ?? process.cwd();

  if (!command) return JSON.stringify({ ok: false, error: "command is required" });

  const malformedViteArgs = malformedPackageManagerViteArgs(command);
  if (malformedViteArgs) return JSON.stringify(malformedViteArgs);

  if (!isReadOnlyShellCommand(command)) {
    const generatedCopyBlock = generatedCopyMutationBlock({
      cwd,
      projectSearchRoot: typeof args.project_search_root === "string" ? args.project_search_root : undefined,
      confirmation: args.__jeriko_generated_copy_edit_confirmation,
    });
    if (generatedCopyBlock) return JSON.stringify(generatedCopyBlock);
  }

  const lease = createLease("agent:daemon", command, { timeout });
  const decision = validateLease(lease);

  if (!decision.allowed) {
    auditDeny(lease, decision.lease_id, decision.reason);
    return JSON.stringify({ ok: false, error: decision.reason });
  }

  auditAllow(lease, decision.lease_id);
  const snapshot = await snapshotCodeFiles(cwd);

  return new Promise<string>((resolve) => {
    const proc = spawn("bash", ["-c", command], {
      cwd,
      detached: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const MAX_CAPTURE = 110_000; // cap accumulation during streaming
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let forceFinishTimer: ReturnType<typeof setTimeout> | null = null;

    const killProcessGroup = (signal: NodeJS.Signals) => {
      if (!proc.pid) return;
      try { process.kill(-proc.pid, signal); }
      catch { try { proc.kill(signal); } catch { /* already gone */ } }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      stderr += `\n[timeout]\nCommand exceeded timeout of ${timeout}ms and was terminated.`;
      killProcessGroup("SIGTERM");
      forceFinishTimer = setTimeout(() => {
        killProcessGroup("SIGKILL");
        void finish(null);
      }, 2_000);
    }, timeout);

    async function finish(code: number | null): Promise<void> {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceFinishTimer) clearTimeout(forceFinishTimer);
      const output = stdout + (stderr ? `\n[stderr]\n${stderr}` : "")
        + (truncated ? "\n[output truncated]" : "");
      try {
        const problems = await detectSnapshotIntegrityProblems(snapshot);
        if (problems.length > 0) {
          const paths = problems.map((problem) => problem.path);
          await restoreSnapshotFiles(snapshot.files, paths);
          resolve(JSON.stringify({
            ok: false,
            guard: "code_integrity",
            error: "Shell command introduced duplicate function implementations; changed code files were restored.",
            restored: paths,
            problems: problems.map((problem) => ({ path: problem.path, duplicates: problem.duplicates, error: problem.error })),
            command_exit_code: code ?? 0,
            output: output.slice(0, 20_000),
          }));
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolve(JSON.stringify({ ok: false, guard: "code_integrity", error: msg, output: output.slice(0, 20_000) }));
        return;
      }
      if (timedOut) {
        resolve(JSON.stringify({ ok: false, error: `Command timed out after ${timeout}ms`, output: output.slice(0, 100_000) }));
        return;
      }
      resolve(output.slice(0, 100_000) || `(exit code ${code ?? 0})`);
    }

    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + stderr.length < MAX_CAPTURE) {
        stdout += chunk.toString().slice(0, MAX_CAPTURE - stdout.length - stderr.length);
      } else { truncated = true; }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (stdout.length + stderr.length < MAX_CAPTURE) {
        stderr += chunk.toString().slice(0, MAX_CAPTURE - stdout.length - stderr.length);
      } else { truncated = true; }
    });

    proc.on("close", (code) => {
      void finish(code);
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceFinishTimer) clearTimeout(forceFinishTimer);
      resolve(JSON.stringify({ ok: false, error: err.message }));
    });
  });
}

export const bashTool: ToolDefinition = {
  id: "bash",
  name: "bash",
  description: "Execute a shell command via bash. Returns stdout/stderr.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
      cwd: { type: "string", description: "Working directory (default: process cwd)" },
    },
    required: ["command"],
  },
  execute,
  // AGENT.md references "exec: <command>" as a CLI command. OSS models
  // confuse CLI command names with tool names and call "exec" instead of "bash".
  aliases: ["exec", "shell", "run", "execute", "run_command", "terminal"],
};

registerTool(bashTool);
