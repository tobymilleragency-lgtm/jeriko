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
import { isAbsolute, resolve } from "node:path";
import { GENERATED_COPY_EDIT_CONFIRMATION } from "./tools/generated-copy-guard.js";

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
  /** Working directory for this run. Injected into cwd-aware tools when the model omits cwd. */
  cwd?: string;
  /** Hard wall-clock cap for the whole agent run. Defaults to 10 minutes. */
  maxDurationMs?: number;
  /** Hard RSS memory cap for this agent run in bytes. Defaults to 2 GiB; set <=0 to disable. */
  maxRssBytes?: number;
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
export const DEFAULT_AGENT_MAX_RSS_BYTES = 2048 * 1024 * 1024;
const AGENT_RESOURCE_MONITOR_INTERVAL_MS = 1000;
const STREAM_NO_PROGRESS_RECOVERY_LIMIT = 1;
const STREAM_NO_PROGRESS_RECOVERY_CONTEXT_LIMIT = 80_000;

export class AgentNoProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentNoProgressError";
  }
}

export class AgentResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentResourceLimitError";
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "unknown";
  const mib = bytes / (1024 * 1024);
  if (mib < 1024) return `${mib.toFixed(0)} MiB`;
  return `${(mib / 1024).toFixed(2)} GiB`;
}

export function buildAgentResourceLimitMessage(args: {
  rssBytes: number;
  maxRssBytes: number;
  elapsedMs: number;
  backend: string;
  model: string;
}): string {
  return [
    "Agent resource guard stopped the run.",
    `Reason: Jeriko process RSS reached ${formatBytes(args.rssBytes)}, above the configured cap of ${formatBytes(args.maxRssBytes)}.`,
    `Context: backend=${args.backend} model=${args.model} elapsed=${Math.round(args.elapsedMs / 1000)}s.`,
    "Action taken: aborted the active model/tool turn before Linux could OOM-kill the desktop session.",
    "Exit status: resource-limit/non-zero for foreground ask clients.",
  ].join("\n");
}

