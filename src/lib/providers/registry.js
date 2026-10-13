/**
 * 模型注册机制（docs/multi-provider-design.md §4 / §8）：
 *   内置预设（BUILTIN_PROVIDERS）+ 用户覆盖表（settings.providers[id]）合并成完整注册表。
 *   - 新增一家 OpenAI 兼容厂商：通常只需在下面加一条预设，或在「设置」页添加自定义厂商 → 零业务代码。
 *   - 用户改过的厂商存**完整对象**（以内置为底展开），合并时直接覆盖，形状恒定。
 *   - 老配置（单一 endpoint/apiKey/model）由 migrateSettings() 自动包装成覆盖表，行为不变。
 */

/** 自定义厂商模板（用户在设置页「添加自定义」时以此为底） */
export const CUSTOM_TEMPLATE = {
  id: 'custom',
  adapter: 'openai',
  displayName: '自定义（OpenAI 兼容）',
  endpoint: 'https://api.deepseek.com/v1',
  apiKey: '',
  models: [],
  defaultModel: '',
  context: 32768,
  noKey: false,
  browserSafe: true,
  pricing: null,
}

/**
 * 内置预设。pricing 是估算口径（per 1M tokens），可能过期——UI 展示必须带「估算」标注。
 * browserSafe=false 表示该服务不支持浏览器直连（CORS），UI 需提示走自建代理。
 */
export const BUILTIN_PROVIDERS = [
  {
    id: 'deepseek',
    adapter: 'openai',
    displayName: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    apiKey: '',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    context: 65536,
    noKey: false,
    browserSafe: true,
    pricing: { currency: 'CNY', inputPerMTok: 2, outputPerMTok: 8, cacheReadPerMTok: 0.5, cacheWritePerMTok: 2 },
  },
  {
    id: 'openai',
    adapter: 'openai',
    displayName: 'OpenAI',
    endpoint: 'https://api.openai.com/v1',
    apiKey: '',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    defaultModel: 'gpt-4o-mini',
    context: 128000,
    noKey: false,
    browserSafe: true,
    pricing: { currency: 'USD', inputPerMTok: 150, outputPerMTok: 600, cacheReadPerMTok: 75, cacheWritePerMTok: 187.5 },
  },
  {
    id: 'moonshot',
    adapter: 'openai',
    displayName: '月之暗面 Kimi',
    endpoint: 'https://api.moonshot.cn/v1',
    apiKey: '',
    models: ['kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    defaultModel: 'kimi-latest',
    context: 128000,
    noKey: false,
    browserSafe: true,
    pricing: { currency: 'CNY', inputPerMTok: 12, outputPerMTok: 12, cacheReadPerMTok: 6, cacheWritePerMTok: 12 },
  },
  {
    id: 'qwen',
    adapter: 'openai',
    displayName: '通义千问（DashScope 兼容模式）',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    defaultModel: 'qwen-plus',
    context: 131072,
    noKey: false,
    browserSafe: false, // 浏览器直连受限，需自建代理
    pricing: { currency: 'CNY', inputPerMTok: 0.8, outputPerMTok: 2, cacheReadPerMTok: 0.2, cacheWritePerMTok: 0.8 },
  },
  {
    id: 'anthropic',
    adapter: 'anthropic',
    displayName: 'Anthropic Claude',
    endpoint: 'https://api.anthropic.com/v1',
    apiKey: '',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
    defaultModel: 'claude-sonnet-4-5',
    context: 200000,
    noKey: false,
    browserSafe: true, // 官方支持浏览器直连（适配器带 anthropic-dangerous-direct-browser-access 头）
    pricing: { currency: 'USD', inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75 },
  },
  {
    id: 'openrouter',
    adapter: 'openai',
    displayName: 'OpenRouter（聚合多家）',
    endpoint: 'https://openrouter.ai/api/v1',
    apiKey: '',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'],
    defaultModel: 'openai/gpt-4o-mini',
    context: 128000,
    noKey: false,
    browserSafe: true,
    pricing: null, // 各家模型价格不同，无法统一估算
  },
  {
    id: 'ollama',
    adapter: 'openai',
    displayName: 'Ollama（本机）',
    endpoint: 'http://localhost:11434/v1',
    apiKey: '',
    models: ['llama3.1', 'qwen2.5:7b'],
    defaultModel: 'llama3.1',
    context: 32768,
    noKey: true, // 本地服务无需 Key
    browserSafe: true,
    pricing: null, // 本地推理无 API 成本
  },
  {
    id: 'lmstudio',
    adapter: 'openai',
    displayName: 'LM Studio（本机）',
    endpoint: 'http://localhost:1234/v1',
    apiKey: '',
    models: [],
    defaultModel: '',
    context: 32768,
    noKey: true,
    browserSafe: true,
    pricing: null,
  },
]

/** 合并内置预设与用户覆盖 → 完整注册表（内置在前，自定义在后）。
 *  覆盖条目带 _userEdited 标记：本地服务（noKey）只有被用户编辑保存过才算"就绪"，
 *  否则内置的 Ollama / LM Studio 会让零配置的新用户误判为"已有可用模型"。 */
export function allProviders(settings) {
  const overrides = settings?.providers || {}
  const builtin = BUILTIN_PROVIDERS.map((b) => (
    overrides[b.id] ? { ...b, ...overrides[b.id], _userEdited: true } : { ...b }
  ))
  const customIds = Object.keys(overrides).filter((id) => !BUILTIN_PROVIDERS.some((b) => b.id === id))
  const custom = customIds.map((id) => ({ ...CUSTOM_TEMPLATE, ...overrides[id], _userEdited: true }))
  return [...builtin, ...custom]
}

/** 按 id 取厂商配置；不存在返回 null */
export function getProvider(settings, id) {
  if (!id) return null
  return allProviders(settings).find((p) => p.id === id) || null
}

/** 厂商是否就绪：云端需已填 Key；本地服务（noKey）需被用户编辑启用过（_userEdited） */
export function providerReady(p) {
  return !!p && (p.noKey ? !!p._userEdited : !!p.apiKey)
}

/** 是否存在至少一家就绪厂商（发送前的最低门槛） */
export function hasAnyProviderReady(settings) {
  return allProviders(settings).some(providerReady)
}

/**
 * 老配置迁移：把单端点时代（v0.2 及之前）的 endpoint/apiKey/model 包装成 providers 覆盖表。
 * 幂等：已是新结构则原样返回。端点能对上内置预设 → 归到该预设；否则建自定义厂商。
 */
export function migrateSettings(s) {
  if (!s || s.providers) return s
  // endpoint 缺省 = 旧版默认端点（DeepSeek）。必须回落，否则空 endpoint 匹配不到
  // 任何内置预设，会生成一个没有模型名的空 custom 厂商 → 永远"没有可用厂商"。
  const endpoint = (s.endpoint || BUILTIN_PROVIDERS[0].endpoint).replace(/\/+$/, '')
  const base = BUILTIN_PROVIDERS.find((b) => b.endpoint.replace(/\/+$/, '') === endpoint)
  const id = base ? base.id : 'custom'
  const template = base || CUSTOM_TEMPLATE
  const models = s.model ? [...new Set([...(template.models || []), s.model])] : [...(template.models || [])]
  return {
    ...s,
    providerId: id,
    providers: {
      [id]: {
        ...template,
        endpoint: s.endpoint || template.endpoint,
        apiKey: s.apiKey || '',
        models,
        defaultModel: s.model || template.defaultModel || (models[0] ?? ''),
      },
    },
  }
}
