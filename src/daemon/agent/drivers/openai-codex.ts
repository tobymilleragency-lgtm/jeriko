// Daemon — OpenAI Codex driver.
// Uses the ChatGPT Codex backend, matching the working OpenClaw OAuth-only path:
//   https://chatgpt.com/backend-api/codex/responses
//
// The OAuth access token itself is the bearer credential. If expired, refresh
// it with the stored refresh token and retry once.

import type {
  LLMDriver,
  StreamChunk,
  DriverConfig,
  DriverMessage,
  ContentBlock,
  ToolCall,
  DriverTool,
} from "./index.js";
import { withTimeout } from "./signal.js";
import { getLogger } from "../../../shared/logger.js";
import {
  getOpenAICodexProfileEnv,
  type OpenAICodexProfileId,
} from "../../../shared/provider-secrets.js";
import { saveSecret } from "../../../shared/secrets.js";

const log = getLogger();
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

type CodexInputPart =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" };

type CodexTool = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type CodexInputMessage =
  | {
      role: "user" | "assistant";
      content: string;
    }
  | {
      role: "user" | "assistant";
      content: CodexInputPart[];
    };

function messageTextContent(content: DriverMessage["content"]): string {
  if (Array.isArray(content)) {
    return content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return content || "";
}

const OPENAI_CODEX_REQUEST_TIMEOUT_MS = 600_000;

type CodexReaderResult = { done: boolean; value?: Uint8Array };
type CodexStreamReader = {
  read: () => Promise<CodexReaderResult>;
  releaseLock: () => void;
};
type CodexReadResult =
  | { aborted: false; result: CodexReaderResult }
  | { aborted: true; result?: never };

async function readCodexChunk(
  reader: CodexStreamReader,
  signal: AbortSignal,
): Promise<CodexReadResult> {
  if (signal.aborted) return { aborted: true };

  let removeAbortListener: (() => void) | undefined;
  const abortPromise = new Promise<CodexReadResult>((resolve) => {
    const onAbort = () => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  const readPromise = reader.read().then((result): CodexReadResult => ({ aborted: false, result }));
  try {
    return await Promise.race([readPromise, abortPromise]);
  } finally {
    removeAbortListener?.();
    readPromise.catch(() => undefined);
  }
}

export class OpenAICodexDriver implements LLMDriver {
  readonly name = "openai-codex";

  private get apiKey(): string {
    return process.env.OPENAI_CODEX_API_KEY || "";
  }

  private get baseUrl(): string {
    return process.env.OPENAI_CODEX_BASE_URL || DEFAULT_CODEX_BASE_URL;
  }

  private resolveEndpoint(): string {
    const normalized = this.baseUrl.replace(/\/+$/, "");
    if (normalized.endsWith("/codex/responses")) return normalized;
    if (normalized.endsWith("/codex")) return `${normalized}/responses`;
    return `${normalized}/codex/responses`;
  }

  convertMessages(messages: DriverMessage[]): CodexInputMessage[] {
    const out: CodexInputMessage[] = [];
    for (const msg of messages) {
      if (msg.role === "system") continue;

      // The ChatGPT Codex endpoint does not accept OpenAI Chat Completions
      // `role: "tool"` messages. Dropping them made the model see the same
      // user request after every tool call, so it repeated `jeriko create` /
      // `--help` forever. Preserve tool outputs as explicit user-visible
      // observations so the next Codex turn can continue from real results.
      if (msg.role === "tool") {
        const callId = msg.tool_call_id ? ` ${msg.tool_call_id}` : "";
        out.push({ role: "user", content: `[tool result${callId}]\n${messageTextContent(msg.content)}` });
        continue;
      }

      if (Array.isArray(msg.content)) {
        const textParts = (msg.content as ContentBlock[])
          .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text);
        const imageParts = (msg.content as ContentBlock[])
          .filter((block): block is Extract<ContentBlock, { type: "image" }> => block.type === "image");

        if (imageParts.length === 0) {
          const joined = textParts.join("\n").trim();
          if (joined) out.push({ role: msg.role, content: joined });
          continue;
        }

        const content: CodexInputPart[] = [];
        if (textParts.length > 0) {
          content.push({ type: "input_text", text: textParts.join("\n") });
        }
        for (const block of imageParts) {
          content.push({
            type: "input_image",
            image_url: `data:${block.mediaType};base64,${block.data}`,
            detail: "auto",
          });
        }
        if (content.length > 0) out.push({ role: msg.role, content });
      } else if (msg.content) {
        out.push({ role: msg.role, content: msg.content });
      }
    }
    return out;
  }

  private async refreshExpiredToken(): Promise<boolean> {
    const activeProfile = (process.env.OPENAI_CODEX_PROFILE_PREFERENCE || "")
      .split(",")
      .map((s) => s.trim())
      .find((s): s is OpenAICodexProfileId => s === "personal" || s === "business")
      ?? "personal";

    const envs = getOpenAICodexProfileEnv(activeProfile);
    const refreshToken = process.env[envs.refreshToken] || process.env.OPENAI_CODEX_REFRESH_TOKEN;
    if (!refreshToken) {
      log.warn("OpenAI Codex token expired, but no refresh token is available.");
      return false;
    }

    const response = await fetch(OPENAI_CODEX_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OPENAI_CODEX_CLIENT_ID,
      }).toString(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log.warn(`OpenAI Codex refresh failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
      return false;
    }

    const data = (await response.json()) as Record<string, unknown>;
    const accessToken = typeof data.access_token === "string" ? data.access_token : undefined;
    const nextRefreshToken = typeof data.refresh_token === "string" ? data.refresh_token : undefined;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : undefined;

    if (!accessToken || !nextRefreshToken || !expiresIn) {
      log.warn(`OpenAI Codex refresh returned missing fields: ${Object.keys(data).join(", ")}`);
      return false;
    }

    const expiresAt = Date.now() + expiresIn * 1000;
    saveSecret(envs.accessToken, accessToken);
    saveSecret("OPENAI_CODEX_API_KEY", accessToken);
    saveSecret(envs.refreshToken, nextRefreshToken);
    saveSecret("OPENAI_CODEX_REFRESH_TOKEN", nextRefreshToken);
    saveSecret(envs.expiresAt, String(expiresAt));
    saveSecret("OPENAI_CODEX_EXPIRES_AT", String(expiresAt));
    return true;
  }

  private convertTools(tools: DriverTool[] | undefined): CodexTool[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  private buildRequestBody(messages: DriverMessage[], config: DriverConfig): Record<string, unknown> {
    const tools = this.convertTools(config.tools);
    return {
      model: config.model,
      store: false,
      stream: true,
      instructions: config.system_prompt,
      input: this.convertMessages(messages),
      text: { verbosity: "medium" },
      include: ["reasoning.encrypted_content"],
      ...(tools && tools.length > 0 ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
    };
  }

  async *chat(messages: DriverMessage[], config: DriverConfig): AsyncGenerator<StreamChunk> {
    const signal = withTimeout(config.signal, OPENAI_CODEX_REQUEST_TIMEOUT_MS);
    const endpoint = this.resolveEndpoint();
    let retriedAfterRefresh = false;

    while (true) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "OpenAI-Beta": "responses=experimental",
        },
        body: JSON.stringify(this.buildRequestBody(messages, config)),
        signal,
      }).catch((err) => {
        throw new Error(err instanceof Error ? err.message : String(err));
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (
          response.status === 401 &&
          !retriedAfterRefresh &&
          /token_expired|authentication token is expired|try signing in again/i.test(text)
        ) {
          retriedAfterRefresh = true;
          const refreshed = await this.refreshExpiredToken();
          if (refreshed) continue;
        }
        yield { type: "error", content: `OpenAI Codex API error ${response.status}: ${text}` };
        yield { type: "done", content: "" };
        return;
      }

      if (!response.body) {
        yield { type: "error", content: "OpenAI Codex API returned no body" };
        yield { type: "done", content: "" };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const toolCallState = new Map<string, { name: string; args: string; itemId: string }>();

      const emitToolCallIfComplete = (event: Record<string, unknown>): ToolCall | null => {
        const item = event.item as Record<string, unknown> | undefined;
        if (!item || item.type !== "function_call") return null;
        const callId = typeof item.call_id === "string" ? item.call_id : undefined;
        const itemId = typeof item.id === "string" ? item.id : undefined;
        const name = typeof item.name === "string" ? item.name : undefined;
        const args = typeof item.arguments === "string" ? item.arguments : "{}";
        if (!callId || !itemId || !name) return null;
        return { id: `${callId}|${itemId}`, name, arguments: args };
      };

      try {
        while (true) {
          const readResult = await readCodexChunk(reader, signal);
          if (readResult.aborted) {
            yield { type: "error", content: "Request aborted" };
            yield { type: "done", content: "" };
            return;
          }
          const { done, value } = readResult.result;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          idx = buffer.indexOf("\n\n");

          const dataLines = chunk
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
          if (dataLines.length === 0) continue;

          const data = dataLines.join("\n").trim();
          if (!data || data === "[DONE]") continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          const type = typeof event.type === "string" ? event.type : "";
          if (type === "error") {
            yield { type: "error", content: `OpenAI Codex error: ${JSON.stringify(event)}` };
            yield { type: "done", content: "" };
            return;
          }

          if (type === "response.output_text.delta") {
            const delta = typeof event.delta === "string" ? event.delta : "";
            if (delta) yield { type: "text", content: delta };
          }

          if (type === "response.reasoning_summary_text.delta") {
            const delta = typeof event.delta === "string" ? event.delta : "";
            if (delta) yield { type: "thinking", content: delta };
          }

          if (type === "response.output_item.added") {
            const item = event.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
              const callId = typeof item.call_id === "string" ? item.call_id : undefined;
              const itemId = typeof item.id === "string" ? item.id : undefined;
              const name = typeof item.name === "string" ? item.name : undefined;
              const args = typeof item.arguments === "string" ? item.arguments : "";
              if (callId && itemId && name) {
                toolCallState.set(itemId, { name, args, itemId: `${callId}|${itemId}` });
              }
            }
          }

          if (type === "response.function_call_arguments.delta") {
            const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
            const delta = typeof event.delta === "string" ? event.delta : "";
            if (itemId && toolCallState.has(itemId)) {
              toolCallState.get(itemId)!.args += delta;
            }
          }

          if (type === "response.output_item.done") {
            const toolCall = emitToolCallIfComplete(event);
            if (toolCall) {
              const itemId = toolCall.id.split("|")[1];
              if (!itemId) {
                yield { type: "tool_call", content: toolCall.arguments, tool_call: toolCall };
                continue;
              }
              const tracked = toolCallState.get(itemId);
              if (tracked) {
                yield {
                  type: "tool_call",
                  content: tracked.args || "{}",
                  tool_call: {
                    id: tracked.itemId,
                    name: tracked.name,
                    arguments: tracked.args || "{}",
                  },
                };
                toolCallState.delete(itemId);
              } else {
                yield { type: "tool_call", content: toolCall.arguments, tool_call: toolCall };
              }
            }
          }

          if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
            yield { type: "done", content: "" };
            return;
          }

          if (type === "response.failed") {
            yield { type: "error", content: `OpenAI Codex response failed: ${JSON.stringify(event)}` };
            yield { type: "done", content: "" };
            return;
          }
        }
        }
      } finally {
        reader.releaseLock();
      }

      yield { type: "done", content: "" };
      return;
    }
  }
}
