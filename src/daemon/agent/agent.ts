// Daemon — Unified agent loop.
// Drives the conversation: send messages to LLM, execute tool calls, yield chunks.
// All LLM backends stream through the same async generator interface.
//
// The agent loop is the ORCHESTRATOR — it resolves models, detects capabilities,
// and adapts behavior dynamically. Drivers receive already-resolved model IDs
// and capabilities; they never maintain their own hardcoded model lists.
//
// Execution safety is delegated to ExecutionGuard (guard.ts), which enforces:
//   - Consecutive error circuit breaking
//   - Wall-clock duration limits
//   - Per-tool rate limiting

import { getDriver, messageText, type DriverConfig, type DriverMessage, type StreamChunk, type ToolCall, type ToolResult } from "./drivers/index.js";
import { resolveModel, getCapabilities, probeLocalModel, type ModelCapabilities } from "./drivers/models.js";
import { getTool, resolveDottedTool, listTools, toDriverFormat } from "./tools/registry.js";
import { addMessage, addPart } from "./session/message.js";
import { touchSession } from "./session/session.js";
import { estimateTokens, DEFAULT_CONTEXT_LIMIT, COMPACTION_CONTEXT_RATIO, MIN_MESSAGES_FOR_COMPACTION } from "../../shared/tokens.js";
import { ExecutionGuard } from "./guard.js";
import { trimHistory, compactHistory, sanitizeToolPairs } from "./history.js";
import { setActiveContext, clearActiveContext } from "./orchestrator-context.js";
import { getLogger } from "../../shared/logger.js";

const log = getLogger();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for an agent loop invocation. */
export interface AgentRunConfig {
  /** Session ID for message persistence. */
  sessionId: string;
  /** LLM backend name (e.g. "claude", "openai", "local"). */
  backend: string;
  /** Model identifier — can be an alias (e.g. "claude") or exact ID (e.g. "claude-sonnet-4-6"). */
  model: string;
  /** System prompt. */
  systemPrompt?: string;
  /** Maximum tokens per response. Defaults to model's maxOutput capability. */
  maxTokens?: number;
  /** Temperature (0-1). */
  temperature?: number;
  /** Enable extended thinking (only for models with reasoning capability). */
  extendedThinking?: boolean;
  /** List of tool IDs to enable. Null = all tools (if model supports them). */
  toolIds?: string[] | null;
  /** Maximum number of tool-call rounds before forcing a text response. */
  maxRounds?: number;
  /** Max conversation history messages to send per request. Keeps tool call/result pairs intact. */
  maxHistoryMessages?: number;
  /** Max estimated tokens of conversation history to send per request. */
  maxHistoryTokens?: number;
  /** Optional AbortSignal for cancellation/timeout. Forwarded to the LLM driver. */
  signal?: AbortSignal;
  /** Hard wall-clock cap for the whole agent run. Defaults to 10 minutes. */
  maxDurationMs?: number;
  /** Max time to wait for a new model stream event before diagnosing a stuck/no-progress loop. Defaults to 3 minutes. */
  noProgressTimeoutMs?: number;
  /** Nesting depth for sub-agent orchestration (0 = top-level). */
  depth?: number;
}

/** A yielded event from the agent loop. */
export type AgentEvent =
  | { type: "text_delta"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call_start"; toolCall: ToolCall }
  | { type: "tool_result"; toolCallId: string; result: string; isError: boolean }
  | { type: "turn_complete"; tokensIn: number; tokensOut: number }
  | { type: "compaction"; beforeTokens: number; afterTokens: number }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export const DEFAULT_AGENT_MAX_DURATION_MS = 10 * 60_000;
export const DEFAULT_AGENT_NO_PROGRESS_TIMEOUT_MS = 3 * 60_000;
const STREAM_NO_PROGRESS_RECOVERY_LIMIT = 1;
const STREAM_NO_PROGRESS_RECOVERY_CONTEXT_LIMIT = 80_000;

export class AgentNoProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNoProgressError";
  }
}

export function createModelRequestAbortController(runSignal: AbortSignal): AbortController {
  const requestAbort = new AbortController();
  if (runSignal.aborted) {
    requestAbort.abort(runSignal.reason);
  } else {
    runSignal.addEventListener("abort", () => requestAbort.abort(runSignal.reason), { once: true });
  }
  return requestAbort;
}

/**
 * Run the agent loop as an async generator.
 *
 * The loop:
 *  1. Resolve model alias → real API model ID.
 *  2. Detect capabilities (tools, reasoning, context window, max output).
 *  3. Build driver config with dynamic capabilities.
 *  4. Stream a response from the LLM.
 *  5. If the response contains tool calls, execute them and loop back.
 *  6. If the response is text-only, yield the final text and return.
 *
 * Callers iterate the generator to consume events as they happen:
 *
 * ```ts
 * for await (const event of runAgent(config, conversationHistory)) {
 *   if (event.type === "text_delta") process.stdout.write(event.content);
 * }
 * ```
 */
