# dsh-opencode-go

[English](./README.en.md)

DeepSeek Harness 的 OpenCode Go LLM provider 插件：注册 `zen-go` 路由，
每次出站推理请求都携带每会话稳定的 `x-opencode-session`。

- **三端面全接**：`chat/completions`（mimo / deepseek-v4 / glm / kimi / longcat / hy）、
  `responses`（grok / gpt-5.6-luna / muse-spark，含独立 `response.incomplete` 终态）、
  `messages`（Anthropic 兼容：minimax / qwen，用 `x-api-key` 鉴权，`max_tokens` 缺省 8192）。
- **会话头**：`x-opencode-session` 取会话 id，缺失时按请求生成 UUID 兜底，保证请求一定带头。
- **客户端标识**：`user-agent: deepseek-harness/<版本> (+url) dsh-opencode-go/<版本>`，
  三端面一致，可被运营方识别放行（绝不是 `Go-http-client/1.1` 那种通用串）。
- **凭证只走 seam**：`credentials.resolve` 按“进程 env → 托管 store
  （`$DSH_HOME/.credentials.yaml`，热加载）→ 项目/家目录 `.env`”分层，
  存换 key 不用重启。无明文字段。
- **设置卡**：Models 页行 + 设置侧边栏独立入口（key 录入/清除、模型勾选与全选、
  刷新实时目录、每模型自填上下文与输出上限、密钥状态点）。
- **推理档位**：responses 系 Minimal/Low/Medium/High/Xhigh（落 `reasoning.effort`），chat 系
  Low/Medium/High（`reasoning_effort` 透传），messages 系无档位词汇（显式传会报错）。
  均不设默认值，Default 即不发字段。
- **多模态**：vision 模型（`deepseek-v4-flash-vision-exp`、两个 muse-spark）声明
  `["text","image"]`，图片经 attachment 服务读盘转 base64 内联
  （png/jpeg/webp/gif，单图 20MB 上限）；纯文本模型由 runtime 自动替换占位；
  未知 id 默认放行，服务端说了算。
- **用量**：三端面 usage 统一换算（`prompt_tokens` / `input_tokens` 双词汇），
  输入输出总量原样保留，缓存读/写、reasoning token 分桶上报。
- **用量账本**：每次调用记一条（模型/会话/实际发出的 `x-opencode-session`/用途/
  输入输出/缓存读写/推理/finish），落 `$DSH_HOME/plugin-data/dsh-opencode-go/usage.jsonl`
  （append-only，清空时归档，不出网）；卡片里「概览/模型」双标签页：大格日历热力图 +
  分模型表，可一键清空。**点热力图任意一天**，展开当天总计 + 按 dsh 会话 id
  分组的明细（含实际发出的 session 头）。

路由刻意叫 `zen-go` 而不是 `opencode-go`——后者是用户自建 pi-ai profile
的常用名，llm 注册表单路由独占，撞名会顶掉别人的路由；`apply()` 启动时
也会主动检查，撞了就报 `DUPLICATE_ADAPTER` 快速失败，不连累他人。

## 安装

```powershell
dsh plugin --profile web add xia-sc/dsh-opencode-go
# 重启 dsh web，然后在会话模型选择器里选 zen-go/<模型>
```

存 key（任选其一，存完即生效，不用重启）：

```yaml
# $DSH_HOME/.credentials.yaml
version: 1
refs:
  OPENCODE_GO_API_KEY: sk-你的key
```

或设环境变量 `OPENCODE_GO_API_KEY`，或在设置卡里直接粘贴保存。

## 配置（layer config / `llm-opencode-go` settings section）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | credential ref 名 |
| `apiBase` | `https://opencode.ai/zen/go` | 去掉尾部 `/v1` 前缀后的基址 |
| `requestTimeoutMs` / `streamIdleTimeoutMs` | `60000` / `300000` | 连接超时 / 流空闲看门狗 |
| `enabledModels` | 全表 | 提供哪些模型（卡片勾选即改这里） |
| `modelCaps` | `[]` | `[{id, contextWindow?, maxTokens?}]`，自填容量覆盖 |

## 测试

```powershell
node --test test/smoke.mjs
# 联网探活（花一点点额度）：
$env:OPENCODE_GO_API_KEY='<key>'; node --test test/smoke.mjs
```

## 已知限制

- responses 系推理 effort 高时容易烧光 token 预算，大 maxTokens 起步更稳。
- 官方 `/v1/models` 不返回上下文窗口，`modelCaps` 目前靠手填；
  官方补了字段即插即用。
- 价格由计费插件自己的价格表定，本插件只保证用量上报正确。
