# 多模型 API 扩展方案（设计稿）

> 定位：让 rp-engine 从「只认 DeepSeek」升级为「可插拔多模型」。
> 本方案**不绑定技术栈**：所有接口用类型化的伪代码描述（可映射到 TS / Python / Go / Rust / Java），
> 核心是**数据契约 + 分层边界**，具体落地时只替换传输层实现。

---

## 0. 目标与非目标

**目标**

| 编号 | 目标 | 验收标准 |
|---|---|---|
| G1 | 统一抽象层：业务只见 `ChatClient`，不见厂商 | 核心业务逻辑中**不出现**任何厂商字段名 |
| G2 | 配置驱动：端点/密钥/参数/价格全在配置文件 | 新增一家 OpenAI 兼容厂商 = 改配置，**零代码** |
| G3 | 适配器隔离格式差异 | 每个厂商差异收敛在独立文件，单测可覆盖 |
| G4 | 故障隔离与降级 | 单厂商 5xx / 限流 / 超时不影响整体可用 |
| G5 | 可观测与对比 | 能按厂商对比延迟、错误率、缓存命中率、成本 |

**非目标**

- 不做模型训练 / 微调 / 本地推理（属于另外的能力域）。
- 不做语义路由（按内容自动挑模型）—— 一期只做**声明式 purpose 路由**。
- 不改现有状态提取 / 上下文编译的业务逻辑（本方案的硬约束）。

---

## 1. 现状与痛点（rp-engine）

```1:6:src/lib/api.js
// DeepSeek (OpenAI 兼容) API 客户端：浏览器直连，已验证支持 CORS
export function makeApi(settings) {
  const base = (settings.endpoint || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${settings.apiKey}`,
  }
```

具体耦合点：

1. **厂商字段外泄**：`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 是 DeepSeek 私有 usage 字段，直接被 `ChatView` 消费。
2. **单一全局配置**：`DEFAULT_SETTINGS` 只有一组 `endpoint / apiKey / model`，无厂商概念。
3. **参数硬编码**：`temperature / max_tokens / stream_options` 拼在请求体里，换厂商需改代码。
4. **无降级**：`fetch` 失败即抛错，只能靠用户手动换配置。
5. **无观测**：只有会话级累计计数，无法对比"哪家快/便宜/稳"。

---

## 2. 总体架构

```
┌─────────────── 业务层（不感知厂商）───────────────┐
│ ChatView / extractor / summarizer                  │
│      只依赖：ChatClient.chat(req) + capabilities   │
└───────────────────────┬───────────────────────────┘
                        │ StandardRequest / AsyncIterable<StreamEvent>
┌───────────────────────▼───────────────────────────┐
│ 统一 API 抽象层（ChatClient）                      │
│  · 参数归一化  · 能力协商  · 事件归一  · 错误归一   │
└───┬──────────────┬───────────────┬────────────────┘
    │              │               │
┌───▼──────┐ ┌─────▼──────┐ ┌──────▼───────────────┐
│ Router   │ │ Resilience │ │ Telemetry            │
│ 选厂商   │ │ 重试/熔断  │ │ metrics + 结构化日志 │
│ purpose  │ │ 降级链     │ │ 成本/延迟/命中率     │
└───┬──────┘ └─────┬──────┘ └──────────────────────┘
    │              │
┌───▼──────────────▼────────────────────────────────┐
│ ProviderAdapter 注册表（配置驱动）                  │
│  openai-compatible(基线)  anthropic  gemini  …     │
└───────────────────────────────────────────────────┘
```

**三条铁律**

1. 业务层**禁止**引用任何厂商特定字段；需要厂商信息时，读 `capabilities`。
2. 适配器是**纯函数优先**：`build(req) → 厂商请求`、`parse(chunk) → 事件`，便于单测与 fixture 回放。
3. 一切跨厂商差异，要么进**配置**，要么进**适配器**，绝不进业务层。

---

## 3. 统一 API 抽象层（数据契约）

### 3.1 标准消息与请求

