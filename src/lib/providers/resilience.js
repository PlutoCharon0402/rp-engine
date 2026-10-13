/**
 * 弹性层（docs/multi-provider-design.md §6.2）：单厂商内重试 + per-provider 熔断。
 * 跨厂商降级由 client 串起 routeChain 完成，不在本模块。
 *
 * 设计取舍：
 *   - 重试只对可重试错误码（429/5xx/网络/超时），指数退避 + 抖动，尊重服务端 Retry-After；
 *   - ABORTED（用户停止）绝不重试；
 *   - 熔断是**内存态**（页面级）：连续失败 N 次开路 M 秒，开路期间该厂商被直接跳过，
 *     避免每次请求都白等一轮超时。刷新页面即复位——对浏览器端单用户场景足够。
 */

/** @type {Map<string, {failures: number, openUntil: number}>} providerId → 熔断状态 */
const breakers = new Map()

export const BREAKER = { threshold: 3, cooldownMs: 60_000 }

export function breakerIsOpen(providerId, now = Date.now()) {
  const b = breakers.get(providerId)
  return !!b && b.openUntil > now
}

/** 成功清零连续失败计数；失败累加，达阈值开路 cooldownMs */
export function breakerRecord(providerId, ok, now = Date.now()) {
  if (ok) { breakers.delete(providerId); return }
  const b = breakers.get(providerId) || { failures: 0, openUntil: 0 }
  b.failures += 1
  if (b.failures >= BREAKER.threshold) b.openUntil = now + BREAKER.cooldownMs
  breakers.set(providerId, b)
}

/** 调试 / 测试用：查看与复位熔断状态 */
export function breakerSnapshot() { return Object.fromEntries(breakers) }
export function resetBreakers() { breakers.clear() }

export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 退避：500ms → 1s → 2s（+抖动），服务端给了 Retry-After 则优先，上限 8s */
export function backoffMs(attempt, retryAfterMs) {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 8000)
  return Math.min(400 * 2 ** attempt + Math.random() * 200, 8000)
}

/**
 * 带重试地执行一次（非流式）调用。流式调用因为生成器里已 yield 的内容无法收回，
 * 重试逻辑由 client 内联实现（yield 前失败才重试），不走本函数。
 *
 * @param {() => Promise<T>} fn
 * @param {{maxRetries?: number, sleep?: (ms:number)=>Promise, isRetryable?: (e:any)=>boolean}} [opts]
 *   maxRetries = 额外重试次数（总尝试 = 1 + maxRetries）
 */
export async function withRetry(fn, opts = {}) {
  const { maxRetries = 2, sleep = defaultSleep, isRetryable = (e) => e?.retryable } = opts
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      lastErr = e
      if (e?.code === 'ABORTED' || !isRetryable(e) || attempt === maxRetries) throw e
      await sleep(backoffMs(attempt, e?.retryAfterMs))
    }
  }
  throw lastErr // 理论不可达
}
