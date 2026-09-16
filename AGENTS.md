# AGENTS.md

面向在本仓库里干活的 AI agent（以及人类协作者）。**只写这个仓库特有的东西** —— 通用的
编程常识、以及 `README.md` 已经讲清楚的功能介绍，这里不重复。

- 包名 `@dsh-plugins/dsh-opencode-go`，是 DeepSeek Harness 的 LLM provider 插件，
  注册 `zen-go` 路由（上游是 OpenCode Go 的 OpenAI 兼容端点）。
- 运行环境：Node `>=22`（`engines`）；peer 依赖 `@deepseek-ai/dsh-*` 为 `^0.1.5-rc.1`。
- 当前版本见 `package.json`（`PLUGIN_VERSION` 由它派生，会进 `user-agent`）。
- 功能说明看 `README.md`（中文主文档）/ `README.en.md`。

## 目录与职责

| 路径 | 职责 | 注意 |
| --- | --- | --- |
| `lib/index.js` | 宿主接线：`Config` schema、`resolveOptions`、`apply(ctx)`、`/zen-go-rpc` 端点表 | 配置校验与 RPC 端点都在这里 |
| `lib/adapter.js` | `LlmAdapter`（`providerInfo` / `listModels` / `resolveModel` / `stream`）、三个 SSE pump、图片读盘、`refreshModels` / `knownModels` | 一切外部依赖经 thunk 注入（`getOptions` / `resolveKey` / `services`），保持可测 |
| `lib/models.js` | 静态模型表、`capabilitiesOf`、各端面档位词表 | **能力解析的唯一真源** |
| `lib/protocol.js` | 纯协议层：请求头、三端面消息转译、SSE 解析、usage 映射、错误映射、`{ok}`/`fail` 信封 | 无 Services、无 IO；顶部有内容块策略说明 |
| `lib/usage.js` | 用量账本（JSONL、聚合） | |
| `lib/client.js` | **生成物**：`src/client/*.js` 拼接后的浏览器半 | **禁止手改**，见下 |
| `src/client/*.js` | 浏览器半源码，7 个分片按 `scripts/build-client.cjs` 的 `ORDER` 拼接 | `00-head`(入口) / `01-dicts`(i18n) / `02-ui`(样式+helper) / `10-store`(状态) / `20-card`(主卡片) / `21-section`(侧栏入口) / `99-tail`(`apply`) |
| `test/smoke.mjs` | 全部测试（`node:test`，单文件） | 唯一测试入口 |
| `scripts/build-client.cjs` | 拼接 + `vm` 语法门禁（先校验后写盘）；导出 `{ ORDER, OUT, build }` | 测试会调用 `build()` 做同步断言 |
| `scripts/setup-local-deps.cjs` | 本地源码安装时把 `node_modules/@deepseek-ai` 桥到宿主安装树（Windows junction） | 只在 `link:` 安装下需要 |
| `cordis.patch.yml` | 组合层 patch（`id` + 完整包名 + 默认 config） | 头部注释已过时，见文末「已知文档债」 |

## 常用命令

```powershell
node test/smoke.mjs      # 推荐：本进程内跑完全部测试
npm test                 # = node --test test/smoke.mjs（在受限沙箱里会 spawn EPERM）
npm run build:client     # 改过 src/client/* 之后必须跑
node scripts/setup-local-deps.cjs [--host <dir>] [--dry-run]   # 本地源码安装桥接
```

没有 lint、没有 typecheck、没有 CI（仓库里没有 `.github/`）。**唯一的门禁是测试 + 构建脚本
里的语法检查**，所以别指望自动化帮你兜底。

## 硬性约定

1. **`lib/client.js` 是生成物**：改浏览器半永远改 `src/client/*.js`，然后
   `npm run build:client`。`test/smoke.mjs` 里有一条断言直接比较产物与 `build()` 的结果，
   忘记重建会立刻测挂（这是故意的）。