```ts
type Role = 'system' | 'user' | 'assistant' | 'tool'

interface ContentPart {            // 多模态扩展位，一期可只用 text
  type: 'text' | 'image' | 'tool_result'
  text?: string
  source?: unknown
}

interface StandardMessage {
  role: Role
  content: string | ContentPart[]
  name?: string                    // 多角色群聊（P3）预留
  toolCalls?: ToolCall[]
  toolCallId?: string
}

/** 归一化参数：业务层只写这些字段 */
interface StandardParams {
  temperature?: number             // 0..2
  topP?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  jsonMode?: boolean               // 需要严格 JSON 输出
  presencePenalty?: number
  frequencyPenalty?: number
  seed?: number
}

interface StandardRequest {
  purpose: 'chat' | 'extract' | 'summary' | 'title'   // 路由键，非厂商字段
  messages: StandardMessage[]
  params: StandardParams
  signal?: AbortSignal
  requestId?: string                // 幂等 / 追踪
  /** 缓存提示：前缀到此为止是"稳定区"，适配器按能力决定是否打缓存标记 */
  cacheHint?: { stablePrefixEndIndex: number }
  /** 能力硬要求：不满足的直接被 Router 过滤掉，而不是请求后失败 */
  require?: { minContextTokens?: number; jsonMode?: boolean; streaming?: boolean }
  metadata?: Record<string, string>  // sessionId / turn 等，只用于日志
}
```

### 3.2 标准响应：事件流（流式与非流式统一）

```ts
type StreamEvent =
  | { type: 'start';       provider: string; model: string; requestId: string }
  | { type: 'delta';       text: string }
  | { type: 'tool_call';   call: ToolCall }
  | { type: 'usage';       usage: Usage }
  | { type: 'finish';      reason: 'stop' | 'length' | 'content_filter' | 'tool_calls' }
  | { type: 'error';       error: ProviderError }

interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number          // 缓存命中（DeepSeek hit / Anthropic cache_read）
  cacheWriteTokens: number         // 缓存写入（DeepSeek miss / Anthropic cache_creation）
  totalTokens: number
  estimated: boolean               // true = 启发式估算，非厂商真实计数
  cost?: MoneyEstimate             // 由 pricing 表算出，永远标记 estimated
}

interface ChatResult {             // 非流式的收敛结果
  text: string
  usage?: Usage
  finishReason?: string
  provider: string                 // 实际服务的厂商（降级后 ≠ 首选）
  attempts: AttemptRecord[]        // 每次尝试的厂商/错误/耗时
}
```

**业务层调用面（唯一入口）**

```ts
interface ChatClient {
  /** 流式；永远产出归一化事件，失败通过 error 事件或抛 ProviderError */
  stream(req: StandardRequest): AsyncIterable<StreamEvent>
  /** 非流式（状态提取 / 摘要用） */
  complete(req: StandardRequest): Promise<ChatResult>
  /** 能力查询，供 UI 与编译器决策 */
  capabilities(providerId?: string): Capabilities
}
```

非流式也能以 `for await (const e of client.stream(req))` 实现：`complete = 收集 delta + 收尾 usage`。
对于**不提供流式**的厂商，适配器可用"假流式"（一次性产出单 delta），业务层无需分支。

### 3.3 能力声明（Capabilities）

```ts
interface Capabilities {
  maxContextTokens: number
  maxOutputTokens: number
  streaming: boolean
  jsonMode: 'native' | 'prompt-only' | 'none'
  /** 前缀缓存机制 —— 决定适配器要不要打缓存标记 */
  prefixCache: 'auto' | 'manual-breakpoint' | 'explicit-object' | 'none'
  minPrefixTokens?: number          // 低于此长度不值得打缓存标记
  tokenizer: 'api' | 'heuristic'
  tools: boolean
  vision: boolean
  rateLimits?: { rpm?: number; tpm?: number; concurrency?: number }
  browserSafe: boolean              // 是否支持浏览器直连（CORS）。false → 必须走代理
}
```

编译器据此做两件事（**这是唯一允许的"业务层读厂商信息"通道**）：

- `maxContextTokens` → 决定历史裁剪窗口（替代现在的硬编码 `maxHistory` 语义）；
- `prefixCache` → 决定是否维持"静态前缀在前"的顺序（保住缓存命中率）。

---

## 4. 配置驱动机制

### 4.1 配置文件（示例，YAML/JSON 均可）