export async function* runAgent(
  config: AgentRunConfig,
  conversationHistory: DriverMessage[],
): AsyncGenerator<AgentEvent> {
  const startedAt = Date.now();
  const maxDurationMs = config.maxDurationMs ?? DEFAULT_AGENT_MAX_DURATION_MS;
  const noProgressTimeoutMs = config.noProgressTimeoutMs ?? DEFAULT_AGENT_NO_PROGRESS_TIMEOUT_MS;
  const runAbort = new AbortController();
  let activeRequestAbort: AbortController | null = null;
  const forwardAbort = () => {
    runAbort.abort(config.signal?.reason);
    activeRequestAbort?.abort(config.signal?.reason);
  };
  if (config.signal?.aborted) forwardAbort();
  else config.signal?.addEventListener("abort", forwardAbort, { once: true });

  // ─── Step 1: Resolve model and detect capabilities ───────────────────
  // Use the driver's canonical name as the provider — not the user-facing alias.
  // The driver registry normalizes "ollama" → "local", "claude" → "anthropic", etc.
  const driver = getDriver(config.backend);
  const provider = driver.name;
  const resolvedModelId = resolveModel(provider, config.model);

  // For local models, probe Ollama for capabilities before proceeding.
  // Cloud models (anthropic/openai) are already cached from models.dev boot fetch.
  if (provider === "local") {
    await probeLocalModel(resolvedModelId);
  }

  const caps = getCapabilities(provider, resolvedModelId);
  const maxRounds = config.maxRounds ?? 40;

  log.debug(`Agent: resolved model "${config.model}" → "${resolvedModelId}" [ctx=${caps.context} out=${caps.maxOutput} tools=${caps.toolCall} reasoning=${caps.reasoning}]`);

  // ─── Step 2: Dynamic tool selection based on model capabilities ──────
  let enabledTools = config.toolIds
    ? listTools().filter((t) => config.toolIds!.includes(t.id))
    : listTools();

  // If the model doesn't support native tool calling, don't send tools.
  // The model can still respond with text — it just can't invoke tools.
  if (!caps.toolCall) {
    enabledTools = [];
    log.debug(`Agent: tools disabled — model "${resolvedModelId}" does not support tool calling`);
    yield {
      type: "text_delta",
      content: `⚠ Model "${config.model}" does not support tool calling — running in chat-only mode.\n` +
        `  Tools (bash, browse, edit, etc.) are disabled. Switch to a tool-capable model for full agent features.\n\n`,
    };
  }

  // ─── Step 3: Build driver config with dynamic values ─────────────────
  const driverConfig: DriverConfig = {
    // Already resolved — drivers use this directly, no further resolution
    model: resolvedModelId,
    // Use explicit maxTokens, or model's maxOutput, capped at a sane default
    max_tokens: config.maxTokens ?? Math.min(caps.maxOutput || 4096, 16_384),
    temperature: config.temperature ?? 0.3,
    // Tools only if model supports them AND we have tools to send
    tools: enabledTools.length > 0 ? toDriverFormat(enabledTools) : undefined,
    // Extended thinking only if model has reasoning capability
    extended_thinking: caps.reasoning ? (config.extendedThinking ?? false) : false,
    system_prompt: config.systemPrompt,
    // Pass capabilities to driver for API-specific adaptations
    capabilities: caps,
    // Per-request abort signals are attached immediately before each driver call.
    // A no-progress timeout must abort only the stuck model request; the overall
    // run may still recover with a fresh request in the next loop iteration.
    signal: undefined,
  };

  // ─── Step 4: Dynamic compaction threshold from context window ────────
  const contextLimit = caps.context || DEFAULT_CONTEXT_LIMIT;
  const compactionThreshold = Math.floor(contextLimit * COMPACTION_CONTEXT_RATIO);

  // ─── Step 5: Initialize execution guard ──────────────────────────────
  const guard = new ExecutionGuard({ maxDurationMs });

  // ─── Step 6: Pre-trim history to fit within configured limits ────────
  // Prevents sending unbounded history to token-limited providers (Groq, etc.)
  // and reduces cost on providers billed by input tokens (Anthropic, OpenAI).
  // Tool call/result pairs are kept intact — never orphaned.
  const trimmed = trimHistory([...conversationHistory], {
    contextLimit,
    maxMessages: config.maxHistoryMessages,
    maxTokens: config.maxHistoryTokens,
  });

  // ─── Step 7: Validate tool call/result pairs ───────────────────────
  // Removes orphaned tool results, tool messages with missing tool_call_id,
  // and assistant tool_calls without matching results. Prevents 400 errors
  // from all providers (Anthropic, OpenAI, Groq, OpenRouter).
  const messages: DriverMessage[] = sanitizeToolPairs(trimmed);

  if (messages.length < conversationHistory.length) {
    log.debug(`Agent: history ${conversationHistory.length} → ${trimmed.length} (trimmed) → ${messages.length} (sanitized)`);
  }

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let streamNoProgressRecoveries = 0;
  let noProgressRecoveries = 0;
  const maxNoProgressRecoveries = 2;
  const repeatGuard = createToolRepeatGuard();
  const roundRepeatGuard = createToolRoundRepeatGuard();

  // Set active context so orchestrator tools (delegate, parallel) can access
  // the parent's system prompt, conversation, depth, and model during tool execution.
  setActiveContext({
    systemPrompt: config.systemPrompt,
    messages,
    depth: config.depth ?? 0,
    backend: config.backend,
    model: config.model,
  });

  try {

  for (let round = 0; round < maxRounds; round++) {
    // ── Guard: pre-round check (duration limit) ───────────────────────
    const durationCheck = guard.checkBeforeRound();
    if (durationCheck) {
      const durationSummary = buildNoProgressStopSummary(messages, durationCheck);
      const durationMsg = addMessage(config.sessionId, "assistant", durationSummary, { input: 0, output: estimateTokens(durationSummary) });
      addPart(durationMsg.id, "text", durationSummary);
      touchSession(config.sessionId);
      yield { type: "text_delta", content: durationSummary };
      yield { type: "turn_complete", tokensIn: totalTokensIn, tokensOut: totalTokensOut };
      return;
    }

    // Check for context compaction using dynamic threshold
    const currentTokens = estimateTokens(
      messages.map((m) => messageText(m)).join(""),
    );
    if (currentTokens >= compactionThreshold && messages.length >= MIN_MESSAGES_FOR_COMPACTION) {
      const beforeTokens = currentTokens;
      const compacted = compactHistory(messages, contextLimit);
      const afterTokens = estimateTokens(
        compacted.map((m) => messageText(m)).join(""),
      );
      messages.length = 0;
      messages.push(...compacted);
      yield { type: "compaction", beforeTokens, afterTokens };
    }

    // Stream response from LLM
    let fullText = "";
    const toolCalls: ToolCall[] = [];
    let hadError = false;

    try {
      activeRequestAbort = createModelRequestAbortController(runAbort.signal);
      const requestDriverConfig: DriverConfig = { ...driverConfig, signal: activeRequestAbort.signal };
      const stream = driver.chat(messages, requestDriverConfig)[Symbol.asyncIterator]();
      while (true) {
        const chunkResult = await nextStreamChunkWithNoProgressTimeout(stream, {
          startedAt,
          maxDurationMs,
          noProgressTimeoutMs,
          abort: () => activeRequestAbort?.abort("agent-no-progress"),
          describe: () => buildStuckDiagnosis({
            reason: "No new model/tool/DB progress was observed while waiting for the model stream.",
            round,
            elapsedMs: Date.now() - startedAt,
            idleMs: Math.min(noProgressTimeoutMs, Math.max(0, maxDurationMs - (Date.now() - startedAt))),
            model: resolvedModelId,
            backend: provider,
          }),
        });
        if (chunkResult.done) break;
        const chunk = chunkResult.value;
        switch (chunk.type) {
          case "text":
            fullText += chunk.content;
            yield { type: "text_delta", content: chunk.content };
            break;

          case "thinking":
            yield { type: "thinking", content: chunk.content };
            break;

          case "tool_call":
            if (chunk.tool_call) {
              toolCalls.push(chunk.tool_call);
              yield { type: "tool_call_start", toolCall: chunk.tool_call };
            }
            break;

          case "error":
            hadError = true;
            yield { type: "error", message: chunk.content };
            break;

          case "done":
            break;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (err instanceof AgentNoProgressError) {
        const diagnosis = errMsg;
        const remainingMs = maxDurationMs - (Date.now() - startedAt);
        if (streamNoProgressRecoveries < STREAM_NO_PROGRESS_RECOVERY_LIMIT && remainingMs > 30_000) {
          streamNoProgressRecoveries += 1;
          const beforeTokens = estimateTokens(messages.map((m) => messageText(m)).join(""));
          const recoveryContextLimit = Math.min(contextLimit, STREAM_NO_PROGRESS_RECOVERY_CONTEXT_LIMIT);
          const compacted = compactHistory(messages, recoveryContextLimit);
          const afterTokens = estimateTokens(compacted.map((m) => messageText(m)).join(""));
          messages.length = 0;
          messages.push(...compacted);
          const recoveryPrompt = buildModelStreamNoProgressRecoveryPrompt(diagnosis, beforeTokens, afterTokens);
          const recoveryMsg = addMessage(config.sessionId, "user", recoveryPrompt);
          addPart(recoveryMsg.id, "text", recoveryPrompt);
          messages.push({ role: "user", content: recoveryPrompt });
          yield { type: "compaction", beforeTokens, afterTokens };
          yield { type: "text_delta", content: recoveryPrompt };
          continue;
        }

        const finalDiagnosis = `${diagnosis}\n\n${buildNoProgressStopSummary(messages, "Model stream stopped before Jeriko could complete a normal final response.")}`;
        const guardMsg = addMessage(config.sessionId, "assistant", finalDiagnosis, { input: totalTokensIn, output: estimateTokens(finalDiagnosis) });
        addPart(guardMsg.id, "text", finalDiagnosis);
        touchSession(config.sessionId);
        yield { type: "text_delta", content: finalDiagnosis };
        yield { type: "error", message: diagnosis };
        yield { type: "turn_complete", tokensIn: totalTokensIn, tokensOut: totalTokensOut };
        return;
      }
      yield { type: "error", message: errMsg };
      log.error(`Agent loop error on round ${round}: ${errMsg}`);
      return;
    }

    // Estimate tokens for this turn (image blocks add ~1000 tokens each)
    const lastMsg = messages[messages.length - 1];
    const lastMsgText = lastMsg ? messageText(lastMsg) : "";
    const imageBlockCount = lastMsg && Array.isArray(lastMsg.content)
      ? lastMsg.content.filter((b) => b.type === "image").length
      : 0;
    const turnTokensIn = estimateTokens(lastMsgText) + (imageBlockCount * 1000);
    const turnTokensOut = estimateTokens(fullText);
    totalTokensIn += turnTokensIn;
    totalTokensOut += turnTokensOut;

    // If the model already produced a final verification/report-style answer,
    // treat that as DONE even if it also emitted stray tool calls. This prevents
    // post-report read/check loops after the requested final report exists.
    if (toolCalls.length > 0 && isFinalAssistantReport(fullText)) {
      toolCalls.length = 0;
    }

    // Persist assistant message — always persist, even when text is empty.
    // Tool-only responses (empty text + tool_calls) must be stored so that
    // session history can be fully reconstructed from DB. Without this,
    // tool result messages become orphaned (no preceding assistant with
    // tool_calls), which OpenAI's API rejects.
    if (fullText || toolCalls.length > 0) {
      const assistantMsg = addMessage(
        config.sessionId,
        "assistant",
        fullText,
        { input: turnTokensIn, output: turnTokensOut },
      );
      if (fullText) addPart(assistantMsg.id, "text", fullText);
      for (const tc of toolCalls) {
        addPart(assistantMsg.id, "tool_call", tc.arguments, tc.name, tc.id);
      }
      messages.push({
        role: "assistant",
        content: fullText,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });
    }

    // If no tool calls, the turn is complete
    if (toolCalls.length === 0 || hadError) {
      if (!hadError && requiresAppFactoryVerification(messages, fullText) && !hasAppFactoryDoneEvidence(messages)) {
        const gateMessage = "\n\nAPP_FACTORY_DONE_GATE: Final report blocked. Generated/scaffolded/existing web-app implementation work must call verify_app and pass placeholder_scan, unsafe_env_scan, install, check, build, start_route, and browser_smoke, then save a git checkpoint/commit before claiming done. If screenshots, Lighthouse, preview deploy, or disabled-route checks were requested and cannot be completed, report them explicitly as blockers instead of claiming completion. Call verify_app/checkpoint now, then produce the final report from that evidence.";
        const gateMsg = addMessage(config.sessionId, "user", gateMessage);
        addPart(gateMsg.id, "text", gateMessage);
        messages.push({ role: "user", content: gateMessage });
        yield { type: "text_delta", content: gateMessage };
        continue;
      }
      touchSession(config.sessionId);
      yield { type: "turn_complete", tokensIn: totalTokensIn, tokensOut: totalTokensOut };
      return;
    }

    // ── Execute tool calls ────────────────────────────────────────────
    const toolResults: ToolResult[] = [];
    const roundRepeatCheck = roundRepeatGuard(toolCalls);

    if (roundRepeatCheck) {
      for (const tc of toolCalls) {
        const result = `${roundRepeatCheck}\nStop rereading the same files or rerunning the same checks. Use the results already in context and provide the final answer now.`;
        const isError = true;
        toolResults.push({ tool_call_id: tc.id, content: result, is_error: isError });
        yield { type: "tool_result", toolCallId: tc.id, result, isError };
        const toolMsg = addMessage(config.sessionId, "tool", result);
        addPart(toolMsg.id, "error", result, tc.name, tc.id);
        messages.push({ role: "tool", content: result, tool_call_id: tc.id });
      }

      noProgressRecoveries += 1;
      if (noProgressRecoveries <= maxNoProgressRecoveries) {
        const recoveryPrompt = buildNoProgressRecoveryPrompt(messages, roundRepeatCheck);
        const recoveryMsg = addMessage(config.sessionId, "user", recoveryPrompt);
        addPart(recoveryMsg.id, "text", recoveryPrompt);
        messages.push({ role: "user", content: recoveryPrompt });
        yield { type: "text_delta", content: recoveryPrompt };
        continue;
      }

      const forcedSummary = buildNoProgressStopSummary(messages, roundRepeatCheck);
      const guardMsg = addMessage(config.sessionId, "assistant", forcedSummary, { input: 0, output: estimateTokens(forcedSummary) });
      addPart(guardMsg.id, "text", forcedSummary);
      yield { type: "text_delta", content: forcedSummary };
      yield { type: "turn_complete", tokensIn: totalTokensIn, tokensOut: totalTokensOut };
      return;
    }

    for (const tc of toolCalls) {
      // Resolve tool — supports dotted names from OSS models (e.g. "browser.click")
      const { tool, inferredAction } = resolveDottedTool(tc.name);

      let result: string;
      let isError = false;

      const repeatCheck = repeatGuard(tc);
      if (repeatCheck) {
        result = `${repeatCheck}\nDo not call the same tool with the same arguments again. Use the previous result and choose a different next step toward the user's request.`;
        isError = true;
      } else if (!tool) {
        result = `Tool "${tc.name}" not found`;
        isError = true;
      } else {
        // Guard: per-tool rate limit check
        const rateCheck = guard.checkToolCall(tool.name);
        if (rateCheck) {
          result = rateCheck;
          isError = true;
        } else {
          try {
            const args = parseToolArgs(tc.arguments);
            // Inject inferred action from dotted name (e.g. "browser.click" → action:"click")
            if (inferredAction && !args.action) {
              args.action = inferredAction;
            }
            result = await tool.execute(args);
          } catch (err) {
            result = err instanceof Error ? err.message : String(err);
            isError = true;
          }
        }
      }

      toolResults.push({ tool_call_id: tc.id, content: result, is_error: isError });
      yield { type: "tool_result", toolCallId: tc.id, result, isError };

      // Persist tool result
      const toolMsg = addMessage(config.sessionId, "tool", result);
      addPart(toolMsg.id, isError ? "error" : "tool_result", result, tc.name, tc.id);
      messages.push({ role: "tool", content: result, tool_call_id: tc.id });
    }

    // ── Guard: post-round circuit breaker ─────────────────────────────
    const allFailed = toolResults.every((r) => r.is_error);
    const breakerCheck = guard.recordRound(allFailed);
    if (breakerCheck) {
      yield { type: "text_delta", content: breakerCheck };
      yield { type: "turn_complete", tokensIn: totalTokensIn, tokensOut: totalTokensOut };
      return;
    }

    log.debug(`Agent round ${round + 1}: ${toolCalls.length} tool(s) executed, continuing`);
  }

  // Max rounds exceeded. Do not leave the operator with only a framework error;
  // persist a concrete recap from captured tool evidence so completed work,
  // verification status, and localhost URL are still visible.
  const maxRoundsSummary = buildNoProgressStopSummary(messages, `Agent loop exceeded maximum rounds (${maxRounds}).`);
  const maxRoundsMsg = addMessage(config.sessionId, "assistant", maxRoundsSummary, { input: 0, output: estimateTokens(maxRoundsSummary) });
  addPart(maxRoundsMsg.id, "text", maxRoundsSummary);
  touchSession(config.sessionId);
  yield { type: "text_delta", content: maxRoundsSummary };
  yield { type: "error", message: `Agent loop exceeded maximum rounds (${maxRounds})` };
  yield { type: "turn_complete", tokensIn: totalTokensIn, tokensOut: totalTokensOut };

  } finally {
    // Always clear active context when the agent loop exits,
    // regardless of whether it completed normally or threw.
    clearActiveContext();
    config.signal?.removeEventListener("abort", forwardAbort);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface NoProgressTimeoutOptions {
  startedAt: number;
  maxDurationMs: number;
  noProgressTimeoutMs: number;
  abort?: () => void;
  describe: () => string;
}

export async function nextStreamChunkWithNoProgressTimeout<T>(
  stream: AsyncIterator<T>,
  options: NoProgressTimeoutOptions,
): Promise<IteratorResult<T>> {
  const elapsedMs = Date.now() - options.startedAt;
  const remainingWallMs = options.maxDurationMs - elapsedMs;
  const timeoutMs = Math.min(options.noProgressTimeoutMs, remainingWallMs);

  if (timeoutMs <= 0) {
    options.abort?.();
    await stream.return?.();
    throw new AgentNoProgressError(options.describe());
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const nextPromise = stream.next();
  // If the timeout wins and aborts the driver, the already-started next()
  // may later reject. Observe it here so it cannot become an unhandled rejection.
  nextPromise.catch(() => undefined);
  try {
    return await Promise.race([
      nextPromise,
      new Promise<IteratorResult<T>>((_, reject) => {
        timer = setTimeout(() => {
          options.abort?.();
          reject(new AgentNoProgressError(options.describe()));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof AgentNoProgressError) {
      await stream.return?.().catch(() => undefined);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function buildStuckDiagnosis(args: {
  reason: string;
  round: number;
  elapsedMs: number;
  idleMs: number;
  model: string;
  backend: string;
}): string {
  return [
    "Agent stuck/no-progress guard stopped the run.",
    args.reason,
    `Diagnosis: model loop produced no new stream, tool, or persisted DB progress for ${Math.round(args.idleMs / 1000)}s while the foreground ask was still active.`,
    `Context: backend=${args.backend} model=${args.model} round=${args.round + 1} elapsed=${Math.round(args.elapsedMs / 1000)}s.`,
    "Action taken: aborted the model stream and persisted this diagnosis instead of allowing Jeriko to spin indefinitely.",
    "Exit status: timeout/non-zero for foreground ask clients.",
  ].join("\n");
}

export function buildModelStreamNoProgressRecoveryPrompt(diagnosis: string, beforeTokens: number, afterTokens: number): string {
  return [
    "MODEL_STREAM_NO_PROGRESS_RECOVERY: The previous model request produced no stream/tool/DB progress before the watchdog fired.",
    diagnosis,
    `History was compacted before retry: ${beforeTokens} estimated tokens → ${afterTokens} estimated tokens.`,
    "Do not repeat broad file/status inspection. Use the evidence already present, take one distinct next action only, then report the result.",
    "If the requested work is already implemented and verified, stop using tools and provide the final report now.",
  ].join("\n");
}

// Repeated identical tool calls are almost always no-progress loops. This hit
// Jeriko's app-builder flow where the model called `jeriko create --help &&
// jeriko dev --help` dozens of times instead of building the app. Keep this
// local to one run so legitimate future turns are unaffected.
export function createToolRepeatGuard(maxConsecutive = 3): (toolCall: ToolCall) => string | null {
  let lastSignature = "";
  let consecutive = 0;

  return (toolCall: ToolCall) => {
    const signature = toolCallSignature(toolCall);
    if (signature === lastSignature) {
      consecutive += 1;
    } else {
      lastSignature = signature;
      consecutive = 1;
    }

    if (consecutive >= maxConsecutive) {
      return `Repeated identical tool call blocked after ${consecutive} attempts: ${summarizeToolCall(toolCall)}`;
    }
    return null;
  };
}

// Repeated rounds of successful read/check calls are also no-progress loops.
// The previous single-call guard missed patterns like repeatedly reading
// build-anti-drift.md + Home.tsx + App.tsx + button.tsx, with occasional
// `pnpm check` calls in between, until maxRounds was exhausted. Track round
// signatures over the whole run so repeated investigation batches stop early.
export function createToolRoundRepeatGuard(maxSeen = 3): (toolCalls: ToolCall[]) => string | null {
  const seen = new Map<string, number>();

  return (toolCalls: ToolCall[]) => {
    const signature = toolRoundSignature(toolCalls);
    const count = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, count);

    if (count >= maxSeen) {
      return `Repeated no-progress tool round blocked after ${count} matching rounds: ${summarizeToolRound(toolCalls)}`;
    }
    return null;
  };
}

export function toolRoundSignature(toolCalls: ToolCall[]): string {
  return toolCalls.map(toolCallSignature).sort().join("\n");
}

function summarizeToolRound(toolCalls: ToolCall[]): string {
  return toolCalls.map(summarizeToolCall).join("; ").slice(0, 500);
}

export function toolCallSignature(toolCall: ToolCall): string {
  return `${toolCall.name}:${normalizeToolArguments(toolCall.arguments)}`;
}

function normalizeToolArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(sortJsonValue(parsed));
  } catch {
    return raw.trim().replace(/\s+/g, " ");
  }
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortJsonValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function summarizeToolCall(toolCall: ToolCall): string {
  try {
    const parsed = JSON.parse(toolCall.arguments);
    if (typeof parsed.command === "string") {
      return `${toolCall.name} ${JSON.stringify(parsed.command.slice(0, 240))}`;
    }
  } catch { /* ignore */ }
  return `${toolCall.name} ${toolCall.arguments.slice(0, 240)}`;
}

export function buildNoProgressStopSummary(messages: DriverMessage[], reason: string): string {
  const state = getCapturedVerificationState(messages);
  const gateLines = state.verifyAppGates.length > 0
    ? state.verifyAppGates.map((gate) => `  - ${gate.name}: ${gate.ok ? "passed" : "FAILED"}${gate.output ? ` — ${gate.output}` : ""}`)
    : ["  - verify_app: not run or not captured"];
  const localUrlLines = state.localUrls.length > 0
    ? state.localUrls.map((url) => `- ${url}`)
    : ["- not captured"];
  const doneLines = state.completedActions.length > 0
    ? state.completedActions.map((item) => `- ${item}`)
    : ["- no concrete completed actions were captured before the guard stopped the run"];
  const notDoneLines = state.notDone.length > 0
    ? state.notDone.map((item) => `- ${item}`)
    : ["- no captured blockers; review the verification lines above before claiming more"];

  const lines = [
    reason.startsWith("Agent loop exceeded") ? "Agent loop stopped at the maximum-round safety limit." : "No-progress guard stopped the run.",
    reason,
    "",
    "Operator recap:",
    "",
    "What Jeriko did:",
    ...doneLines,
    "",
    "Localhost URL:",
    ...localUrlLines,
    "",
    "Verification gates:",
    ...gateLines,
    "",
    "Current verified state:",
    `- pnpm check: ${state.checkPassed ? "passed" : "not verified in the captured context"}`,
    `- pnpm build: ${state.buildPassed ? "passed" : "not verified in the captured context"}`,
    `- changed files: ${state.noChangedFiles ? "none" : "not verified in the captured context"}`,
    `- code_integrity guard triggered: ${state.codeIntegrityTriggered ? "yes" : "no"}`,
    state.changedFilesSummary ? `- latest changed files: ${state.changedFilesSummary}` : "- latest changed files: not captured",
    state.checkpoint ? `- checkpoint: ${state.checkpoint}` : "- checkpoint: not captured",
    "",
    "What Jeriko did not finish / did not prove:",
    ...notDoneLines,
    "",
    "Action taken: stopped after bounded recovery attempts instead of rereading the same files or rerunning the same checks.",
  ];
  return lines.join("\n");
}

export function buildNoProgressRecoveryPrompt(messages: DriverMessage[], reason: string): string {
  const state = getCapturedVerificationState(messages);
  const nextStep = !state.checkPassed
    ? "Run the existing typecheck/check command once, or report the exact blocker if it cannot run."
    : !state.buildPassed
      ? "Run the existing build command once, or report the exact blocker if it cannot run."
      : "Stop using tools and provide the final answer from the verified evidence already in context.";

  return [
    "NO_PROGRESS_RECOVERY: You repeated the same no-progress tool round.",
    reason,
    "Do not call the same tool(s) with the same arguments again.",
    "Use the existing context and take the next distinct step only.",
    `Next required action: ${nextStep}`,
  ].join("\n");
}

interface CapturedGateState {
  name: string;
  ok: boolean;
  output?: string;
}

interface CapturedVerificationState {
  checkPassed: boolean;
  buildPassed: boolean;
  noChangedFiles: boolean;
  codeIntegrityTriggered: boolean;
  changedFilesSummary: string;
  checkpoint: string;
  localUrls: string[];
  verifyAppGates: CapturedGateState[];
  completedActions: string[];
  notDone: string[];
}

function getCapturedVerificationState(messages: DriverMessage[]): CapturedVerificationState {
  const toolTexts = messages.filter((msg) => msg.role === "tool").map((msg) => messageText(msg));
  const latestMutationIndex = latestGeneratedAppMutationIndex(toolTexts);
  const checkPassed = toolTexts.some((text, index) => index > latestMutationIndex && text.includes("tsc --noEmit") && !/error TS\d+|\bFAILED\b|\bERR_/i.test(text));
  const buildPassed = toolTexts.some((text, index) => index > latestMutationIndex && ((text.includes("vite build") && text.includes("✓ built in")) || (text.includes("bun build") && !/error TS\d+|\bFAILED\b|\bERR_/i.test(text))));
  const workspaceTexts = toolTexts.filter((text) => text.includes('"diffStat"') || text.includes('"changed_files"'));
  const latestWorkspace = workspaceTexts.at(-1) ?? "";
  const noChangedFiles = latestWorkspace.includes('"diffStat":""') || latestWorkspace.includes('"diffStat": ""') || latestWorkspace.includes('changed_files: 0') || latestWorkspace.includes('"changed_files": 0');
  const codeIntegrityTriggered = toolTexts.some((text) => text.includes('"guard":"code_integrity"') || text.includes("code_integrity"));
  const parsedToolResults = toolTexts.map(parseToolResultJson).filter((value): value is Record<string, any> => Boolean(value && typeof value === "object" && !Array.isArray(value)));

  const localUrls = uniqueStrings([
    ...toolTexts.flatMap(extractLocalUrls),
    ...parsedToolResults.flatMap((parsed) => {
      const urls: string[] = [];
      if (typeof parsed?.data?.server?.url === "string") urls.push(parsed.data.server.url);
      if (typeof parsed?.server?.url === "string") urls.push(parsed.server.url);
      return urls;
    }),
  ]).slice(0, 4);

  const verifyResults = parsedToolResults.filter((parsed) => {
    const gates = parsed?.data?.gates ?? parsed?.gates;
    return Array.isArray(gates);
  });
  const latestVerify = verifyResults.at(-1);
  const verifyAppGates: CapturedGateState[] = Array.isArray(latestVerify?.data?.gates ?? latestVerify?.gates)
    ? (latestVerify?.data?.gates ?? latestVerify?.gates).map((gate: any) => ({
      name: String(gate?.name ?? "unknown"),
      ok: gate?.ok === true,
      output: summarizeGateOutput(gate?.output),
    }))
    : [];

  const latestWorkspaceJson = parseToolResultJson(latestWorkspace);
  const changedFilesSummary = summarizeChangedFiles(latestWorkspaceJson) || summarizeChangedFilesFromText(latestWorkspace);

  const checkpointResult = parsedToolResults.findLast((parsed) => typeof parsed?.data?.hash === "string" || typeof parsed?.hash === "string");
  const checkpointHash = checkpointResult?.data?.hash ?? checkpointResult?.hash;
  const checkpointMessage = checkpointResult?.data?.message ?? checkpointResult?.message;
  const checkpoint = checkpointHash ? `${checkpointHash}${checkpointMessage ? ` — ${checkpointMessage}` : ""}` : "";

  const completedActions = buildCompletedActions(parsedToolResults, verifyAppGates, changedFilesSummary, checkpoint, checkPassed, buildPassed);
  const notDone = buildNotDoneList(verifyAppGates, latestVerify, checkPassed, buildPassed, localUrls);

  return { checkPassed, buildPassed, noChangedFiles, codeIntegrityTriggered, changedFilesSummary, checkpoint, localUrls, verifyAppGates, completedActions, notDone };
}

function parseToolResultJson(text: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
  } catch {
    const firstBrace = text.indexOf("{");
    const lastBrace = text.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) return null;
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : null;
    } catch {
      return null;
    }
  }
}

function latestGeneratedAppMutationIndex(toolTexts: string[]): number {
  let latest = -1;
  for (let index = 0; index < toolTexts.length; index += 1) {
    const parsed = parseToolResultJson(toolTexts[index] ?? "");
    const changedPath = typeof parsed?.path === "string"
      ? parsed.path
      : typeof parsed?.data?.path === "string"
        ? parsed.data.path
        : "";
    if (parsed?.ok === true && isCodeMutationPath(changedPath)) latest = index;
  }
  return latest;
}

function isCodeMutationPath(filePath: string): boolean {
  return /\.(tsx?|jsx?|css|json|html|mdx?)$/i.test(filePath);
}

function extractLocalUrls(text: string): string[] {
  return [...text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/[\w./?=&%-]*)?/g)].map((match) => match[0]);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function summarizeGateOutput(output: unknown): string {
  if (typeof output !== "string" || !output.trim()) return "";
  return output.trim().replace(/\s+/g, " ").slice(0, 220);
}

function summarizeChangedFiles(workspace: Record<string, any> | null): string {
  const git = workspace?.git;
  if (!git || typeof git !== "object") return "";
  const diffStat = typeof git.diffStat === "string" ? git.diffStat.trim() : "";
  const status = typeof git.status === "string" ? git.status.trim() : "";
  return (diffStat || status).replace(/\n/g, "; ").slice(0, 500);
}

function summarizeChangedFilesFromText(text: string): string {
  const match = text.match(/"diffStat"\s*:\s*"([\s\S]*?)"\s*[,}]/);
  if (!match?.[1]) return "";
  return match[1].replace(/\\n/g, "; ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function buildCompletedActions(
  parsedToolResults: Record<string, any>[],
  gates: CapturedGateState[],
  changedFilesSummary: string,
  checkpoint: string,
  checkPassed: boolean,
  buildPassed: boolean,
): string[] {
  const actions: string[] = [];
  if (changedFilesSummary) actions.push(`changed files: ${changedFilesSummary}`);
  if (checkPassed) actions.push("TypeScript/check command passed");
  if (buildPassed) actions.push("production build passed");
  if (gates.length > 0) actions.push(`verify_app ran with ${gates.filter((gate) => gate.ok).length}/${gates.length} passing gates`);
  if (checkpoint) actions.push(`saved checkpoint ${checkpoint}`);
  const webdevStatus = parsedToolResults.findLast((parsed) => parsed?.data?.server?.running === true);
  if (webdevStatus?.data?.project) actions.push(`webdev reports project ${webdevStatus.data.project} running`);
  return uniqueStrings(actions);
}

function buildNotDoneList(
  gates: CapturedGateState[],
  latestVerify: Record<string, any> | undefined,
  checkPassed: boolean,
  buildPassed: boolean,
  localUrls: string[],
): string[] {
  const items: string[] = [];
  if (!checkPassed) items.push("pnpm check / TypeScript was not proven passing in captured output");
  if (!buildPassed) items.push("production build was not proven passing in captured output");
  if (gates.length === 0) {
    items.push("verify_app did not run or its result was not captured");
  } else {
    for (const gate of gates.filter((gate) => !gate.ok)) {
      items.push(`${gate.name} failed${gate.output ? `: ${gate.output}` : ""}`);
    }
    if (latestVerify?.ok !== true) items.push("latest verify_app result was not fully green");
  }
  if (localUrls.length === 0) items.push("localhost URL was not captured");
  return uniqueStrings(items);
}

export function requiresAppFactoryVerification(messages: DriverMessage[], finalText: string): boolean {
  if (!isFinalAssistantReport(finalText)) return false;
  const combined = [...messages.map((msg) => messageText(msg)), finalText].join("\n").toLowerCase();
  const mentionsGeneratedAppWork = /\b(scaffold|scaffolded|generated app|generate(d)?\s+(a\s+)?(full-stack|web|app)|jeriko\s+create|create\s+web-static|create\s+web-db-user|web-static|web-db-user)\b/.test(combined);
  const mentionsExistingWebAppImplementation = /\b(existing\s+(react|vite|tailwind|vercel|web)\s+(site|app)|react\s*\+\s*vite|vite\s*\+\s*tailwind|vercel\s+(site|app|preview)|programmatic\s+local\s+seo|local\s+seo\s+architecture|preview\s+deploy(?:ed|ment)?)\b/.test(combined)
    && /\b(add|build|implement|update|modify|fix|deploy(?:ed)?|created?|committed?|verified)\b/.test(combined);
  const explicitlyReadOnly = /\b(read[- ]only|audit only|analysis only|do not change|do not modify|no code changes)\b/.test(combined);
  const explicitlyNotAppBuilder = /\b(no scaffold|do not scaffold|not generated)\b/.test(combined);
  return (mentionsGeneratedAppWork && !explicitlyNotAppBuilder) || (mentionsExistingWebAppImplementation && !explicitlyReadOnly);
}

export function hasAppFactoryDoneEvidence(messages: DriverMessage[]): boolean {
  return hasPassingVerifyApp(messages) && hasCheckpointEvidence(messages);
}

export function hasCheckpointEvidence(messages: DriverMessage[]): boolean {
  return messages.some((msg) => {
    if (msg.role !== "tool") return false;
    const text = messageText(msg);
    const parsed = parseToolResultJson(text);
    const hash = parsed?.data?.hash ?? parsed?.hash ?? parsed?.commit ?? parsed?.data?.commit;
    if (typeof hash === "string" && /^[a-f0-9]{7,40}$/i.test(hash)) return true;
    return /\b\[[\w/-]+\s+[a-f0-9]{7,40}\]\s+.+/.test(text) || /\bcommit(?:ted)?\b[\s\S]{0,120}\b[a-f0-9]{7,40}\b/i.test(text);
  });
}

export function hasPassingVerifyApp(messages: DriverMessage[]): boolean {
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const text = messageText(msg);
    if (!text.includes('"browser_smoke"') || !text.includes('"start_route"')) continue;
    try {
      const parsed = JSON.parse(text);
      const gates = parsed?.data?.gates;
      if (parsed?.ok === true && Array.isArray(gates)) {
        const required = ["placeholder_scan", "unsafe_env_scan", "install", "check", "build", "start_route", "browser_smoke"];
        if (required.every((name) => gates.some((gate: any) => gate?.name === name && gate?.ok === true))) return true;
      }
    } catch {
      // Fall back to text detection for older captured tool outputs.
      const hasAllGateNames = ["placeholder_scan", "install", "check", "build", "start_route", "browser_smoke"].every((name) => text.includes(`"${name}"`));
      if (hasAllGateNames && /"ok"\s*:\s*true/.test(text) && !/"ok"\s*:\s*false/.test(text)) return true;
    }
  }
  return false;
}

export function isFinalAssistantReport(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  const hasReportHeading = /(^|\n)\s*#{0,3}\s*(verified fixed now|exact evidence|plain answer|verification results|files changed|remaining issues)\b/i.test(text);
  const hasDoneSignal = /\b(done|completed|verified|passes|passed)\b/i.test(text);
  const hasVerification = /\b(pnpm|bun|npm)\s+(run\s+)?(check|build|test)\b|\btsc\s+--noemit\b|\bbuild\s+passed\b/i.test(text);
  return hasReportHeading && hasDoneSignal && hasVerification;
}

/**
 * Parse tool call arguments with repair for common OSS model JSON issues.
 *
 * OSS models (Llama, Qwen, Mistral, DeepSeek) frequently produce:
 *   - Trailing commas: {"a": 1, "b": 2,}
 *   - Single-quoted strings: {'key': 'value'}
 *   - Unquoted keys: {key: "value"}
 *   - Wrapped in markdown: ```json\n{...}\n```
 *   - Empty or whitespace-only strings
 *
 * We try JSON.parse first (fast path), then repair common issues.
 */
function parseToolArgs(raw: string): Record<string, unknown> {
  // Fast path — valid JSON
  try {
    return JSON.parse(raw);
  } catch {
    // Fall through to repair
  }

  let s = raw.trim();

  // Empty arguments → empty object
  if (!s) return {};

  // Strip markdown code fences: ```json\n{...}\n```
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  }

  // Trailing commas before closing brackets
  s = s.replace(/,\s*([}\]])/g, "$1");

  // Single-quoted strings → double-quoted
  // Only do this if there are no double quotes at all (avoid breaking mixed quotes)
  if (!s.includes('"') && s.includes("'")) {
    s = s.replace(/'/g, '"');
  }

  // Unquoted keys: { key: "value" } → { "key": "value" }
  s = s.replace(/([{,]\s*)([a-zA-Z_]\w*)\s*:/g, '$1"$2":');

  try {
    return JSON.parse(s);
  } catch {
    // Last resort — the original error is more useful than the repair error
    return JSON.parse(raw);
  }
}