2. **纯模块要保持纯**：`models.js` / `protocol.js` / `usage.js` 不引入 Services、不做 IO。
   需要外部能力时经 `adapter.js` 的 thunk 注入。
3. **内容块策略（`protocol.js` 顶部注释是权威版）**：三个端面对 user/assistant 消息
   一律「带得了的带、带不了的丢」，**不抛错**；只有 `image` 硬报错。
   原因是踩过的坑：一条转译不了的内容块已经在**持久历史**里，抛错会让**该会话之后每一轮**
   都失败且不自愈（后台子代理结算通知会把子会话最后的 assistant 内容整段展开进 user 消息，
   所以 `reasoning` / `tool-call` 合法地出现在 user 消息里）。别把 `throw` 加回来。
4. **能力解析只走 `capabilitiesOf(model, override)`**：优先级是
   **用户 `modelCaps` 声明 > 静态表 > 保守 unknown**。`reasoningFor` / `modelSupportsImage`
   都是它的薄封装。不要在别处再写一套「这个模型支持什么」的判断。
5. **声明必须与消费者一致**：`resolveModel` / `listModels` 声明什么，`stream()` 就按什么路由；
   `models/refresh` 与 `models/known` 共用 `classifyModel()`，避免卡上的展示与实际请求分叉。
   声明 `image: true` 时，`imagePart` 的准入判定也必须放行（runtime 会凭同一声明把图片放行），
   所以覆盖要顺着参数一路传下去，不能只改 `resolveModel`。
6. **配置校验 fail-fast**：`resolveOptions` 对非法值直接抛（含档位 id 与端面不匹配、messages
   端面给档位等）；`apply` 捕获后保留上一份好配置并记日志。新增字段时同步更新 `Config`
   schema、`resolveOptions`、测试与 README。
7. **schemastery 的坑**：`z.array(...)` 在字段**缺席时会 materialize 成 `[]`**。当「缺席」
   与「空数组」语义不同时（例如 `modelCaps[].efforts`：缺席=跟随内置表，`[]`=明确无档位），
   必须写 `.default(undefined)`，否则任何只填了别的字段的条目都会被解读成「无档位」。
8. **凭证只走 seam**：`credentials.resolve`（env → 托管 store → `.env`），settings 与组合文件里
   不得出现明文 key；`apiKeyEnv` 只是引用名。UI 侧只经 `remote.credentials`。
9. **UI 文案一律进字典**：`src/client/01-dicts.js` 的 `zh` 与 `en` 两份都要加。
   用了不存在的 key 不会崩，只会把 key 原样显示出来，所以别指望手测发现。
10. **路由名 `zen-go` 是刻意的**：`opencode-go` 是用户自建 pi-ai profile 的常用名，
   路由独占会顶掉别人；`apply()` 启动时也会检查并报 `DUPLICATE_ADAPTER`。别改。
11. **`Refs #N`，不要 `Fixes`/`Closes`**：issue 由维护者确认报告人验证通过后再关。
12. 三段式改动（`modelCaps` 这类）要同时顾及：schema、校验、`resolveModel`/`listModels`、
   路由、客户端 UI、i18n、测试、README、版本号。漏一段就会出现「卡上能填、请求不生效」
   这类半成品。

## 测试怎么写

- 单文件 `test/smoke.mjs`，用 `node:test` + `node:assert/strict`；跑法见上。
- 宿主侧用 `stubCtx({ credentials, providers })` 拿到被 `apply()` 注册的对象
  （`calls.adapter.adapter` / `calls.rpc.dispatch`），再直接调用 adapter 方法或 RPC 端点。
- 需要一个 key 的联网探针（`live /v1/models`）在无 key 时自动 skip —— **skip 不是失败**，
  当前基线是「N 项，N-1 pass + 1 skip」。
