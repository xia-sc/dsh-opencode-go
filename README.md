# dsh-opencode-go

[English](./README.en.md)

DeepSeek Harness 的 OpenCode Go LLM provider 插件：注册 `zen-go` 路由，
每次出站推理请求都携带每会话稳定的 `x-opencode-session`。

> **运行环境**：适配 DeepSeek Harness `0.1.6-alpha.1` 及以上（peer 依赖
> `@deepseek-ai/dsh-*` 声明为 `^0.1.6-alpha.1`）。0.1.6 起图片 offload 由 adapter
> 负责（见下文「图片超限」），本插件依赖该契约，所以下限是 0.1.6。

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
  刷新实时目录、每模型自填上下文/输出上限/端面/思考档位/多模态、密钥状态点）。
- **推理档位**：responses 系 Minimal/Low/Medium/High/Xhigh（落 `reasoning.effort`），chat 系
  Low/Medium/High（`reasoning_effort` 透传；deepseek-v4-flash/pro/flash-vision-exp
  另有 Max 档——上游网关实测支持，感谢 [@34262315716](https://github.com/34262315716)
  真机验证并贡献，见 [#1](https://github.com/xia-sc/dsh-opencode-go/pull/1)），messages 系
  无档位词汇（显式传会报错）。
  均不设默认值，Default 即不发字段。
- **多模态**：vision 模型（`deepseek-v4-flash-vision-exp`、两个 muse-spark）声明
  `["text","image"]`，图片经 attachment 服务读盘转 base64 内联（png/jpeg/webp/gif）；
  纯文本模型由 runtime 自动替换占位；未知 id 默认放行，服务端说了算。
  **单图大小由 attachment 的准入归一化决定，不是本插件**：本部署在准入时就把每张图
  压到 ≤ 4 MiB / ≤ 2048×2048 像素（单边 ≤ 8192；上传侧单图 ≤ 20 MiB、单消息 ≤ 200 MiB），
  而 `imageHostPath` 给的就是那份**归一化副本**——所以我们内联的不是原始上传。
  插件自己那条 20 MiB 单图检查只对**不做归一化的 attachment provider** 生效，是兜底
  而不是主力。
- **图片超限走 harness 的卸载回路**：一次请求内联图片总量（base64 后的字节数）超过
  `maxRequestImageBytes`（默认 64 MiB）时，本插件**不自己丢图**，而是抛
  `IMAGE_OFFLOAD_REQUIRED` 并附上「最旧的几张要丢」——
  `dsh-compaction-image-offload` 记下这个决定并重试该步。丢图是**持久会话决定**，
  只能由 harness 记录，所以判定一定发生在发请求之前（durable ref 自带字节数，
  不读盘）。已由 harness 标记 `offloaded` 的图片一律按占位文本发送，**不会**被重新
  内联——那是它自己的账，路由无权撤销。注意触发条件是图片**张数**而非单图体积：
  归一化后单图约 5.4 MiB（base64），64 MiB 预算约合十余张同请求。
- **未知模型可手动归类**：官方 `/v1/models` 只给 id，新上线的模型（如 `deepseek-flash`）
  归类为 `unknown`，于是「选不了思考等级、也定不了多模态」（[#4](https://github.com/xia-sc/dsh-opencode-go/issues/4)）。
  现在可在设置卡里按模型手填**端面**（chat / responses / messages）、**思考档位**与
  **多模态**，留空即跟随内置表。端面决定路由与档位词表——chat 落 `reasoning_effort`、
  responses 落 `reasoning.effort`、messages 无档位词汇，所以档位选项会跟着端面走；
  手填的 `image` 会同时改写声明与图片准入判定，text-only 的已知模型不会因此被拒。
- **端面与档位是一对，改端面时自动收敛档位**：宿主把 `surface` 与 `efforts` **当成一个组合**
  校验（`surface: responses` 配 chat 才有的 `max` 会被整段拒绝）。所以卡片在改端面的**同一次
  写入**里就把档位收敛好：新端面支持的保留，不支持的去掉并提示去掉了哪些；切到 messages 这类
  没有档位词汇的端面则整体清空；把端面交回「跟随默认」时按**该模型自身的默认档位表**收敛
  （未归类模型默认不提供档位，于是整体清空）。这样卡片写不出被拒绝的组合——否则整段设置会被
  丢弃，路由静默退回默认值。
- **内容块策略**：user 消息只承载用户载荷（text/image），其余块——reasoning、
  tool-call 这类 harness 注解，以及 merge-extensible 的新类型——一律丢弃而不报错。
  子代理结算通知会把子会话最后的 assistant 内容整段展开进 user 消息，这类块因此会
  合法地出现在历史里；历史是持久的，一条转译不了的块若直接抛错，会让该会话**之后每一轮**
  都失败（见 [#3](https://github.com/xia-sc/dsh-opencode-go/issues/3)）。assistant 侧同理，
  只有 image 仍然硬报错——用户上传的二进制内容不能被悄悄抹掉。
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
dsh plugin --profile web add github xia-sc/dsh-opencode-go
# 重启 dsh web，然后在会话模型选择器里选 zen-go/<模型>
```

本地源码安装（`dsh plugin add <目录>`，pnpm `link:` 方式）
多一步——否则启动直接崩（见 [#2](https://github.com/xia-sc/dsh-opencode-go/issues/2)）：

```powershell
cd <插件源码目录>
node scripts/setup-local-deps.cjs   # 自动定位宿主依赖树，建 node_modules/@deepseek-ai 桥
dsh plugin --profile web add <插件源码目录>
# 重启 dsh web
```

原理一句话：`link:` 安装只是在 profile 里建个 junction 指回源码目录，
Node 按**真实路径**向上找 `@deepseek-ai/*` peer 包——源码盘里没有，只能
桥到宿主那份。`--host <目录>` 可显式指定宿主依赖树（install root /
`node_modules` / `@deepseek-ai` 本级都认），`--dry-run` 只探测不建链。
建桥失败（比如启动报 `Cannot find package '@deepseek-ai/xxx'`）就检查桥
还在不在：`node_modules/@deepseek-ai` 必须是 junction，不在就重跑脚本。
registry / github 安装不受影响，不用跑这步。

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
| `requestTimeoutMs` / `streamIdleTimeoutMs` | `60000` / `300000` | 建连+首包超时（响应头一到即停表，长流不受总时长限制） / 流空闲看门狗 |
| `maxRequestImageBytes` | `67108864`（64 MiB） | 单请求内联图片总量上限，按**进请求体的 base64 字节**计；超了抛 `IMAGE_OFFLOAD_REQUIRED` 让 harness 卸载最旧的几张并重试。上游没公布请求体上限，所以这是部署取值：默认远高于日常截图流量（归一化后单图约 5.4 MiB，约合十余张同请求），代理有更小的 body cap 就往下调 |
| `enabledModels` | 全表 | 提供哪些模型（卡片勾选即改这里） |
| `modelCaps` | `[]` | `[{id, contextWindow?, maxTokens?, surface?, image?, efforts?}]`，自填容量与能力覆盖 |

设置卡会自己说明「设置没生效」：如果这一段被校验拒绝（例如 `modelCaps` 里
`surface: responses` 配了 chat 才有的 `max` 档），插件会**整段丢弃并沿用默认值**，
同时把拒绝原因显示在模型列表上方——否则卡片里的勾选数与实际路由会各说各话。

## 测试

```powershell
node --test test/smoke.mjs        # 插件自洽（宿主全打桩）
node test/host-compat.mjs         # 真宿主契约（真 dsh-llm + 真流语法不变量）
# 联网探活（花一点点额度）：
$env:OPENCODE_GO_API_KEY='<key>'; node --test test/smoke.mjs
```

`test/host-compat.mjs` 直接 import 装在 `node_modules` 里的真实
`@deepseek-ai/dsh-llm` / `dsh-invariants` / `cordis`，跑真 `llm` 服务与真流语法校验。
宿主换版本后先跑它：`smoke.mjs` 把宿主面全打桩，宿主收紧契约（例如 0.1.6 把图片
offload 从 runtime 挪进 adapter）它发现不了。

## 浏览器半构建

`lib/client.js` 是生成物，不要手改：改 `src/client/*.js`
（数字前缀即拼接顺序），然后跑 `npm run build:client`。
构建脚本拼完会做语法门检查，坏了直接失败，不会把坏包写进 `lib/`。

## 已知限制

- responses 系推理 effort 高时容易烧光 token 预算，大 maxTokens 起步更稳。
- 官方 `/v1/models` 不返回上下文窗口，`modelCaps` 目前靠手填；
  官方补了字段即插即用。
- 价格由计费插件自己的价格表定，本插件只保证用量上报正确。

## 致谢

- [@34262315716](https://github.com/34262315716)（Critical Natural）：真机验证上游网关
  支持 `reasoning_effort=max`，并贡献 deepseek-v4 三模型的 Max 档
  （[#1](https://github.com/xia-sc/dsh-opencode-go/pull/1)）；本地源码 link 安装
  启动崩溃的根因分析（[#2](https://github.com/xia-sc/dsh-opencode-go/issues/2)）。
