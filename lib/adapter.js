/**
 * @dsh-plugins/dsh-opencode-go — provider adapter: registry surface,
 * streaming pumps, image resolution, live catalog refresh.
 * Owns no Services directly; everything external arrives via thunks.
 */
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { IMAGE_MEDIA_TYPES, MAX_INLINE_IMAGE_BYTES, MODEL_TABLE, endpointOf, reasoningFor } from "./models.js";
import {
  apiAttributionHeaders,
  buildAnthropicBody,
  buildChatBody,
  buildHeaders,
  buildResponsesBody,
  collectImageRefs,
  fail,
  httpError,
  mapAnthropicStop,
  mapFinishReason,
  ok,
  parseRetryAfterMs,
  parseSseData,
  sessionHeaderValue,
  toTokenUsage,
} from "./protocol.js";
import { meteredStream } from "./usage.js";

/**
 * Shared SSE line pump for all three surfaces: yields parsed `data:`
 * payloads ("[DONE]" filtered out) with an idle watchdog. A quiet stream
 * throws TIMEOUT; the caller's abort propagates untouched. Owns the reader:
 * the `finally` releases it so a consumer early-exit does not leak the
 * underlying socket until GC.
 */
async function* ssePayloads(webBody, callerSignal, streamIdleTimeoutMs) {
  const reader = webBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimer;
  let idleFired = false;
  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      reader.cancel().catch(() => undefined);
    }, streamIdleTimeoutMs);
    if (idleTimer.unref) idleTimer.unref();
  };
  const clearIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const emitLine = function* (line) {
    if (!line.startsWith("data:")) return;
    const event = parseSseData(line.slice(5));
    if (event !== null) yield event;
  };
  armIdle();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        yield* emitLine(line);
        boundary = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail !== "") yield* emitLine(tail);
  } finally {
    clearIdle();
    // Release the lock even when the consumer broke out early; without this
    // the socket stays held until GC. releaseLock (not cancel) so an early
    // exit does not mask the real outcome with a spurious abort error; the
    // idle TIMEOUT below still throws when the watchdog fired.
    try {
      reader.releaseLock();
    } catch {}
    if (idleFired && callerSignal?.aborted !== true) {
      throw new LlmError(
        `llm-opencode-go: stream idle timeout after ${streamIdleTimeoutMs}ms`,
        "TIMEOUT",
      );
    }
  }
}

/** Adapter: OpenAI-compatible chat streaming with the session header. */
export class OpencodeGoAdapter extends LlmAdapter {
  constructor(getOptions, resolveKey, services = {}) {
    super();
    this.getOptions = getOptions;
    this.resolveKey = resolveKey;
    this.services = services;
  }

  providerInfo(provider) {
    return { id: provider, name: "zen-go (OpenCode Go)" };
  }

  async listModels(provider) {
    const enabled = this.getOptions().enabledModels;
    const known = new Set(MODEL_TABLE.map((m) => m.id));
    const listed = MODEL_TABLE.filter((m) => enabled.includes(m.id)).map((m) => ({
      provider,
      id: m.id,
      name: m.id,
      ...(m.image === true ? { inputModalities: ["text", "image"] } : { inputModalities: ["text"] }),
    }));
    // Enabled ids the static table does not know (e.g. discovered via
    // refresh) stay selectable; requests route to the chat surface and the
    // server stays authoritative.
    for (const id of enabled) {
      if (!known.has(id) && !listed.some((m) => m.id === id)) listed.push({ provider, id, name: id });
    }
    return listed;
  }

