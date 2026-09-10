/**
 * @dsh-plugins/dsh-opencode-go — host wiring (pure host-side provider plugin).
 *
 * Registers the `zen-go` provider route on `ctx.llm`, mounts the
 * `/zen-go-rpc` channel, and owns the usage ledger. Layered layout:
 *
 *   - `models.js` — static model knowledge (surfaces, vision, reasoning).
 *   - `protocol.js` — pure wire protocol (headers, translation, SSE, usage).
 *   - `adapter.js` — provider adapter (registry, pumps, images, refresh).
 *   - `usage.js` — metering ledger (records, aggregation, JSONL persistence).
 *   - `index.js` (this file) — composition: config, Services, registration.
 *
 * Sends `x-opencode-session` (stable per conversation) on every request, which
 * is the header OpenCode Go requires for prompt-cache optimization and, from
 * 09/05, for the request to be accepted at all.
 *
 * Credential chain: the credentials seam only (`credentials.resolve`
 * layers process env over the managed store over `.env` files, per request,
 * so stored/rotated keys need no restart). No literal key field exists on
 * purpose — secrets never belong in settings or composition files.
 *
 * @module dsh-opencode-go
 */
import z from "@deepseek-ai/schemastery";
import { LlmError, assertUsableApiKey } from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { MAX_TIMER_DELAY_MS } from "@deepseek-ai/dsh-timeout";
import { readFile } from "node:fs/promises";
import { MODEL_TABLE } from "./models.js";
import { OpencodeGoAdapter, refreshModels } from "./adapter.js";
import { fail } from "./protocol.js";
import { createUsageLedger, pluginDataDir } from "./usage.js";

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
  const rawApiBase = String(raw.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  try {
    // Fail fast at settings load: a typo'd apiBase ("xxx", "htp://…")
    // otherwise surfaces only as a cryptic `Failed to parse URL` inside fetch.
    new URL(rawApiBase);
  } catch {
    throw new Error(`llm-opencode-go: apiBase is not a valid URL: ${JSON.stringify(rawApiBase)}`);
  }
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
    apiBase: rawApiBase,
    requestTimeoutMs,
    streamIdleTimeoutMs,
    enabledModels: [...(raw.enabledModels ?? MODEL_TABLE.map((m) => m.id))],
    modelCaps: caps,
  };
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
  // Usage ledger: append-only JSONL under the plugin-data dir, loaded at
  // boot (failures are logged, never fatal), one row per finished stream.
  const ledger = createUsageLedger({ dir: pluginDataDir() });
  ledger.load().catch((error) => {
    try {
      ctx.logger.error("llm-opencode-go: usage ledger failed to load, starting empty");
      ctx.logger.error(error);
    } catch {}
  });
  const adapter = new OpencodeGoAdapter(options, resolveKey, {
    resolveAttachments: () => ctx.get("attachments"),
    mapHostPath: (hostPath) => ctx.get("fs")?.processPathFromHostPath(hostPath),
    readFile: (path) => readFile(path),
    recordUsage: (entry) => {
      ledger.record(entry).catch((error) => {
        try {
          ctx.logger.error("llm-opencode-go: usage record failed to persist");
          ctx.logger.error(error);
        } catch {}
      });
    },
  });
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: "zen-go (OpenCode Go)",
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
  // RPC channel: register the physical prefix route DIRECTLY on the
  // `webServer` from the same fiber that injects it — never through
  // `connection.rpc.handle`. Why: that helper resolves
  // `owner.webServer.register` inside the CONNECTION service's own
  // context (`owner = the fiber reading ctx.connection`), whose fiber
  // chain cannot see `webServer`; Cordis then swallows the
  // `cannot get property "webServer" without inject` thrown inside the
  // effect body, the route silently never mounts, and every browser
  // POST to `/zen-go-rpc/*` falls through to the SPA fallback, which
  // answers non-GET/HEAD with HTTP 405 ("transport failure ... 405").
  //
  // This fiber (`rpcCtx`) DID inject `webServer`, so registering on it
  // is legal and the route lands. The handler is the same fetch-shaped
  // contract `connection.rpc.handle` would have bridged: buffered body,
  // `client-request` envelope, endpoint == method, and `{ok}`/`fail`
  // results — the browser's `ctx.connection.rpc.call("/zen-go-rpc", …)`
  // sends exactly that. `requestRejection` (trusted-host + browser
  // auth) is applied when the connection service offers it, matching
  // the `/api` fence; when absent (headless/embed) the route is open,
  // same as before. Nested inject keeps the core LLM route working in
  // headless profiles with no webServer: only this channel waits.
  ctx.inject(["connection", "webServer"], (rpcCtx) => {
    ctx.logger.info('llm-opencode-go: webServer available, mounting "/zen-go-rpc"');
    const endpoint = (pathname) => {
      if (!pathname.startsWith("/zen-go-rpc/")) return "";
      const rest = pathname.slice("/zen-go-rpc/".length);
      return rest !== "" && !rest.split("/").some((s) => s === "" || s === "." || s === ".." || !/^[A-Za-z0-9_$.-]+$/.test(s)) ? rest : "";
    };
    const handle = async (envelope, signal) => {
      // Browser rpc.call sends { type, rpcId, method, payload }, and the
      // endpoint args live under payload.args (see client lib: rpc.call(channel,
      // endpoint, payload) -> envelope.payload = payload).
      const rawPayload = envelope?.payload;
      const args =
        rawPayload !== null && typeof rawPayload === "object" &&
        rawPayload.args !== null && typeof rawPayload.args === "object"
          ? rawPayload.args
          : {};
      switch (envelope.method ?? "") {
        case "models/refresh":
          return refreshModels(options, resolveKey, signal);
        case "usage/summary": {
          const days = Number(args.days);
          return { ok: true, value: ledger.summary(Number.isFinite(days) && days > 0 ? Math.floor(days) : 120) };
        }
        case "usage/day": {
          const date = typeof args.date === "string" ? args.date : "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail("invalid-args", "usage/day needs {date: 'YYYY-MM-DD'}");
          return { ok: true, value: ledger.day(date) };
        }
        case "usage/reset":
          return { ok: true, value: await ledger.reset() };
        default:
          return fail("unknown-endpoint", `unknown zen-go endpoint ${JSON.stringify(envelope.method ?? "")}`);
      }
    };
    const respond = (rpcId, result) =>
      Response.json({ type: "server-response", rpcId, result });
    const apiHandler = {
      requestBodyMode: () => "buffered",
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        const name = endpoint(pathname);
        if (request.method !== "POST" || name === "") return new Response("not found", { status: 404 });
        if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
          return new Response("content type must be application/json", { status: 415 });
        }
        let envelope;
        try {
          envelope = await request.json();
        } catch {
          return new Response("body is not JSON", { status: 400 });
        }
        const rawId = envelope?.rpcId;
        if (
          envelope === null || typeof envelope !== "object" ||
          envelope.type !== "client-request" || typeof rawId !== "string" ||
          typeof envelope.method !== "string"
        ) {
          return respond(typeof rawId === "string" ? rawId : "invalid-request", {
            ok: false,
            error: { code: "gateway/bad-request", message: "invalid client-request message", details: {} },
          });
        }
        if (envelope.method !== name) {
          return respond(rawId, {
            ok: false,
            error: {
              code: "gateway/bad-request",
              message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(name)}`,
              details: {},
            },
          });
        }
        try {
          return respond(rawId, await handle(envelope, request.signal));
        } catch (error) {
          return new Response(`handler failure: ${String(error)}`, { status: 500 });
        }
      },
    };
    rpcCtx.effect(() => rpcCtx.webServer.register({
      kind: "prefix",
      path: "/zen-go-rpc",
      // Non-standard hook so unit tests can exercise the pure endpoint
      // dispatch without a full HTTP round-trip.
      dispatch: handle,
      handler: async (req, res) => {
        let rejection;
        try {
          rejection = rpcCtx.connection?.requestRejection?.(req);
        } catch {
          rejection = void 0; // connection service without a fence (embed/headless)
        }
        if (rejection !== void 0) {
          res.writeHead(rejection);
          res.end(rejection === 401 ? "unauthorized" : "forbidden");
          return;
        }
        // Buffered <-> fetch bridge for this route (same shape as the
        // /api transport): body capped at 1 MiB for these small envelopes.
        let body = "";
        try {
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 1024 * 1024) {
              res.writeHead(413, { connection: "close" });
              res.end();
              req.destroy();
              return;
            }
          }
        } catch {
          res.writeHead(400);
          res.end();
          return;
        }
        const url = new URL(req.url ?? "/", "http://dsh.internal");
        const request = new Request(url, {
          method: req.method ?? "GET",
          headers: Object.fromEntries(Object.entries(req.headers ?? {}).filter(([, v]) => typeof v === "string")),
          ...(req.method !== "GET" && req.method !== "HEAD" && body !== "" ? { body } : {}),
        });
        const response = await apiHandler.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body === null) res.end();
        else {
          for await (const chunk of response.body) res.write(chunk);
          res.end();
        }
      },
    }), 'llm-opencode-go: "/zen-go-rpc" rpc channel');
    ctx.logger.info('llm-opencode-go: "/zen-go-rpc" mounted');
  });
}

// Re-export the layers so a single entry covers tests and embedders.
export * from "./models.js";
export * from "./protocol.js";
export * from "./adapter.js";
export * from "./usage.js";
