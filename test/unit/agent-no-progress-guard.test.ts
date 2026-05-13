import { describe, expect, it } from "bun:test";
import {
  AgentNoProgressError,
  buildStuckDiagnosis,
  nextStreamChunkWithNoProgressTimeout,
} from "../../src/daemon/agent/agent.js";

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
