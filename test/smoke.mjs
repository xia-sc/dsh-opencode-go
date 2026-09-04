import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
// Isolate the usage ledger: apply() creates a real ledger under DSH_HOME,
// so point it at a temp dir (archived-chats precedent). Must run before tests.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "zen-go-smoke-"));
import {
  CHAT_MODEL_IDS,
  Config,
  NS,
  OpencodeGoAdapter,
  PROVIDER,
  SESSION_HEADER,
  apply,
  buildAnthropicBody,
  buildChatBody,
  buildHeaders,
  buildResponsesBody,
  collectImageRefs,
  createUsageLedger,
  dayKey,
  endpointOf,
  httpError,
  imagePart,
  mapAnthropicStop,
  mapFinishReason,
  meteredStream,
  modelSupportsImage,
  parseRetryAfterMs,
  parseSseData,
  pluginDataDir,
  REASONING_EFFORTS,
  reasoningFor,
  resolveOptions,
  sessionHeaderValue,
  summarize,
  toAnthropicMessages,
  toOpenAiMessages,
  toResponsesInput,
  toTokenUsage,
} from "../lib/index.js";

test("session header value prefers the loop-stamped id", () => {
  assert.equal(sessionHeaderValue("sess-1"), "sess-1");
  const generated = sessionHeaderValue(undefined);
  assert.match(generated, /^[0-9a-f-]{36}$/);
});

test("headers carry auth, attribution and the session header", () => {
  const headers = buildHeaders("k", "sess-1");
  assert.equal(headers.authorization, "Bearer k");
  assert.equal(headers[SESSION_HEADER], "sess-1");
  assert.ok(typeof headers["user-agent"] === "string" && headers["user-agent"].includes("deepseek-harness"));
  assert.match(headers["user-agent"], /dsh-opencode-go\/\d+\.\d+\.\d+/);
  assert.ok(!headers["user-agent"].includes("Go-http-client"));
  // extras merge in but can never suppress identity or session headers
  const merged = buildHeaders("k", "sess-1", { "x-api-key": "k", "user-agent": "evil", [SESSION_HEADER]: "evil" });
  assert.equal(merged["x-api-key"], "k");
  assert.match(merged["user-agent"], /dsh-opencode-go\//);
  assert.equal(merged[SESSION_HEADER], "sess-1");
});

test("chat models table covers the probed ids", () => {
  for (const id of ["mimo-v2.5", "deepseek-v4-flash", "glm-5.3-flash", "kimi-k3"]) {
    assert.equal(endpointOf(id), "chat");
    assert.ok(CHAT_MODEL_IDS.includes(id));
  }
  assert.equal(endpointOf("muse-spark-1.3-contributor"), "responses");
  assert.equal(endpointOf("minimax-m3"), "messages");
  assert.equal(endpointOf("nope-unknown"), undefined);
});

test("message translation: text, system, tools, tool-call/result", () => {
  const body = buildChatBody({
    model: "mimo-v2.5",
    system: "sys",
    messages: [
      { id: "1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
      {
        id: "2",
        role: "assistant",
        content: [{ type: "tool-call", id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }],
        source: { kind: "model", provider: PROVIDER, model: "mimo-v2.5" },
      },
      {
        id: "3",
        role: "user",
        content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }],
        source: { kind: "tool", callId: "c1" },
      },
    ],
    tools: [{ name: "bash", description: "run", parameters: { type: "object" } }],
    temperature: 0.2,
    maxTokens: 64,
    stop: ["<stop>"],
  });
  assert.equal(body.model, "mimo-v2.5");
  assert.equal(body.stream, true);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[1].content, "hi");
  assert.equal(body.messages[2].tool_calls[0].id, "c1");
  assert.equal(body.messages[3].role, "tool");
  assert.equal(body.tools[0].function.name, "bash");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 64);
  assert.deepEqual(body.stop, ["<stop>"]);
});

