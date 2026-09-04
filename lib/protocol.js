/**
 * @dsh-plugins/dsh-opencode-go — pure wire protocol: headers, message
 * translation, SSE parsing, usage mapping, error mapping, RPC envelopes.
 * No Services, no I/O; everything here is unit-testable.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import { modelSupportsImage } from "./models.js";
/** Required by OpenCode Go on every inference request (per-conversation ID). */
export const SESSION_HEADER = "x-opencode-session";

/**
 * This package's own version, appended to the harness attribution identity
 * so the operator can tell plugin traffic apart from other harness traffic:
 * `deepseek-harness/<v> (+url) dsh-opencode-go/<v>`.
 */
export const PLUGIN_VERSION = createRequire(import.meta.url)("../package.json").version;

/**
 * Collect durable image references from messages, including nested
 * tool-result content, deduplicated by attachment id (pure).
 */
export function collectImageRefs(messages) {
  const seen = new Map();
  const walk = (blocks) => {
    for (const block of blocks ?? []) {
      if (block?.type === "image" && block.attachment) {
        const id = String(block.attachment.attachmentId ?? "");
        if (id !== "" && !seen.has(id)) seen.set(id, block.attachment);
      } else if (block?.type === "tool-result" && Array.isArray(block.content)) {
        walk(block.content);
      }
    }
  };
  for (const message of messages ?? []) walk(message.content);
  return [...seen.values()];
}

/**
 * Session header value for one request: the loop-stamped conversation id when
 * present, otherwise a one-off UUID so the request still carries the required
 * header instead of failing server-side.
 */
export function sessionHeaderValue(sessionId) {
  return sessionId === undefined ? randomUUID() : String(sessionId);
}

/** Wire headers for one request (pure, exported for tests). */
export function buildHeaders(apiKey, sessionId, extra = {}) {
  const { "user-agent": attribution, ...rest } = attributionHeaders();
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    ...rest,
    ...extra,
    // Last on purpose: the session header is required by the operator and
    // nothing may suppress the attribution identity.
    [SESSION_HEADER]: sessionHeaderValue(sessionId),
    "user-agent": `${attribution} dsh-opencode-go/${PLUGIN_VERSION}`,
  };
}

/** Flatten tool-result content blocks to model-facing text (pure). */
export function flattenBlocks(blocks) {
  return blocks
    .map((block) => {
      if (block.type === "text" || block.type === "reasoning") return block.text;
      if (block.type === "image") return "[image omitted]";
      return JSON.stringify(block);
    })
    .join("\n");
}

/**
 * Translate one durable image reference to a surface-native part (pure).
 * Known text-only models are refused loudly; unknown ids stay permissive
 * (the server is authoritative). Bytes must be pre-resolved into `images`
 * by the stream path — see resolveImageData.
 */
export function imagePart(ref, images, model, surface) {
  if (!modelSupportsImage(model)) {
    throw new LlmError(
      `llm-opencode-go: model "${model}" does not accept image input`,
      "UNSUPPORTED_CONTENT",
    );
  }
  const hit = images.get(String(ref.attachmentId));
  if (hit === undefined) {
    throw new LlmError("llm-opencode-go: image bytes are unavailable for this request", "PROVIDER_PROTOCOL_ERROR");
  }
  if (surface === "responses") return { type: "input_image", image_url: `data:${hit.mediaType};base64,${hit.base64}` };
  if (surface === "messages") {
    return { type: "image", source: { type: "base64", media_type: hit.mediaType, data: hit.base64 } };
  }
  return { type: "image_url", image_url: { url: `data:${hit.mediaType};base64,${hit.base64}` } };
}

/**
 * Translate dsh messages to OpenAI chat messages (pure).
 * Text + tool-call/tool-result + images (vision models); assistant reasoning
 * is omitted explicitly rather than silently mangled.
 */
