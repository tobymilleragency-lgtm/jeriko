import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { detectWorkspaceTarget } from "../../diagnostics/session.js";

export const GENERATED_COPY_EDIT_CONFIRMATION = "I confirm this generated copy is the intended edit target.";

interface GuardOptions {
  cwd: string;
  targetPath?: string;
  projectSearchRoot?: string;
  confirmation?: unknown;
}

export interface GeneratedCopyMutationBlock {
  ok: false;
  guard: "generated_copy_target";
  error: string;
  generatedCopyPath: string;
  realRepoPath: string;
  gitRemote: string;
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function hasGeneratedCopyEditConfirmation(value: unknown): boolean {
  return typeof value === "string" && value.trim() === GENERATED_COPY_EDIT_CONFIRMATION;
}

export function resolveAgainstCwd(cwd: string, maybePath: string): string {
  return isAbsolute(maybePath) ? resolve(maybePath) : resolve(cwd, maybePath);
}

export function generatedCopyMutationBlock(options: GuardOptions): GeneratedCopyMutationBlock | null {
  const cwd = resolve(options.cwd || process.cwd());
  const target = detectWorkspaceTarget(cwd, options.projectSearchRoot || homedir()) as Record<string, unknown>;
  if (target.classification !== "generated_copy_with_real_repo_match") return null;

  const generatedCopyPath = String(target.generatedCopyPath || cwd);
  const realRepoPath = String(target.realRepoPath || "");
  const gitRemote = String(target.gitRemote || "");
  if (options.targetPath && !pathInside(generatedCopyPath, options.targetPath)) return null;
  if (hasGeneratedCopyEditConfirmation(options.confirmation)) return null;

  return {
    ok: false,
    guard: "generated_copy_target",
    generatedCopyPath,
    realRepoPath,
    gitRemote,
    error: `WRITE BLOCKED: This workspace is a Jeriko generated copy with a matching real repo at ${realRepoPath}. Production edits probably belong there. Re-run from the real repo, or explicitly confirm generated-copy edits with: ${GENERATED_COPY_EDIT_CONFIRMATION}`,
  };
}

export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return true;
  if (/[>|<]|\b(tee|touch|mv|cp|rm|trash|mkdir|rmdir|install|patch|git\s+(add|commit|checkout|switch|reset|clean|merge|rebase|pull|push)|python|python3|node|bun|npm|pnpm|yarn)\b/i.test(trimmed)) {
    return false;
  }
  const segments = trimmed.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean);
  if (segments.length === 0) return true;
  return segments.every((segment) => /^(pwd|git\s+(status|diff|log|show|rev-parse|branch|remote|ls-files|grep)\b|ls\b|find\b|grep\b|rg\b|cat\b|sed\s+-n\b|head\b|tail\b|wc\b|printf\s+['\"]?[^>]*$|echo\s+['\"]?[^>]*$)/i.test(segment.trim()));
}
