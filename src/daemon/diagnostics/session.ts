import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getDatabase } from "../storage/db.js";
import { readProjectState } from "../../cli/commands/dev/project-state.js";
import { getDependencyStatus } from "../../cli/commands/dev/verify-app.js";

type Row = Record<string, unknown>;

export interface DiagnoseLatestOptions {
  sessionId?: string;
  cwd?: string;
  limit?: number;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function truncate(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function parseJsonMaybe(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function latestSession(sessionId?: string): Row | null {
  try {
    const db = getDatabase();
    if (sessionId) {
      return db.query<Row, [string, string]>("SELECT * FROM session WHERE id = ? OR slug = ? LIMIT 1").get(sessionId, sessionId) ?? null;
    }
    return db.query<Row, []>("SELECT * FROM session ORDER BY updated_at DESC LIMIT 1").get() ?? null;
  } catch {
    return null;
  }
}

function sessionParts(sessionId: string, limit = 120): Row[] {
  try {
    const db = getDatabase();
    return db.query<Row, [string, number]>(
      `SELECT part.rowid AS rowid, part.type, part.tool_name, part.content, part.tool_call_id, part.created_at, message.role
     FROM part
     JOIN message ON message.id = part.message_id
     WHERE message.session_id = ?
     ORDER BY part.rowid DESC
     LIMIT ?`,
    ).all(sessionId, limit);
  } catch {
    return [];
  }
}

function latestUserPrompt(sessionId: string): string {
  try {
    const db = getDatabase();
    const row = db.query<Row, [string]>(
      "SELECT content FROM message WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1",
    ).get(sessionId);
    return asString(row?.content);
  } catch {
    return "";
  }
}

function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    env: boundedGitEnv(cwd),
  });
  if (res.status !== 0) return "";
  return (res.stdout ?? "").trim();
}

function boundedGitEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Do not let diagnostics/status commands discover a repository above the
    // inspected workspace. This is critical for generated apps under
    // ~/.jeriko/projects/* when the user's home directory is itself a git repo.
    GIT_CEILING_DIRECTORIES: dirname(cwd),
  };
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function localGitRepository(cwd: string): boolean {
  if (!existsSync(join(cwd, ".git"))) return false;
  const topLevel = git(["rev-parse", "--show-toplevel"], cwd);
  return Boolean(topLevel) && samePath(topLevel, cwd);
}

export function buildWorkspaceStatus(opts: DiagnoseLatestOptions = {}): Record<string, unknown> {
  const cwd = resolve(opts.cwd || process.cwd());
  const projectState = readProjectState(cwd);
  const session = latestSession(opts.sessionId);
  const parts = session ? sessionParts(asString(session.id), opts.limit ?? 80) : [];
  const isLocalGitRepo = localGitRepository(cwd);
  const recentToolCalls = parts.filter((p) => p.type === "tool_call").slice(0, 12).map((p) => ({
    rowid: p.rowid,
    tool: p.tool_name,
    args: truncate(asString(p.content), 240),
  }));
  const recentVerification = parts
    .filter((p) => p.tool_name === "bash" && /\b(pnpm|bun|npm)\s+(check|build|test|run check|run build|run test)|tsc|vitest|pytest/i.test(asString(p.content)))
    .slice(0, 8)
    .map((p) => ({ rowid: p.rowid, type: p.type, content: truncate(asString(p.content), 500) }));
  const latestBrowser = parts.find((p) => p.tool_name === "browser" && p.type === "tool_result");
  const browserData = latestBrowser ? parseJsonMaybe(asString(latestBrowser.content)) : undefined;

  return {
    ok: true,
    cwd,
    projectState,
    dependencyStatus: getDependencyStatus(cwd),
    git: isLocalGitRepo ? {
      branch: git(["branch", "--show-current"], cwd),
      status: git(["status", "--short"], cwd),
      diffStat: git(["diff", "--stat"], cwd),
    } : { status: "not a git repository at cwd" },
    latestSession: session ? {
      id: session.id,
      slug: session.slug,
      title: session.title,
      model: session.model,
      updated_at: session.updated_at,
      token_count: session.token_count,
    } : null,
    latestUserPrompt: session ? truncate(latestUserPrompt(asString(session.id)), 700) : "",
    recentToolCalls,
    recentVerification,
    latestBrowserResult: browserData ?? (latestBrowser ? truncate(asString(latestBrowser.content), 700) : null),
  };
}

