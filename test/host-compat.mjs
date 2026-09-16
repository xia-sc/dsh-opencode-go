/**
 * Host-compatibility regression harness for @dsh-plugins/dsh-opencode-go.
 *
 * Why this file exists next to `test/smoke.mjs`: smoke.mjs stubs every host
 * surface (`stubCtx`), so it can only prove the plugin is self-consistent. It
 * cannot notice that the *installed* harness tightened a contract — that is
 * exactly what a "the new dsh is incompatible with this plugin" report is
 * about. This harness imports the real packages out of `node_modules`
 * (`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-invariants`, `@deepseek-ai/cordis`)
 * and drives the plugin through the real service, so a host-side contract
 * change fails here with the host's own error code.
 *
 * It is version-sensitive by design: it asserts against whatever harness is
 * installed, and reports the installed versions in its output.
 *
 * Run standalone: `node test/host-compat.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The usage ledger writes under $DSH_HOME; keep the real home untouched.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-opencode-go-hostcompat-"));
/** Image fixtures live beside that home and are likewise throwaway. */
const IMAGE_DIR = process.env.DSH_HOME;

const { Context } = await import("@deepseek-ai/cordis");
const { default: LlmRuntime } = await import("@deepseek-ai/dsh-llm");
const { default: InvariantRegistry } = await import("@deepseek-ai/dsh-invariants");
const llmInvariant = await import("@deepseek-ai/dsh-llm/invariant");
const plugin = await import("../lib/index.js");

/**
 * Installed harness versions, so a failure names the environment it ran in.
 * Every `@deepseek-ai/dsh-*` package ships one harness version; `dsh-llm` is
 * the one this plugin's contract lives in. The `dsh` launcher itself is not
 * resolvable from here (the bridge points at its own dependency tree), so it is
 * not listed.
 */
export async function hostVersions() {
  const versions = {};
  for (const name of ["@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-credentials", "@deepseek-ai/cordis", "@deepseek-ai/schemastery"]) {
    try {
      versions[name] = JSON.parse(
        await (await import("node:fs/promises")).readFile(
          new URL(`../node_modules/${name}/package.json`, import.meta.url),
          "utf8",
        ),
      ).version;
    } catch {
      versions[name] = "unresolved";
    }
  }
  return versions;
}

/**
 * The composition entry, exactly as `cordis.patch.yml` declares it. Everything
 * a user configures lives in the settings section below, never here — that
 * split is what makes the fallback in the "rejected settings section" case
 * observable at all.
 */
export const COMPOSITION_CONFIG = { apiKeyEnv: "OPENCODE_GO_API_KEY" };

/** The user-facing configuration this regression exercises (mirrors settings.yaml). */
export const HOST_SECTION = {
  enabledModels: ["muse-spark-1.2-contributor", "muse-spark-1.3-contributor", "deepseek-flash", "gpt-5.6-luna"],
  modelCaps: [
    { id: "muse-spark-1.3-contributor", contextWindow: 1000000 },
    { id: "muse-spark-1.2-contributor", contextWindow: 1000000 },
    { id: "deepseek-flash", image: true, efforts: ["low", "medium", "high", "xhigh"], surface: "responses" },
  ],
};

/** `settings.yaml` as this machine actually holds it (surface and levels disagree). */
export const LIVE_SETTINGS_SECTION = {
  enabledModels: ["muse-spark-1.2-contributor", "muse-spark-1.3-contributor", "deepseek-flash", "gpt-5.6-luna"],
  modelCaps: [
    { id: "deepseek-flash", image: true, efforts: ["low", "medium", "high", "max"], surface: "responses" },
  ],
};

/**
 * Boot a real Cordis app carrying the real LLM service (and, when requested,
 * the harness's own stream-grammar invariant companion), then mount the plugin
 * under test with every non-LLM service stubbed at the documented seam.
 *
 * `config` is the composition entry (`cordis.patch.yml`); `section` is the raw
 * `settings.yaml` section a user layer would add. The settings stub mirrors the
 * real `installSection` contract exactly: `setSource` receives a *function*
 * returning the schema-resolved scope, and `onChange` fires on registration —
 * the plugin reads `options()` live per request instead of caching the object.
 */