  async resolveModel(provider, model) {
    // The catalog is advisory and the server is authoritative: known ids on
    // any of the three surfaces resolve, unknown ids pass through, and a
    // mistyped id surfaces as the provider's own 400. Declared modalities
    // matter: the runtime substitutes text placeholders for images on
    // text-only routes, and passes images through otherwise. User-filled
    // capacity overrides (modelCaps) attach context + default output cap.
    const entry = MODEL_TABLE.find((m) => m.id === model);
    const cap = this.getOptions().modelCaps.find((c) => c.id === model);
    return {
      provider,
      id: model,
      name: model,
      ...(entry === undefined ? {} : { inputModalities: entry.image === true ? ["text", "image"] : ["text"] }),
      ...(reasoningFor(model) === undefined ? {} : { reasoning: reasoningFor(model) }),
      ...(cap?.contextWindow === undefined ? {} : { context: { contextWindow: cap.contextWindow } }),
      ...(cap?.maxTokens === undefined ? {} : { defaultMaxTokens: cap.maxTokens }),
    };
  }

  /**
   * Resolve pre-collected image refs to inline base64 payloads. Reads the
   * normalized copies through the attachment + fs services (both injectable
   * for tests).
   */
  async resolveImageData(refs) {
    const attachments = this.services.resolveAttachments?.();
    if (attachments === undefined) {
      throw new LlmError(
        "llm-opencode-go: image input requires the durable attachment service",
        "UNSUPPORTED_CONTENT",
      );
    }
    const out = new Map();
    for (const ref of refs) {
      const mediaType = ref.mediaType;
      if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
        throw new LlmError(
          `llm-opencode-go: image type ${mediaType} is not supported (png/jpeg/webp/gif only)`,
          "UNSUPPORTED_CONTENT",
        );
      }
      const hostPath = attachments.imageHostPath(ref);
      if (hostPath === undefined) {
        throw new LlmError("llm-opencode-go: attachment has no readable copy", "PROVIDER_PROTOCOL_ERROR");
      }
      const readable = this.services.mapHostPath?.(hostPath) ?? hostPath;
      const bytes = await this.services.readFile(readable);
      if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
        throw new LlmError(
          `llm-opencode-go: image exceeds the ${MAX_INLINE_IMAGE_BYTES} byte inline limit`,
          "IMAGES_TOO_LARGE",
        );
      }
      out.set(String(ref.attachmentId), { mediaType, base64: Buffer.from(bytes).toString("base64") });
    }
    return out;
  }

  async *stream(options) {
    const connection = this.getOptions();
    const apiKey = await this.resolveKey();
    const headers = buildHeaders(apiKey, options.sessionId);
    const refs = collectImageRefs(options.messages);
    const images = refs.length > 0 ? await this.resolveImageData(refs) : new Map();
    const endpoint = endpointOf(options.model) ?? "chat";
    const meta = {
      t: Date.now(),
      model: options.model,
      session: options.sessionId === undefined ? null : String(options.sessionId),
      // The exact header value put on the wire (loop id when present,
      // otherwise the per-request fallback) — this is what the drill-down
      // shows as the sent x-opencode-session.
      sessionHeader: sessionHeaderValue(options.sessionId),
      purpose: options.purpose ?? null,
    };
    const record = (entry) => this.services.recordUsage?.(entry);
    if (endpoint === "responses") {
      yield* meteredStream(this.streamSurface(connection, headers, options, "/v1/responses", buildResponsesBody(options, images), (body, signal, idleMs) => this.pumpResponses(body, signal, idleMs)), meta, record);
    } else if (endpoint === "messages") {
      // The messages surface authenticates Anthropic-style: Bearer alone
      // 401s with "Missing API key", so x-api-key rides along.
      const msgHeaders = buildHeaders(apiKey, options.sessionId, { "x-api-key": apiKey });
      yield* meteredStream(this.streamSurface(connection, msgHeaders, options, "/v1/messages", buildAnthropicBody(options, images), (body, signal, idleMs) => this.pumpMessages(body, signal, idleMs)), meta, record);
    } else {
      yield* meteredStream(this.streamSurface(connection, headers, options, "/v1/chat/completions", buildChatBody(options, images), (body, signal, idleMs) => this.pumpChunks(body, signal, idleMs)), meta, record);
    }
  }

  /** Shared POST + error mapping for the three SSE surfaces. */
  async *streamSurface(connection, headers, options, path, bodyObject, pump) {
    // Request-phase timeout only: connect + response headers. The timer is
    // cleared the moment headers arrive; the body phase is guarded solely by
    // the idle watchdog. A single AbortSignal.timeout over the whole fetch
    // would kill long reasoning streams whose total wall-clock exceeds the
    // connect budget (seen as batches of "aborted due to timeout" on spark).
    const requestTimeout = new AbortController();
    const requestTimer = setTimeout(() => {
      requestTimeout.abort(
        new DOMException(
          `llm-opencode-go: no response within ${connection.requestTimeoutMs}ms`,
          "TimeoutError",
        ),
      );
    }, connection.requestTimeoutMs);
    if (requestTimer.unref) requestTimer.unref();
    const signal =
      options.signal === undefined
        ? requestTimeout.signal
        : AbortSignal.any([options.signal, requestTimeout.signal]);

    let response;
    try {
      response = await fetch(`${connection.apiBase}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyObject),
        signal,
      });
    } catch (error) {
      clearTimeout(requestTimer);
      if (options.signal?.aborted) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new LlmError(
          `llm-opencode-go: request timed out after ${connection.requestTimeoutMs}ms`,
          "TIMEOUT",
          { cause: error },
        );
      }
      throw new LlmError(`llm-opencode-go: request transport failed: ${error?.message ?? error}`, "TRANSPORT", {
        cause: error,
      });
    }
    clearTimeout(requestTimer);
    // The timer may have fired in the same tick headers arrived: still a
    // request-phase timeout — report it as such instead of leaking a raw
    // DOMException out of the body phase.
    if (requestTimeout.signal.aborted && options.signal?.aborted !== true) {
      throw new LlmError(
        `llm-opencode-go: request timed out after ${connection.requestTimeoutMs}ms`,
        "TIMEOUT",
      );
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw httpError(response.status, errText, parseRetryAfterMs(response.headers.get("retry-after")));
    }
    if (!response.body) throw new LlmError("llm-opencode-go: empty response body", "PROVIDER_PROTOCOL_ERROR");

    yield* pump(response.body, options.signal, connection.streamIdleTimeoutMs);
  }

  /** Read SSE, translate deltas to StreamChunks. */
  async *pumpChunks(webBody, callerSignal, streamIdleTimeoutMs) {
    let nextIndex = 0;
    let textIndex = -1;
    let textContent = "";
    let reasoningIndex = -1;
    let reasoningContent = "";
    const toolAcc = new Map(); // tc stream index -> { id, name, args }
    let usage = null;
    let finish = null;

    const closeText = function* () {
      if (textIndex < 0) return;
      yield { type: "block-end", index: textIndex, block: { type: "text", text: textContent } };
      textIndex = -1;
      textContent = "";
    };
    const closeReasoning = function* () {
      if (reasoningIndex < 0) return;
      yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningContent } };
      reasoningIndex = -1;
      reasoningContent = "";
    };

    const handlePayload = function* (event) {
      if (event === null || typeof event !== "object") return;
      // Provider-level error event (same shape the responses/messages
      // pumps already handle): surface it directly instead of falling
      // through to "stream ended without a finish reason".
      if (event.type === "error" || event.error !== undefined) {
        const detail = event.error?.message ?? event.message ?? event.error?.code ?? event.code ?? "unknown";
        throw new LlmError(`llm-opencode-go: provider error: ${detail}`, "PROVIDER_ERROR");
      }
      const mapped = toTokenUsage(event.usage);
      if (mapped !== null) usage = mapped;
      const choice = event.choices?.[0];
      if (!choice) return;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content !== "") {
        if (textIndex < 0) {
          textIndex = nextIndex++;
          yield { type: "block-start", index: textIndex, blockType: "text" };
        }
        textContent += delta.content;
        yield { type: "text-delta", index: textIndex, text: delta.content };
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
        if (reasoningIndex < 0) {
          reasoningIndex = nextIndex++;
          yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
        }
        reasoningContent += delta.reasoning_content;
        yield { type: "reasoning-delta", index: reasoningIndex, text: delta.reasoning_content };
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const slot = toolAcc.get(tc.index) ?? { id: undefined, name: undefined, args: "" };
          if (typeof tc.id === "string") slot.id = tc.id;
          if (typeof tc.function?.name === "string") slot.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") slot.args += tc.function.arguments;
          toolAcc.set(tc.index, slot);
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finish = mapFinishReason(choice.finish_reason);
      }
    };

    // Shared line pump owns the reader, idle watchdog, and release; the
    // per-surface logic above only translates parsed payloads, so the two
    // can no longer drift apart on framing.
    for await (const event of ssePayloads(webBody, callerSignal, streamIdleTimeoutMs)) {
      yield* handlePayload(event);
    }
    yield* closeText();
    yield* closeReasoning();
    for (const slot of [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s)) {
      if (slot.id === undefined || slot.name === undefined) {
        throw new LlmError("llm-opencode-go: truncated tool-call (missing id or name)", "PROVIDER_PROTOCOL_ERROR");
      }
      const index = nextIndex++;
      yield { type: "block-start", index, blockType: "tool-call" };
      yield { type: "tool-call-delta", index, id: slot.id, name: slot.name, argumentsDelta: slot.args };
      yield {
        type: "block-end",
        index,
        block: { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.args },
      };
    }
    if (usage) yield { type: "usage", usage };
    if (finish) {
      yield { type: "finish", reason: finish };
    } else {
      throw new LlmError("llm-opencode-go: stream ended without a finish reason", "PROVIDER_PROTOCOL_ERROR");
    }
  }

  /** Responses-API SSE → StreamChunks. */
  async *pumpResponses(webBody, callerSignal, streamIdleTimeoutMs) {
    let nextIndex = 0;
    let textIndex = -1;
    let textContent = "";
    let reasoningIndex = -1;
    let reasoningContent = "";
    const toolAcc = new Map(); // item key -> { id, name, args }
    let usage = null;
    let finish = null;
    const closeText = function* () {
      if (textIndex < 0) return;
      yield { type: "block-end", index: textIndex, block: { type: "text", text: textContent } };
      textIndex = -1;
      textContent = "";
    };
    const closeReasoning = function* () {
      if (reasoningIndex < 0) return;
      yield { type: "block-end", index: reasoningIndex, block: { type: "reasoning", text: reasoningContent } };
      reasoningIndex = -1;
      reasoningContent = "";
    };
    const accSlot = (key) => {
      let slot = toolAcc.get(key);
      if (slot === undefined) {
        slot = { id: undefined, name: undefined, args: "" };
        toolAcc.set(key, slot);
      }
      return slot;
    };
    const handle = function* (event) {
      if (event === null || typeof event !== "object") return;
      const type = event.type;
      if (type === "error") {
        throw new LlmError(
          `llm-opencode-go: provider error: ${event.message ?? event.code ?? "unknown"}`,
          "PROVIDER_ERROR",
        );
      }
      if (type === "response.output_text.delta" && typeof event.delta === "string" && event.delta !== "") {
        if (textIndex < 0) {
          textIndex = nextIndex++;
          yield { type: "block-start", index: textIndex, blockType: "text" };
        }
        textContent += event.delta;
        yield { type: "text-delta", index: textIndex, text: event.delta };
        return;
      }
      if (
        (type === "response.reasoning_text.delta" || type === "response.reasoning_summary_text.delta") &&
        typeof event.delta === "string" && event.delta !== ""
      ) {
        if (reasoningIndex < 0) {
          reasoningIndex = nextIndex++;
          yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
        }
        reasoningContent += event.delta;
        yield { type: "reasoning-delta", index: reasoningIndex, text: event.delta };
        return;
      }
      if (type === "response.output_item.added" && event.item?.type === "function_call") {
        const slot = accSlot(String(event.output_index ?? event.item.call_id ?? event.item.id));
        if (typeof event.item.call_id === "string") slot.id = event.item.call_id;
        else if (slot.id === undefined && typeof event.item.id === "string") slot.id = event.item.id;
        if (typeof event.item.name === "string") slot.name = event.item.name;
        if (typeof event.item.arguments === "string" && event.item.arguments !== "") slot.args = event.item.arguments;
        return;
      }
      if (type === "response.function_call_arguments.delta") {
        const slot = accSlot(String(event.output_index ?? event.item_id));
        if (typeof event.delta === "string") slot.args += event.delta;
        return;
      }
      if (type === "response.output_item.done" && event.item?.type === "function_call") {
        const slot = accSlot(String(event.output_index ?? event.item.call_id ?? event.item.id));
        if (typeof event.item.call_id === "string") slot.id = event.item.call_id;
        else if (slot.id === undefined && typeof event.item.id === "string") slot.id = event.item.id;
        if (typeof event.item.name === "string") slot.name = event.item.name;
        if (typeof event.item.arguments === "string" && event.item.arguments !== "") slot.args = event.item.arguments;
        return;
      }
      // Terminal states arrive either nested in `response.completed` or as a
      // standalone `response.incomplete` event; both carry usage + reason.
      if (
        (type === "response.completed" || type === "response.incomplete") &&
        event.response !== null && typeof event.response === "object"
      ) {
        const resp = event.response;
        const mapped = toTokenUsage(resp.usage);
        if (mapped !== null) usage = mapped;
        if (resp.status === "completed") {
          finish = toolAcc.size > 0 ? { kind: "tool-calls" } : { kind: "stop" };
        } else if (resp.status === "incomplete" || type === "response.incomplete") {
          const reason = resp.incomplete_details?.reason;
          finish =
            reason === "max_output_tokens"
              ? { kind: "max-tokens" }
              : { kind: "error", failure: { message: `llm-opencode-go: incomplete response (${reason ?? "unknown reason"})`, code: "PROVIDER_ERROR" } };
        } else {
          finish = { kind: "error", failure: { message: `llm-opencode-go: response status ${String(resp.status)}`, code: "PROVIDER_ERROR" } };
        }
      }
    };
    for await (const event of ssePayloads(webBody, callerSignal, streamIdleTimeoutMs)) {
      yield* handle(event);
    }
    yield* closeText();
    yield* closeReasoning();
    for (const slot of toolAcc.values()) {
      if (slot.id === undefined || slot.name === undefined) {
        throw new LlmError("llm-opencode-go: truncated function call (missing id or name)", "PROVIDER_PROTOCOL_ERROR");
      }
      const index = nextIndex++;
      yield { type: "block-start", index, blockType: "tool-call" };
      yield { type: "tool-call-delta", index, id: slot.id, name: slot.name, argumentsDelta: slot.args };
      yield {
        type: "block-end",
        index,
        block: { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.args },
      };
    }
    if (usage) yield { type: "usage", usage };
    if (finish) {
      yield { type: "finish", reason: finish };
    } else {
      throw new LlmError("llm-opencode-go: stream ended without a finish reason", "PROVIDER_PROTOCOL_ERROR");
    }
  }

  /** Anthropic-messages SSE → StreamChunks. */
  async *pumpMessages(webBody, callerSignal, streamIdleTimeoutMs) {
    let nextIndex = 0;
    const open = new Map(); // provider block index -> { dshIndex, kind, id, name, text, args }
    const toolDone = [];
    let inputTokens = null;
    let inputCached = 0;
    let inputWrite = 0;
    let outputTokens = null;
    let finish = null;
    const closeChunk = (entry) => {
      open.delete(entry.providerIndex);
      if (entry.kind === "text") {
        return { type: "block-end", index: entry.dshIndex, block: { type: "text", text: entry.text } };
      }
      if (entry.kind === "thinking") {
        return { type: "block-end", index: entry.dshIndex, block: { type: "reasoning", text: entry.text } };
      }
      try {
        JSON.parse(entry.args);
      } catch {
        throw new LlmError(
          `llm-opencode-go: truncated tool input for "${entry.name ?? "unknown"}"`,
          "PROVIDER_PROTOCOL_ERROR",
        );
      }
      toolDone.push(entry);
      return null;
    };
    // Open (or reuse) the dsh block for a provider block index. Returns
    // [entry, openedChunk, closedChunk]; callers yield the non-null chunks.
    const openEntry = (providerIndex, kind) => {
      let entry = open.get(providerIndex);
      let closed = null;
      if (entry !== undefined && entry.kind !== kind) {
        closed = closeChunk(entry);
        entry = undefined;
      }
      let opened = null;
      if (entry === undefined) {
        entry = { providerIndex, dshIndex: nextIndex++, kind, id: undefined, name: undefined, text: "", args: "" };
        open.set(providerIndex, entry);
        opened = { type: "block-start", index: entry.dshIndex, blockType: kind === "tool" ? "tool-call" : kind };
      }
      return [entry, opened, closed];
    };
    const handle = function* (event) {
      if (event === null || typeof event !== "object") return;
      const type = event.type;
      if (type === "error") {
        throw new LlmError(
          `llm-opencode-go: provider error: ${event.error?.message ?? event.message ?? "unknown"}`,
          "PROVIDER_ERROR",
        );
      }
      if (type === "message_start" && event.message?.usage) {
        const usage = event.message.usage;
        if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
        if (typeof usage.cache_read_input_tokens === "number") inputCached = usage.cache_read_input_tokens;
        if (typeof usage.cache_creation_input_tokens === "number") inputWrite = usage.cache_creation_input_tokens;
        return;
      }
      if (type === "content_block_start" && event.content_block && typeof event.index === "number") {
        const block = event.content_block;
        if (block.type === "text" || block.type === "thinking") {
          const [, opened, closed] = openEntry(event.index, block.type);
          if (closed) yield closed;
          if (opened) yield opened;
        } else if (block.type === "tool_use") {
          const [entry, opened, closed] = openEntry(event.index, "tool");
          if (closed) yield closed;
          if (opened) yield opened;
          if (typeof block.id === "string") entry.id = block.id;
          if (typeof block.name === "string") entry.name = block.name;
        }
        // redacted_thinking and unknown block kinds are skipped deliberately.
        return;
      }
      if (type === "content_block_delta" && event.delta && typeof event.index === "number") {
        const delta = event.delta;
        if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") {
          const [entry, opened, closed] = openEntry(event.index, "text");
          if (closed) yield closed;
          if (opened) yield opened;
          entry.text += delta.text;
          yield { type: "text-delta", index: entry.dshIndex, text: delta.text };
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") {
          const [entry, opened, closed] = openEntry(event.index, "thinking");
          if (closed) yield closed;
          if (opened) yield opened;
          entry.text += delta.thinking;
          yield { type: "reasoning-delta", index: entry.dshIndex, text: delta.thinking };
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
          const entry = open.get(event.index);
          if (entry?.kind === "tool") entry.args += delta.partial_json;
        }
        // signature_delta carries no displayable content.
        return;
      }
      if (type === "content_block_stop" && typeof event.index === "number") {
        const entry = open.get(event.index);
        if (entry !== undefined) {
          const closed = closeChunk(entry);
          if (closed) yield closed;
        }
        return;
      }
      if (type === "message_delta" && event.delta && typeof event.delta === "object") {
        if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) {
          finish = mapAnthropicStop(event.delta.stop_reason);
        }
        // The delta usage is authoritative when present (it repeats the
        // input side, often larger once prefixes/cache join in).
        if (event.usage && typeof event.usage === "object") {
          if (typeof event.usage.input_tokens === "number") inputTokens = event.usage.input_tokens;
          if (typeof event.usage.output_tokens === "number") outputTokens = event.usage.output_tokens;
          if (typeof event.usage.cache_read_input_tokens === "number") inputCached = event.usage.cache_read_input_tokens;
          if (typeof event.usage.cache_creation_input_tokens === "number") inputWrite = event.usage.cache_creation_input_tokens;
        }
      }
    };
    for await (const event of ssePayloads(webBody, callerSignal, streamIdleTimeoutMs)) {
      yield* handle(event);
    }
    for (const entry of [...open.values()]) {
      const closed = closeChunk(entry);
      if (closed) yield closed;
    }
    for (const slot of toolDone) {
      if (slot.id === undefined || slot.name === undefined) {
        throw new LlmError("llm-opencode-go: truncated tool use (missing id or name)", "PROVIDER_PROTOCOL_ERROR");
      }
      const index = slot.dshIndex;
      yield { type: "tool-call-delta", index, id: slot.id, name: slot.name, argumentsDelta: slot.args };
      yield {
        type: "block-end",
        index,
        block: { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.args },
      };
    }
    if (inputTokens !== null && outputTokens !== null) {
      const read = Math.min(Math.max(0, inputCached), inputTokens);
      const write = Math.min(Math.max(0, inputWrite), inputTokens - read);
      yield {
        type: "usage",
        usage: {
          inputTokens: inputTokens - read - write,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          ...(read > 0 ? { cacheReadTokens: read } : {}),
          ...(write > 0 ? { cacheWriteTokens: write } : {}),
        },
      };
    }
    if (finish) {
      yield { type: "finish", reason: finish };
    } else {
      throw new LlmError("llm-opencode-go: stream ended without a finish reason", "PROVIDER_PROTOCOL_ERROR");
    }
  }
}

/**
 * Live model catalog for the settings card: GETs `/v1/models` with the
 * seam-held key and classifies each id by serving surface. Pure fetch +
 * injectable options/key make it directly testable.
 */
export async function refreshModels(getOptions, resolveKey, signal) {
  const connection = getOptions();
  let apiKey;
  try {
    apiKey = await resolveKey();
  } catch (error) {
    return fail("missing-credential", error?.message ?? String(error));
  }
  let response;
  // Same unref'd AbortController pattern as the inference path: the timer
  // guards connect + response headers only and never holds the process open.
  const refreshTimeout = new AbortController();
  const refreshTimer = setTimeout(() => {
    refreshTimeout.abort(
      new DOMException(
        `llm-opencode-go: model refresh timed out after ${connection.requestTimeoutMs}ms`,
        "TimeoutError",
      ),
    );
  }, connection.requestTimeoutMs);
  if (refreshTimer.unref) refreshTimer.unref();
  const refreshSignal =
    signal === undefined ? refreshTimeout.signal : AbortSignal.any([signal, refreshTimeout.signal]);
  try {
    response = await fetch(`${connection.apiBase}/v1/models`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...apiAttributionHeaders(),
      },
      signal: refreshSignal,
    });
  } catch (error) {
    if (signal?.aborted) return fail("aborted", "model refresh aborted");
    if (refreshTimeout.signal.aborted) return fail("transport", `model refresh timed out after ${connection.requestTimeoutMs}ms`);
    return fail("transport", `model refresh request failed: ${error?.message ?? error}`);
  } finally {
    clearTimeout(refreshTimer);
  }
  if (response.status === 401) return fail("invalid-credential", "model refresh rejected: invalid API key (401)");
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return fail("refresh-failed", `model refresh failed (HTTP ${response.status})${text === "" ? "" : `: ${text.slice(0, 300)}`}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return fail("refresh-failed", "model refresh returned non-JSON");
  }
  const data = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (data === null) return fail("refresh-failed", "model refresh returned an unexpected shape");
  const models = [];
  for (const entry of data) {
    if (entry !== null && typeof entry === "object" && typeof entry.id === "string" && entry.id !== "") {
      const known = MODEL_TABLE.find((m) => m.id === entry.id);
      models.push({
        id: entry.id,
        surface: endpointOf(entry.id) ?? "unknown",
        // Modality for the card tags; omitted when the static table does
        // not know the id (the card then shows the surface tag only).
        ...(known === undefined ? {} : { input: known.image === true ? ["text", "image"] : ["text"] }),
      });
    }
  }
  return ok({ models });
}
