import { registerTool } from "./registry.js";
import type { ToolDefinition } from "./registry.js";
import { buildWorkspaceStatus } from "../../diagnostics/session.js";

async function execute(args: Record<string, unknown>): Promise<string> {
  const cwd = typeof args.cwd === "string" ? args.cwd : typeof args.project_path === "string" ? args.project_path : process.cwd();
  const sessionId = typeof args.session_id === "string" ? args.session_id : undefined;
  const limit = typeof args.limit === "number" ? args.limit : 80;
  return JSON.stringify(buildWorkspaceStatus({ cwd, sessionId, limit }), null, 2);
}

export const workspaceStatusTool: ToolDefinition = {
  id: "workspace_status",
  name: "workspace_status",
  description: "Get a compact project/session situation report: git changed files, diff stat, recent tool calls, recent verification commands/results, and latest browser result. Use this instead of repeatedly rereading files after edits or verification.",
  parameters: {
    type: "object",
    properties: {
      cwd: { type: "string", description: "Project directory to inspect. Defaults to current daemon cwd." },
      project_path: { type: "string", description: "Alias for cwd." },
      session_id: { type: "string", description: "Optional session ID/slug. Defaults to latest updated session." },
      limit: { type: "number", description: "Recent part rows to inspect. Default 80." },
    },
  },
  execute,
  aliases: ["status_report", "situation_report"],
};

registerTool(workspaceStatusTool);
