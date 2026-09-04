/**
 * @dsh-plugins/dsh-opencode-go — static model knowledge: serving surfaces,
 * vision flags, reasoning vocabularies. No imports, no I/O.
 */

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
