/**
 * 多模型层 · 数据契约（JSDoc 类型定义）
 *
 * 这是业务层与适配器层之间的**唯一**数据形状。落地到强类型语言时，
 * 本文件即接口定义源；业务代码禁止出现任何厂商字段名（prompt_tokens / choices / …）。
 *
 * 分层与规则见 docs/multi-provider-design.md。
 */

/**
 * @typedef {'system'|'user'|'assistant'} Role
 */

/**
 * 归一化消息（当前只有文本；多模态时扩展 content 为分块数组）
 * @typedef {{ role: Role, content: string }} StandardMessage
 */

/**
 * 归一化生成参数（厂商私有参数一律不进这里，由适配器自行丢弃并记录）
 * @typedef {{
 *   temperature?: number,
 *   maxOutputTokens?: number,
 *   jsonMode?: boolean,        // 需要严格 JSON 输出（提取器用）
 *   stopSequences?: string[],
 * }} StandardParams
 */

/**
 * 一次生成请求。purpose 是路由键，不是厂商字段。
 * @typedef {{
 *   purpose: 'chat'|'extract'|'summary',   // 对话 / 状态提取 / 剧情摘要
 *   messages: StandardMessage[],
 *   params: StandardParams,
 *   signal?: AbortSignal,
 *   metadata?: { sessionId?: number|string, [k: string]: unknown },
 *   override?: { providerId?: string, model?: string },  // 用户显式选择（仅对话用途）
 * }} StandardRequest
 */

/**
 * 归一化用量。cacheRead/cacheWrite 覆盖各家缓存计费口径。
 * @typedef {{
 *   inputTokens: number, outputTokens: number,
 *   cacheRead: number, cacheWrite: number,
 *   totalTokens: number, estimated: boolean,
 * }} Usage
 */

/**
 * 流式事件：所有适配器的输出统一为这一种形状。
 * @typedef {{type:'delta', text:string}
 *   | {type:'usage', usage:Usage}
 *   | {type:'finish', reason:string}
 *   | {type:'error', error:import('./errors').ProviderError}
 * } StreamEvent
 */

/**
 * 厂商配置（注册表中的条目）。内置预设 + 用户覆盖（settings.providers[id]）同构。
 * @typedef {{
 *   id: string,                 // 稳定标识（路由 / 熔断 / 指标都用它）
 *   adapter: 'openai'|'anthropic',
 *   displayName: string,
 *   endpoint: string,
 *   apiKey: string,             // 浏览器端存 localStorage；绝写不进日志
 *   models: string[],
 *   defaultModel: string,
 *   context: number,            // 上下文窗口（token），编译器裁剪历史用
 *   noKey: boolean,             // 本地服务（Ollama 等）无需 Key
 *   browserSafe: boolean,       // 是否支持浏览器直连（CORS）
 *   pricing: null | { currency:'CNY'|'USD', inputPerMTok:number, outputPerMTok:number,
 *                     cacheReadPerMTok:number, cacheWritePerMTok:number },
 * }} ProviderConfig
 */

/**
 * 路由结果：一次请求要尝试的目标链（按顺序降级）。
 * @typedef {{ provider: ProviderConfig, model: string }} RouteTarget
 */

/**
 * 一次模型调用的监控记录（metrics 表）。
 * @typedef {{
 *   ts: number, purpose: string, provider: string, model: string,
 *   ok: boolean, errorCode?: string,
 *   isFallback: boolean, attempts: number,
 *   ttftMs?: number|null, totalMs: number,
 *   usage?: Usage|null, cost?: {amount:number, currency:string}|null,
 *   sessionId?: number|string|null,
 * }} ModelCallRecord
 */

export {}
