/**
 * @dsh-plugins/dsh-opencode-go — host half (pure host-side provider plugin).
 *
 * Registers the `zen-go` provider route on `ctx.llm`. v1 speaks the
 * OpenCode Go OpenAI-compatible endpoint (`/v1/chat/completions`, SSE) and
 * sends `x-opencode-session` (stable per conversation) on every request, which
 * is the header OpenCode Go requires for prompt-cache optimization and, from
 * 09/05, for the request to be accepted at all.
 *
 * Model -> endpoint map follows https://opencode.ai/docs/go : chat models are
 * served in v1; `responses` / `messages` models resolve with an explicit
 * UNSUPPORTED error until phase 2 wires those two surfaces.
 *
 * Credential chain: the credentials seam only (`credentials.resolve`
 * layers process env over the managed store over `.env` files, per request,
 * so stored/rotated keys need no restart). No literal key field exists on
 * purpose — secrets never belong in settings or composition files.
 *
 * @module dsh-opencode-go
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import z from "@deepseek-ai/schemastery";
import {
  LlmAdapter,
  LlmError,
  assertUsableApiKey,
  attributionHeaders,
} from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";

export const name = "llm-opencode-go";
export const inject = ["llm", "connection"];
/** User-settings namespace owning this plugin's section. */
export const NS = "llm-opencode-go";

/**
 * The single provider route this plugin owns. Deliberately NOT `opencode-go`:
 * that is the natural name for user-owned pi-ai custom profiles, and the llm
 * registry allows exactly one owner per route (DUPLICATE_ADAPTER otherwise).
 */
export const PROVIDER = "zen-go";
export const DEFAULT_API_BASE = "https://opencode.ai/zen/go";
export const DEFAULT_API_KEY_ENV = "OPENCODE_GO_API_KEY";
/** Required by OpenCode Go on every inference request (per-conversation ID). */
export const SESSION_HEADER = "x-opencode-session";

/**
 * This package's own version, appended to the harness attribution identity
 * so the operator can tell plugin traffic apart from other harness traffic:
 * `deepseek-harness/<v> (+url) dsh-opencode-go/<v>`.
 */
export const PLUGIN_VERSION = createRequire(import.meta.url)("../package.json").version;

/**
 * Static model -> serving-surface table from the Go docs plus a live
 * `/v1/models` probe (34 ids). `contextWindow` stays unset: the endpoint
 * discloses ids only, and catalog fields are advisory.
 */
export const MODEL_TABLE = [
  // ---- chat/completions (served in v1) ----
  { id: "mimo-v2.5", endpoint: "chat" },
  { id: "mimo-v2.5-pro", endpoint: "chat" },
  { id: "mimo-v2-pro", endpoint: "chat" },
  { id: "mimo-v2-omni", endpoint: "chat" },
  { id: "deepseek-v4-flash", endpoint: "chat" },
  { id: "deepseek-v4-pro", endpoint: "chat" },
  { id: "deepseek-v4-flash-vision-exp", endpoint: "chat", image: true },
  { id: "glm-5.3-flash", endpoint: "chat" },
  { id: "glm-5.3", endpoint: "chat" },
  { id: "glm-5.2", endpoint: "chat" },
  { id: "glm-5.1", endpoint: "chat" },
  { id: "glm-5", endpoint: "chat" },
  { id: "kimi-k3", endpoint: "chat" },
  { id: "kimi-k2.7-code", endpoint: "chat" },
  { id: "kimi-k2.6", endpoint: "chat" },
  { id: "kimi-k2.5", endpoint: "chat" },
  { id: "longcat-2.0", endpoint: "chat" },
  { id: "hy4-preview", endpoint: "chat" },
  { id: "hy3", endpoint: "chat" },
  { id: "hy3-preview", endpoint: "chat" },
  // ---- responses (phase 2) ----
  { id: "grok-4.6", endpoint: "responses" },
  { id: "grok-4.5", endpoint: "responses" },
  { id: "gpt-5.6-luna", endpoint: "responses" },
  { id: "muse-spark-1.3-contributor", endpoint: "responses", image: true },
  { id: "muse-spark-1.2-contributor", endpoint: "responses", image: true },
  // ---- messages / Anthropic-compatible (phase 2) ----
  { id: "minimax-m3", endpoint: "messages" },
  { id: "minimax-m2.7", endpoint: "messages" },
  { id: "minimax-m2.5", endpoint: "messages" },
  { id: "qwen3.8-max", endpoint: "messages" },
  { id: "qwen3.8-flash", endpoint: "messages" },
  { id: "qwen3.7-max", endpoint: "messages" },
  { id: "qwen3.7-plus", endpoint: "messages" },
  { id: "qwen3.6-plus", endpoint: "messages" },
  { id: "qwen3.5-plus", endpoint: "messages" },
];