export function buildLatestDiagnosis(opts: DiagnoseLatestOptions = {}): Record<string, unknown> {
  const cwd = resolve(opts.cwd || process.cwd());
  const isLocalGitRepo = localGitRepository(cwd);
  const session = latestSession(opts.sessionId);
  if (!session) return { ok: false, error: "No sessions found" };
  const sessionId = asString(session.id);
  const parts = sessionParts(sessionId, opts.limit ?? 160);
  const toolCalls = parts.filter((p) => p.type === "tool_call");
  const toolResults = parts.filter((p) => p.type === "tool_result" || p.type === "error");
  const callCounts = new Map<string, number>();
  for (const p of toolCalls) {
    const key = `${asString(p.tool_name)} ${asString(p.content)}`;
    callCounts.set(key, (callCounts.get(key) ?? 0) + 1);
  }
  const repeatedToolCalls = [...callCounts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([signature, count]) => ({ count, signature: truncate(signature, 350) }));
  const latestCall = toolCalls[0];
  const latestResult = toolResults[0];
  const latestError = parts.find((p) => p.type === "error" || /error|failed|timeout|exceeded|denied/i.test(asString(p.content)));
  const latestRow = parts[0];
  const latestCallAfterResult = latestCall && (!latestResult || Number(latestCall.rowid) > Number(latestResult.rowid));
  const likelyStuckReason = latestCallAfterResult
    ? `Latest tool call has no newer tool result yet: ${asString(latestCall.tool_name)}`
    : repeatedToolCalls.length > 0
      ? `Repeated tool calls detected; top repeat count ${repeatedToolCalls[0]!.count}`
      : latestError
        ? `Latest error-like row: ${truncate(asString(latestError.content), 220)}`
        : "No obvious stuck pattern in recent persisted rows";

  return {
    ok: true,
    cwd,
    session: {
      id: session.id,
      slug: session.slug,
      title: session.title,
      model: session.model,
      updated_at: session.updated_at,
      token_count: session.token_count,
    },
    lastUserPrompt: truncate(latestUserPrompt(sessionId), 1200),
    latestRow: latestRow ? { rowid: latestRow.rowid, type: latestRow.type, tool: latestRow.tool_name, content: truncate(asString(latestRow.content), 700) } : null,
    latestToolCall: latestCall ? { rowid: latestCall.rowid, tool: latestCall.tool_name, args: truncate(asString(latestCall.content), 700) } : null,
    latestToolResult: latestResult ? { rowid: latestResult.rowid, tool: latestResult.tool_name, type: latestResult.type, content: truncate(asString(latestResult.content), 700) } : null,
    repeatedToolCalls,
    lastErrorOrWarning: latestError ? { rowid: latestError.rowid, type: latestError.type, tool: latestError.tool_name, content: truncate(asString(latestError.content), 700) } : null,
    changedFiles: isLocalGitRepo ? git(["status", "--short"], cwd).split("\n").filter(Boolean) : [],
    diffStat: isLocalGitRepo ? git(["diff", "--stat"], cwd) : "",
    likelyStuckReason,
  };
}

export function formatDiagnosisText(diagnosis: Record<string, unknown>): string {
  if (!diagnosis.ok) return `Jeriko diagnose: ${diagnosis.error}`;
  const d = diagnosis as Record<string, any>;
  return [
    "Jeriko latest-session diagnosis",
    `session: ${d.session?.slug ?? d.session?.id} (${d.session?.id})`,
    `title: ${d.session?.title ?? ""}`,
    `model: ${d.session?.model ?? ""}`,
    `token_count: ${d.session?.token_count ?? 0}`,
    `likely_stuck_reason: ${d.likelyStuckReason}`,
    `latest_tool_call: ${d.latestToolCall ? `${d.latestToolCall.tool} row ${d.latestToolCall.rowid}` : "none"}`,
    `latest_tool_result: ${d.latestToolResult ? `${d.latestToolResult.tool} row ${d.latestToolResult.rowid}` : "none"}`,
    `repeated_tool_calls: ${Array.isArray(d.repeatedToolCalls) ? d.repeatedToolCalls.length : 0}`,
    `changed_files: ${Array.isArray(d.changedFiles) ? d.changedFiles.length : 0}`,
  ].join("\n");
}