```yaml
version: 1
defaults:
  purpose:
    chat:    { provider: deepseek,   model: deepseek-chat }
    extract: { provider: deepseek,   model: deepseek-chat }   # 可换成便宜模型
    summary: { provider: deepseek,   model: deepseek-chat }

providers:
  deepseek:
    adapter: openai-compatible          # 复用基线适配器，零代码
    displayName: DeepSeek
    endpoint: https://api.deepseek.com/v1
    auth: { type: bearer, source: { kind: env, ref: DEEPSEEK_API_KEY } }
    models:
      deepseek-chat: { context: 65536, maxOutput: 8192 }
    params: { temperature: 1.1, maxOutputTokens: 1024 }
    capabilities: { streaming: true, jsonMode: native, prefixCache: auto, browserSafe: true }
    pricing:
      currency: CNY
      inputPerMTok: 2.0
      outputPerMTok: 8.0
      cacheReadPerMTok: 0.5
      cacheWritePerMTok: 2.0
    resilience: { timeoutMs: 60000, maxRetries: 2, breaker: { threshold: 5, cooldownMs: 60000 } }

  qwen:
    adapter: openai-compatible
    displayName: 通义千问（兼容模式）
    endpoint: https://dashscope.aliyuncs.com/compatible-mode/v1
    auth: { type: bearer, source: { kind: keyring, ref: qwen } }
    models: { qwen-plus: { context: 131072, maxOutput: 8192 } }
    capabilities: { streaming: true, jsonMode: native, prefixCache: none, browserSafe: false }
    resilience: { timeoutMs: 60000, maxRetries: 2 }
    notes: 浏览器直连受限，需配 proxyUrl

  claude:
    adapter: anthropic                # 独立适配器：协议不同
    endpoint: https://api.anthropic.com/v1
    auth: { type: header, name: x-api-key, source: { kind: env, ref: ANTHROPIC_API_KEY } }
    models: { claude-sonnet-4-5: { context: 200000, maxOutput: 8192 } }
    capabilities: { streaming: true, jsonMode: prompt-only, prefixCache: manual-breakpoint, browserSafe: false }

fallbacks:
  chat:    [deepseek, qwen, claude]
  extract: [deepseek, qwen]
  summary: [deepseek, qwen]

policies:
  onUnsupportedParam: drop           # drop | clamp | fail
  onContextOverflow: summarize-and-retry
  onStreamError: retry-nonstream     # 流式失败可改用非流式重试
  maxFallbackDepth: 2
  costGuard: { dailyBudget: null }   # 可设上限，超限降级到更便宜的链

telemetry:
  logLevel: info                     # debug 才记 payload
  redact: [authorization, api-key, x-api-key]
  store: { kind: indexeddb, table: metrics, retentionDays: 30 }
```

### 4.2 关键约束

- **密钥永不进配置文件正文**：只写引用（`env` / `keyring` / 用户输入的引用 id）。
  前端场景实际存 localStorage 时，仍走 `source.ref` 间接寻址，日志按 `redact` 脱敏。
- **Schema 校验 + fail fast**：加载即校验；不合法的配置**拒绝启动/拒绝该厂商**，而不是调用时才炸。
- **配置版本化**：`version` 字段 + `migrate()`，与 rp-engine 的 `db.version` 同理（新增表要升版本）。
- **能力协商**：请求参数超出能力时按 `onUnsupportedParam` 处理，并把被丢弃/裁剪的字段写进日志
  （例如某厂商不支持 `presencePenalty` → drop 并记 `dropped: ["presencePenalty"]`）。
- **热加载**：配置变更只需重建 `ChatClient`，业务层无感；UI 上表现为「设置页改完立即生效」。

---

## 5. 适配器模式

### 5.1 适配器接口（六个方法）

```ts
interface ProviderAdapter {
  id: string
  /** 标准请求 → 厂商请求（URL / headers / body / timeout） */
  buildRequest(req: StandardRequest, ctx: AdapterContext): HttpRequestLike
  /** 逐块解析流式响应 → 0..n 个标准事件（纯函数，可单测） */
  parseChunk(chunk: string, state: ParseState): { events: StreamEvent[]; state: ParseState }
  /** 非流式响应 → 文本 + usage */
  parseResponse(body: unknown): { text: string; usage?: Usage; finishReason?: string }
  /** HTTP 错误 / 厂商错误码 → 归一化错误 */
  mapError(err: HttpErrorLike): ProviderError
  /** token 估算（有 API 计数就用，没有就启发式并标 estimated） */
  estimateTokens(msgs: StandardMessage[]): number
  /** 可选：拉取模型列表，供 UI 下拉 */
  listModels?(ctx: AdapterContext): Promise<ModelInfo[]>
}
```

