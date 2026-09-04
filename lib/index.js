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
      case "usage/summary": {
        const days = Number(args.days);
        return { ok: true, value: ledger.summary(Number.isFinite(days) && days > 0 ? Math.floor(days) : 120) };
      }
      case "usage/reset":
        return { ok: true, value: await ledger.reset() };
      default:
        return fail("unknown-endpoint", `unknown zen-go endpoint ${JSON.stringify(endpoint)}`);
    }
  }, { authority: "trusted-host" });
}

// Re-export the layers so a single entry covers tests and embedders.
export * from "./models.js";
export * from "./protocol.js";
export * from "./adapter.js";
export * from "./usage.js";