test("image support is per-model", () => {
  assert.equal(modelSupportsImage("muse-spark-1.3-contributor"), true);
  assert.equal(modelSupportsImage("deepseek-v4-flash-vision-exp"), true);
  assert.equal(modelSupportsImage("mimo-v2.5"), false);
  assert.equal(modelSupportsImage("some-future-model"), true);
  const img = (id) => ({
    id: "1",
    role: "user",
    content: [{ type: "image", attachment: { attachmentId: id, mediaType: "image/png" } }],
    source: { kind: "user" },
  });
  // text-only model refuses loudly
  assert.throws(() => toOpenAiMessages(undefined, [img("a")], new Map(), "mimo-v2.5"), /does not accept image input/);
  // vision models encode per surface
  const images = new Map([["a", { mediaType: "image/png", base64: "iVBOR" }]]);
  const chat = toOpenAiMessages(undefined, [img("a")], images, "deepseek-v4-flash-vision-exp");
  assert.deepEqual(chat[0].content, [{ type: "image_url", image_url: { url: "data:image/png;base64,iVBOR" } }]);
  const resp = toResponsesInput(undefined, [img("a")], images, "muse-spark-1.3-contributor");
  assert.deepEqual(resp.input[0].content, [{ type: "input_image", image_url: "data:image/png;base64,iVBOR" }]);
  const ant = toAnthropicMessages(undefined, [img("a")], images, "muse-spark-1.3-contributor");
  assert.deepEqual(ant.messages[0].content, [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }]);
  // bytes missing from the map
  assert.throws(() => toOpenAiMessages(undefined, [img("b")], images, "muse-spark-1.3-contributor"), /bytes are unavailable/);
});

test("collectImageRefs walks nested content once", () => {
  const ref = (id) => ({ attachmentId: id, mediaType: "image/png" });
  const msgs = [
    { id: "1", role: "user", content: [{ type: "image", attachment: ref("a") }, { type: "text", text: "x" }], source: { kind: "user" } },
    { id: "2", role: "assistant", content: [{ type: "text", text: "y" }], source: { kind: "model", provider: PROVIDER, model: "x" } },
    { id: "3", role: "user", content: [{ type: "tool-result", toolCallId: "c", content: [{ type: "image", attachment: ref("a") }, { type: "image", attachment: ref("b") }] }], source: { kind: "tool", callId: "c" } },
  ];
  assert.deepEqual(collectImageRefs(msgs).map((r) => r.attachmentId), ["a", "b"]);
  assert.deepEqual(collectImageRefs([]), []);
});

test("sse + finish mapping", () => {
  assert.equal(parseSseData("[DONE]"), null);
  assert.equal(parseSseData(' {"a":1} ').a, 1);
  assert.deepEqual(mapFinishReason("stop"), { kind: "stop" });
  assert.deepEqual(mapFinishReason("tool_calls"), { kind: "tool-calls" });
  assert.deepEqual(mapFinishReason("length"), { kind: "max-tokens" });
  assert.equal(mapFinishReason("weird").kind, "error");
});