`AdapterContext` 只注入配置片段（endpoint / auth / params / capabilities / pricing），
**不注入任何业务对象** —— 保证适配器可独立测试。

### 5.2 基线适配器 + 差异覆盖

多数厂商号称 OpenAI 兼容，实际差异在小处。因此内置 **`openai-compatible` 基线**，
新厂商只写配置即可；差异通过配置项覆盖：

| 差异点 | 覆盖方式（配置） |
|---|---|
| 认证头 | `auth.type: bearer \| header \| query` |
| 路径后缀 | `paths.chatCompletions: /chat/completions` |
| usage 字段不在末帧 | `usage.mode: final-chunk \| separate-chunk \| header` |
| `[DONE]` 终止符不同 | `stream.doneToken` |
| usage 字段名不同 | `usage.fieldMap: { inputTokens: prompt_tokens, cacheReadTokens: prompt_cache_hit_tokens }` |
| 不支持 `stream_options` | `stream.includeUsage: false` |

只有**协议级不同**（SSE 变体、非 JSON 行协议、显式缓存对象、工具调用结构不同）才写独立适配器。

### 5.3 已识别的跨厂商差异清单

| 维度 | OpenAI 系 | Anthropic | Gemini | 归一化做法 |
|---|---|---|---|---|
| 认证 | `Authorization: Bearer` | `x-api-key` + `anthropic-version` | `x-goog-api-key` | `auth` 配置 |
| 系统提示 | `messages[role=system]` | 顶层 `system` 字段 | `systemInstruction` | 适配器搬运 |
| 流式 | SSE `data:` + `[DONE]` | SSE `event:` + `content_block_delta` | chunked JSON 数组 | `parseChunk` |
| usage | 末帧 / `stream_options` | `message_start` + `message_delta` | 末块 | 统一 `usage` 事件 |
| 前缀缓存 | 自动 | 显式 `cache_control`（≤4 断点） | 显式 cached content | `prefixCache` 能力 |
| JSON 模式 | `response_format` | 无（prefill + 校验） | `responseMimeType` | `jsonMode` 能力 |
| 停止 | `stop` | `stop_sequences` | `stopSequences` | 参数映射表 |

### 5.4 适配器测试（不依赖网络）

- **Golden fixture**：每个适配器提供 `fixtures/{request,stream,response,error}.json`；
- **契约测试套件**（所有适配器共用）：流式拼接 == 非流式文本、usage 字段齐备、错误码映射正确、
  中断（`signal.abort`）能收敛、空 delta 不产生 `delta` 事件；
- **可选 live canary**：标记 `skipLive` 的用例在没密钥时自动跳过，CI 不要求。

---

## 6. 错误处理与降级策略

### 6.1 错误归一（唯一错误类型）

```ts
interface ProviderError {
  code: 'AUTH' | 'RATE_LIMIT' | 'INVALID_REQUEST' | 'CONTEXT_OVERFLOW'
      | 'SERVER' | 'NETWORK' | 'TIMEOUT' | 'UNSUPPORTED' | 'ABORTED' | 'PARSE'
  retryable: boolean
  httpStatus?: number
  provider: string
  message: string                  // 面向用户的中文提示
  raw?: unknown                    // 仅 debug 日志携带
  retryAfterMs?: number            // 来自 Retry-After
}
```

`ABORTED` **不参与重试**（用户主动停止，语义上不是故障）—— 与 rp-engine 批次3 的 `partial` 行为对齐。

### 6.2 三层防护

```
请求 → ① 超时/重试（单厂商） → ② 熔断（单厂商） → ③ 降级链（跨厂商） → 业务错误
```

1. **重试**：仅对 `retryable`（429 / 5xx / 网络 / 超时）指数退避 + jitter，尊重 `retryAfterMs`；
   最多 `maxRetries`（默认 2），且**同一请求总时长有上限**。
2. **熔断**：per-provider 滑动窗口，连续失败达 `threshold` → 开路 `cooldownMs` → 半开试探；
   开路期间该厂商**直接跳过**，不再白白等超时。
