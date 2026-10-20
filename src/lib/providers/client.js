/**
 * ChatClient —— 多模型统一入口（docs/multi-provider-design.md §3）。
 *
 * 组装：路由（选目标链）→ 熔断过滤 → 单厂商重试 → 跨厂商降级 → 指标落库。
 * 业务层只见 StandardRequest 进、归一化事件流出；任何厂商字段都被挡在适配器内。
 *
 * 降级的正确性约束（设计文档 §6.3）：
 *   - ABORTED 永不重试 / 不降级（用户主动停止）；
 *   - 流式一旦 yield 过内容就不再换厂商重试（否则输出会重复），错误直接上抛，
 *     已产出部分由上层按 partial 语义保留；
 *   - 每家厂商先耗尽自己的重试预算，才轮到下一家；
 *   - 全链失败时抛出的错误带完整 attempts 链（deepseek:RATE_LIMIT → qwen:SERVER）。
 */
import { getProvider } from './registry'
import { routeChain, explicitUnavailable } from './router'
import { withRetry, breakerIsOpen, breakerRecord, defaultSleep } from './resilience'
import { openaiAdapter } from './adapters/openaiCompat'
import { anthropicAdapter } from './adapters/anthropic'
import { recordCall } from './metrics'
import { ProviderError, fromFetchError } from './errors'

const ADAPTERS = { openai: openaiAdapter, anthropic: anthropicAdapter }

/** 估算成本（per 1M token 价格表）。无价格表的厂商返回 null，UI 显示「—」。 */
function estimateCost(usage, pricing) {
  if (!usage || !pricing) return null
  const c =
    (usage.inputTokens * (pricing.inputPerMTok || 0)
      + usage.outputTokens * (pricing.outputPerMTok || 0)
      + usage.cacheRead * (pricing.cacheReadPerMTok || 0)
      + usage.cacheWrite * (pricing.cacheWritePerMTok || 0)) / 1e6
  return { amount: Math.round(c * 10000) / 10000, currency: pricing.currency || 'CNY' }
}

/** 路由 + 显式选择校验。显式选择的厂商没配 Key → 直接报错引导配置，不静默换别家。 */
function planTargets(settings, req) {
  const unavailable = explicitUnavailable(settings, req.override)
  if (unavailable) {
    throw new ProviderError('AUTH', `你选择的「${unavailable.displayName}」尚未配置 API Key。请到「设置」页完成配置，或换一家模型。`)
  }
  const targets = routeChain(settings, req.purpose, req.override || {})
  if (!targets.length) {
    throw new ProviderError('UNSUPPORTED', '没有可用的模型厂商：请到「设置」页配置 API Key（或添加本机模型服务）。')
  }
  return targets
}

/**
 * 单厂商流式尝试（含内部重试）。
 * yield 过内容后不再重试——半截输出无法与重试结果拼接。
 */
async function* attemptStream(target, req, sleep) {
  const adapter = ADAPTERS[target.provider.adapter] || openaiAdapter
  let yielded = false
  for (let attempt = 0; ; attempt++) {
    try {
      const http = adapter.buildStreamRequest(target, req)
      const res = await fetch(http.url, http.init)
      if (!res.ok) throw adapter.mapError(res.status, await res.text(), target.provider.id)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      const state = adapter.createState()
      let ttftMs = null
      const t0 = Date.now()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const ev of adapter.parseChunk(state, dec.decode(value, { stream: true }))) {
          if (ev.type === 'delta') {
            if (ttftMs === null) ttftMs = Date.now() - t0
            yielded = true
            ev.ttftMs = ttftMs
            yield ev
          } else if (ev.type === 'error') {
            throw ev.error
          }
        }
      }
      const tail = adapter.endOfStream(state)
      const usage = tail.find((e) => e.type === 'usage')?.usage || null
      if (usage) yield { type: 'usage', usage }
      return { usage, ttftMs, totalMs: Date.now() - t0 }
    } catch (e) {
      const err = fromFetchError(e, target.provider.id)
      // 停止 / 已产出 / 不可重试 / 重试预算耗尽 → 上抛给降级层
      if (err.code === 'ABORTED' || yielded || !err.retryable || attempt >= 1) throw err
      await sleep(500 * 2 ** attempt)
    }
  }
}

/**
 * @param {object} settings 已迁移的设置（providers / providerId / routing / fallbackIds）
 * @param {{sleep?: (ms:number)=>Promise}} [inj] 测试注入点（退避等待）
 */