export function checkAgentResourceLimit(maxRssBytes: number | undefined, args: {
  startedAt: number;
  backend: string;
  model: string;
}): string | null {
  const limit = maxRssBytes ?? DEFAULT_AGENT_MAX_RSS_BYTES;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const rssBytes = process.memoryUsage().rss;
  if (rssBytes <= limit) return null;
  return buildAgentResourceLimitMessage({
    rssBytes,
    maxRssBytes: limit,
    elapsedMs: Date.now() - args.startedAt,
    backend: args.backend,
    model: args.model,
  });
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
  const maxRssBytes = config.maxRssBytes ?? DEFAULT_AGENT_MAX_RSS_BYTES;
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
  let resourceLimitMessage: string | null = null;
  const checkResourceLimit = () => {
    resourceLimitMessage = checkAgentResourceLimit(maxRssBytes, {
      startedAt,
      backend: provider,
      model: resolvedModelId,
    });
    if (resourceLimitMessage) {
      activeRequestAbort?.abort("agent-resource-limit");
      runAbort.abort("agent-resource-limit");
    }
    return resourceLimitMessage;
  };
  let resourceTimer: ReturnType<typeof setInterval> | undefined;

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
  const generatedCopyEditConfirmed = messages.some((message) => message.role === "user" && messageText(message).includes(GENERATED_COPY_EDIT_CONFIRMATION));
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
    if (maxRssBytes > 0) {
      resourceTimer = setInterval(() => { checkResourceLimit(); }, AGENT_RESOURCE_MONITOR_INTERVAL_MS);
    }

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

    if (checkResourceLimit()) {
      const resourceSummary = `${resourceLimitMessage}\n\n${buildNoProgressStopSummary(messages, "Jeriko stopped because the process crossed the configured memory ceiling.")}`;
      const resourceMsg = addMessage(config.sessionId, "assistant", resourceSummary, { input: totalTokensIn, output: estimateTokens(resourceSummary) });
      addPart(resourceMsg.id, "text", resourceSummary);
      touchSession(config.sessionId);
      yield { type: "text_delta", content: resourceSummary };
      yield { type: "error", message: resourceLimitMessage ?? "Agent resource limit exceeded" };
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
          checkResourceLimit,
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
        if (resourceLimitMessage ?? checkResourceLimit()) {
          throw new AgentResourceLimitError(resourceLimitMessage ?? "Agent resource limit exceeded");
        }
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
      if (err instanceof AgentResourceLimitError || resourceLimitMessage) {
        const diagnosis = resourceLimitMessage ?? errMsg;
        const finalDiagnosis = `${diagnosis}\n\n${buildNoProgressStopSummary(messages, "Jeriko stopped because the process crossed the configured memory ceiling.")}`;
        const guardMsg = addMessage(config.sessionId, "assistant", finalDiagnosis, { input: totalTokensIn, output: estimateTokens(finalDiagnosis) });
        addPart(guardMsg.id, "text", finalDiagnosis);
        touchSession(config.sessionId);
        yield { type: "text_delta", content: finalDiagnosis };
        yield { type: "error", message: diagnosis };
        yield { type: "turn_complete", tokensIn: totalTokensIn, tokensOut: totalTokensOut };
        return;
      }
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
          continue;
        }

        const finalDiagnosis = buildNoProgressStopSummary(messages, "Model stream stopped before Jeriko could complete a normal final response.");
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
      if (!hadError && requiresExplicitDeliverableVerification(messages, fullText) && !hasExplicitDeliverableDoneEvidence(messages)) {
        const gateMessage = "\n\nEXPLICIT_DELIVERABLE_DONE_GATE: Final report blocked. This task listed concrete deliverables (separate fix commits, push/deploy, live curl/raw-HTML checks, P0/no-new-blocker confirmation, or a required pause marker). Do not claim completion from partial progress. Gather tool-backed evidence for every requested commit label/hash, every requested live verification check, and every requested audit/P0 confirmation, then produce the final report from that evidence.";
        const gateMsg = addMessage(config.sessionId, "user", gateMessage);
        addPart(gateMsg.id, "text", gateMessage);
        messages.push({ role: "user", content: gateMessage });
        continue;
      }
      if (!hadError && requiresAppFactoryVerification(messages, fullText) && !hasAppFactoryDoneEvidence(messages)) {
        const missingRouteBreadthProof = requiresRouteBreadthVerification(messages) && !hasRouteBreadthEvidence(messages);
        const missingContentStructure = requiresContentStructureVerification(messages) && !hasContentStructureEvidence(messages);
        const missingAiScannerProof = requiresAiScannerVerification(messages) && !hasAiScannerEvidence(messages);
        const missingPremiumMarketingProof = requiresPremiumMarketingVerification(messages) && !hasPremiumMarketingEvidence(messages);
        const missingProductionDeployProof = requiresProductionDeployVerification(messages) && !hasProductionDeployEvidence(messages);
        const missingProductWorkflowProof = requiresProductWorkflowVerification(messages) && !hasProductWorkflowEvidence(messages);
        const gateMessage = missingRouteBreadthProof
          ? "\n\nAPP_FACTORY_DONE_GATE: Final report blocked. Full web-app/site work requires route-breadth proof before claiming completion. Prove ROUTE_BREADTH_OK with the implemented routable pages from appSpec/user request, including each requested page such as /services, /industries, /case-studies, /process, /pricing, /resources, and /contact. A one-page landing page plus check/build/verify is not a completed full app."
          : missingContentStructure
            ? "\n\nAPP_FACTORY_DONE_GATE: Final report blocked. Content-heavy web-app/page work requires tool-backed content structure evidence before claiming completion. Audit rendered service/city/content pages and prove CONTENT_STRUCTURE_OK: semantic sections, h2/h3 hierarchy, multiple readable paragraphs per long-form section, paragraph lengths under 650 characters, and no wall-of-text blocks; also keep verify_app + checkpoint + persistent localhost preview evidence."
            : missingAiScannerProof
            ? "\n\nAPP_FACTORY_DONE_GATE: Final report blocked. AI scanner work requires scanner-specific proof before claiming completion. Invoke the live scanner route/API with a real product text/photo payload (or report the exact provider/API blocker) and capture LIVE_AI_SCANNER_OK with app.aiScanner/scanner API evidence plus returned productName/decision/confidence/pricing fields. Generic check/build/browser-smoke evidence is not enough."
            : missingPremiumMarketingProof
              ? "\n\nAPP_FACTORY_DONE_GATE: Final report blocked. Contractor/local-service marketing site work requires premium conversion-system proof before claiming completion. Run verify_app and prove `premium_marketing_site_scan` passed, preserving SPA-safe AppLink/useLocation navigation, a visible Home nav item, LeadOpsVisual, LeadFlowLineSection, LeadLeakAudit, BeforeAfterComparison, StickyAuditRail, dark no-flash base styles, Vercel dist/public static routing, useful service-area/city pages, and no glued UI copy. Brochureware plus generic check/build/browser-smoke evidence is not enough."
              : missingProductionDeployProof
                ? "\n\nAPP_FACTORY_DONE_GATE: Final report blocked. Production deploy work requires deploy_app or equivalent live production evidence before claiming completion. Prove Vercel deployment/alias, production URL smoke, and for web-db-user apps production Google OAuth /status + /start + no Google redirect_uri_mismatch. If Google Cloud or DNS is the blocker, report BLOCKED with exact external action instead of saying fixed."
                : missingProductWorkflowProof
                  ? "\n\nAPP_FACTORY_DONE_GATE: Final report blocked. Full-stack product app work requires live product workflow proof before claiming completion. Prove PRODUCT_WORKFLOW_OK or READ_AFTER_WRITE_OK with a real create/save/scan/order/listing request, returned ID/result, and list/detail readback from the generated backend/database. Static verify_app, check/build, and browser smoke are not enough for production-builder claims."
                  : "\n\nAPP_FACTORY_DONE_GATE: Final report blocked. Generated/scaffolded/existing web-app implementation work must call verify_app and pass placeholder_scan, unsafe_env_scan, image_uniqueness_scan, install, check, build, start_route, and browser_smoke; save a git checkpoint/commit; then start a persistent local preview with webdev restart and include the localhost URL for Toby to review before deployment. If screenshots, Lighthouse, preview deploy, disabled-route checks, or local preview startup were requested and cannot be completed, report them explicitly as blockers instead of claiming completion. Call verify_app/checkpoint/webdev restart now, then produce the final report from that evidence.";
        const gateMsg = addMessage(config.sessionId, "user", gateMessage);
        addPart(gateMsg.id, "text", gateMessage);
        messages.push({ role: "user", content: gateMessage });
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
        const result = `${roundRepeatCheck}\nStop rereading the same files or rerunning the same checks. Use the results already in context, take a distinct next action, or report the exact blocker. Do not claim completion while required gates are still red.`;
        const isError = true;
        toolResults.push({ tool_call_id: tc.id, content: result, is_error: isError });
        yield { type: "tool_result", toolCallId: tc.id, result, isError };
        const toolMsg = addMessage(config.sessionId, "tool", result);
        addPart(toolMsg.id, "error", result, tc.name, tc.id);
        messages.push({ role: "tool", content: result, tool_call_id: tc.id });
      }

      const priorRecoveryPrompts = messages.filter((msg) => /NO_PROGRESS_RECOVERY/i.test(messageText(msg))).length;
      const repeatedStatusAfterGreenVerify = isStatusOnlyRound(toolCalls) && hasLatestFullyGreenVerifyApp(messages);
      if (!repeatedStatusAfterGreenVerify && requiresAppFactoryVerification(messages, "Done") && !hasAppFactoryDoneEvidence(messages) && priorRecoveryPrompts < 2) {
        const recoveryPrompt = buildNoProgressRecoveryPrompt(messages, roundRepeatCheck);
        const recoveryMsg = addMessage(config.sessionId, "user", recoveryPrompt);
        addPart(recoveryMsg.id, "text", recoveryPrompt);
        messages.push({ role: "user", content: recoveryPrompt });
        continue;
      }

      const forcedSummary = buildNoProgressStopSummary(messages, repeatedStatusAfterGreenVerify
        ? `${roundRepeatCheck}\nJeriko already has a fully green verify_app result for this app, so it is stopping the status loop and reporting the captured app/build state now.`
        : roundRepeatCheck);
      const guardMsg = addMessage(config.sessionId, "assistant", forcedSummary, { input: 0, output: estimateTokens(forcedSummary) });
      addPart(guardMsg.id, "text", forcedSummary);
      yield { type: "text_delta", content: forcedSummary };
      yield { type: "turn_complete", tokensIn: totalTokensIn, tokensOut: totalTokensOut };
      return;
    }

    for (const tc of toolCalls) {
      if (checkResourceLimit()) {
        const resourceSummary = `${resourceLimitMessage}\n\n${buildNoProgressStopSummary(messages, "Jeriko stopped before executing more tools because the process crossed the configured memory ceiling.")}`;
        const resourceMsg = addMessage(config.sessionId, "assistant", resourceSummary, { input: totalTokensIn, output: estimateTokens(resourceSummary) });
        addPart(resourceMsg.id, "text", resourceSummary);
        touchSession(config.sessionId);
        yield { type: "text_delta", content: resourceSummary };
        yield { type: "error", message: resourceLimitMessage ?? "Agent resource limit exceeded" };
        yield { type: "turn_complete", tokensIn: totalTokensIn, tokensOut: totalTokensOut };
        return;
      }
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
            if (config.cwd && tool.parameters?.properties?.cwd) {
              if (!args.cwd) {
                args.cwd = config.cwd;
              } else if (typeof args.cwd === "string" && !isAbsolute(args.cwd)) {
                args.cwd = resolve(config.cwd, args.cwd);
              }
            }
            if (generatedCopyEditConfirmed) {
              args.__jeriko_generated_copy_edit_confirmation = GENERATED_COPY_EDIT_CONFIRMATION;
            }
            result = await tool.execute(args);
            if (inferToolResultIsError(result)) isError = true;
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
    if (resourceTimer) clearInterval(resourceTimer);
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
  checkResourceLimit?: () => string | null;
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
  let resourceTimer: ReturnType<typeof setInterval> | undefined;
  const nextPromise = stream.next();
  // If the timeout/resource guard wins and aborts the driver, the already-started next()
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
      new Promise<IteratorResult<T>>((_, reject) => {
        if (!options.checkResourceLimit) return;
        resourceTimer = setInterval(() => {
          const msg = options.checkResourceLimit?.();
          if (!msg) return;
          options.abort?.();
          reject(new AgentResourceLimitError(msg));
        }, 250);
      }),
    ]);
  } catch (err) {
    if (err instanceof AgentNoProgressError || err instanceof AgentResourceLimitError) {
      await stream.return?.().catch(() => undefined);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (resourceTimer) clearInterval(resourceTimer);
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
  const idleSeconds = Math.max(1, Math.round((args.idleMs > 0 ? args.idleMs : args.elapsedMs) / 1000));
  return [
    "Agent stuck/no-progress guard stopped the run.",
    args.reason,
    `Diagnosis: model loop produced no new stream, tool, or persisted DB progress for ${idleSeconds}s while the foreground ask was still active.`,
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
    if (isVerificationOnlyRound(toolCalls)) return null;
    const signature = toolRoundSignature(toolCalls);
    const count = (seen.get(signature) ?? 0) + 1;
    seen.set(signature, count);

    if (count >= maxSeen) {
      return `Repeated no-progress tool round blocked after ${count} matching rounds: ${summarizeToolRound(toolCalls)}`;
    }
    return null;
  };
}

function isVerificationOnlyRound(toolCalls: ToolCall[]): boolean {
  if (toolCalls.length === 0) return false;
  return toolCalls.every((toolCall) => {
    if (toolCall.name !== "bash") return false;
    try {
      const parsed = JSON.parse(toolCall.arguments);
      const command = typeof parsed.command === "string" ? parsed.command : "";
      return /\b(pnpm|npm|yarn|bun)\s+run\s+(check|build|test|lint)\b/.test(command)
        || /\b(tsc\s+--noEmit|vite\s+build)\b/.test(command);
    } catch {
      return false;
    }
  });
}

function isStatusOnlyRound(toolCalls: ToolCall[]): boolean {
  return toolCalls.length > 0 && toolCalls.every((toolCall) => toolCall.name === "workspace_status" || toolCall.name === "status_report" || toolCall.name === "situation_report");
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
  const publicReason = publicNoProgressReason(reason);
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
  const appLines = buildAppSummaryLines(state);

  const lines = [
    publicReason.startsWith("Agent loop exceeded") ? "Agent loop stopped at the maximum-round safety limit." : "No-progress guard stopped the run.",
    publicReason,
    "",
    "Operator recap:",
    "",
    "Built / target app:",
    ...appLines,
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
    state.generatedCopyBlocker ? `- generated-copy guard: ${state.generatedCopyBlocker}` : "- generated-copy guard: no block captured",
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

function publicNoProgressReason(reason: string): string {
  const trimmed = reason.trim();
  if (/MODEL_STREAM_NO_PROGRESS_RECOVERY|APP_FACTORY_DONE_GATE|NO_PROGRESS_RECOVERY/i.test(trimmed)) {
    return "Jeriko hit an internal recovery/final-report guard while trying to finish the run.";
  }
  if (/Repeated no-progress tool round blocked/i.test(trimmed)) {
    return trimmed.replace(/:\s*[^\n]*$/, ".");
  }
  return trimmed;
}

export function buildNoProgressRecoveryPrompt(messages: DriverMessage[], reason: string): string {
  const state = getCapturedVerificationState(messages);
  const failedGate = state.verifyAppGates.find((gate) => !gate.ok);
  const verifyRan = state.verifyAppGates.length > 0;
  const verifyFullyGreen = verifyRan && !failedGate;
  const nextStep = failedGate
    ? `Fix the ${failedGate.name} gate root cause, then rerun verify_app once. Do not repeat the same verify_app arguments until the ${failedGate.name} failure has been changed or diagnosed.`
    : !verifyRan
      ? "Run verify_app once with install/check/build/start/browser gates, or report the exact blocker if it cannot run."
      : !state.checkPassed
        ? "Run the existing typecheck/check command once, or report the exact blocker if it cannot run."
        : !state.buildPassed
          ? "Run the existing build command once, or report the exact blocker if it cannot run."
          : !verifyFullyGreen
            ? "Repair the remaining verify_app blocker, rerun verify_app once, or report the exact blocker."
            : state.localUrls.length === 0
              ? "Start a persistent local preview with webdev restart and capture the localhost URL, then browser-confirm it."
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
  generatedCopyBlocker: string;
  changedFilesSummary: string;
  checkpoint: string;
  localUrls: string[];
  verifyAppGates: CapturedGateState[];
  projectName: string;
  projectDirectory: string;
  appType: string;
  appFeatures: string[];
  appPages: string[];
  completedActions: string[];
  notDone: string[];
}

function getCapturedVerificationState(messages: DriverMessage[]): CapturedVerificationState {
  const toolTexts = messages.filter((msg) => msg.role === "tool").map((msg) => messageText(msg));
  const latestMutationIndex = latestGeneratedAppMutationIndex(toolTexts);
  const checkPassedDirect = toolTexts.some((text, index) => index > latestMutationIndex && text.includes("tsc --noEmit") && !/error TS\d+|\bFAILED\b|\bERR_/i.test(text));
  const buildPassedDirect = toolTexts.some((text, index) => index > latestMutationIndex && ((text.includes("vite build") && text.includes("✓ built in")) || (text.includes("bun build") && !/error TS\d+|\bFAILED\b|\bERR_/i.test(text))));
  const workspaceTexts = toolTexts.filter((text) => text.includes('"diffStat"') || text.includes('"changed_files"'));
  const latestWorkspace = workspaceTexts.at(-1) ?? "";
  const noChangedFiles = latestWorkspace.includes('"diffStat":""') || latestWorkspace.includes('"diffStat": ""') || latestWorkspace.includes('changed_files: 0') || latestWorkspace.includes('"changed_files": 0');
  const codeIntegrityTriggered = toolTexts.some((text) => text.includes('"guard":"code_integrity"') || text.includes("code_integrity"));
  const parsedToolResultsWithIndex = toolTexts
    .map((text, index) => ({ index, parsed: parseToolResultJson(text) }))
    .filter((entry): entry is { index: number; parsed: Record<string, any> } => Boolean(entry.parsed && typeof entry.parsed === "object" && !Array.isArray(entry.parsed)));
  const parsedToolResults = parsedToolResultsWithIndex.map((entry) => entry.parsed);
  const generatedCopyBlockResult = parsedToolResults.findLast((parsed) => parsed?.guard === "generated_copy_target");
  const generatedCopyBlocker = typeof generatedCopyBlockResult?.error === "string" ? generatedCopyBlockResult.error : "";

  const localUrls = uniqueStrings(parsedToolResults.flatMap((parsed) => persistentLocalUrlsFromToolResult(parsed))).slice(0, 4);

  const verifyResults = parsedToolResultsWithIndex.filter(({ parsed }) => {
    const gates = parsed?.data?.gates ?? parsed?.gates;
    return Array.isArray(gates);
  });
  const latestVerifyEntry = verifyResults.at(-1);
  const latestVerify = latestVerifyEntry?.parsed;
  const latestVerifyGates = latestVerify?.data?.gates ?? latestVerify?.gates;
  const latestVerifyPayload = latestVerify?.data && typeof latestVerify.data === "object"
    ? latestVerify.data
    : latestVerify;
  const projectState = latestVerifyPayload?.projectState;
  const appSpec = projectState?.appSpec;
  const projectName = firstString(projectState?.name, latestVerifyPayload?.project, latestVerifyPayload?.packageName, inferPackageNameFromToolTexts(toolTexts));
  const projectDirectory = firstString(latestVerifyPayload?.directory, latestVerify?.directory, inferDirectoryFromToolTexts(toolTexts));
  const appType = firstString(appSpec?.appType, projectState?.template, latestVerifyPayload?.profile, latestVerify?.profile);
  const appFeatures = Array.isArray(appSpec?.features)
    ? appSpec.features.map((feature: unknown) => String(feature)).filter(Boolean).slice(0, 6)
    : [];
  const appPages = Array.isArray(appSpec?.pages)
    ? appSpec.pages.map((page: any) => typeof page?.path === "string" ? page.path : "").filter(Boolean).slice(0, 8)
    : [];
  const verifyAppGates: CapturedGateState[] = Array.isArray(latestVerifyGates)
    ? latestVerifyGates.map((gate: any) => ({
      name: String(gate?.name ?? "unknown"),
      ok: gate?.ok === true,
      output: summarizeGateOutput(gate?.output),
    }))
    : [];
  const latestVerifyIsAfterMutation = latestVerifyEntry ? latestVerifyEntry.index > latestMutationIndex : false;
  const checkPassedByVerifyApp = latestVerifyIsAfterMutation && verifyAppGates.some((gate) => gate.name === "check" && gate.ok);
  const buildPassedByVerifyApp = latestVerifyIsAfterMutation && verifyAppGates.some((gate) => gate.name === "build" && gate.ok);

  const checkPassed = checkPassedDirect || checkPassedByVerifyApp;
  const buildPassed = buildPassedDirect || buildPassedByVerifyApp;

  const latestWorkspaceJson = parseToolResultJson(latestWorkspace);
  const changedFilesSummary = summarizeChangedFiles(latestWorkspaceJson) || summarizeChangedFilesFromText(latestWorkspace);

  const checkpointResult = parsedToolResults.findLast((parsed) => typeof parsed?.data?.hash === "string" || typeof parsed?.hash === "string");
  const checkpointHash = checkpointResult?.data?.hash ?? checkpointResult?.hash;
  const checkpointMessage = checkpointResult?.data?.message ?? checkpointResult?.message;
  const checkpoint = checkpointHash ? `${checkpointHash}${checkpointMessage ? ` — ${checkpointMessage}` : ""}` : "";

  const completedActions = buildCompletedActions(parsedToolResults, verifyAppGates, changedFilesSummary, checkpoint, checkPassed, buildPassed);
  const notDone = buildNotDoneList(verifyAppGates, latestVerify, checkPassed, buildPassed, localUrls);

  return { checkPassed, buildPassed, noChangedFiles, codeIntegrityTriggered, generatedCopyBlocker, changedFilesSummary, checkpoint, localUrls, verifyAppGates, projectName, projectDirectory, appType, appFeatures, appPages, completedActions, notDone };
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

function persistentLocalUrlsFromToolResult(parsed: Record<string, any>): string[] {
  const urls: string[] = [];
  const serverUrl = parsed?.data?.server?.url ?? parsed?.server?.url;
  if ((parsed?.data?.server?.running === true || parsed?.server?.running === true) && typeof serverUrl === "string") {
    urls.push(serverUrl);
  }

  // webdev restart returns data.url after it has spawned a detached server and
  // proved HTTP readiness. verify_app/browser_smoke URLs are deliberately not
  // accepted here because verify_app tears down its temporary server after the
  // gate and those localhost URLs are stale by the time an operator reads the
  // recap.
  const restartUrl = parsed?.data?.url;
  if (parsed?.ok === true
    && typeof restartUrl === "string"
    && typeof parsed?.data?.pid === "number"
    && typeof parsed?.data?.command === "string"
    && typeof parsed?.data?.logFile === "string") {
    urls.push(restartUrl);
  }

  return urls.filter((url) => /^https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/[\w./?=&%-]*)?$/i.test(url));
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

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function inferPackageNameFromToolTexts(toolTexts: string[]): string {
  for (let index = toolTexts.length - 1; index >= 0; index -= 1) {
    const text = toolTexts[index] ?? "";
    const match = text.match(/>\s*([@\w.-]+)@\d[^\n]*\s+(?:check|build|test|lint)\b/);
    if (match?.[1]) return match[1];
  }
  return "";
}

function inferDirectoryFromToolTexts(toolTexts: string[]): string {
  for (let index = toolTexts.length - 1; index >= 0; index -= 1) {
    const text = toolTexts[index] ?? "";
    const match = text.match(/(?:directory|dir|cwd)"?\s*[:=]\s*"(\/[^"\n]+)"/) || text.match(/\b(\/home\/[^\s"']+)\b/);
    if (match?.[1]) return match[1];
  }
  return "";
}

function buildAppSummaryLines(state: CapturedVerificationState): string[] {
  const lines: string[] = [];
  if (state.projectName) lines.push(`- project: ${state.projectName}`);
  if (state.projectDirectory) lines.push(`- directory: ${state.projectDirectory}`);
  if (state.appType) lines.push(`- type: ${state.appType}`);
  if (state.appFeatures.length > 0) lines.push(`- features: ${state.appFeatures.join("; ")}`);
  if (state.appPages.length > 0) lines.push(`- pages/routes: ${state.appPages.join("; ")}`);
  if (lines.length === 0) {
    return ["- project details were not captured from tool output; run verify_app from the project root or preserve .jeriko/project-state.json output next time"];
  }
  return lines;
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
  const webdevStatus = parsedToolResults.findLast((parsed) => parsed?.data?.server?.running === true || (typeof parsed?.data?.url === "string" && /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i.test(parsed.data.url)));
  if (webdevStatus?.data?.project) actions.push(`webdev reports project ${webdevStatus.data.project} running`);
  else if (typeof webdevStatus?.data?.url === "string") actions.push(`local preview running at ${webdevStatus.data.url}`);
  return uniqueStrings(actions);
}

function hasLatestFullyGreenVerifyApp(messages: DriverMessage[]): boolean {
  const state = getCapturedVerificationState(messages);
  return state.verifyAppGates.length > 0
    && state.verifyAppGates.every((gate) => gate.ok)
    && state.checkPassed
    && state.buildPassed;
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
  if (!isFinalAssistantReport(finalText) && !isCompletionClaim(finalText)) return false;
  const combined = [...messages.map((msg) => messageText(msg)), finalText].join("\n").toLowerCase();
  const mentionsGeneratedAppWork = /\b(scaffold|scaffolded|generated app|generate(d)?\s+(a\s+)?(full-stack|web|app)|jeriko\s+create|create\s+web-static|create\s+web-db-user|web-static|web-db-user)\b/.test(combined);
  const mentionsExistingWebAppImplementation = /\b(existing\s+(react|vite|tailwind|vercel|web)\s+(site|app)|react\s*\+\s*vite|vite\s*\+\s*tailwind|vercel\s+(site|app|preview)|programmatic\s+local\s+seo|local\s+seo\s+architecture|preview\s+deploy(?:ed|ment)?)\b/.test(combined)
    && /\b(add|build|implement|update|modify|fix|deploy(?:ed)?|created?|committed?|verified)\b/.test(combined);
  const mentionsProductAppImplementation = /\b(wire|connect|hook up|integrate|add|build|implement|update|modify|fix|repair)\b[\s\S]{0,180}\b(ai|scanner|inventory|dashboard|orders?|sourcing|finance|calculator|workflow|app)\b/.test(combined)
    && /\b(app|scanner|inventory|dashboard|orders?|sourcing|finance|calculator|workflow)\b/.test(combined);
  const explicitlyReadOnly = /\b(read[- ]only|audit only|analysis only|do not change|do not modify|no code changes)\b/.test(combined);
  const explicitlyNotAppBuilder = /\b(no scaffold|do not scaffold|not generated)\b/.test(combined);
  return (mentionsGeneratedAppWork && !explicitlyNotAppBuilder) || ((mentionsExistingWebAppImplementation || mentionsProductAppImplementation) && !explicitlyReadOnly);
}

export function hasAppFactoryDoneEvidence(messages: DriverMessage[]): boolean {
  const productionDeployRequested = requiresProductionDeployVerification(messages);
  if (productionDeployRequested && hasProductionDeployEvidence(messages)) {
    if (requiresRouteBreadthVerification(messages) && !hasRouteBreadthEvidence(messages)) return false;
    if (requiresContentStructureVerification(messages) && !hasContentStructureEvidence(messages)) return false;
    if (requiresAiScannerVerification(messages) && !hasAiScannerEvidence(messages)) return false;
    if (requiresProductWorkflowVerification(messages) && !hasProductWorkflowEvidence(messages)) return false;
    if (requiresPremiumMarketingVerification(messages) && !hasPremiumMarketingEvidence(messages)) return false;
    return true;
  }
  if (!hasPassingVerifyApp(messages) || !hasCheckpointEvidence(messages) || !hasLocalhostPreviewEvidence(messages)) return false;
  if (requiresRouteBreadthVerification(messages) && !hasRouteBreadthEvidence(messages)) return false;
  if (requiresContentStructureVerification(messages) && !hasContentStructureEvidence(messages)) return false;
  if (requiresAiScannerVerification(messages) && !hasAiScannerEvidence(messages)) return false;
  if (requiresProductWorkflowVerification(messages) && !hasProductWorkflowEvidence(messages)) return false;
  if (requiresPremiumMarketingVerification(messages) && !hasPremiumMarketingEvidence(messages)) return false;
  if (requiresProductionDeployVerification(messages) && !hasProductionDeployEvidence(messages)) return false;
  return true;
}

export function requiresRouteBreadthVerification(messages: DriverMessage[]): boolean {
  const text = messages
    .filter((msg) => msg.role === "user")
    .map((msg) => messageText(msg))
    .filter((value) => !/APP_FACTORY_DONE_GATE|EXPLICIT_DELIVERABLE_DONE_GATE|NO_PROGRESS_RECOVERY|MODEL_STREAM_NO_PROGRESS_RECOVERY/i.test(value))
    .join("\n")
    .toLowerCase();
  if (/\b(read[- ]only|audit only|analysis only|do not change|do not modify|no code changes)\b/.test(text)) return false;
  const asksFullSite = /\b(full|multi[- ]page|complete|entire)\b[\s\S]{0,80}\b(web\s+app|app|site|website)\b/.test(text)
    || /\b(web\s+app|app|site|website)\b[\s\S]{0,80}\b(full|multi[- ]page|complete|entire)\b/.test(text);
  const namedPageCount = uniqueStrings([...text.matchAll(/\b(services?|industries|case studies|case-studies|process|pricing|packages?|resources?|blog|contact|about|service areas?|locations?|gallery|portfolio|auctions?|buy|sell|listings?|area guide|area-guide)\b/g)].map((match) => normalizeRouteProofToken(match[1] ?? ""))).filter(Boolean).length;
  return asksFullSite || namedPageCount >= 3;
}

export function hasRouteBreadthEvidence(messages: DriverMessage[]): boolean {
  const requiredRoutes = requiredRouteBreadthTokens(messages);
  return messages.some((msg) => {
    if (msg.role !== "tool") return false;
    const text = messageText(msg).toLowerCase();
    if (!/ROUTE_BREADTH_OK/i.test(messageText(msg)) && !/implemented routable pages|appspec.*pages|route breadth/i.test(text)) return false;
    const routeHits = new Set([...text.matchAll(/\/(?:services|industries|case-studies|process|pricing|resources|contact|about|service-areas|gallery|portfolio|auctions|buy|sell|listings|area-guide)\b/g)].map((match) => match[0]));
    if (requiredRoutes.length > 0 && requiredRoutes.every((route) => routeHits.has(route))) return true;
    return routeHits.size >= Math.max(3, Math.min(5, requiredRoutes.length || 5));
  });
}

function requiredRouteBreadthTokens(messages: DriverMessage[]): string[] {
  const text = messages
    .filter((msg) => msg.role === "user")
    .map((msg) => messageText(msg))
    .filter((value) => !/APP_FACTORY_DONE_GATE|EXPLICIT_DELIVERABLE_DONE_GATE|NO_PROGRESS_RECOVERY|MODEL_STREAM_NO_PROGRESS_RECOVERY/i.test(value))
    .join("\n")
    .toLowerCase();
  const namedRoutes = [...text.matchAll(/\b(services?|industries|case studies|case-studies|process|pricing|packages?|resources?|blog|contact|about|service areas?|locations?|gallery|portfolio|auctions?|buy|sell|listings?|area guide|area-guide)\b/g)]
    .map((match) => normalizeRouteProofToken(match[1] ?? ""))
    .filter(Boolean);
  const explicitSlashRoutes = [...text.matchAll(/\/(?:services|industries|case-studies|process|pricing|resources|contact|about|service-areas|gallery|portfolio|auctions|buy|sell|listings|area-guide)\b/g)]
    .map((match) => match[0]);
  return uniqueStrings([...namedRoutes, ...explicitSlashRoutes]);
}

function normalizeRouteProofToken(token: string): string {
  const normalized = token.toLowerCase().replace(/\s+/g, "-");
  if (/^services?$/.test(normalized)) return "/services";
  if (normalized === "industries") return "/industries";
  if (normalized === "case-studies") return "/case-studies";
  if (normalized === "process") return "/process";
  if (/^(pricing|packages?)$/.test(normalized)) return "/pricing";
  if (/^(resources?|blog)$/.test(normalized)) return "/resources";
  if (normalized === "contact") return "/contact";
  if (normalized === "about") return "/about";
  if (/^(service-areas?|locations?)$/.test(normalized)) return "/service-areas";
  if (normalized === "gallery") return "/gallery";
  if (normalized === "portfolio") return "/portfolio";
  if (/^auctions?$/.test(normalized)) return "/auctions";
  if (normalized === "buy") return "/buy";
  if (normalized === "sell") return "/sell";
  if (/^listings?$/.test(normalized)) return "/listings";
  if (normalized === "area-guide") return "/area-guide";
  return "";
}

function requiresAiScannerVerification(messages: DriverMessage[]): boolean {
  const text = messages.filter((msg) => msg.role === "user").map((msg) => messageText(msg)).join("\n").toLowerCase();
  return /\b(wire|connect|hook up|integrate|add|build|implement|update|modify|fix|repair)\b[\s\S]{0,180}\b(ai|openai|llm|vision)\b[\s\S]{0,180}\bscanner\b/.test(text)
    || /\bscanner\b[\s\S]{0,180}\b(ai|openai|llm|vision)\b/.test(text);
}

function hasAiScannerEvidence(messages: DriverMessage[]): boolean {
  return messages.some((msg) => {
    if (msg.role !== "tool") return false;
    const text = messageText(msg);
    if (/LIVE_AI_SCANNER_OK/i.test(text)
      && /\b(app\.aiScanner|aiScanner|scanner route|scanner api|called)\b/i.test(text)
      && /\b(productName|decision|confidence|estimatedSalePrice|netProfit|analysis result|response returned)\b/i.test(text)) return true;
    const parsed = parseToolResultJson(text);
    const haystack = JSON.stringify(parsed ?? {}).toLowerCase();
    return /aiscanner|scanner/.test(haystack)
      && /productname|decision|confidence|estimatedsaleprice|netprofit/.test(haystack)
      && /ok"?\s*:?\s*true|success/.test(haystack);
  });
}

export function requiresProductWorkflowVerification(messages: DriverMessage[]): boolean {
  const text = messages
    .filter((msg) => msg.role === "user")
    .map((msg) => messageText(msg))
    .filter((value) => !/APP_FACTORY_DONE_GATE|EXPLICIT_DELIVERABLE_DONE_GATE|NO_PROGRESS_RECOVERY|MODEL_STREAM_NO_PROGRESS_RECOVERY/i.test(value))
    .join("\n")
    .toLowerCase();
  if (/\b(read[- ]only|audit only|analysis only|do not change|do not modify|no code changes)\b/.test(text)) return false;
  const productTerms = /\b(inventory|scanner|scan|orders?|shipments?|listings?|customers?|buyers?|expenses?|sourcing|finance|calculator|workflow|dashboard|portal|crm|save|upload|photos?|items?|records?)\b/.test(text);
  const implementationTerms = /\b(build|create|generate|scaffold|wire|connect|hook up|integrate|implement|update|modify|fix|repair|ship|done|completed?)\b/.test(text);
  const appTerms = /\b(web-db-user|full-stack|database app|product app|generated app)\b/.test(text);
  return productTerms && implementationTerms && appTerms;
}

export function hasProductWorkflowEvidence(messages: DriverMessage[]): boolean {
  return messages.some((msg) => {
    if (msg.role !== "tool") return false;
    const text = messageText(msg);
    if (/(PRODUCT_WORKFLOW_OK|READ_AFTER_WRITE_OK)/i.test(text)
      && /\b(post|create|save|scan|order|listing|inventory|item|record|mutation|request)\b/i.test(text)
      && /\b(id|recordId|itemId|scanId|orderId|result|saved|created)\b/i.test(text)
      && /\b(get|list|detail|readback|read-after-write|fetched|returned)\b/i.test(text)) return true;
    const parsed = parseToolResultJson(text);
    const haystack = JSON.stringify(parsed ?? {}).toLowerCase();
    return /(product_workflow_ok|read_after_write_ok)/.test(haystack)
      && /(created|saved|post|mutation|scan|inventory|order|listing)/.test(haystack)
      && /(id|recordid|itemid|scanid|orderid|result)/.test(haystack)
      && /(readback|list|detail|get|fetched|returned)/.test(haystack);
  });
}

export function requiresProductionDeployVerification(messages: DriverMessage[]): boolean {
  const text = messages
    .filter((msg) => msg.role === "user")
    .map((msg) => messageText(msg))
    .filter((value) => !/APP_FACTORY_DONE_GATE|EXPLICIT_DELIVERABLE_DONE_GATE|NO_PROGRESS_RECOVERY|MODEL_STREAM_NO_PROGRESS_RECOVERY/i.test(value))
    .join("\n")
    .toLowerCase();
  if (/\b(read[- ]only|audit only|analysis only|do not change|do not modify|no code changes)\b/.test(text)) return false;
  if (/\b(do not deploy|don't deploy|no deploy|deployment not requested|do not push|don't push|local only)\b/.test(text)) return false;
  return /\b(deploy(?:ed|ment)?|production|vercel|live site|go live|ship)\b/.test(text)
    && /\b(site|website|web app|app|generated app|flipscout|google auth|oauth)\b/.test(text);
}

export function hasProductionDeployEvidence(messages: DriverMessage[]): boolean {
  const toolText = messages.filter((msg) => msg.role === "tool").map((msg) => messageText(msg)).join("\n");
  const lower = toolText.toLowerCase();
  if (/redirect_uri_mismatch/i.test(toolText)) return false;
  if (/"production_google_oauth_smoke"[\s\S]{0,160}"ok"\s*:\s*false/i.test(toolText)) return false;
  const hasDeployAppReport = /"target"\s*:\s*"vercel"/.test(toolText)
    && /"productionUrl"\s*:\s*"https?:\/\//.test(toolText)
    && /"blockers"\s*:\s*\[\s*\]/.test(toolText);
  const hasManualProductionSmoke = /https?:\/\/[^\s"']+/i.test(toolText)
    && (/production(_|\s)?smoke|live production|vercel inspect|aliased/i.test(lower)
      || (/\.vercel\.app/i.test(toolText) && /content_check\s*=\s*pass/i.test(toolText)))
    && /http\/2\s+200|http_code\s*=\s*200|status\s*[:=]\s*200|"status"\s*:\s*200/i.test(toolText);
  const oauthRequestText = messages
    .map((msg) => messageText(msg))
    .filter((value) => !/APP_FACTORY_DONE_GATE|EXPLICIT_DELIVERABLE_DONE_GATE|NO_PROGRESS_RECOVERY|MODEL_STREAM_NO_PROGRESS_RECOVERY/i.test(value))
    .join("\n");
  const oauthRequested = /google auth|oauth|\/api\/oauth\/google\/start|web-db-user|flipscout/i.test(oauthRequestText);
  if (!oauthRequested) return hasDeployAppReport || hasManualProductionSmoke;
  const hasOAuthProof = /\/api\/oauth\/google\/status/i.test(toolText)
    && /\/api\/oauth\/google\/start/i.test(toolText)
    && /redirect_uri=/i.test(toolText)
    && !/redirect_uri_mismatch/i.test(toolText);
  return (hasDeployAppReport || hasManualProductionSmoke) && hasOAuthProof;
}

export function requiresPremiumMarketingVerification(messages: DriverMessage[]): boolean {
  const text = messages
    .filter((msg) => msg.role === "user")
    .map((msg) => messageText(msg))
    .filter((value) => !/APP_FACTORY_DONE_GATE|EXPLICIT_DELIVERABLE_DONE_GATE|NO_PROGRESS_RECOVERY|MODEL_STREAM_NO_PROGRESS_RECOVERY/i.test(value))
    .join("\n")
    .toLowerCase();
  if (/\b(read[- ]only|audit only|analysis only|do not change|do not modify|no code changes)\b/.test(text)) return false;
  const siteWork = /\b(build|create|generate|scaffold|make|design|implement|update|fix|repair)\b[\s\S]{0,140}\b(site|website|web app|landing|homepage|pages?)\b/.test(text)
    || /\b(site|website|web app|landing|homepage|pages?)\b[\s\S]{0,140}\b(build|create|generate|scaffold|make|design|implement|update|fix|repair)\b/.test(text);
  const contractorOrLocal = /\b(contractor|roof(?:er|ing)?|remodel(?:er|ing)?|construction|service[- ]area|local service|lead(?:s)?|quote|estimate|go alpha|marketing|homeowner|plumb(?:er|ing)|hvac|electric(?:al|ian)?|concrete|fencing|siding|gutter)\b/.test(text);
  return siteWork && contractorOrLocal;
}

export function hasPremiumMarketingEvidence(messages: DriverMessage[]): boolean {
  return messages.some((msg) => {
    if (msg.role !== "tool") return false;
    const text = messageText(msg);
    if (/PREMIUM_MARKETING_SITE_OK/i.test(text) && /\b(LeadOpsVisual|LeadFlowLineSection|LeadLeakAudit|BeforeAfterComparison|StickyAuditRail|premium_marketing_site_scan)\b/i.test(text)) return true;
    const parsed = parseToolResultJson(text);
    const gates = parsed?.data?.gates ?? parsed?.gates;
    if (Array.isArray(gates) && gates.some((gate: any) => gate?.name === "premium_marketing_site_scan" && gate?.ok === true)) return true;
    return /"premium_marketing_site_scan"\s*,\s*"ok"\s*:\s*true/i.test(text) || /"name"\s*:\s*"premium_marketing_site_scan"[\s\S]{0,80}"ok"\s*:\s*true/i.test(text);
  });
}

export function requiresExplicitDeliverableVerification(messages: DriverMessage[], finalText: string): boolean {
  if (!isFinalAssistantReport(finalText) && !isCompletionClaim(finalText)) return false;
  const combined = [...messages.map((msg) => messageText(msg)), finalText].join("\n");
  const lower = combined.toLowerCase();
  const explicitlyReadOnly = /\b(read[- ]only|audit only|analysis only|do not change|do not modify|no code changes)\b/.test(lower);
  if (explicitlyReadOnly) return false;

  const fixLabels = extractRequestedFixLabels(messages);
  const grepPhrases = extractRequestedGrepPhrases(messages);
  const asksSeparateCommits = /commit each fix as (a )?separate|separate clean commits?|all \d+ commit hashes/i.test(combined);
  const asksLiveRawChecks = /curl\/raw html|raw html check|live production.*curl|curl\s+-s[\s\S]{0,80}grep\s+-i/i.test(combined);
  const asksPauseMarker = /\bPAUSE at\b|HERMES-[A-Z0-9-]+-COMPLETE/i.test(combined);
  const asksP0Confirmation = /no new p0|p0s? introduced|launch-readiness audit/i.test(lower);

  return (asksSeparateCommits && fixLabels.length >= 2)
    || (asksLiveRawChecks && grepPhrases.length >= 2)
    || (asksPauseMarker && (fixLabels.length > 0 || grepPhrases.length > 0))
    || (asksP0Confirmation && (fixLabels.length > 0 || grepPhrases.length > 0));
}

export function hasExplicitDeliverableDoneEvidence(messages: DriverMessage[]): boolean {
  const fixLabels = extractRequestedFixLabels(messages);
  const grepPhrases = extractRequestedGrepPhrases(messages);
  const requestedText = messages.filter((msg) => msg.role === "user").map((msg) => messageText(msg)).join("\n").toLowerCase();
  const toolText = messages.filter((msg) => msg.role === "tool").map((msg) => messageText(msg)).join("\n");
  const toolLower = toolText.toLowerCase();

  if (fixLabels.length > 0) {
    for (const label of fixLabels) {
      const labelIndex = toolLower.indexOf(label.toLowerCase());
      if (labelIndex < 0) return false;
      const near = toolText.slice(Math.max(0, labelIndex - 90), labelIndex + label.length + 90);
      if (!/[a-f0-9]{7,40}/i.test(near)) return false;
    }
  }

  if (grepPhrases.length > 0) {
    const hasLiveDomain = /https?:\/\/[^\s'"`]*relaxremodelconsulting\.com/i.test(toolText) || /live production|raw html/i.test(toolLower);
    if (!hasLiveDomain) return false;
    for (const phrase of grepPhrases) {
      if (!toolLower.includes(phrase.toLowerCase())) return false;
    }
    if (/no match \(exit|NO MATCH/i.test(toolText)) return false;
  }

  if (/no new p0|p0s? introduced|launch-readiness audit/i.test(requestedText)) {
    const hasP0Proof = /P0_FAILS\s*=\s*0/i.test(toolText)
      || /no new p0s? introduced/i.test(toolText)
      || /no new p0/i.test(toolText);
    if (!hasP0Proof) return false;
  }

  return fixLabels.length > 0 || grepPhrases.length > 0;
}

function extractRequestedFixLabels(messages: DriverMessage[]): string[] {
  const text = messages.filter((msg) => msg.role === "user").map((msg) => messageText(msg)).join("\n");
  const labels = [...text.matchAll(/\bfix\d+-[A-Za-z0-9_-]+\b/g)].map((match) => match[0]);
  return uniqueStrings(labels);
}

function extractRequestedGrepPhrases(messages: DriverMessage[]): string[] {
  const text = messages.filter((msg) => msg.role === "user").map((msg) => messageText(msg)).join("\n");
  const phrases = [...text.matchAll(/grep\s+-i\s+["']([^"']+)["']/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  return uniqueStrings(phrases);
}

export function requiresContentStructureVerification(messages: DriverMessage[]): boolean {
  const combined = messages
    .filter((msg) => msg.role === "user")
    .map((msg) => messageText(msg))
    .filter((text) => !/APP_FACTORY_DONE_GATE|EXPLICIT_DELIVERABLE_DONE_GATE|NO_PROGRESS_RECOVERY/i.test(text))
    .join("\n")
    .toLowerCase();
  const contentWork = /\b(generate|write|rewrite|replace|populate|add|improve|update)\b[\s\S]{0,160}\b(content|copy|paragraph|page copy|seo copy|service pages?|city pages?|location pages?|local seo pages?)\b/.test(combined)
    || /\b(service pages?|city pages?|location pages?|local seo pages?)\b[\s\S]{0,160}\b(content|copy|paragraph|section|real content)\b/.test(combined);
  const existingWebApp = /\b(react|vite|tailwind|vercel|website|web app|site|local seo|programmatic seo)\b/.test(combined);
  const explicitlyReadOnly = /\b(read[- ]only|audit only|analysis only|do not change|do not modify|no code changes)\b/.test(combined);
  return contentWork && existingWebApp && !explicitlyReadOnly;
}

export function hasContentStructureEvidence(messages: DriverMessage[]): boolean {
  return messages.some((msg) => {
    if (msg.role !== "tool") return false;
    const text = messageText(msg);
    return /CONTENT_STRUCTURE_OK/i.test(text)
      && /semantic sections?/i.test(text)
      && /h2\/?h3|heading hierarchy|h2\/h3 hierarchy/i.test(text)
      && /multiple (readable )?(paragraphs?|p tags?)/i.test(text)
      && /no wall[- ]of[- ]text/i.test(text);
  });
}

export function hasCheckpointEvidence(messages: DriverMessage[]): boolean {
  return messages.some((msg) => {
    if (msg.role !== "tool") return false;
    const text = messageText(msg);
    const parsed = parseToolResultJson(text);
    const hash = parsed?.data?.hash ?? parsed?.hash ?? parsed?.commit ?? parsed?.data?.commit;
    if (typeof hash === "string" && /^[a-f0-9]{7,40}$/i.test(hash)) return true;
    const message = parsed?.data?.message ?? parsed?.message;
    if (parsed?.ok === true && typeof message === "string" && /no changes to commit/i.test(message)) return true;
    return /\b\[[\w/-]+\s+[a-f0-9]{7,40}\]\s+.+/.test(text) || /\bcommit(?:ted)?\b[\s\S]{0,120}\b[a-f0-9]{7,40}\b/i.test(text);
  });
}

export function hasLocalhostPreviewEvidence(messages: DriverMessage[]): boolean {
  return messages.some((msg) => {
    if (msg.role !== "tool") return false;
    const text = messageText(msg);
    if (/https?:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/[\w./?=&%-]*)?/i.test(text) && /\b(opened|preview|webdev|server|running)\b/i.test(text)) return true;
    const parsed = parseToolResultJson(text);
    const urls = [parsed?.data?.url, parsed?.url, parsed?.data?.server?.url, parsed?.server?.url]
      .filter((value): value is string => typeof value === "string");
    return urls.some((url) => /https?:\/\/(?:localhost|127\.0\.0\.1):\d+/i.test(url));
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
        const required = ["placeholder_scan", "unsafe_env_scan", "db_auth_workflow_wiring", "mock_data_import_scan", "provider_config_scan", "image_uniqueness_scan", "install", "check", "build", "start_route", "browser_smoke"];
        if (required.every((name) => gates.some((gate: any) => gate?.name === name && gate?.ok === true))) return true;
      }
    } catch {
      // Fall back to text detection for older captured tool outputs.
      const hasAllGateNames = ["placeholder_scan", "unsafe_env_scan", "db_auth_workflow_wiring", "mock_data_import_scan", "provider_config_scan", "image_uniqueness_scan", "install", "check", "build", "start_route", "browser_smoke"].every((name) => text.includes(`"${name}"`));
      if (hasAllGateNames && /"ok"\s*:\s*true/.test(text) && !/"ok"\s*:\s*false/.test(text)) return true;
    }
  }
  return false;
}

export function isFinalAssistantReport(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!normalized.trim()) return false;
  const hasReportHeading = /(^|\n)\s*#{0,3}\s*(verified fixed now|exact evidence|plain answer|verification results|verification evidence|files changed|remaining issues|what i did|what i did not do|local preview url|full clickable url)\b/i.test(text);
  const hasDoneSignal = /\b(done|completed|verified|passes|passed)\b/i.test(text);
  const hasVerification = /\b(pnpm|bun|npm)\s+(run\s+)?(check|build|test)\b|\btsc\s+--noemit\b|\bbuild\s+passed\b/i.test(text);
  return hasReportHeading && hasDoneSignal && hasVerification;
}

export function isCompletionClaim(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  if (!normalized) return false;
  if (/^blocked\b|\b(blocked|blocker|missing required|missing .*evidence|not yet proven|not proven|still incomplete|cannot claim|do not have evidence|failed because|is still building)\b/i.test(normalized)) return false;
  if (/\b(i will|i'll|next i|going to|need to|still need|not done|not complete|working on|in progress)\b/i.test(normalized)) return false;
  return /\b(done|all done|complete|completed|finished|ready|ready for review|built the app|implemented|fixed|verified|shipped|deployed|all set)\b/i.test(normalized);
}

export function inferToolResultIsError(result: string): boolean {
  const trimmed = result.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      if ((parsed as any).ok === false) return true;
      if ((parsed as any).error && (parsed as any).ok !== true) return true;
      if ((parsed as any).status === "error" || (parsed as any).status === "failed") return true;
    }
  } catch {
    // Non-JSON tool output is common; fall through to conservative textual markers.
  }
  return /\b(command timed out|failed gate|errorcode|exited with code [1-9]|agent loop exceeded maximum rounds)\b/i.test(trimmed);
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

