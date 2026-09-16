/**
 * @dsh-plugins/dsh-opencode-go — static model knowledge: serving surfaces,
 * vision flags, reasoning vocabularies. No imports, no I/O.
 */

/**
 * DeepSeek-v4 chat models: the zen-go gateway accepts `reasoning_effort=max`
 * on this surface too (verified live: HTTP 200 + reasoning_content returned).
 * Declared per-model so other chat models (mimo/glm/kimi/...) keep the
 * conservative low/medium/high vocabulary.
 */
const DEEPSEEK_V4_EFFORTS = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Medium" },
  { id: "high", name: "High" },
  { id: "max", name: "Max" },
];

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
  { id: "deepseek-v4-flash", endpoint: "chat", efforts: DEEPSEEK_V4_EFFORTS },
  { id: "deepseek-v4-pro", endpoint: "chat", efforts: DEEPSEEK_V4_EFFORTS },
  { id: "deepseek-v4-flash-vision-exp", endpoint: "chat", image: true, efforts: DEEPSEEK_V4_EFFORTS },
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

/** The three serving surfaces this route can speak. */
export const SURFACES = ["chat", "responses", "messages"];

/**
 * Effort ids the wire accepts per surface, for validating a user-supplied
 * level list. `chat` is the union over chat models (only deepseek-v4 declares
 * `max` upstream, but a user forcing it is stating capability, not asking this
 * plugin to guess). `messages` has no level vocabulary at all.
 */
export const SURFACE_EFFORT_IDS = {
  chat: ["low", "medium", "high", "max"],
  responses: ["minimal", "low", "medium", "high", "xhigh"],
  messages: [],
};

/** Display casing for every wire effort id this plugin can send. */
const EFFORT_NAMES = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Xhigh",
  max: "Max",
};

/**
 * Selectable reasoning levels per serving surface. Ids are the exact wire
 * values; names match the picker's display casing. No defaultEffort is
 * declared anywhere, so the picker offers Default (= omit the field and let
 * the server decide). Messages surface has no level vocabulary (Anthropic
 * thinking is budget-based), so it declares nothing. A per-model `modelCaps`
 * override replaces this list for that one model.
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

/** Serving surface for a model id, or undefined when unknown. */
export function endpointOf(model) {
  return MODEL_TABLE.find((m) => m.id === model)?.endpoint;
}

/**
 * Effective capabilities for one exact model id.
 *
 * Resolution order: the user's explicit per-model override (a `modelCaps`
 * entry) wins, then the static table, then a conservative unknown fallback.
 * The operator's catalog discloses ids only, so a newly served model lands in
 * "unknown": it routes to chat, declares no modality (the runtime stays
 * permissive and the request succeeds), and offers no reasoning levels. Each
 * of those three is exactly what a user can now state by hand instead of being
 * stuck with the fallback.
 *
 * @param model - exact model id.
 * @param override - the user's `modelCaps` entry for this id, when present.
 * @returns effective `surface`; `image` as `true`/`false` when declared and
 *   `undefined` when unknown (never guess a modality); `efforts` as the
 *   reasoning level ids in display order, possibly empty for "no levels".
 */
export function capabilitiesOf(model, override = undefined) {
  const entry = MODEL_TABLE.find((m) => m.id === model);
  const surface = override?.surface ?? entry?.endpoint ?? "chat";
  const image = override?.image ?? (entry === undefined ? undefined : entry.image === true);
  let efforts;
  if (surface === "messages") {
    // Anthropic thinking is budget-based; declaring levels here would only
    // produce a request the messages surface refuses.
    efforts = [];
  } else if (override?.efforts !== undefined) {
    efforts = [...override.efforts];
  } else if (override?.surface !== undefined) {
    // Stating the surface states its vocabulary too, so the picker works
    // without a second choice.
    efforts = REASONING_EFFORTS[surface].map((e) => e.id);
  } else if (entry?.efforts !== undefined) {
    efforts = entry.efforts.map((e) => e.id);
  } else if (entry !== undefined) {
    efforts = REASONING_EFFORTS[surface].map((e) => e.id);
  } else {
    // Unknown id and nothing declared: stay conservative rather than
    // advertising levels the model may reject.
    efforts = [];
  }
  return { surface, image, efforts };
}

/**
 * Whether a model accepts image input. Known vision models (see MODEL_TABLE)
 * return true, known text-only models false, and an explicit `modelCaps`
 * `image` flag wins over both; unknown ids with no declaration stay permissive
 * (true) so newly discovered models keep working — the server stays
 * authoritative and rejects what it cannot serve.
 */
export function modelSupportsImage(model, override = undefined) {
  return capabilitiesOf(model, override).image ?? true;
}

/**
 * Fallback per-image inline cap, for an attachment provider that does not
 * normalize at admission.
 *
 * It is a fallback, not the operative bound: the stock `dsh-attachment-local`
 * already caps one normalized image at 4 MiB / 2048x2048 px (8192 per side) and
 * `imageHostPath` hands back that normalized copy, so this check cannot fire
 * there. What actually bounds one request is `maxRequestImageBytes` — and since
 * one image stays well below it, only a request carrying many images reaches it.
 */
export const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Wire formats accepted for inline base64 images on every surface. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * Reasoning metadata for one model id, or undefined when it offers no level
 * vocabulary. Derived from {@link capabilitiesOf}, so a user override is
 * reflected here exactly as it is in the request path.
 */
export function reasoningFor(model, override = undefined) {
  const { efforts } = capabilitiesOf(model, override);
  if (efforts.length === 0) return undefined;
  return { efforts: efforts.map((id) => ({ id, name: EFFORT_NAMES[id] ?? id })) };
}
