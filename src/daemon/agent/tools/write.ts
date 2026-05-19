// Tool — Write file contents.

import { registerTool } from "./registry.js";
import { isPathBlocked } from "../../security/index.js";
import type { ToolDefinition } from "./registry.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validateCodeIntegrity } from "./code-integrity-guard.js";
import { generatedCopyMutationBlock, resolveAgainstCwd } from "./generated-copy-guard.js";

async function execute(args: Record<string, unknown>): Promise<string> {
  const filePath = args.file_path as string;
  const content = args.content as string;
  const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();

  if (!filePath) return JSON.stringify({ ok: false, error: "file_path is required" });
  if (content === undefined || content === null) {
    return JSON.stringify({ ok: false, error: "content is required" });
  }

  const absPath = resolveAgainstCwd(cwd, filePath);

  const generatedCopyBlock = generatedCopyMutationBlock({
    cwd,
    targetPath: absPath,
    projectSearchRoot: typeof args.project_search_root === "string" ? args.project_search_root : undefined,
    confirmation: args.__jeriko_generated_copy_edit_confirmation,
  });
  if (generatedCopyBlock) return JSON.stringify(generatedCopyBlock);

  const blocked = isPathBlocked(absPath);
  if (blocked.blocked) {
    return JSON.stringify({ ok: false, error: `Path is blocked by security policy: ${absPath}` });
  }

  try {
    let before: string | null = null;
    try {
      before = await readFile(absPath, "utf-8");
    } catch {
      before = null;
    }
    const integrityProblem = validateCodeIntegrity(absPath, before, content);
    if (integrityProblem) {
      return JSON.stringify({ ...integrityProblem, guard: "code_integrity" });
    }

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, "utf-8");
    return JSON.stringify({ ok: true, path: absPath, bytes: Buffer.byteLength(content) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ ok: false, error: msg });
  }
}

export const writeTool: ToolDefinition = {
  id: "write_file",
  name: "write_file",
  description: "Write content to a file. Creates parent directories if needed.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path to the file to write" },
      cwd: { type: "string", description: "Working directory for resolving relative file_path values" },
      content: { type: "string", description: "The content to write" },
    },
    required: ["file_path", "content"],
  },
  execute,
  aliases: ["write", "create_file", "save_file"],
};

registerTool(writeTool);
