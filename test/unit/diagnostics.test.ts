import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase, closeDatabase } from "../../src/daemon/storage/db.js";
import { createSession } from "../../src/daemon/agent/session/session.js";
import { addMessage, addPart } from "../../src/daemon/agent/session/message.js";
import { buildLatestDiagnosis, buildWorkspaceStatus, formatDiagnosisText } from "../../src/daemon/diagnostics/session.js";

describe("session diagnostics", () => {
  let dir = "";

  afterEach(() => {
    closeDatabase();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  function setupDb() {
    dir = mkdtempSync(join(tmpdir(), "jeriko-diagnose-"));
    initDatabase(join(dir, "jeriko.db"));
    const session = createSession({ model: "codex", title: "diagnose test" });
    const user = addMessage(session.id, "user", "Improve the CRM");
    addPart(user.id, "text", "Improve the CRM");
    const assistant = addMessage(session.id, "assistant", "");
    addPart(assistant.id, "tool_call", JSON.stringify({ file_path: "/tmp/Home.tsx", offset: 0, limit: 1200 }), "read_file", "call-1");
    const tool = addMessage(session.id, "tool", "1\tcontent");
    addPart(tool.id, "tool_result", "1\tcontent", "read_file", "call-1");
    return session;
  }

  test("diagnose latest reports latest call/result and no obvious stuck pattern", () => {
    const session = setupDb();
    const diagnosis = buildLatestDiagnosis({ sessionId: session.id, cwd: dir });

    expect(diagnosis.ok).toBe(true);
    expect((diagnosis.session as Record<string, unknown>).id).toBe(session.id);
    expect((diagnosis.latestToolCall as Record<string, unknown>).tool).toBe("read_file");
    expect((diagnosis.latestToolResult as Record<string, unknown>).tool).toBe("read_file");
    expect(String(diagnosis.likelyStuckReason)).toContain("No obvious stuck pattern");
    expect(formatDiagnosisText(diagnosis)).toContain("Jeriko latest-session diagnosis");
  });

  test("workspace status includes recent tool calls and latest prompt", () => {
    const session = setupDb();
    const status = buildWorkspaceStatus({ sessionId: session.id, cwd: dir });

    expect(status.ok).toBe(true);
    expect(status.latestUserPrompt).toBe("Improve the CRM");
    expect(Array.isArray(status.recentToolCalls)).toBe(true);
    expect((status.recentToolCalls as unknown[]).length).toBe(1);
  });
});