test("usage mapping keeps disjoint counts", () => {
  // exact shape captured from the live endpoint
  const live = toTokenUsage({
    prompt_tokens: 248,
    completion_tokens: 1,
    total_tokens: 249,
    prompt_tokens_details: { cached_tokens: 192 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  assert.deepEqual(live, { inputTokens: 56, outputTokens: 1, totalTokens: 249, cacheReadTokens: 192 });
  const plain = toTokenUsage({ prompt_tokens: 10, completion_tokens: 3 });
  assert.deepEqual(plain, { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  assert.equal(toTokenUsage(null), null);
  assert.equal(toTokenUsage({}), null);
  // over-reported cache clamps to the prompt total instead of going negative
  const clamped = toTokenUsage({ prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 99 } });
  assert.deepEqual(clamped, { inputTokens: 0, outputTokens: 1, totalTokens: 6, cacheReadTokens: 5 });
  // responses/messages vocabulary (the shape that used to vanish entirely)
  const spark = toTokenUsage({
    input_tokens: 9,
    output_tokens: 229,
    total_tokens: 238,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 209 },
  });
  assert.deepEqual(spark, { inputTokens: 9, outputTokens: 229, totalTokens: 238, reasoningTokens: 209 });
  const cached2 = toTokenUsage({ input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 60 }, cache_creation_input_tokens: 10 });
  assert.deepEqual(cached2, { inputTokens: 30, outputTokens: 10, totalTokens: 110, cacheReadTokens: 60, cacheWriteTokens: 10 });
});

test("http error mapping", () => {  assert.equal(httpError(401, "bad", undefined).code, "AUTH");
  assert.equal(httpError(429, "", 1500).code, "RATE_LIMIT");
  assert.equal(httpError(429, "", 1500).failure.providerRetryAfterMs, 1500);
  assert.equal(httpError(400, "x", undefined).code, "INVALID_REQUEST");
  assert.equal(httpError(500, "", undefined).code, "PROVIDER_UNAVAILABLE");
  assert.equal(parseRetryAfterMs("2"), 2000);
  assert.equal(parseRetryAfterMs(null), undefined);
});

test("config schema defaults + resolveOptions", async () => {
  const result = await Config["~standard"].validate({});
  assert.equal(result.issues, undefined);
  assert.equal(result.value.apiKeyEnv, "OPENCODE_GO_API_KEY");
  assert.equal(result.value.apiBase, "https://opencode.ai/zen/go");
  assert.ok(result.value.requestTimeoutMs > 0 && result.value.streamIdleTimeoutMs > 0);
  assert.deepEqual(result.value.modelCaps, []);
  const withCaps = await Config["~standard"].validate({ modelCaps: [{ id: "mimo-v2.5", contextWindow: 100 }] });
  assert.equal(withCaps.issues, undefined);
  assert.deepEqual(withCaps.value.modelCaps, [{ id: "mimo-v2.5", contextWindow: 100 }]);
  const resolved = resolveOptions({});
  assert.equal(String(resolved.apiKeyEnv), "OPENCODE_GO_API_KEY");
  assert.equal(resolved.apiBase, "https://opencode.ai/zen/go");
  assert.throws(() => resolveOptions({ requestTimeoutMs: -1 }), /requestTimeoutMs/);
  assert.throws(() => resolveOptions({ apiKeyEnv: "has space" }), /credential ref/);
});

function stubCtx({ credentials, providers = [] } = {}) {
  const calls = { configurable: null, adapter: null, section: null, rpc: null };
  const ctx = {
    get: (name) => (name === "credentials" ? credentials : undefined),
    logger: { error: () => {} },
    inject: (deps, cb) => {
      // Mirrors the real installSection: setSource + synchronous onChange.
      // An apply that omits onChange dies here, exactly like in production.
      // setSource carries the merged value: base (composition entry) wins
      // when the user section is empty, like the real resolve().
      if (deps.includes("settings")) cb({ settings: { installSection: (...args) => { calls.section = args; const hooks = args[4]; hooks.setSource(() => args[3]); hooks.onChange(); } } });
    },
    connection: {
      rpc: { handle: (channel, handler, opts) => { calls.rpc = { channel, handler, opts }; } },
    },
    llm: {
      listProviders: () => providers,
      registerConfigurableProviders: (entries) => { calls.configurable = entries; },
      registerAdapter: (routes, adapter) => { calls.adapter = { routes, adapter }; },
    },
  };
  return { ctx, calls };
}

test("apply registers route + configurable directory + settings section", async () => {
  const { ctx, calls } = stubCtx({ credentials: { resolve: async () => ({ value: "k", source: "file" }) } });
  apply(ctx, {});
  assert.deepEqual(calls.adapter.routes, [PROVIDER]);
  assert.deepEqual(calls.configurable, [{
    provider: PROVIDER,
    displayName: "OpenCode Go",
    settingsNs: NS,
    settingsPath: [],
  }]);
  assert.equal(calls.section[1], NS);
  assert.equal(calls.rpc.channel, "/zen-go-rpc");
  const models = await calls.adapter.adapter.listModels(PROVIDER);
  assert.ok(models.length > 10 && models.every((m) => m.provider === PROVIDER));
  const resolved = await calls.adapter.adapter.resolveModel(PROVIDER, "mimo-v2.5");
  assert.equal(resolved.id, "mimo-v2.5");
  const spark = await calls.adapter.adapter.resolveModel(PROVIDER, "muse-spark-1.3-contributor");
  assert.equal(spark.id, "muse-spark-1.3-contributor");
  const qwen = await calls.adapter.adapter.resolveModel(PROVIDER, "qwen3.8-max");
  assert.equal(qwen.id, "qwen3.8-max");
  const passthrough = await calls.adapter.adapter.resolveModel(PROVIDER, "future-model-x");
  assert.equal(passthrough.id, "future-model-x");
});

test("apply refuses a taken route without registering", () => {
  const { ctx, calls } = stubCtx({ providers: [{ id: PROVIDER, name: "x" }] });
  assert.throws(() => apply(ctx, {}), (e) => e.code === "DUPLICATE_ADAPTER" && /already registered/.test(e.message));
  assert.equal(calls.adapter, null);
  assert.equal(calls.configurable, null);
});

test("stream resolves the key through the seam only", async () => {
  const seen = [];
  const { ctx, calls } = stubCtx({
    credentials: {
      resolve: async (ref) => {
        seen.push(String(ref));
        return { value: "seam-key", source: "file" };
      },
    },
  });
  apply(ctx, {});
  // drive stream far enough to observe the Authorization header, then abort
  const controller = new AbortController();
  let headerError;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    try {
      assert.equal(init.headers.authorization, "Bearer seam-key");
      assert.match(init.headers[SESSION_HEADER], /^[0-9a-f-]{36}$/);
    } catch (e) {
      headerError = e;
    }
    controller.abort();
    return realFetch(url, { ...init, signal: controller.signal });
  };
  try {
    for await (const c of calls.adapter.adapter.stream({
      provider: PROVIDER,
      model: "mimo-v2.5",
      messages: [{ id: "1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }],
      maxTokens: 1,
    })) void c;
  } catch {
    // aborted on purpose after header observation; network may also fail in sandbox
  } finally {
    globalThis.fetch = realFetch;
  }
  if (headerError) throw headerError;
  assert.deepEqual(seen, ["OPENCODE_GO_API_KEY"]);
});

test("stream without any key raises MISSING_CREDENTIAL", async () => {
  const { ctx, calls } = stubCtx({ credentials: { resolve: async () => undefined } });
  apply(ctx, {});
  await assert.rejects(
    (async () => {
      for await (const c of calls.adapter.adapter.stream({
        provider: PROVIDER,
        model: "mimo-v2.5",
        messages: [{ id: "1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }],
      })) void c;
    })(),
    (e) => e.code === "MISSING_CREDENTIAL" && /OPENCODE_GO_API_KEY/.test(e.message),
  );
});

// Live probe: needs OPENCODE_GO_KEY in env, otherwise skipped.
test("live /v1/models (needs OPENCODE_GO_KEY)", async (t) => {
  if (!process.env.OPENCODE_GO_KEY) {
    t.skip("no key");
    return;
  }
  const r = await fetch("https://opencode.ai/zen/go/v1/models", {
    headers: { Authorization: `Bearer ${process.env.OPENCODE_GO_KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.data) && j.data.length > 20);
});

test("listModels honors enabledModels", async () => {
  const full = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(full.ctx, {});
  const all = await full.calls.adapter.adapter.listModels(PROVIDER);
  assert.ok(all.length > 10);
  const subset = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(subset.ctx, { enabledModels: ["mimo-v2.5"] });
  const only = await subset.calls.adapter.adapter.listModels(PROVIDER);
  assert.deepEqual(only.map((m) => m.id), ["mimo-v2.5"]);
  const none = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(none.ctx, { enabledModels: [] });
  assert.deepEqual(await none.calls.adapter.adapter.listModels(PROVIDER), []);
  const fresh = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(fresh.ctx, { enabledModels: ["mimo-v2.5", "omen-alpha"] });
  assert.deepEqual(
    (await fresh.calls.adapter.adapter.listModels(PROVIDER)).map((m) => m.id),
    ["mimo-v2.5", "omen-alpha"],
  );
});

test("reasoning levels are declared per surface and wired to bodies", async () => {
  assert.deepEqual(reasoningFor("muse-spark-1.3-contributor").efforts.map((e) => e.id), ["minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(reasoningFor("mimo-v2.5").efforts.map((e) => e.id), ["low", "medium", "high"]);
  assert.equal(reasoningFor("qwen3.8-max"), undefined);
  assert.equal(reasoningFor("unknown-model"), undefined);
  // ids are unique, non-empty, display-cased
  for (const family of Object.values(REASONING_EFFORTS)) {
    const ids = family.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const e of family) assert.ok(e.id.length > 0 && e.name.length > 0);
  }
  const { ctx, calls } = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(ctx, {});
  const spark = await calls.adapter.adapter.resolveModel(PROVIDER, "muse-spark-1.3-contributor");
  assert.equal(spark.reasoning.efforts.length, 5);
  assert.equal(spark.reasoning.defaultEffort, undefined);
  const qwen = await calls.adapter.adapter.resolveModel(PROVIDER, "qwen3.8-max");
  assert.equal(qwen.reasoning, undefined);
  // wire mapping
  const base = { model: "x", messages: [{ id: "1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }] };
  assert.deepEqual(buildResponsesBody({ ...base, reasoningEffort: "xhigh" }).reasoning, { effort: "xhigh" });
  assert.equal(buildResponsesBody(base).reasoning, undefined);
  assert.equal(buildChatBody({ ...base, reasoningEffort: "high" }).reasoning_effort, "high");
  assert.equal(buildChatBody(base).reasoning_effort, undefined);
  assert.throws(() => buildAnthropicBody({ ...base, reasoningEffort: "high" }), /budget-based/);
  assert.ok(buildAnthropicBody(base));
});

test("rpc models/refresh returns classified ids", async () => {
  const { ctx, calls } = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(ctx, {});
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "mimo-v2.5" }, { id: "muse-spark-1.3-contributor" }, { id: "brand-new-thing" }, { id: "" }] }),
  });
  try {
    const res = await calls.rpc.handler("models/refresh", { args: {} }, undefined);
    assert.equal(res.ok, true);
    assert.deepEqual(res.value.models, [
      { id: "mimo-v2.5", surface: "chat", input: ["text"] },
      { id: "muse-spark-1.3-contributor", surface: "responses", input: ["text", "image"] },
      { id: "brand-new-thing", surface: "unknown" },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("rpc models/refresh without key fails cleanly", async () => {
  const { ctx, calls } = stubCtx({ credentials: { resolve: async () => undefined } });
  apply(ctx, {});
  const res = await calls.rpc.handler("models/refresh", { args: {} }, undefined);
  assert.equal(res.ok, false);
  assert.equal(res.error.details.code, "missing-credential");
  const unknown = await calls.rpc.handler("nope", { args: {} }, undefined);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.details.code, "unknown-endpoint");
});

const TEXT_MSG = { id: "1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } };
const TOOL_CALL_MSG = {
  id: "2",
  role: "assistant",
  content: [{ type: "tool-call", id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }],
  source: { kind: "model", provider: PROVIDER, model: "mimo-v2.5" },
};
const TOOL_RESULT_MSG = {
  id: "3",
  role: "user",
  content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }] }],
  source: { kind: "tool", callId: "c1" },
};

test("responses input translation", () => {
  const { instructions, input } = toResponsesInput("sys", [TEXT_MSG, TOOL_CALL_MSG, TOOL_RESULT_MSG]);
  assert.equal(instructions, "sys");
  assert.equal(input[0].role, "user");
  assert.equal(input[0].content[0].type, "input_text");
  assert.equal(input[1].type, "function_call");
  assert.equal(input[1].call_id, "c1");
  assert.equal(input[2].type, "function_call_output");
  assert.equal(input[2].output, "ok");
  const body = buildResponsesBody({ model: "muse-spark-1.3-contributor", messages: [TEXT_MSG], tools: [{ name: "bash", description: "run", parameters: { type: "object" } }], maxTokens: 64 });
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.max_output_tokens, 64);
  assert.equal(body.stream, true);
  assert.throws(() => buildResponsesBody({ model: "x", messages: [], stop: ["q"] }), /stop sequences/);
});

test("anthropic input translation", () => {
  const { system, messages } = toAnthropicMessages("sys", [TEXT_MSG, TOOL_CALL_MSG, TOOL_RESULT_MSG]);
  assert.equal(system, "sys");
  assert.equal(messages[0].content[0].type, "text");
  assert.equal(messages[1].content[0].type, "tool_use");
  assert.deepEqual(messages[1].content[0].input, { cmd: "ls" });
  assert.equal(messages[2].content[0].type, "tool_result");
  const errBlock = { type: "tool-result", toolCallId: "c9", isError: true, content: [{ type: "text", text: "boom" }] };
  const errMsg = { id: "9", role: "user", content: [errBlock], source: { kind: "tool", callId: "c9" } };
  const out = toAnthropicMessages(undefined, [errMsg]);
  assert.equal(out.messages[0].content[0].is_error, true);
  assert.throws(
    () => toAnthropicMessages(undefined, [{
      id: "8", role: "assistant",
      content: [{ type: "tool-call", id: "c8", name: "bash", arguments: "not-json{" }],
      source: { kind: "model", provider: PROVIDER, model: "x" },
    }]),
    /not valid JSON/,
  );
  const body = buildAnthropicBody({ model: "qwen3.8-max", messages: [TEXT_MSG] });
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.stream, true);
  const body2 = buildAnthropicBody({ model: "qwen3.8-max", messages: [TEXT_MSG], stop: ["<end>"] });
  assert.deepEqual(body2.stop_sequences, ["<end>"]);
});

test("anthropic stop mapping", () => {
  assert.deepEqual(mapAnthropicStop("end_turn"), { kind: "stop" });
  assert.deepEqual(mapAnthropicStop("tool_use"), { kind: "tool-calls" });
  assert.deepEqual(mapAnthropicStop("max_tokens"), { kind: "max-tokens" });
  assert.equal(mapAnthropicStop("weird").kind, "error");
});

function sseStream(lines) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const line of lines) c.enqueue(enc.encode(line + "\n"));
      c.close();
    },
  });
}

function testAdapter() {
  return new OpencodeGoAdapter(() => resolveOptions({}), async () => "k");
}

test("pumpResponses emits text, tool call, usage, finish", async () => {
  const adapter = testAdapter();
  const chunks = [];
  const events = [
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"Hel"}',
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"lo"}',
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc1","output_index":1,"delta":"{\\"x\\""}',
    'data: {"type":"response.function_call_arguments.delta","item_id":"fc1","output_index":1,"delta":":1}"}',
    'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_9","name":"bash","arguments":"{\\"x\\":1}"}}',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"prompt_tokens_details":{"cached_tokens":40}}}}',
  ];
  for await (const c of adapter.pumpResponses(sseStream(events), undefined, 5000)) chunks.push(c);
  const types = chunks.map((c) => c.type);
  assert.deepEqual(types, ["block-start", "text-delta", "text-delta", "block-end", "block-start", "tool-call-delta", "block-end", "usage", "finish"]);
  assert.equal(chunks[4].blockType, "tool-call");
  assert.equal(chunks[5].id, "call_9");
  assert.equal(chunks[5].argumentsDelta, '{"x":1}');
  assert.deepEqual(chunks[7].usage, { inputTokens: 60, outputTokens: 5, totalTokens: 105, cacheReadTokens: 40 });
  assert.deepEqual(chunks[8].reason, { kind: "tool-calls" });
});

test("pumpResponses handles standalone response.incomplete", async () => {
  const adapter = testAdapter();
  const chunks = [];
  const events = [
    'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","status":"in_progress","summary":[]}}',
    'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"prompt_tokens":12,"completion_tokens":16,"total_tokens":28,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":13}}}}',
  ];
  for await (const c of adapter.pumpResponses(sseStream(events), undefined, 5000)) chunks.push(c);
  const types = chunks.map((c) => c.type);
  assert.deepEqual(types, ["usage", "finish"]);
  assert.deepEqual(chunks[0].usage, { inputTokens: 12, outputTokens: 16, totalTokens: 28, reasoningTokens: 13 });
  assert.deepEqual(chunks[1].reason, { kind: "max-tokens" });
});

test("pumpMessages prefers delta usage", async () => {
  const adapter = testAdapter();
  const chunks = [];
  const events = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":66,"output_tokens":16,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}',
    'data: {"type":"message_stop"}',
  ];
  for await (const c of adapter.pumpMessages(sseStream(events), undefined, 5000)) chunks.push(c);
  const usage = chunks.find((c) => c.type === "usage");
  assert.deepEqual(usage.usage, { inputTokens: 66, outputTokens: 16, totalTokens: 82 });
  assert.deepEqual(chunks[chunks.length - 1].reason, { kind: "stop" });
});

test("pumpResponses plain stop finish", async () => {
  const adapter = testAdapter();
  const chunks = [];
  const events = [
    'data: {"type":"response.output_text.delta","output_index":0,"delta":"ok"}',
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}}',
  ];
  for await (const c of adapter.pumpResponses(sseStream(events), undefined, 5000)) chunks.push(c);
  assert.equal(chunks[chunks.length - 1].type, "finish");
  assert.deepEqual(chunks[chunks.length - 1].reason, { kind: "stop" });
});

test("pumpMessages emits text, thinking, tool use, usage, finish", async () => {
  const adapter = testAdapter();
  const chunks = [];
  const events = [
    'data: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":50,"cache_read_input_tokens":20}}}',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
    'data: {"type":"content_block_stop","index":0}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"bash"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}',
    'data: {"type":"content_block_stop","index":1}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}',
    'data: {"type":"message_stop"}',
  ];
  for await (const c of adapter.pumpMessages(sseStream(events), undefined, 5000)) chunks.push(c);
  const types = chunks.map((c) => c.type);
  assert.deepEqual(types, ["block-start", "text-delta", "block-end", "block-start", "tool-call-delta", "block-end", "usage", "finish"]);
  assert.equal(chunks[4].id, "tu_1");
  assert.equal(chunks[4].argumentsDelta, '{"cmd":"ls"}');
  assert.deepEqual(chunks[6].usage, { inputTokens: 30, outputTokens: 12, totalTokens: 62, cacheReadTokens: 20 });
  assert.deepEqual(chunks[7].reason, { kind: "tool-calls" });
});

test("resolveImageData reads through attachment+fs services", async () => {
  const files = { "/copy/a.png": Buffer.from([137, 80, 78, 71]) };
  const adapter = new OpencodeGoAdapter(() => resolveOptions({}), async () => "k", {
    resolveAttachments: () => ({ imageHostPath: (ref) => ({ a: "/host/a.png" }[ref.attachmentId]) }),
    mapHostPath: (p) => ({ "/host/a.png": "/copy/a.png" }[p]),
    readFile: async (p) => {
      if (!files[p]) throw new Error("missing " + p);
      return files[p];
    },
  });
  const out = await adapter.resolveImageData([{ attachmentId: "a", mediaType: "image/png" }]);
  assert.equal(out.get("a").base64, Buffer.from([137, 80, 78, 71]).toString("base64"));
  await assert.rejects(adapter.resolveImageData([{ attachmentId: "b", mediaType: "image/png" }]), /no readable copy/);
  await assert.rejects(adapter.resolveImageData([{ attachmentId: "a", mediaType: "image/bmp" }]), /not supported/);
  const noSvc = new OpencodeGoAdapter(() => resolveOptions({}), async () => "k", {});
  await assert.rejects(noSvc.resolveImageData([{ attachmentId: "a", mediaType: "image/png" }]), /attachment service/);
});

test("stream carries an image end to end on a vision model", async () => {
  const seen = {};
  const files = { "/copy/a.png": Buffer.from([1, 2, 3]) };
  const adapter = new OpencodeGoAdapter(() => resolveOptions({}), async () => "k", {
    resolveAttachments: () => ({ imageHostPath: () => "/host/a.png" }),
    mapHostPath: () => "/copy/a.png",
    readFile: async (p) => files[p],
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.body = JSON.parse(init.body);
    return { ok: true, status: 200, headers: new Headers(), body: sseStream(['data: {"choices":[{"index":0,"finish_reason":"stop","delta":{"content":"seen"}}]}']) };
  };
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      provider: PROVIDER,
      model: "deepseek-v4-flash-vision-exp",
      messages: [
        { id: "1", role: "user", content: [{ type: "text", text: "what" }, { type: "image", attachment: { attachmentId: "a", mediaType: "image/png" } }], source: { kind: "user" } },
      ],
    })) chunks.push(c);
    assert.deepEqual(seen.body.messages[0].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } });
    assert.equal(chunks[chunks.length - 1].type, "finish");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("listModels and resolveModel declare modalities", async () => {
  const { ctx, calls } = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(ctx, {});
  const models = await calls.adapter.adapter.listModels(PROVIDER);
  const spark = models.find((m) => m.id === "muse-spark-1.3-contributor");
  assert.deepEqual(spark.inputModalities, ["text", "image"]);
  const mimo = models.find((m) => m.id === "mimo-v2.5");
  assert.deepEqual(mimo.inputModalities, ["text"]);
  const resolved = await calls.adapter.adapter.resolveModel(PROVIDER, "deepseek-v4-flash-vision-exp");
  assert.deepEqual(resolved.inputModalities, ["text", "image"]);
});

test("modelCaps attach context and defaultMaxTokens", async () => {
  const withCaps = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(withCaps.ctx, { modelCaps: [{ id: "mimo-v2.5", contextWindow: 1000000, maxTokens: 32000 }] });
  const resolved = await withCaps.calls.adapter.adapter.resolveModel(PROVIDER, "mimo-v2.5");
  assert.deepEqual(resolved.context, { contextWindow: 1000000 });
  assert.equal(resolved.defaultMaxTokens, 32000);
  const partial = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(partial.ctx, { modelCaps: [{ id: "mimo-v2.5", contextWindow: 500000 }] });
  const resolved2 = await partial.calls.adapter.adapter.resolveModel(PROVIDER, "mimo-v2.5");
  assert.deepEqual(resolved2.context, { contextWindow: 500000 });
  assert.equal(resolved2.defaultMaxTokens, undefined);
  const plain = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(plain.ctx, {});
  const resolved3 = await plain.calls.adapter.adapter.resolveModel(PROVIDER, "mimo-v2.5");
  assert.equal(resolved3.context, undefined);
  assert.equal(resolved3.defaultMaxTokens, undefined);
  assert.throws(() => resolveOptions({ modelCaps: [{ id: "" }] }), /non-empty id/);
  assert.throws(() => resolveOptions({ modelCaps: [{ id: "x", contextWindow: -5 }] }), /positive integer/);
  assert.throws(() => resolveOptions({ modelCaps: "nope" }), /must be an array/);
});

test("meteredStream records exactly once per outcome", async () => {
  const seen = [];
  async function* chunks(list) {
    for (const c of list) yield c;
  }
  const got = [];
  for await (const c of meteredStream(chunks([{ type: "usage", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 4 } }, { type: "finish", reason: { kind: "stop" } }]), { t: 1, model: "m", session: "s", purpose: null }, (e) => seen.push(e))) {
    got.push(c);
  }
  assert.equal(got.length, 2);
  assert.deepEqual(seen, [{ t: 1, model: "m", session: "s", purpose: null, input: 10, output: 2, cacheRead: 4, cacheWrite: 0, reasoning: 0, finish: "stop" }]);
  // error path records and rethrows
  const seen2 = [];
  const boom = new Error("x");
  boom.code = "TRANSPORT";
  async function* failGen() {
    yield { type: "block-start", index: 0, blockType: "text" };
    throw boom;
  }
  await assert.rejects((async () => {
    for await (const c of meteredStream(failGen(), { t: 2, model: "m", session: null, purpose: "compaction" }, (e) => seen2.push(e))) void c;
  })(), /x/);
  assert.deepEqual(seen2, [{ t: 2, model: "m", session: null, purpose: "compaction", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, finish: "error:TRANSPORT" }]);
  // quiet abort records zero counters
  const seen3 = [];
  async function* empty() {}
  for await (const c of meteredStream(empty(), { t: 3, model: "m" }, (e) => seen3.push(e))) void c;
  assert.deepEqual(seen3[0].finish, "aborted");
  assert.equal(seen3[0].input, 0);
});

test("ledger persists, loads, summarizes and resets", async () => {
  const mem = {};
  const io = {
    readFile: async (p) => {
      if (!(p in mem)) {
        const e = new Error("missing");
        e.code = "ENOENT";
        throw e;
      }
      return mem[p];
    },
    writeFile: async (p, text) => { mem[p] = text; },
    appendFile: async (p, text) => { mem[p] = (mem[p] ?? "") + text; },
    mkdir: async () => {},
    rename: async (a, b) => { mem[b] = mem[a]; delete mem[a]; },
  };
  const ledger = createUsageLedger({ dir: "/data", io, now: () => 1700000000000 });
  const loaded = await ledger.load();
  assert.deepEqual(loaded, { loaded: 0, skipped: 0 });
  await ledger.record({ model: "mimo-v2.5", session: "s1", input: 100, output: 10, cacheRead: 50, finish: "stop" });
  await ledger.record({ model: "mimo-v2.5", session: "s1", input: 200, output: 20, cacheRead: 0, finish: "stop" });
  await ledger.record({ model: "muse-spark-1.3-contributor", session: "s2", purpose: "compaction", input: 10, output: 5, finish: "stop" });
  assert.equal(ledger.size, 3);
  const usagePath = path.join("/data", "usage.jsonl");
  assert.ok(mem[usagePath].split("\n").filter((l) => l.trim() !== "").length === 3);
  const sum = ledger.summary(100000);
  assert.equal(sum.totals.requests, 3);
  assert.equal(sum.totals.input, 310);
  assert.equal(sum.totals.cacheRead, 50);
  assert.equal(sum.totals.sessions, 2);
  assert.equal(sum.byModel[0].model, "mimo-v2.5");
  assert.equal(sum.byModel[0].input, 300);
  assert.ok(sum.days.length >= 1 && sum.days[0].requests >= 1);
  // reload from disk
  const ledger2 = createUsageLedger({ dir: "/data", io, now: () => 1700000000000 });
  const loaded2 = await ledger2.load();
  assert.equal(loaded2.loaded, 3);
  assert.equal(ledger2.summary(100000).totals.requests, 3);
  // bad lines are skipped, reset archives
  mem[usagePath] += "not-json\n";
  const ledger3 = createUsageLedger({ dir: "/data", io, now: () => 1700000000000 });
  const loaded3 = await ledger3.load();
  assert.deepEqual(loaded3, { loaded: 3, skipped: 1 });
  const reset = await ledger3.reset();
  assert.match(reset.archived, /^usage-\d+-\d+\.bak\.jsonl$/);
  assert.equal(ledger3.size, 0);
  assert.equal(ledger3.summary(100000).totals.requests, 0);
});

test("dayKey buckets local days and pluginDataDir respects DSH_HOME", () => {
  assert.match(dayKey(1700000000000), /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(pluginDataDir("/tmp/x").endsWith("dsh-opencode-go"));
});

test("rpc usage endpoints serve the ledger", async () => {
  const { ctx, calls } = stubCtx({ credentials: { resolve: async () => ({ value: "k" }) } });
  apply(ctx, {});
  const empty = await calls.rpc.handler("usage/summary", { args: {} }, undefined);
  assert.equal(empty.ok, true);
  assert.equal(empty.value.totals.requests, 0);
  const reset = await calls.rpc.handler("usage/reset", { args: {} }, undefined);
  assert.equal(reset.ok, true);
  assert.match(reset.value.archived, /\.bak\.jsonl$/);
});
