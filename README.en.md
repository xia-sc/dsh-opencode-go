# dsh-opencode-go

[中文](./README.md)

An LLM provider plugin for DeepSeek Harness that serves OpenCode Go: it registers
the `zen-go` route and sends a stable per-conversation `x-opencode-session`
header on every outbound inference request.

> **Runtime**: adapted to DeepSeek Harness `0.1.5-rc.1` (peer dependencies
> `@deepseek-ai/dsh-*` declared as `^0.1.5-rc.1`).

- **All three surfaces**: `chat/completions` (mimo / deepseek-v4 / glm / kimi /
  longcat / hy), `responses` (grok / gpt-5.6-luna / muse-spark, including the
  standalone `response.incomplete` terminal state), and `messages`
  (Anthropic-compatible: minimax / qwen, authenticated with `x-api-key`,
  `max_tokens` defaults to 8192 when unset).
- **Session header**: `x-opencode-session` carries the conversation id, with a
  per-request UUID fallback so the header is never missing.
- **Client identity**:
  `user-agent: deepseek-harness/<version> (+url) dsh-opencode-go/<version>`,
  identical on all surfaces so operators can identify and permit exactly this
  traffic (never a generic string like `Go-http-client/1.1`).
- **Seam-only credentials**: `credentials.resolve` layers process env over the
  managed store (`$DSH_HOME/.credentials.yaml`, hot-reloaded) over
  project/home `.env` files — storing or rotating the key needs no restart.
  There is no plaintext key field anywhere.
- **Settings card**: a Models-page row plus a standalone Settings sidebar entry
  (key save/clear, model checklist with select-all, live catalog refresh,
  per-model context/max-output inputs, credential status dot).
- **Reasoning levels**: responses models offer Minimal/Low/Medium/High/Xhigh
  (wired to `reasoning.effort`); chat models offer Low/Medium/High
  (`reasoning_effort` passthrough; deepseek-v4-flash/pro/flash-vision-exp
  additionally offer Max — verified live against the upstream gateway, thanks
  to [@34262315716](https://github.com/34262315716), see
  [#1](https://github.com/xia-sc/dsh-opencode-go/pull/1)); messages models
  offer none (Anthropic thinking is budget-based — explicit values are
  rejected). No defaults are declared: Default omits the field (the server
  decides).
- **Multimodal**: vision models (`deepseek-v4-flash-vision-exp`, both
  `muse-spark-*-contributor`) declare `["text", "image"]` so the runtime passes
  images through; other known models are text-only (the runtime substitutes
  placeholders); unknown ids stay permissive and the server decides. Images
  resolve from the durable attachment store to inline base64 data URLs per
  surface (png/jpeg/webp/gif, 20 MB cap per image).
- **Usage**: normalized across all three surfaces (both `prompt_tokens` and
  `input_tokens` vocabularies), provider totals preserved verbatim, cache
  reads/writes and reasoning tokens reported in separate buckets.
- **Usage ledger**: one row per call (model/session/sent `x-opencode-session`/
  purpose/in/out/cache read/write/reasoning/finish) in
  `$DSH_HOME/plugin-data/dsh-opencode-go/usage.jsonl` (append-only, archived
  on clear, never leaves the machine); the card shows an Overview/Models tab
  pair with a large-cell daily heatmap plus a per-model table, with one-click
  clear. **Click any heatmap day** to expand that day's totals plus a
  per-dsh-session breakdown (including the actually sent session header).

The route is deliberately named `zen-go`, not `opencode-go` — the latter is the
natural name for user-owned pi-ai custom profiles, and the llm registry allows
exactly one owner per route. `apply()` also refuses to boot with a clear
`DUPLICATE_ADAPTER` error when the route is taken, so a collision can never
silently break the other party.

## Install

```powershell
dsh plugin --profile web add <plugin-directory>
# restart dsh web, then pick zen-go/<model> in the session model picker
```

Local-source installs (`dsh plugin add <dir>`, the pnpm `link:` route) need
one extra step first — otherwise boot crashes outright (see
[#2](https://github.com/xia-sc/dsh-opencode-go/issues/2)):

```powershell
cd <plugin-source-dir>
node scripts/setup-local-deps.cjs   # locate the host tree, bridge node_modules/@deepseek-ai
dsh plugin --profile web add <plugin-source-dir>
# restart dsh web
```

Why: a `link:` install is just a junction back at the source tree, so Node
resolves the host half's `@deepseek-ai/*` peer imports upward from the REAL
source path, where no `@deepseek-ai/*` exists. `--host <dir>` pins the host
tree explicitly (install root, `node_modules`, or the `@deepseek-ai` dir
itself); `--dry-run` only probes. If boot ever complains
`Cannot find package '@deepseek-ai/xxx'`, check the bridge is still a
junction and re-run the script. Registry/github installs are unaffected —
skip this step.

Store the key (any one of these; effective immediately, no restart):

```yaml
# $DSH_HOME/.credentials.yaml
version: 1
refs:
  OPENCODE_GO_API_KEY: sk-your-key
```

Or export the `OPENCODE_GO_API_KEY` environment variable, or paste it in the
settings card.

## Configuration (layer config / `llm-opencode-go` settings section)

| Field | Default | Notes |
| --- | --- | --- |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | credential ref name |
| `apiBase` | `https://opencode.ai/zen/go` | base URL without the trailing `/v1` prefix |
| `requestTimeoutMs` / `streamIdleTimeoutMs` | `60000` / `300000` | connect + first-byte timeout (timer stops at response headers; long streams aren't capped by total time) / stream idle watchdog |
| `enabledModels` | whole table | which models are offered (the card checkboxes edit this) |
| `modelCaps` | `[]` | `[{id, contextWindow?, maxTokens?}]`, user-filled capacity overrides |

## Test

```powershell
node --test test/smoke.mjs
# live probes (spend a tiny amount of quota):
$env:OPENCODE_GO_API_KEY='<key>'; node --test test/smoke.mjs
```

## Known limitations

- High reasoning effort on the responses surface burns through the token
  budget fast; start with a generous maxTokens.
- The official `/v1/models` endpoint discloses no context windows, so
  `modelCaps` is manual for now; first-class fields plug straight in once
  the operator adds them.
- Pricing lives in the metering plugin's own price tables; this plugin only
  guarantees correct usage reporting.

## Acknowledgements

- [@34262315716](https://github.com/34262315716) (Critical Natural): verified
  live that the upstream gateway accepts `reasoning_effort=max` and
  contributed the Max tier for the three deepseek-v4 models
  ([#1](https://github.com/xia-sc/dsh-opencode-go/pull/1)); root-caused the
  local-source link-install boot crash
  ([#2](https://github.com/xia-sc/dsh-opencode-go/issues/2)).