- 浏览器半用 `stub React`（`createElement` / 有状态的 `useState` / 仅挂载运行的 `useEffect`）
  驱动 `lib/client.js`：断言行渲染、展开/收起、以及改动落成的 `modelCaps` 载荷。
  注意 `h()` 把数组子节点嵌套一层，遍历要用 `.flat(Infinity)`；条件子节点是 `null`，要跳过。
- 写断言时**别持有上一轮渲染的元素对象**去触发事件：它的闭包捕获的是那一轮的状态
  （真实 DOM 节点不会这样，React 每轮更新 handler）。每次触发前重新查一遍。
- 新增行为就加断言，别为了过而放宽既有断言。

## 发版流程

这个包**不在 npm 上**（registry 404），发行渠道是 GitHub：用户用
`dsh plugin --profile web add github xia-sc/dsh-opencode-go` 安装/升级。

1. `package.json` 版本号跟随改动（预发布用 `-rc.N`，同一目标版本的后续 RC 递增 N）。
2. 提交信息：conventional 前缀 + 英文主题 + 括号里带版本，正文写「为什么」与踩过的坑，
   结尾一行 `Tests: N, X pass + 1 skip` 与 `Refs #N`。
3. annotated tag `v<版本>`，推送；`gh release create v<版本> --prerelease --latest=false`，
   标题形如 `v0.8.9-rc.2 — <中文一句话> (preview)`；notes 用**中英双语**（中文在前，`---`，
   英文），分节：新功能 / 修复 / 验证 / 已知未覆盖 / 升级。正式版去掉 `--prerelease`
   并写详细 notes（参考 `v0.8.8`）。

## 宿主 vs 客户端：生效时机不同

- **宿主侧**（`lib/*.js` 除 `client.js`）：`dsh web` **启动时加载**，改完必须重启进程才生效。
- **客户端半**：宿主**按请求从磁盘读取** bundle，并用内容哈希当版本号（`&rev=`），
  所以刷新页面即可拿到新代码，不需要重启。
- 排查「改了没生效」时先分清是哪一半；`models/known` 这类新端点在新进程起来前会返回
  `unknown-endpoint`，那是正常的，不代表代码写错了。

## 这个环境（Windows 沙箱）的坑

- `git push` / `git ls-remote` 走 HTTPS 时可能报
  `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS` —— 是沙箱不给凭据句柄，
  不是仓库或凭据坏了；`gh` 与 `npm` 用自己的 TLS 栈，不受影响。推送需要提权重试。
- `npm test`（`node --test`）会 spawn 子进程，在受限沙箱里 `EPERM`；用
  `node test/smoke.mjs` 在同一进程内跑。
- 本机 GUI 在 `http://127.0.0.1:3080`，**没有 token 直接访问会 401**，别拿 curl 当探针；
  需要浏览器时用 playwright/chrome-devtools MCP，截图默认落在 MCP 服务进程的工作目录
  （本机是 `C:\Users\sc`），不在仓库里。
- `~/.dsh/sessions/**/session*.jsonl.zstd` 是**多帧 zstd**（每次 append 一帧），
  Node 的 `zstdDecompressSync` 只解第一帧；要逐帧解（按魔数 `28 b5 2f fd` 切）。

## 已知文档债

- `cordis.patch.yml` 头部注释过时：写着「no browser half」和 `opencode-go`
  provider route，而实际既有浏览器半、路由也叫 `zen-go`。改这个文件时顺手修正注释。

## 相关背景

- 「一条内容块打死整个会话」的完整分析：issue
  [#3](https://github.com/xia-sc/dsh-opencode-go/issues/3)（修复见 `v0.8.9-rc.1` 的 release notes）。
- 「未知模型无法设置思考等级/多模态」：issue
  [#4](https://github.com/xia-sc/dsh-opencode-go/issues/4)，`modelCaps` 能力覆盖的设计与取舍见
  `v0.8.9-rc.2` 的 release notes。