export async function bootHost({ withInvariant = true, config = COMPOSITION_CONFIG, section = HOST_SECTION } = {}) {
  const root = new Context();
  const calls = {
    webRoutes: [],
    settingsSections: [],
    logs: [],
    requests: [],
    // attachmentId -> readable file on disk; registered by `writeImage`.
    imageFiles: new Map(),
  };

  // The plugin's fail-safe paths only log; capture the structured sink so a
  // silently-swallowed configuration error is still visible to the regression.
  root.logger.exporter({
    export: (message) => {
      const args = Array.isArray(message?.args) ? message.args : [message?.content ?? message];
      calls.logs.push({
        level: String(message?.level ?? ""),
        message: args.map((value) => (value instanceof Error ? value.message : String(value))).join(" "),
      });
    },
  });

  root.provide("connection", { requestRejection: () => undefined });
  root.provide("webServer", {
    register: (route) => {
      calls.webRoutes.push(route);
      return () => {};
    },
  });
  root.provide("credentials", {
    resolve: async () => ({ value: "host-compat-test-key" }),
  });
  root.provide("settings", {
    // Real signature: installSection(owner, ns, schema, entry, hooks).
    installSection: (_owner, ns, schema, entry, hooks) => {
      const resolveScope = () => schema({ ...entry, ...(section ?? {}) });
      calls.settingsSections.push({ ns, schema, entry, section, hooks });
      calls.resolveScope = resolveScope;
      hooks.setSource(resolveScope);
      hooks.onChange();
      return () => {};
    },
  });
  root.provide("attachments", {
    // The real image path is a real file: the adapter reads it through
    // `node:fs/promises`, so handing back a path is what makes the inline case
    // end-to-end instead of a mock handshake.
    imageHostPath: (ref) => calls.imageFiles.get(String(ref?.attachmentId ?? "")),
  });
  root.provide("fs", { processPathFromHostPath: (path) => path });

  // Each plugin load settles before the next: the real LLM service registers
  // its `llm` service asynchronously, and the plugin under test waits on it.
  await root.plugin(InvariantRegistry);
  await root.plugin(LlmRuntime);
  if (withInvariant) await root.plugin(llmInvariant);
  await root.plugin(plugin, config);

  return { root, calls };
}

