// 多模型统一入口的兼容外壳（docs/multi-provider-design.md §9 步骤①②）。
//
// 业务层（ChatView / extractor / summarizer）继续用 makeApi(settings).stream/complete，
// 不感知多模型细节；内部委托 providers/client：路由 → 熔断 → 重试 → 降级 → 指标。
//
// 兼容性说明：
//   - 老配置（单一 endpoint/apiKey/model）由 migrateSettings 自动包装，行为不变；
//   - onUsage 回调改为**归一化 Usage**（inputTokens/outputTokens/cacheRead/cacheWrite），
//     不再暴露厂商字段（prompt_tokens 等）——业务层禁止依赖厂商字段是本架构的铁律。
import { createChatClient } from './providers/client'
import { migrateSettings } from './providers/registry'

export function makeApi(settings) {
  const s = migrateSettings(settings || {})
  const client = createChatClient(s)

  /** 业务层调用形状 → StandardRequest（purpose 可由调用方指定，默认对话） */
  const toReq = (messages, opts, purpose) => ({
    purpose: opts.purpose || purpose,
    messages,
    params: {
      temperature: opts.temperature ?? s.temperature,
      maxOutputTokens: opts.maxTokens ?? s.maxTokens,
      jsonMode: !!opts.json,
    },
    signal: opts.signal,
    metadata: opts.metadata || {},
    // 对话用途的显式选择：settings 已是 effectiveSettings 的合并结果
    //（会话覆盖 > 全局），非对话用途的 override 由 router 按 routing 配置处理。
    override: { providerId: s.providerId, model: s.model },
  })

  return {
    /**
     * 流式对话：yield 增量文本；onUsage 收归一化用量；全部厂商失败时抛 ProviderError。
     * opts.onFinish(reason)：生成结束原因——'length' = 撞 maxTokens 被截断
     *（此前该信号被静默丢弃，截断的回复末尾消失却无提示，alpha.13 透传）。
     */
    async *stream(messages, opts = {}) {
      for await (const ev of client.stream(toReq(messages, opts, 'chat'))) {
        if (ev.type === 'delta') yield ev.text
        else if (ev.type === 'usage' && opts.onUsage) opts.onUsage(ev.usage)
        else if (ev.type === 'finish' && opts.onFinish) opts.onFinish(ev.reason)
      }
    },

    /** 非流式调用（状态提取 / 摘要用），返回文本 */
    async complete(messages, opts = {}) {
      const r = await client.complete(toReq(messages, opts, opts.purpose || 'chat'))
      return r.text
    },
  }
}
