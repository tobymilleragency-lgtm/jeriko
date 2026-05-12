import { describe, expect, it } from "bun:test";

import { OpenAICodexDriver } from "../../src/daemon/agent/drivers/openai-codex.js";

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
});
