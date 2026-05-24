import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentNoProgressError,
  AgentResourceLimitError,
  buildAgentResourceLimitMessage,
  buildStuckDiagnosis,
  checkAgentResourceLimit,
  createModelRequestAbortController,
  hasProductWorkflowEvidence,
  hasProductionDeployEvidence,
  hasRouteBreadthEvidence,
  nextStreamChunkWithNoProgressTimeout,
  requiresProductWorkflowVerification,
  requiresProductionDeployVerification,
  requiresRouteBreadthVerification,
  runAgent,
} from "../../src/daemon/agent/agent.js";
import { registerDriver, type DriverConfig, type DriverMessage, type LLMDriver, type StreamChunk } from "../../src/daemon/agent/drivers/index.js";
import { registerTool } from "../../src/daemon/agent/tools/registry.js";
import { createSession } from "../../src/daemon/agent/session/session.js";
import { closeDatabase, initDatabase } from "../../src/daemon/storage/db.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "jeriko-agent-no-progress-"));

beforeAll(() => {
  initDatabase(join(TEST_DIR, "test.db"));
});

afterAll(() => {
  closeDatabase();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("agent no-progress guard", () => {
  it("times out a model stream that produces no chunks", async () => {
    let aborted = false;
    let returned = false;
    const stream: AsyncIterator<{ type: "done"; content: string }> = {
      next: () => new Promise(() => undefined),
      return: async () => {
        returned = true;
        return { done: true, value: undefined as never };
      },
    };

    const startedAt = Date.now();
    await expect(nextStreamChunkWithNoProgressTimeout(stream, {
      startedAt,
      maxDurationMs: 10_000,
      noProgressTimeoutMs: 15,
      abort: () => { aborted = true; },
      describe: () => "Agent stuck/no-progress guard stopped the run.",
    })).rejects.toThrow(AgentNoProgressError);

    expect(aborted).toBe(true);
    expect(returned).toBe(true);
  });

  it("hard-stops a silent model stream when the resource guard trips", async () => {
    let aborted = false;
    let returned = false;
    const stream: AsyncIterator<{ type: "done"; content: string }> = {
      next: () => new Promise(() => undefined),
      return: async () => {
        returned = true;
        return { done: true, value: undefined as never };
      },
    };

    await expect(nextStreamChunkWithNoProgressTimeout(stream, {
      startedAt: Date.now(),
      maxDurationMs: 10_000,
      noProgressTimeoutMs: 10_000,
      abort: () => { aborted = true; },
      checkResourceLimit: () => "Agent resource guard stopped the run.",
      describe: () => "Agent stuck/no-progress guard stopped the run.",
    })).rejects.toThrow(AgentResourceLimitError);

    expect(aborted).toBe(true);
    expect(returned).toBe(true);
  });

  it("formats and detects agent RSS resource cap violations", () => {
    const currentRss = process.memoryUsage().rss;
    const msg = checkAgentResourceLimit(currentRss - 1, {
      startedAt: Date.now() - 2_000,
      backend: "test-backend",
      model: "test-model",
    });

    expect(msg).toContain("Agent resource guard stopped the run.");
    expect(msg).toContain("above the configured cap");
    expect(msg).toContain("before Linux could OOM-kill the desktop session");
    expect(checkAgentResourceLimit(0, {
      startedAt: Date.now(),
      backend: "test-backend",
      model: "test-model",
    })).toBeNull();

    const formatted = buildAgentResourceLimitMessage({
      rssBytes: 3 * 1024 * 1024 * 1024,
      maxRssBytes: 2 * 1024 * 1024 * 1024,
      elapsedMs: 42_000,
      backend: "test-backend",
      model: "test-model",
    });
    expect(formatted).toContain("3.00 GiB");
    expect(formatted).toContain("2.00 GiB");
  });

  it("uses wall-clock remaining time when it is shorter than idle timeout", async () => {
    let aborted = false;
    const stream: AsyncIterator<{ type: "done"; content: string }> = {
      next: async () => ({ done: true, value: undefined as never }),
    };

    await expect(nextStreamChunkWithNoProgressTimeout(stream, {
      startedAt: Date.now() - 101,
      maxDurationMs: 100,
      noProgressTimeoutMs: 60_000,
      abort: () => { aborted = true; },
      describe: () => "wall clock expired",
    })).rejects.toThrow(AgentNoProgressError);

    expect(aborted).toBe(true);
  });

  it("creates a fresh model request AbortSignal after a no-progress request abort", () => {
    const runAbort = new AbortController();
    const firstRequest = createModelRequestAbortController(runAbort.signal);

    firstRequest.abort("agent-no-progress");

    const recoveryRequest = createModelRequestAbortController(runAbort.signal);
    expect(firstRequest.signal.aborted).toBe(true);
    expect(recoveryRequest.signal.aborted).toBe(false);

    runAbort.abort("operator-stop");
    expect(recoveryRequest.signal.aborted).toBe(true);
  });

  it("recovers from a silent model stream with a fresh non-aborted request", async () => {
    const seenRequestSignals: boolean[] = [];
    let callCount = 0;
    const driver: LLMDriver = {
      name: "test-no-progress-recovery",
      chat(_messages: DriverMessage[], config: DriverConfig) {
        callCount += 1;
        seenRequestSignals.push(config.signal?.aborted === true);
        const callNumber = callCount;
        let yielded = false;
        const iterator: AsyncGenerator<StreamChunk> = {
          async next() {
            if (callNumber === 1) return new Promise(() => undefined);
            if (!yielded) {
              yielded = true;
              return { done: false, value: { type: "text", content: "RECOVERED" } };
            }
            return { done: true, value: undefined as never };
          },
          async return() {
            return { done: true, value: undefined as never };
          },
          async throw(error?: unknown) {
            throw error;
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return iterator;
      },
    };
    registerDriver(driver);
    const session = createSession({ title: "no-progress-recovery-test", model: "test-model" });

    const events = [];
    for await (const event of runAgent({
      sessionId: session.id,
      backend: "test-no-progress-recovery",
      model: "test-model",
      noProgressTimeoutMs: 10,
      maxDurationMs: 60_000,
      maxRounds: 3,
    }, [{ role: "user", content: "hello" }])) {
      events.push(event);
    }

    expect(seenRequestSignals).toEqual([false, false]);
    const visibleText = events.filter((event) => event.type === "text_delta").map((event: any) => event.content).join("\n");
    expect(visibleText).toContain("RECOVERED");
    expect(visibleText).not.toContain("MODEL_STREAM_NO_PROGRESS_RECOVERY");
  });

  it("hard-stops with an operator recap on repeated tool rounds without asking the model to recover", async () => {
    let callCount = 0;
    const driver: LLMDriver = {
      name: "test-repeated-round-hard-stop",
      chat() {
        callCount += 1;
        const callNumber = callCount;
        let yielded = false;
        const iterator: AsyncGenerator<StreamChunk> = {
          async next() {
            if (yielded) return { done: true, value: undefined as never };
            yielded = true;
            if (callNumber <= 3) {
              return {
                done: false,
                value: {
                  type: "tool_call",
                  tool_call: {
                    id: `read-${callNumber}`,
                    name: "missing_read_probe",
                    arguments: JSON.stringify({ file_path: "/tmp/Home.tsx", offset: 0, limit: 80 }),
                  },
                },
              };
            }
            return { done: false, value: { type: "text", content: "MODEL_WAS_REASKED_AFTER_REPEAT_GUARD" } };
          },
          async return() {
            return { done: true, value: undefined as never };
          },
          async throw(error?: unknown) {
            throw error;
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
        return iterator;
      },
    };
    registerDriver(driver);
    const session = createSession({ title: "repeated-round-hard-stop-test", model: "test-model" });

    const text: string[] = [];
    for await (const event of runAgent({
      sessionId: session.id,
      backend: "test-repeated-round-hard-stop",
      model: "test-model",
      noProgressTimeoutMs: 10_000,
      maxDurationMs: 60_000,
      maxRounds: 8,
    }, [{ role: "user", content: "inspect the app" }])) {
      if (event.type === "text_delta") text.push(event.content);
    }

    const output = text.join("\n");
    expect(callCount).toBe(3);
    expect(output).toContain("No-progress guard stopped the run.");
    expect(output).toContain("Operator recap:");
    expect(output).toContain("Repeated no-progress tool round blocked after 3 matching rounds");
    expect(output).not.toContain("NO_PROGRESS_RECOVERY");
    expect(output).not.toContain("MODEL_WAS_REASKED_AFTER_REPEAT_GUARD");
  });

  it("hard-stops repeated status loops after green verify_app instead of asking for more recovery", async () => {
    registerTool({
      id: "workspace_status",
      name: "workspace_status",
      description: "Test workspace status",
      parameters: { type: "object", properties: {} },
      execute: async () => JSON.stringify({
        ok: true,
        data: {
          directory: "/home/toby/.jeriko/projects/cody-chestnut-realtor-site",
          profile: "web-static",
          projectState: {
            name: "cody-chestnut-realtor-site",
            profile: "web-static",
            appSpec: {
              appType: "premium-local-service-marketing-site",
              features: ["buyer pathway", "seller pathway"],
              pages: [{ path: "/", title: "Home" }, { path: "/buy", title: "Buy" }, { path: "/sell", title: "Sell" }],
            },
          },
          gates: [
            { name: "placeholder_scan", ok: true },
            { name: "check", ok: true, output: "tsc --noEmit" },
            { name: "build", ok: true, output: "vite build ✓ built in 1.1s" },
            { name: "start_route", ok: true },
            { name: "browser_smoke", ok: true },
          ],
        },
      }),
    });

    let callCount = 0;
    const driver: LLMDriver = {
      name: "test-status-loop-after-green-verify",
      chat(): AsyncGenerator<StreamChunk> {
        callCount += 1;
        const callNumber = callCount;
        let yielded = false;
        const iterator: AsyncGenerator<StreamChunk> = {
          async next() {
            if (yielded) return { done: true, value: undefined as never };
            yielded = true;
            if (callNumber <= 3) {
              return {
                done: false,
                value: {
                  type: "tool_call",
                  content: "",
                  tool_call: { id: `status-${callNumber}`, name: "workspace_status", arguments: JSON.stringify({ cwd: "/home/toby/.jeriko/projects/cody-chestnut-realtor-site" }) },
                },
              };
            }
            return { done: false, value: { type: "text", content: "MODEL_WAS_REASKED_AFTER_GREEN_VERIFY" } };
          },
          async return() { return { done: true, value: undefined as never }; },
          async throw(error?: unknown) { throw error; },
          [Symbol.asyncIterator]() { return this; },
        };
        return iterator;
      },
    };
    registerDriver(driver);
    const session = createSession({ title: "status-loop-after-green-verify", model: "test-model" });
    const text: string[] = [];

    for await (const event of runAgent({
      sessionId: session.id,
      backend: "test-status-loop-after-green-verify",
      model: "test-model",
      noProgressTimeoutMs: 10_000,
      maxDurationMs: 60_000,
      maxRounds: 8,
    }, [{ role: "user", content: "finish this generated Cody realtor website" }])) {
      if (event.type === "text_delta") text.push(event.content);
    }

    const output = text.join("\n");
    expect(callCount).toBe(3);
    expect(output).toContain("Built / target app:");
    expect(output).toContain("cody-chestnut-realtor-site");
    expect(output).toContain("premium-local-service-marketing-site");
    expect(output).not.toContain("NO_PROGRESS_RECOVERY");
    expect(output).not.toContain("MODEL_WAS_REASKED_AFTER_GREEN_VERIFY");
  });

  it("hard-stops after app-builder final reports instead of executing stray tool calls", async () => {
    let toolExecuted = false;
    registerTool({
      id: "post_report_probe",
      name: "post_report_probe",
      description: "Test-only post-report probe",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        toolExecuted = true;
        return JSON.stringify({ ok: true });
      },
    });

    const driver: LLMDriver = {
      name: "test-final-report-hard-stop",
      async *chat(): AsyncGenerator<StreamChunk> {
        yield { type: "text", content: "## What I did\nFinished the site.\n\nVerification evidence\n- pnpm run check passed\n- pnpm run build passed\n" };
        yield {
          type: "tool_call",
          content: "",
          tool_call: { id: "post-report-1", name: "post_report_probe", arguments: "{}" },
        };
      },
    };
    registerDriver(driver);
    const session = createSession({ title: "final-report-hard-stop-test", model: "test-model" });
    const text: string[] = [];
    const toolResults: string[] = [];

    for await (const event of runAgent({
      sessionId: session.id,
      backend: "test-final-report-hard-stop",
      model: "test-model",
      noProgressTimeoutMs: 10_000,
      maxDurationMs: 60_000,
      maxRounds: 4,
    }, [{ role: "user", content: "finish this generated web-static site" }])) {
      if (event.type === "text_delta") text.push(event.content);
      if (event.type === "tool_result") toolResults.push(event.result);
    }

    expect(text.join("\n")).toContain("## What I did");
    expect(toolExecuted).toBe(false);
    expect(toolResults).toEqual([]);
  });

  it("injects the run cwd into cwd-aware tools when the model omits cwd", async () => {
    registerTool({
      id: "cwd_probe_agent_test",
      name: "cwd_probe_agent_test",
      description: "Test-only cwd probe",
      parameters: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory" },
        },
      },
      execute: async (args) => JSON.stringify({ cwd: args.cwd ?? null }),
    });

    let callCount = 0;
    const driver: LLMDriver = {
      name: "test-agent-cwd-injection",
      async *chat() {
        callCount += 1;
        if (callCount === 1) {
          yield {
            type: "tool_call",
            content: "",
            tool_call: {
              id: "cwd-probe-1",
              name: "cwd_probe_agent_test",
              arguments: JSON.stringify({ cwd: "." }),
            },
          };
          return;
        }
        yield { type: "text", content: "done" };
      },
    };
    registerDriver(driver);
    const session = createSession({ title: "cwd-injection-test", model: "test-model" });
    const runCwd = "/tmp/jeriko-caller-cwd";
    const toolResults: string[] = [];

    for await (const event of runAgent({
      sessionId: session.id,
      backend: "test-agent-cwd-injection",
      model: "test-model",
      cwd: runCwd,
      noProgressTimeoutMs: 10_000,
      maxDurationMs: 60_000,
      maxRounds: 4,
    }, [{ role: "user", content: "probe cwd" }])) {
      if (event.type === "tool_result") toolResults.push(event.result);
    }

    expect(toolResults.some((result) => result.includes(`"cwd":"${runCwd}"`))).toBe(true);
  });

  it("builds a foreground stuck diagnosis with timeout/non-zero guidance", () => {
    const diagnosis = buildStuckDiagnosis({
      reason: "No new model/tool/DB progress was observed while waiting for the model stream.",
      round: 2,
      elapsedMs: 12_345,
      idleMs: 180_000,
      model: "test-model",
      backend: "test-backend",
    });

    expect(diagnosis).toContain("Agent stuck/no-progress guard stopped the run.");
    expect(diagnosis).toContain("no new stream, tool, or persisted DB progress");
    expect(diagnosis).toContain("backend=test-backend model=test-model round=3");
    expect(diagnosis).toContain("progress for 180s");
    expect(diagnosis).toContain("timeout/non-zero");
  });

  it("does not report zero idle seconds when elapsed time is nonzero", () => {
    const diagnosis = buildStuckDiagnosis({
      reason: "No new model/tool/DB progress was observed while waiting for the model stream.",
      round: 30,
      elapsedMs: 600_000,
      idleMs: 0,
      model: "gpt-5.5",
      backend: "openai-codex",
    });

    expect(diagnosis).not.toContain("progress for 0s");
    expect(diagnosis).toContain("progress for 600s");
    expect(diagnosis).toContain("elapsed=600s");
  });

  it("requires route breadth proof for full website/app requests before final completion", () => {
    const messages: DriverMessage[] = [
      {
        role: "user",
        content: "Build a full Go Alpha Marketing web app/site with services, industries, case studies, process, pricing, resources, and contact pages.",
      },
      {
        role: "tool",
        content: JSON.stringify({ ok: true, data: { gates: [{ name: "browser_smoke", ok: true }, { name: "start_route", ok: true }] } }),
      },
    ];

    expect(requiresRouteBreadthVerification(messages)).toBe(true);
    expect(hasRouteBreadthEvidence(messages)).toBe(false);

    const proved: DriverMessage[] = [
      ...messages,
      {
        role: "tool",
        content: "ROUTE_BREADTH_OK implemented routable pages: /services /industries /case-studies /process /pricing /resources /contact",
      },
    ];
    expect(hasRouteBreadthEvidence(proved)).toBe(true);
  });

  it("requires live production deploy/OAuth proof before production completion claims", () => {
    const messages: DriverMessage[] = [
      { role: "user", content: "Deploy this generated web-db-user app to production on Vercel and fix Google auth." },
      { role: "tool", content: "verify_app passed; local preview http://127.0.0.1:4187/" },
    ];

    expect(requiresProductionDeployVerification(messages)).toBe(true);
    expect(hasProductionDeployEvidence(messages)).toBe(false);

    const blocked: DriverMessage[] = [
      ...messages,
      { role: "tool", content: "production smoke HTTP/2 200; /api/oauth/google/status OK; /api/oauth/google/start redirect_uri=https://example.com/api/oauth/callback; Google returned redirect_uri_mismatch" },
    ];
    expect(hasProductionDeployEvidence(blocked)).toBe(false);

    const proved: DriverMessage[] = [
      ...messages,
      { role: "tool", content: "vercel inspect Ready Aliased https://example.com; production smoke status=200; /api/oauth/google/status OK; /api/oauth/google/start redirect_uri=https://example.com/api/oauth/callback; Google authorize follow reached account chooser without mismatch" },
    ];
    expect(hasProductionDeployEvidence(proved)).toBe(true);
  });

  it("does not require production deploy proof when scope explicitly says do not deploy", () => {
    const messages: DriverMessage[] = [
      { role: "user", content: "Use the production-ready SOP for local SEO/accessibility verification, but do not deploy this web-static Cody site." },
      { role: "user", content: "APP_FACTORY_DONE_GATE: Final report blocked. Production deploy work requires deploy_app and for web-db-user apps production Google OAuth /status + /start." },
      { role: "tool", content: "verify_app passed; local preview http://127.0.0.1:4175/" },
    ];

    expect(requiresProductionDeployVerification(messages)).toBe(false);
    expect(hasProductionDeployEvidence(messages)).toBe(false);
  });

  it("does not make OAuth proof mandatory from internal production gate text alone", () => {
    const messages: DriverMessage[] = [
      { role: "user", content: "Deploy this web-static marketing site to Vercel production." },
      { role: "user", content: "APP_FACTORY_DONE_GATE: Final report blocked. Production deploy work requires deploy_app and for web-db-user apps production Google OAuth /status + /start." },
      { role: "tool", content: "vercel inspect Ready Aliased https://example.com; production smoke status=200" },
    ];

    expect(requiresProductionDeployVerification(messages)).toBe(true);
    expect(hasProductionDeployEvidence(messages)).toBe(true);
  });

  it("requires read-after-write product workflow proof for full-stack product app completion", () => {
    const messages: DriverMessage[] = [
      { role: "user", content: "Build a generated full-stack web-db-user inventory scanner app with upload, save to inventory, orders, and listing workflow." },
      { role: "tool", content: "verify_app passed; check/build/browser_smoke passed; local preview http://127.0.0.1:4187/" },
    ];

    expect(requiresProductWorkflowVerification(messages)).toBe(true);
    expect(hasProductWorkflowEvidence(messages)).toBe(false);

    const fakeLocalOnly: DriverMessage[] = [
      ...messages,
      { role: "tool", content: "button exists and scan page renders with sample inventory cards" },
    ];
    expect(hasProductWorkflowEvidence(fakeLocalOnly)).toBe(false);

    const proved: DriverMessage[] = [
      ...messages,
      { role: "tool", content: "PRODUCT_WORKFLOW_OK POST /api/inventory created itemId=inv_123; GET /api/inventory returned readback with itemId=inv_123 and saved listing result" },
    ];
    expect(hasProductWorkflowEvidence(proved)).toBe(true);
  });
});