export function toOpenAiMessages(system, messages, images = new Map(), model = "") {
  const out = [];
  if (system !== undefined) out.push({ role: "system", content: system });
  for (const message of messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: flattenBlocks(message.content) });
      continue;
    }
    if (message.role === "user" && message.source?.kind === "tool") {
      const [result] = message.content;
      out.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: flattenBlocks(result.content),
      });
      continue;
    }
    if (message.role === "user") {
      const parts = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push({ type: "text", text: block.text });
        else if (block.type === "image") parts.push(imagePart(block.attachment, images, model, "chat"));
        else {
          throw new LlmError(
            `llm-opencode-go: unexpected ${block.type} block in user message`,
            "UNSUPPORTED_CONTENT",
          );
        }
      }
      out.push({
        role: "user",
        content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts,
      });
      continue;
    }
    // assistant
    const texts = [];
    const toolCalls = [];
    for (const block of message.content) {
      if (block.type === "text") texts.push(block.text);
      else if (block.type === "reasoning") continue; // v1: no reasoning slot on chat API
      else if (block.type === "tool-call") {
        toolCalls.push({
          id: String(block.id),
          type: "function",
          function: { name: block.name, arguments: block.arguments },
        });
      } else {
        throw new LlmError(
          `llm-opencode-go: unexpected ${block.type} block in assistant message`,
          "UNSUPPORTED_CONTENT",
        );
      }
    }
    if (toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: texts.join("") === "" ? null : texts.join(""),
        tool_calls: toolCalls,
      });
    } else {
      out.push({ role: "assistant", content: texts.join("") });
    }
  }
  return out;
}

/** Assemble the chat request body (pure, exported for tests). */
export function buildChatBody(options, images = new Map()) {
  const body = {
    model: options.model,
    messages: toOpenAiMessages(options.system, options.messages, images, options.model),
    stream: true,
  };
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.stop !== undefined) body.stop = options.stop;
  if (options.reasoningEffort !== undefined) body.reasoning_effort = String(options.reasoningEffort);
  return body;
}

/**
 * Translate dsh messages to Responses-API input items (pure).
 * System content folds into `instructions`; history reasoning is omitted
 * (no reasoning slot on this surface).
 */
export function toResponsesInput(system, messages, images = new Map(), model = "") {
  const instructions = [];
  if (system !== undefined) instructions.push(system);
  const input = [];
  for (const message of messages) {
    if (message.role === "system") {
      instructions.push(flattenBlocks(message.content));
      continue;
    }
    if (message.role === "user" && message.source?.kind === "tool") {
      const [result] = message.content;
      input.push({
        type: "function_call_output",
        call_id: String(result.toolCallId),
        output: flattenBlocks(result.content),
      });
      continue;
    }
    if (message.role === "user") {
      const parts = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push({ type: "input_text", text: block.text });
        else if (block.type === "image") parts.push(imagePart(block.attachment, images, model, "responses"));
        else {
          throw new LlmError(
            `llm-opencode-go: unexpected ${block.type} block in user message (responses surface)`,
            "UNSUPPORTED_CONTENT",
          );
        }
      }
      input.push({ role: "user", content: parts });
      continue;
    }
    // assistant
    const texts = [];
    for (const block of message.content) {
      if (block.type === "text") texts.push(block.text);
      else if (block.type === "reasoning") continue;
      else if (block.type === "tool-call") {
        input.push({
          type: "function_call",
          call_id: String(block.id),
          name: block.name,
          arguments: block.arguments,
        });
      } else {
        throw new LlmError(
          `llm-opencode-go: unexpected ${block.type} block in assistant message (responses surface)`,
          "UNSUPPORTED_CONTENT",
        );
      }
    }
    if (texts.length > 0) {
      input.push({ role: "assistant", content: [{ type: "output_text", text: texts.join("") }] });
    }
  }
  return { instructions: instructions.length > 0 ? instructions.join("\n\n") : undefined, input };
}

/** Assemble the Responses-API request body (pure). */
export function buildResponsesBody(options, images = new Map()) {
  if (options.stop !== undefined && options.stop.length > 0) {
    throw new LlmError("llm-opencode-go: stop sequences are not supported on the responses surface", "UNSUPPORTED_OPTION");
  }
  const { instructions, input } = toResponsesInput(options.system, options.messages, images, options.model);
  const body = { model: options.model, input, stream: true };
  if (instructions !== undefined) body.instructions = instructions;
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_output_tokens = options.maxTokens;
  if (options.reasoningEffort !== undefined) body.reasoning = { effort: String(options.reasoningEffort) };
  return body;
}