/** Collect a chunk stream, surfacing the terminal failure the runtime yields. */
export async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** One canned OpenAI-compatible SSE response. */
export function sseResponse(...events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** The SSE reply a plain text turn expects. */
export function textSse(text) {
  return sseResponse(
    { choices: [{ delta: { content: text } }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  );
}

/**
 * Register one readable image file for `attachmentId`, so the adapter's real
 * `readFile` has bytes to inline. Nothing is registered for an occurrence a
 * test expects to be offloaded — an attempt to read it then fails loudly.
 */
export function writeImage(calls, attachmentId, bytes) {
  const path = join(IMAGE_DIR, `${attachmentId}-${bytes}.bin`);
  writeFileSync(path, Buffer.alloc(bytes, 7));
  calls.imageFiles.set(String(attachmentId), path);
  return path;
}

/**
 * Replace global fetch for one test, recording every request body the adapter
 * actually put on the wire. Asserting on the body — not on the callbacks the
 * adapter happened to make — is what makes these cases behavior-level: the wire
 * is the contract the endpoint, and the reviewer, sees.
 */
export function stubFetch(t, calls, respond) {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = async (url, init) => {
    calls.requests.push({
      url: String(url),
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    });
    return respond(url, init);
  };
}

const USER_MESSAGE = { role: "user", content: [{ type: "text", text: "hi" }] };

/** Print the host this run measured, so a failure report names its environment. */
test("host under test", async (t) => {
  t.diagnostic(JSON.stringify(await hostVersions()));
});

test("host registry accepts the plugin's provider, directory and adapter metadata", async () => {
  const { root, calls } = await bootHost();
  const llm = root.get("llm");
  assert.ok(llm, "the real llm service must be mounted");

  const providers = llm.listProviders();
  assert.deepEqual(providers.map((p) => p.id), ["zen-go"]);
  assert.equal(providers[0].name, "zen-go (OpenCode Go)");

  // The invariant companion reads this on every llm/adapters-updated event.
  assert.ok(llm.providerRetryPolicy("zen-go"), "providerRetryPolicy must stay readable");

  const directory = llm.listConfigurableProviders();
  assert.deepEqual(directory.map((entry) => entry.provider), ["zen-go"]);
  assert.equal(directory[0].settingsNs, "llm-opencode-go");

  // Real listModels validation: provider/id/name shape plus duplicate rejection.
  // Rows follow the static table's order; ids the table does not know (here
  // `deepseek-flash`, supplied only by the user's modelCaps) are appended.
  const models = await llm.listModels("zen-go");
  assert.deepEqual(models.map((m) => m.id), [
    "gpt-5.6-luna",
    "muse-spark-1.3-contributor",
    "muse-spark-1.2-contributor",
    "deepseek-flash",
  ]);

  // Real resolveModel validation for every enabled id, overrides included.
  for (const id of HOST_SECTION.enabledModels) {
    const info = await llm.resolveModelInfo("zen-go", id);
    assert.equal(info.provider, "zen-go");
    assert.equal(info.id, id);
  }

  // Settings + web wiring reached the host seams.
  assert.deepEqual(calls.settingsSections.map((s) => s.ns), ["llm-opencode-go"]);
  assert.deepEqual(calls.webRoutes.map((r) => r.path), ["/zen-go-rpc"]);
  assert.equal(calls.webRoutes[0].kind, "prefix");
});

test("declared reasoning and modality survive the host's own capability checks", async () => {
  const { root } = await bootHost();
  const llm = root.get("llm");
  const flash = await llm.resolveModelInfo("zen-go", "deepseek-flash");
  assert.deepEqual(flash.inputModalities, ["text", "image"]);
  assert.deepEqual(flash.reasoning.efforts.map((e) => e.id), ["low", "medium", "high", "xhigh"]);
  // `deepseek-flash` is not in the static table, so its capacity comes only
  // from the user's modelCaps entry — which this fixture does not give it.
  assert.equal(flash.context, undefined);

  const muse = await llm.resolveModelInfo("zen-go", "muse-spark-1.3-contributor");
  assert.deepEqual(muse.context, { contextWindow: 1000000 });

  // An explicit effort the model declares must pass; the runtime rejects unknown ones.
  const resolved = await llm.resolveCallConfig({
    provider: "zen-go",
    model: "deepseek-flash",
    reasoningEffort: "high",
  });
  assert.equal(resolved.reasoningEffort, "high");

  // The static table's chat vocabulary must be accepted for a chat-served id.
  const chat = await llm.resolveModelInfo("zen-go", "deepseek-v4-flash");
  assert.deepEqual(chat.reasoning.efforts.map((e) => e.id), ["low", "medium", "high", "max"]);
});

test("adapter chunk grammar satisfies the harness stream invariant", async (t) => {
  const { root } = await bootHost();
  const llm = root.get("llm");

  const surfaces = {
    chat: sseResponse(
      { choices: [{ delta: { content: "he" } }] },
      { choices: [{ delta: { content: "llo" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    ),
    responses: sseResponse(
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
    ),
    messages: sseResponse(
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 3, output_tokens: 1 } },
    ),
    toolcall: sseResponse(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"a"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ),
  };

  const cases = [
    { name: "chat text", model: "deepseek-v4-flash", body: surfaces.chat },
    { name: "chat tool call", model: "deepseek-v4-flash", body: surfaces.toolcall },
    { name: "responses text", model: "muse-spark-1.3-contributor", body: surfaces.responses },
    { name: "messages text", model: "qwen3.8-max", body: surfaces.messages },
  ];

  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  for (const testCase of cases) {
    globalThis.fetch = async () => testCase.body.clone();
    const chunks = await collect(
      llm.stream({ provider: "zen-go", model: testCase.model, messages: [USER_MESSAGE], sessionId: "host-compat" }),
    );
    // adapterStream converts an adapter throw into a terminal error chunk; the
    // invariant companion, when it trips, throws out of the stream instead.
    const failure = chunks.find((chunk) => chunk.type === "finish" && chunk.reason.kind === "error");
    assert.equal(
      failure,
      undefined,
      `${testCase.name}: ${failure?.reason?.failure?.code}: ${failure?.reason?.failure?.message}`,
    );
    const finish = chunks.find((chunk) => chunk.type === "finish");
    assert.ok(finish, `${testCase.name}: every stream must end in a terminal finish chunk`);
    assert.notEqual(finish.reason.kind, "error", `${testCase.name}: ${JSON.stringify(finish.reason)}`);
    // Every opened block must be closed before the terminal chunk.
    const open = new Set();
    for (const chunk of chunks) {
      if (chunk.type === "block-start") open.add(chunk.index);
      if (chunk.type === "block-end") open.delete(chunk.index);
    }
    assert.equal(open.size, 0, `${testCase.name}: unbalanced block indices ${[...open].join(",")}`);
  }
});

/**
 * Finding: a settings section the plugin's own `resolveOptions` refuses is
 * dropped whole, and the adapter keeps the composition default. Nothing reaches
 * the user — the settings card still renders the persisted ids, so the card and
 * the request path disagree about which models this route serves.
 *
 * The live `settings.yaml` on this machine is exactly such a section:
 * `modelCaps["deepseek-flash"]` declares `surface: responses` together with the
 * `max` level, which only the chat surface accepts.
 */
test("a rejected settings section silently falls back to the composition default", async () => {
  const { root, calls } = await bootHost({ section: LIVE_SETTINGS_SECTION });
  const llm = root.get("llm");

  // Root cause, pinned as a pure call: the plugin's own validation refuses the
  // section the harness would happily hand it.
  assert.throws(
    () => plugin.resolveOptions({ ...COMPOSITION_CONFIG, ...LIVE_SETTINGS_SECTION }),
    /modelCaps\["deepseek-flash"\]\.efforts entry "max"/,
  );

  const served = await llm.listModels("zen-go");
  const refusal = calls.logs.find((entry) => entry.message.includes("keeping the last good configuration"));
  assert.ok(refusal, `the refusal must at least be logged, got: ${JSON.stringify(calls.logs)}`);
  assert.ok(
    calls.logs.some((entry) => entry.message.includes("modelCaps") && entry.message.includes("efforts")),
    `the log must name the offending field, got: ${calls.logs.map((e) => e.message).join(" | ")}`,
  );

  // The user asked for four ids; the route serves the whole static table.
  assert.notDeepEqual(served.map((m) => m.id), LIVE_SETTINGS_SECTION.enabledModels);
  assert.ok(served.length > LIVE_SETTINGS_SECTION.enabledModels.length);

  // Nothing tells the settings surface that its section was refused: the card
  // reads the persisted ids straight from the settings scope.
  assert.deepEqual(calls.resolveScope().enabledModels, LIVE_SETTINGS_SECTION.enabledModels);
});

/**
 * The 0.1.6 harness moved image offloading from the runtime into the adapter:
 * `ImageBlock.offloaded` is a durable decision every route must honor by
 * sending placeholder text, and an over-budget request must fail with
 * `IMAGE_OFFLOAD_REQUIRED` (plus `offloadImages`) so `dsh-compaction-image-offload`
 * can record the selection and retry. `dsh-llm-deepseek` and `dsh-llm-pi-ai`
 * both call `projectOffloadedImages` and `requiredImageOffload` for this;
 * `dsh-compaction-image-offload` does not exist before 0.1.6 at all.
 */
test("durably offloaded images travel as placeholder text, never as bytes", async (t) => {
  const { root, calls } = await bootHost();
  const llm = root.get("llm");
  stubFetch(t, calls, () => textSse("ok"));

  const chunks = await collect(
    llm.stream({
      provider: "zen-go",
      // Image-capable on purpose: for a text-only route the runtime itself
      // substitutes the text, which would hide what this route does. The id is
      // chat-served and declares vision in the static table. No file is
      // registered for `offloaded-1`, so re-inlining it could not even succeed.
      model: "deepseek-v4-flash-vision-exp",
      sessionId: "host-compat",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          {
            type: "image",
            offloaded: true,
            attachment: { attachmentId: "offloaded-1", mediaType: "image/png", width: 8, height: 8, bytes: 8 },
          },
        ],
      }],
    }),
  );

  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.notEqual(finish?.reason?.kind, "error", JSON.stringify(finish?.reason));
  assert.equal(calls.requests.length, 1, "the turn must still be sent");
  const body = JSON.stringify(calls.requests[0].body);
  assert.ok(
    body.includes("image omitted to fit request image limits"),
    `the offloaded occurrence must become the harness placeholder, got: ${body.slice(0, 400)}`,
  );
  assert.ok(!body.includes("data:image/"), "an offloaded occurrence must never be re-inlined as bytes");
  assert.ok(body.includes("offloaded-1"), "the placeholder must still identify the attachment");
});

test("an over-budget request asks the harness to offload instead of dispatching", async (t) => {
  // A deliberately small budget: the accounting is what is under test, not the
  // shipped default (which is far above ordinary traffic by design).
  const { root, calls } = await bootHost({
    section: { ...HOST_SECTION, maxRequestImageBytes: 8 * 1024 * 1024 },
  });
  const llm = root.get("llm");
  stubFetch(t, calls, () => {
    throw new Error("nothing may reach the provider while the route budget is exceeded");
  });

  // Three 4 MiB occurrences: each fits the per-image cap, the set does not fit
  // the request budget.
  const messages = Array.from({ length: 3 }, (_unused, index) => ({
    role: "user",
    content: [
      { type: "text", text: `shot ${index}` },
      {
        type: "image",
        attachment: {
          attachmentId: `big-${index}`,
          mediaType: "image/png",
          width: 4096,
          height: 4096,
          bytes: 4 * 1024 * 1024,
        },
      },
    ],
  }));

  const chunks = await collect(
    llm.stream({ provider: "zen-go", model: "muse-spark-1.3-contributor", sessionId: "host-compat", messages }),
  );

  assert.equal(calls.requests.length, 0, "the budget must be enforced before dispatch");
  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.equal(finish?.reason?.failure?.code, "IMAGE_OFFLOAD_REQUIRED");
  // 3 x base64(4 MiB) ≈ 16.8 MiB against an 8 MiB budget: the oldest two must go.
  assert.equal(finish?.reason?.failure?.offloadImages, 2);
});

test("a request inside the budget dispatches every occurrence inline", async (t) => {
  const { root, calls } = await bootHost({ section: { ...HOST_SECTION, maxRequestImageBytes: 8 * 1024 * 1024 } });
  const llm = root.get("llm");
  stubFetch(t, calls, () => textSse("ok"));
  writeImage(calls, "ok-1", 4096);

  const chunks = await collect(
    llm.stream({
      provider: "zen-go",
      model: "deepseek-v4-flash-vision-exp",
      sessionId: "host-compat",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "one shot" },
          {
            type: "image",
            attachment: { attachmentId: "ok-1", mediaType: "image/png", width: 64, height: 64, bytes: 4096 },
          },
        ],
      }],
    }),
  );

  const finish = chunks.find((chunk) => chunk.type === "finish");
  assert.notEqual(finish?.reason?.kind, "error", JSON.stringify(finish?.reason));
  assert.equal(calls.requests.length, 1);
  const body = JSON.stringify(calls.requests[0].body);
  assert.ok(body.includes("data:image/png;base64,"), "a retained occurrence must reach the wire inline");
});
