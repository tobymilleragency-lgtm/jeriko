import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentNoProgressError,
  buildStuckDiagnosis,
  createModelRequestAbortController,
  nextStreamChunkWithNoProgressTimeout,
  runAgent,
} from "../../src/daemon/agent/agent.js";
import { registerDriver, type DriverConfig, type DriverMessage, type LLMDriver, type StreamChunk } from "../../src/daemon/agent/drivers/index.js";
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
    expect(events.some((event) => event.type === "text_delta" && event.content.includes("RECOVERED"))).toBe(true);
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
    expect(diagnosis).toContain("timeout/non-zero");
  });
});