/**
 * Translate dsh messages to Anthropic-messages shape (pure). Returns
 * `{system, messages}`; reasoning history is omitted.
 */
export function toAnthropicMessages(system, messages, images = new Map(), model = "") {
  const systems = [];
  if (system !== undefined) systems.push(system);
  const out = [];
  for (const message of messages) {
    if (message.role === "system") {
      systems.push(flattenBlocks(message.content));
      continue;
    }
    if (message.role === "user" && message.source?.kind === "tool") {
      const [result] = message.content;
      out.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: String(result.toolCallId),
          content: flattenBlocks(result.content),
          ...(result.isError === true ? { is_error: true } : {}),
        }],
      });
      continue;
    }
    if (message.role === "user") {
      const parts = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push({ type: "text", text: block.text });
        else if (block.type === "image") parts.push(imagePart(block.attachment, images, model, "messages"));
        else {
          throw new LlmError(
            `llm-opencode-go: unexpected ${block.type} block in user message (messages surface)`,
            "UNSUPPORTED_CONTENT",
          );
        }
      }
      out.push({ role: "user", content: parts });
      continue;
    }
    // assistant
    const content = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "reasoning") continue;
      else if (block.type === "tool-call") {
        let parsed;
        try {
          parsed = JSON.parse(block.arguments);
        } catch {
          throw new LlmError(
            `llm-opencode-go: stored tool-call arguments are not valid JSON for "${block.name}"`,
            "PROVIDER_PROTOCOL_ERROR",
          );
        }
        content.push({ type: "tool_use", id: String(block.id), name: block.name, input: parsed });
      } else {
        throw new LlmError(
          `llm-opencode-go: unexpected ${block.type} block in assistant message (messages surface)`,
          "UNSUPPORTED_CONTENT",
        );
      }
    }
    out.push({ role: "assistant", content });
  }
  return { system: systems.length > 0 ? systems.join("\n\n") : undefined, messages: out };
}

/** Assemble the Anthropic-messages request body (pure). */
export function buildAnthropicBody(options, images = new Map()) {
  const { system, messages } = toAnthropicMessages(options.system, options.messages, images, options.model);
  const body = {
    model: options.model,
    max_tokens: options.maxTokens ?? 8192,
    messages,
    stream: true,
  };
  if (system !== undefined) body.system = system;
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.stop !== undefined && options.stop.length > 0) body.stop_sequences = options.stop;
  if (options.reasoningEffort !== undefined) {
    throw new LlmError(
      "llm-opencode-go: reasoning levels are not mapped on the messages surface (Anthropic thinking is budget-based); leave the effort at Default",
      "UNSUPPORTED_OPTION",
    );
  }
  return body;
}

/** Map Anthropic stop_reason to a dsh finish reason (pure). */
export function mapAnthropicStop(reason) {
  if (reason === "end_turn" || reason === "stop_sequence") return { kind: "stop" };
  if (reason === "tool_use") return { kind: "tool-calls" };
  if (reason === "max_tokens") return { kind: "max-tokens" };
  return {
    kind: "error",
    failure: {
      message: `llm-opencode-go: unsupported stop_reason ${JSON.stringify(reason)}`,
      code: "PROVIDER_PROTOCOL_ERROR",
    },
  };
}

/** Map OpenAI finish_reason to a dsh finish reason (pure). */
export function mapFinishReason(reason) {
  if (reason === "stop") return { kind: "stop" };
  if (reason === "tool_calls") return { kind: "tool-calls" };
  if (reason === "length") return { kind: "max-tokens" };
  return {
    kind: "error",
    failure: {
      message: `llm-opencode-go: unsupported finish_reason ${JSON.stringify(reason)}`,
      code: "PROVIDER_PROTOCOL_ERROR",
    },
  };
}