export function createChatClient(settings, inj = {}) {
  const sleep = inj.sleep || defaultSleep
  const s = settings || {}

  return {
    /** 能力查询：上下文窗口等（编译器裁剪历史用） */
    capabilities(providerId) {
      const p = getProvider(s, providerId || s.providerId)
      return p ? { context: p.context, streaming: true, browserSafe: p.browserSafe } : null
    },

    /** 就绪厂商清单（UI 下拉用） */
    readyProviders() {
      return routeChain(s, 'chat', {}).map((t) => t.provider)
    },

    /**
     * 流式调用。事件：delta / usage；结束即正常 return；失败抛 ProviderError。
     * @param {import('./types').StandardRequest} req
     */
    async *stream(req) {
      const targets = planTargets(s, req)
      const attempts = []
      for (let ti = 0; ti < targets.length; ti++) {
        const t = targets[ti]
        if (breakerIsOpen(t.provider.id)) {
          attempts.push({ provider: t.provider.id, errorCode: 'BREAKER_OPEN' })
          continue
        }
        let usage = null
        let ttftMs = null
        let yielded = false // 本家是否已产出过内容：产出后不可换厂商（输出会重复）
        const t0 = Date.now()
        try {
          for await (const ev of attemptStream(t, req, sleep)) {
            if (ev.type === 'delta') {
              if (ttftMs === null) ttftMs = Date.now() - t0
              yielded = true
              yield { type: 'delta', text: ev.text }
            } else if (ev.type === 'usage') {
              usage = ev.usage
              yield ev
            }
          }
          breakerRecord(t.provider.id, true)
          recordCall({
            ok: true, purpose: req.purpose, provider: t.provider.id, model: t.model,
            isFallback: ti > 0, attempts: attempts.length, ttftMs, totalMs: Date.now() - t0, usage,
            cost: estimateCost(usage, t.provider.pricing), sessionId: req.metadata?.sessionId ?? null,
          })
          return
        } catch (err) {
          breakerRecord(t.provider.id, false)
          attempts.push({
            provider: t.provider.id, errorCode: err.code || 'UNKNOWN', ms: Date.now() - t0,
            detail: String(err.message || '').slice(0, 120), // 服务端原因透出，便于定位（如模型名不存在）
          })
          recordCall({
            ok: false, purpose: req.purpose, provider: t.provider.id, model: t.model,
            isFallback: ti > 0, attempts: attempts.length, errorCode: err.code || 'UNKNOWN',
            totalMs: Date.now() - t0, sessionId: req.metadata?.sessionId ?? null,
          })
          // 停止（用户主动）或已产出部分内容 → 直接上抛，绝不换厂商重试
          if (err.code === 'ABORTED' || yielded) throw err
          // 否则继续尝试下一家（降级）
        }
      }
      throw new ProviderError(
        'SERVER',
        `全部模型厂商均失败：${attempts.map((a) => `${a.provider}（${a.errorCode}${a.detail ? `：${a.detail}` : ''}）`).join(' → ')}。请到「设置」页检查各厂商的 Key 与端点。`,
        { raw: attempts },
      )
    },

    /**
     * 非流式调用（状态提取 / 摘要用）。
     * @returns {Promise<{text:string, usage:import('./types').Usage|null, provider:string, model:string,
     *                    cost:{amount:number,currency:string}|null, attempts:Array}>}
     */
    async complete(req) {
      const targets = planTargets(s, req)
      const attempts = []
      for (let ti = 0; ti < targets.length; ti++) {
        const t = targets[ti]
        if (breakerIsOpen(t.provider.id)) {
          attempts.push({ provider: t.provider.id, errorCode: 'BREAKER_OPEN' })
          continue
        }
        const adapter = ADAPTERS[t.provider.adapter] || openaiAdapter
        const t0 = Date.now()
        try {
          const r = await withRetry(async () => {
            const http = adapter.buildCompleteRequest(t, req)
            const res = await fetch(http.url, http.init)
            if (!res.ok) throw adapter.mapError(res.status, await res.text(), t.provider.id)
            return adapter.parseResponse(await res.json())
          }, { maxRetries: 2, sleep })
          breakerRecord(t.provider.id, true)
          const cost = estimateCost(r.usage, t.provider.pricing)
          recordCall({
            ok: true, purpose: req.purpose, provider: t.provider.id, model: t.model,
            isFallback: ti > 0, attempts: attempts.length, totalMs: Date.now() - t0,
            usage: r.usage, cost, sessionId: req.metadata?.sessionId ?? null,
          })
          return { text: r.text, usage: r.usage, provider: t.provider.id, model: t.model, cost, attempts: [...attempts] }
        } catch (err) {
          const e = fromFetchError(err, t.provider.id)
          breakerRecord(t.provider.id, false)
          attempts.push({
            provider: t.provider.id, errorCode: e.code || 'UNKNOWN', ms: Date.now() - t0,
            detail: String(e.message || '').slice(0, 120),
          })
          recordCall({
            ok: false, purpose: req.purpose, provider: t.provider.id, model: t.model,
            isFallback: ti > 0, attempts: attempts.length, errorCode: e.code || 'UNKNOWN',
            totalMs: Date.now() - t0, sessionId: req.metadata?.sessionId ?? null,
          })
          if (e.code === 'ABORTED') throw e
          // 继续尝试下一家
        }
      }
      throw new ProviderError(
        'SERVER',
        `全部模型厂商均失败：${attempts.map((a) => `${a.provider}（${a.errorCode}${a.detail ? `：${a.detail}` : ''}）`).join(' → ')}。请到「设置」页检查各厂商的 Key 与端点。`,
        { raw: attempts },
      )
    },
  }
}