3. **降级链**：`fallbacks[purpose]` 按序尝试；触发条件 = `retryable` 且未耗尽 / 熔断开路 / 能力不满足 / 上下文溢出。
   `provider` 字段回传**实际服务者**，UI 可提示"已切换到备用模型"。

### 6.3 降级时的正确性（易踩坑）

- **上下文窗口不同**：降级到更小窗口的厂商时，必须按目标 `maxContextTokens` **重新编译上下文**
  （裁剪/摘要），不能复用原请求 —— 由 `Router` 在切换后触发 `compiler` 重算。
- **参数重新协商**：切厂商后重新走能力协商，参数可能被 drop/clamp。
- **缓存前缀重建**：新厂商没有旧缓存，命中率会掉一回合，属预期，日志打点记录。
- **流式中断**：已产出的文本按 `partial` 语义保留（业务层决定要不要入库），
  可选 `onStreamError: retry-nonstream` 改非流式重试拿完整结果。
- **全部失败**：抛出携带 `attempts[]` 的聚合错误，UI 展示"deepseek: 429 → qwen: 超时"链条，附「前往设置」。
- **成本控制**：`costGuard` 超预算时只允许走便宜链，或直接拒绝并提示。

---

## 7. 性能监控与日志

### 7.1 每次调用一条记录

```ts
interface ModelCallRecord {
  requestId: string
  ts: number
  purpose: 'chat' | 'extract' | 'summary' | 'title'
  provider: string
  model: string
  isFallback: boolean              // 是否降级后的厂商
  attempts: { provider: string; errorCode?: string; ms: number }[]
  ttftMs?: number                  // 首字延迟（流式才有）
  totalMs: number
  usage: Usage
  droppedParams?: string[]         // 被能力协商丢弃的参数
  sessionId?: string               // 业务关联，便于"这个故事花了多少"
  ok: boolean
}
```

### 7.2 聚合指标（对比视图）

| 指标 | 定义 | 用途 |
|---|---|---|
| TTFT p50/p95 | 首字延迟分位 | 体感快慢 |
| 总时长 p50/p95 | 完整响应耗时 | 稳定性 |
| 错误率 / 重试率 | 按 `code` 分组 | 可靠性 |
| 降级率 | `isFallback` 占比 | 主链路健康度 |
| 缓存命中率 | `cacheRead / (cacheRead + cacheWrite + input)` | 成本大头 |
| 单位成本 | `cost / 1k output tokens`，按 purpose 分 | 选型 |
| 每故事成本 | 按 `sessionId` 聚合 | 用户感知 |

rp-engine 落地：写入 IndexedDB `metrics` 表（**新增表需升 `db.version`**），
设置页新增「模型表现」卡片：按厂商 × purpose 的对比表格 + 时间范围筛选 + 导出 CSV。

### 7.3 日志规范

- 结构化（JSON）单行日志，`level` 分级；`debug` 才记 payload，且先过 `redact` 白名单脱敏；
- **密钥永不落日志**：`redact` 默认含 `authorization / api-key / x-api-key`，并对疑似 key 串做正则兜底；
- 同一 `requestId` 串联重试与降级，便于还原"一次用户操作"的完整链路；
- 采样：高频 `chat` 可全量记指标、**采样记正文**，控制存储。

---

## 8. 新增一个模型：不改动核心业务的 SOP

### 路径 A：OpenAI 兼容（零代码，最常见）

1. 在 `providers.yaml` 增加一段配置（adapter 填 `openai-compatible`）；
2. 填 `endpoint` / `auth` / `models` / `capabilities` / `pricing`；
3. （可选）把它加进 `fallbacks[*]` 或 `defaults.purpose[*]`；
4. 重启 / 热加载 → UI 下拉里出现该模型。
   **业务代码零改动**，自动获得：流式、重试、熔断、降级、指标、成本估算。

### 路径 B：协议不同（写适配器）

1. 新建 `adapters/<vendor>.{ts,py,go}`，实现 `ProviderAdapter` 六个方法；
2. 复制契约测试模板，补 4 个 fixture（request / stream / response / error）；
3. 配置里 `adapter: <vendor>` 注册；
4. 跑**契约测试套件**全绿 + 一次真实调用冒烟。
   **业务代码仍然零改动**——因为业务只依赖 `ChatClient` 与 `capabilities`。

