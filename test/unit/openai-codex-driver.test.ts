import { afterEach, describe, expect, it } from "bun:test";

import { OpenAICodexDriver } from "../../src/daemon/agent/drivers/openai-codex.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_CODEX_API_KEY;
  delete process.env.OPENAI_CODEX_BASE_URL;
});

describe("OpenAICodexDriver message conversion", () => {
  it("preserves tool results as user-visible observations", () => {
    const driver = new OpenAICodexDriver();
    const converted = driver.convertMessages([
      { role: "user", content: "build a simple crm" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1|item_1",
            name: "bash",
            arguments: JSON.stringify({ command: "jeriko create web-db-user simple-crm --git" }),
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1|item_1",
        content: '{"ok":true,"data":{"directory":"/home/toby/.jeriko/projects/simple-crm","reused":true}}',
      },
    ]);

    expect(converted).toEqual([
      { role: "user", content: "build a simple crm" },
      {
        role: "user",
        content: '[tool result call_1|item_1]\n{"ok":true,"data":{"directory":"/home/toby/.jeriko/projects/simple-crm","reused":true}}',
      },
    ]);
  });

  it("unblocks a silent streaming response when the AbortSignal fires", async () => {
    process.env.OPENAI_CODEX_API_KEY = "test-token";
    process.env.OPENAI_CODEX_BASE_URL = "https://codex.test/backend-api";

    globalThis.fetch = (async () => new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // Intentionally never enqueue or close. This reproduces the live stuck
          // state where Codex accepted the request but produced no SSE frames.
        },
      }),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )) as unknown as typeof fetch;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 25);

    const driver = new OpenAICodexDriver();
    const started = Date.now();
    const chunks = [];
    for await (const chunk of driver.chat(
      [{ role: "user", content: "hello" }],
      { model: "gpt-5.5", max_tokens: 128, temperature: 0, signal: controller.signal },
    )) {
      chunks.push(chunk);
    }

    expect(Date.now() - started).toBeLessThan(1000);
    expect(chunks.some((chunk) => chunk.type === "error" && chunk.content.includes("aborted"))).toBe(true);
    expect(chunks[chunks.length - 1]?.type).toBe("done");
  });
});