/** Chat-served ids advertised by `listModels()` in v1. */
export const CHAT_MODEL_IDS = MODEL_TABLE.filter((m) => m.endpoint === "chat").map((m) => m.id);

/** Serving surface for a model id, or undefined when unknown. */
export function endpointOf(model) {
  return MODEL_TABLE.find((m) => m.id === model)?.endpoint;
}

/**
 * Whether a model accepts image input. Known vision models (see MODEL_TABLE)
 * return true, known text-only models false; unknown ids are permissive
 * (true) so newly discovered models keep working — the server stays
 * authoritative and rejects what it cannot serve.
 */
export function modelSupportsImage(model) {
  const entry = MODEL_TABLE.find((m) => m.id === model);
  if (entry === undefined) return true;
  return entry.image === true;
}

/** Inline-image byte cap per occurrence (matches common provider limits). */
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Wire formats accepted for inline base64 images on every surface. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

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

/**
 * Settings/composition schema. Every field carries a default so an empty
 * user section validates; the key itself deliberately has NO field here —
 * secrets travel the credentials seam (`apiKeyEnv` names the reference),
 * never settings or composition files.
 */
export const Config = z.object({
  apiKeyEnv: z.string().role("credential-ref").default(DEFAULT_API_KEY_ENV),
  apiBase: z.string().default(DEFAULT_API_BASE),
  requestTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(60000),
  streamIdleTimeoutMs: z.number().min(1).max(MAX_TIMER_DELAY_MS).default(300000),
  /**
   * Models offered by this route. Defaults to every known id across all
   * three surfaces; the settings card edits this list (refresh discovers,
   * checkboxes select). An explicit empty array means "offer none".
   */
  enabledModels: z.array(z.string()).default(MODEL_TABLE.map((m) => m.id)),
  /**
   * Per-model capacity overrides, user-filled (the operator discloses no
   * context metadata). Entries carry only the fields the user set; an empty
   * array means "no overrides". Fields are optional by schemastery default
   * (only `id` is required).
   */
  modelCaps: z.array(z.object({
    id: z.string().required(),
    contextWindow: z.number().step(1).min(1),
    maxTokens: z.number().step(1).min(1),
  })).default([]),
});