### 不改动业务层的保证机制

- **静态检查**：CI 加一条扫描规则——业务目录禁止出现厂商字段名
  （如 `prompt_tokens` / `choices` / `cache_control` / `content_block`），出现即 fail。
- **类型边界**：业务层只能拿到 `StandardRequest` / `StreamEvent` / `Capabilities`，
  厂商原始响应类型在适配器模块内不导出。
- **契约测试**：所有适配器跑同一套用例，防止"某家少给了一个事件"这类隐性差异泄漏到上层。

---

## 9. rp-engine 落地路径（增量迁移，四步）

| 步骤 | 改动 | 风险 |
|---|---|---|
| ① 抽接口 | `src/lib/api.js` 内部拆成 `ProviderAdapter`（DeepSeek 为第一个实现）+ `ChatClient`，**对外 API 保持不变** | 低：行为等价，现有 82 条测试应全绿 |
| ② 配置化 | `settings` 增加 `providers[]` / `routing`；老配置（单一 endpoint/apiKey/model）经 `migrateSettings()` 包成一个 default provider | 低：纯兼容包装 |
| ③ 业务去耦合 | `ChatView` / `extractor` / `summarizer` 改用 `StandardRequest`；`compiler` 从 `capabilities.maxContextTokens` 取窗口，替代硬编码 `maxHistory` 的隐式假设 | 中：需回归上下文长度相关行为 |
| ④ 观测与降级 | 新增 `metrics` 表（**升 `db.version`**）+ 降级链 + 设置页「模型表现」 | 中：需同步 README 的迁移规则与 SW 缓存版本 |

**关键注意（沿用项目既有约定）**

- 新增 `metrics` 表必须升 `db.version`，且与新 bundle 同批发布；
- `metrics` **不应**进入 `CLEAR_TABLES`（否则导入一次历史表现全没了）——是否清空按产品决定，但要在 README 写明；
- 浏览器直连厂商须 `browserSafe: true`（CORS）；否则需配置 `proxyUrl`，并在 UI 明示「该厂商需自建代理，密钥不会经过本项目服务器」；
- 状态提取对 JSON 严格性要求高，建议 `purpose: extract` 固定配 `jsonMode: native` 的厂商，
  不支持的厂商降级时走 `prompt-only` + 校验重试（失败则任务留 `pending`，由全局补跑兜底）。

---

## 10. 风险与边界

| 风险 | 说明 | 缓解 |
|---|---|---|
| token 计数不一致 | 各厂商口径不同，部分只有估算 | `usage.estimated` 显式标记，UI 区分"实测/估算" |
| 前缀缓存语义不同 | 自动 vs 显式断点 vs 显式对象 | `prefixCache` 能力 + `cacheHint`；编译器保证前缀稳定 |
| 价格表过期 | 估算成本可能与账单不符 | pricing 可配置 + 标注「估算，仅供参考」 |
| 浏览器直连受限 | 多数厂商不允许 CORS / 暴露密钥风险 | `browserSafe` 标记 + 代理模式 + UI 风险提示 |
| 流式解析脆弱 | SSE 注释行、分块 JSON、gzip、粘包 | `parseChunk` 有状态机 + fixture 覆盖异常分片 |
| 上下文溢出 | 长对话超窗 | `onContextOverflow: summarize-and-retry`，复用已有摘要能力 |
| 降级导致风格漂移 | 换模型后文风突变 | 降级仅兜底，UI 明确提示；`purpose: chat` 的降级链尽量选同档模型 |

---

## 11. 验收清单（Definition of Done）

- [ ] 业务目录无任何厂商字段名（CI 扫描通过）
- [ ] 仅改配置即可接入一家新的 OpenAI 兼容厂商（有端到端验证）
- [ ] 契约测试套件 ≥ 2 个适配器通过（含 openai-compatible 基线）
- [ ] 主厂商 429 / 5xx / 超时三类故障，能自动降级到备用厂商并回传实际 provider
- [ ] 每次调用产出 `ModelCallRecord`，设置页可按厂商 × purpose 对比 TTFT / 错误率 / 缓存命中率 / 成本
- [ ] 日志中检索不到任何密钥（有自动化断言）
- [ ] 老配置（单 endpoint/apiKey/model）升级后行为不变