/** Parse one SSE `data:` payload into its JSON value; "[DONE]" -> null. */
export function parseSseData(payload) {
  const text = payload.trim();
  if (text === "[DONE]") return null;
  return JSON.parse(text);
}

/**
 * Translate a provider `usage` object to dsh TokenUsage (pure).
 * Accepts both wire vocabularies: chat-completions (`prompt_tokens` /
 * `completion_tokens` / `*_tokens_details`) and responses/messages
 * (`input_tokens` / `output_tokens` / `*_tokens_details`).
 * Counts are DISJOINT per the dsh contract: `inputTokens` is uncached input
 * only, cached input rides `cacheReadTokens` (creation writes ride
 * `cacheWriteTokens` when reported), and the provider total is preserved
 * verbatim.
 */
export function toTokenUsage(usage) {
  if (usage === null || typeof usage !== "object") return null;
  const promptRaw = usage.prompt_tokens ?? usage.input_tokens;
  const completionRaw = usage.completion_tokens ?? usage.output_tokens;
  if (typeof promptRaw !== "number" || typeof completionRaw !== "number") return null;
  const prompt = Math.max(0, Math.floor(promptRaw));
  const output = Math.max(0, Math.floor(completionRaw));
  const promptDetails = usage.prompt_tokens_details ?? usage.input_tokens_details;
  const cachedRaw =
    promptDetails !== null && typeof promptDetails === "object" && typeof promptDetails.cached_tokens === "number"
      ? promptDetails.cached_tokens
      : typeof usage.prompt_cache_hit_tokens === "number"
        ? usage.prompt_cache_hit_tokens
        : 0;
  const creationRaw = usage.cache_creation_input_tokens;
  const cached = Math.min(Math.max(0, Math.floor(cachedRaw)), prompt);
  const created = Math.min(Math.max(0, typeof creationRaw === "number" ? Math.floor(creationRaw) : 0), prompt - cached);
  const result = {
    inputTokens: prompt - cached - created,
    outputTokens: output,
    totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : prompt + output,
  };
  if (cached > 0) result.cacheReadTokens = cached;
  if (created > 0) result.cacheWriteTokens = created;
  const reasoningDetails = usage.completion_tokens_details ?? usage.output_tokens_details;
  const reasoning =
    reasoningDetails !== null && typeof reasoningDetails === "object" ? reasoningDetails.reasoning_tokens : undefined;
  if (typeof reasoning === "number" && reasoning > 0) {
    result.reasoningTokens = Math.floor(reasoning);
  }
  return result;
}

/** Map non-2xx HTTP status to an LlmError (pure construction helper). */
export function httpError(status, errText, retryAfterMs) {
  const detail = errText.slice(0, 500);
  if (status === 401) {
    return new LlmError(
      `llm-opencode-go: invalid API key (401)${detail === "" ? "" : `: ${detail}`}; check OPENCODE_GO_API_KEY`,
      "AUTH",
      { status },
    );
  }
  if (status === 429) {
    return new LlmError(
      `llm-opencode-go: rate limited (429)${detail === "" ? "" : `: ${detail}`}`,
      "RATE_LIMIT",
      retryAfterMs === undefined ? { status } : { status, providerRetryAfterMs: retryAfterMs },
    );
  }
  if (status === 400) {
    return new LlmError(`llm-opencode-go: request rejected (400): ${detail}`, "INVALID_REQUEST", { status });
  }
  return new LlmError(
    `llm-opencode-go: provider error (HTTP ${status})${detail === "" ? "" : `: ${detail}`}`,
    "PROVIDER_UNAVAILABLE",
    { status },
  );
}

/** Parse a Retry-After (seconds or HTTP date) header to milliseconds. */
export function parseRetryAfterMs(value) {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** A successful RPC result. */
export function ok(value) {
  return { ok: true, value };
}
/**
 * A failed RPC result. Custom codes ride inside `details`: the transport
 * validates `error.code` against the protocol enum, where only `internal`
 * is the open catch-all.
 */
export function fail(code, message, details = {}) {
  return { ok: false, error: { code: "internal", message, details: { ...details, code } } };
}