export function resolveOptions(raw = {}) {
  const requestTimeoutMs = raw.requestTimeoutMs ?? 60000;
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error("llm-opencode-go: requestTimeoutMs must be a positive finite number");
  }
  const streamIdleTimeoutMs = raw.streamIdleTimeoutMs ?? 300000;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error("llm-opencode-go: streamIdleTimeoutMs must be a positive finite number");
  }
  const modelCaps = raw.modelCaps ?? [];
  if (!Array.isArray(modelCaps)) throw new Error("llm-opencode-go: modelCaps must be an array");
  const caps = modelCaps.map((entry) => {
    if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || entry.id === "") {
      throw new Error("llm-opencode-go: modelCaps entries need a non-empty id");
    }
    const out = { id: entry.id };
    for (const field of ["contextWindow", "maxTokens"]) {
      if (entry[field] === undefined) continue;
      if (!Number.isInteger(entry[field]) || entry[field] <= 0) {
        throw new Error(`llm-opencode-go: modelCaps["${entry.id}"].${field} must be a positive integer`);
      }
      out[field] = entry[field];
    }
    return out;
  });
  return {
    apiKeyEnv: credentialRef(raw.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    apiBase: String(raw.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
    requestTimeoutMs,
    streamIdleTimeoutMs,
    enabledModels: [...(raw.enabledModels ?? MODEL_TABLE.map((m) => m.id))],
    modelCaps: caps,
  };
}

/**
 * Shared SSE line pump for the responses/messages surfaces: yields parsed
 * `data:` payloads ("[DONE]" filtered out) with the same idle watchdog the
 * chat surface uses. A quiet stream throws TIMEOUT; the caller's abort
 * propagates untouched.
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
    if (idleFired && callerSignal?.aborted !== true) {
      throw new LlmError(
        `llm-opencode-go: stream idle timeout after ${streamIdleTimeoutMs}ms`,
        "TIMEOUT",
      );
    }
  }
}

/**
 * Selectable reasoning levels per serving surface. Ids are the exact wire
 * values; names match the picker's display casing. No defaultEffort is
 * declared anywhere, so the picker offers Default (= omit the field and let
 * the server decide). Messages surface has no level vocabulary (Anthropic
 * thinking is budget-based), so it declares nothing.
 */
export const REASONING_EFFORTS = {
  responses: [
    { id: "minimal", name: "Minimal" },
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
    { id: "xhigh", name: "Xhigh" },
  ],
  chat: [
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
  ],
};

/** Reasoning metadata for one model id, or undefined when the surface has no level vocabulary. */
export function reasoningFor(model) {
  const endpoint = endpointOf(model);
  if (endpoint === "responses") return { efforts: REASONING_EFFORTS.responses };
  if (endpoint === "chat") return { efforts: REASONING_EFFORTS.chat };
  return undefined;
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
    return { id: provider, name: "OpenCode Go" };
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
    if (endpoint === "responses") {
      yield* this.streamSurface(connection, headers, options, "/v1/responses", buildResponsesBody(options, images), (body, signal, idleMs) => this.pumpResponses(body, signal, idleMs));
    } else if (endpoint === "messages") {
      // The messages surface authenticates Anthropic-style: Bearer alone
      // 401s with "Missing API key", so x-api-key rides along.
      const msgHeaders = buildHeaders(apiKey, options.sessionId, { "x-api-key": apiKey });
      yield* this.streamSurface(connection, msgHeaders, options, "/v1/messages", buildAnthropicBody(options, images), (body, signal, idleMs) => this.pumpMessages(body, signal, idleMs));
    } else {
      yield* this.streamSurface(connection, headers, options, "/v1/chat/completions", buildChatBody(options, images), (body, signal, idleMs) => this.pumpChunks(body, signal, idleMs));
    }
  }

  /** Shared POST + error mapping for the three SSE surfaces. */
  async *streamSurface(connection, headers, options, path, bodyObject, pump) {
    const signal =
      options.signal === undefined
        ? AbortSignal.timeout(connection.requestTimeoutMs)
        : AbortSignal.any([options.signal, AbortSignal.timeout(connection.requestTimeoutMs)]);

    let response;
    try {
      response = await fetch(`${connection.apiBase}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(bodyObject),
        signal,
      });
    } catch (error) {
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
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw httpError(response.status, errText, parseRetryAfterMs(response.headers.get("retry-after")));
    }
    if (!response.body) throw new LlmError("llm-opencode-go: empty response body", "PROVIDER_PROTOCOL_ERROR");

    yield* pump(response.body, options.signal, connection.streamIdleTimeoutMs);
  }

  /** Read SSE, translate deltas to StreamChunks. */
  async *pumpChunks(webBody, callerSignal, streamIdleTimeoutMs) {
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
    armIdle();
    try {
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

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n");
        while (boundary !== -1) {
          const line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          if (line.startsWith("data:")) {
            const event = parseSseData(line.slice(5));
            if (event !== null) yield* handlePayload(event);
          }
          boundary = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail.startsWith("data:")) {
        const event = parseSseData(tail.slice(5));
        if (event !== null) yield* handlePayload(event);
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
    } finally {
      clearIdle();
      if (idleFired && callerSignal?.aborted !== true) {
        throw new LlmError(
          `llm-opencode-go: stream idle timeout after ${streamIdleTimeoutMs}ms`,
          "TIMEOUT",
        );
      }
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

export function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  // Live connection facts: the composition entry at load, then each user
  // settings snapshot at first use. An invalid snapshot keeps the last good
  // one instead of breaking the next request.
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveOptions(raw);
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error("llm-opencode-go: keeping the last good configuration after an invalid settings section");
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();
  // Fail fast on a route collision instead of breaking whoever owns the
  // route (e.g. a user-owned pi-ai custom profile): the registry would throw
  // DUPLICATE_ADAPTER and, depending on boot order, either our layer or the
  // other party's routes would silently lose. Introspection is best-effort;
  // when it is unavailable the registry itself stays authoritative.
  try {
    const existing = ctx.llm.listProviders?.();
    if (Array.isArray(existing) && existing.some((p) => p?.id === PROVIDER)) {
      throw new LlmError(
        `llm-opencode-go: provider route "${PROVIDER}" is already registered (e.g. by a custom pi-ai profile); ` +
          `rename one of them before enabling this plugin`,
        "DUPLICATE_ADAPTER",
      );
    }
  } catch (error) {
    if (error?.code === "DUPLICATE_ADAPTER" && String(error?.message ?? "").startsWith("llm-opencode-go:")) throw error;
  }
  // Key resolution is seam-only: `credentials.resolve` already layers process
  // env over the managed store over `.env` files, and re-reads per request,
  // so a stored or rotated key reaches the next request with no restart.
  const resolveKey = async () => {
    const ref = options().apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref);
      if (hit !== undefined) return assertUsableApiKey(hit.value, "llm-opencode-go", ref);
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref);
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, "llm-opencode-go", ref);
      }
    }
    throw new LlmError(
      `llm-opencode-go: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service ` +
        `(managed store, project/home .env, or the launching environment)`,
      "MISSING_CREDENTIAL",
    );
  };
  const adapter = new OpencodeGoAdapter(options, resolveKey, {
    resolveAttachments: () => ctx.get("attachments"),
    mapHostPath: (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath),
    readFile: (path) => readFile(path),
  });
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: "OpenCode Go",
    settingsNs: NS,
    settingsPath: [],
  }]);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => {
        current = source;
      },
      // Required: installSection invokes onChange synchronously during
      // registration (and on every change). Omitting it throws inside the
      // inject callback and takes down the whole layer. Our adapter reads
      // options() live per request, so no replace dance is needed here.
      onChange: () => {},
    });
  });
  ctx.connection.rpc.handle("/zen-go-rpc", async (endpoint, payload, signal) => {
    const args =
      payload !== null && typeof payload === "object" && payload.args !== null && typeof payload.args === "object"
        ? payload.args
        : {};
    switch (endpoint) {
      case "models/refresh":
        return refreshModels(options, resolveKey, signal);
      default:
        return fail("unknown-endpoint", `unknown zen-go endpoint ${JSON.stringify(endpoint)}`);
    }
  }, { authority: "trusted-host" });
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
  try {
    response = await fetch(`${connection.apiBase}/v1/models`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...attributionHeaders(),
      },
      signal: signal === undefined ? AbortSignal.timeout(connection.requestTimeoutMs) : AbortSignal.any([
        signal,
        AbortSignal.timeout(connection.requestTimeoutMs),
      ]),
    });
  } catch (error) {
    if (signal?.aborted) return fail("aborted", "model refresh aborted");
    return fail("transport", `model refresh request failed: ${error?.message ?? error}`);
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
