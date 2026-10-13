/**
 * 性能监控（docs/multi-provider-design.md §7）：每次模型调用落一条记录到 IndexedDB `metrics` 表，
 * 支持按厂商聚合（调用数 / 成功率 / 延迟 / 首字延迟 / token / 估算成本 / 缓存命中）。
 *
 * 注意：
 *   - metrics 表随 db v4 新增，**不在**导入清空范围（历史表现不该被导入抹掉）；
 *   - 写入失败静默（监控绝不影响主流程）；
 *   - 只保留最近 MAX 条，写入时顺手裁剪，无需定时任务。
 */
import { db } from '../db'

export const MAX_METRICS = 500

/**
 * 记录一次调用（成功 / 失败都记）。fire-and-forget：任何异常吞掉。
 * @param {import('./types').ModelCallRecord} rec
 */
export async function recordCall(rec) {
  try {
    await db.metrics.add({ ts: Date.now(), ...rec })
    const excess = (await db.metrics.count()) - MAX_METRICS
    if (excess > 0) {
      const oldest = await db.metrics.orderBy('id').limit(excess).toArray()
      await db.metrics.bulkDelete(oldest.map((r) => r.id))
    }
  } catch { /* 库未就绪 / 老版本库无此表：静默 */ }
}

/**
 * 纯聚合函数（无 DB 依赖，可单测）：按厂商汇总记录。
 * @returns {Array<{
 *   provider: string, calls: number, ok: number, okRate: number,
 *   avgMs: number, p95Ms: number, avgTtftMs: number|null,
 *   tokens: number, cacheHitRate: number|null,
 *   cost: number|null, currency: string|null, errors: Object<string, number>,
 * }>}
 */
export function aggregate(records) {
  const byProvider = new Map()
  for (const r of records || []) {
    const p = r.provider || '(unknown)'
    if (!byProvider.has(p)) {
      byProvider.set(p, { provider: p, calls: 0, ok: 0, totalMs: [], ttfts: [], tokens: 0, cacheHit: 0, cacheMiss: 0, cost: 0, currency: null, errors: {} })
    }
    const a = byProvider.get(p)
    a.calls += 1
    if (r.ok) {
      a.ok += 1
      a.totalMs.push(r.totalMs || 0)
      if (r.ttftMs != null) a.ttfts.push(r.ttftMs)
      if (r.usage) {
        a.tokens += (r.usage.inputTokens || 0) + (r.usage.outputTokens || 0)
        a.cacheHit += r.usage.cacheRead || 0
        a.cacheMiss += r.usage.cacheWrite || 0
      }
      if (r.cost) { a.cost += r.cost.amount; a.currency = r.cost.currency }
    } else {
      const code = r.errorCode || 'UNKNOWN'
      a.errors[code] = (a.errors[code] || 0) + 1
      if (r.totalMs) a.totalMs.push(r.totalMs)
    }
  }
  return [...byProvider.values()].map((a) => {
    const sorted = [...a.totalMs].sort((x, y) => x - y)
    const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0)
    const hitMiss = a.cacheHit + a.cacheMiss
    return {
      provider: a.provider,
      calls: a.calls,
      ok: a.ok,
      okRate: a.calls ? a.ok / a.calls : 0,
      avgMs: sorted.length ? Math.round(sorted.reduce((s, x) => s + x, 0) / sorted.length) : 0,
      p95Ms: pct(0.95),
      avgTtftMs: a.ttfts.length ? Math.round(a.ttfts.reduce((s, x) => s + x, 0) / a.ttfts.length) : null,
      tokens: a.tokens,
      cacheHitRate: hitMiss > 0 ? a.cacheHit / hitMiss : null,
      cost: a.cost ? Math.round(a.cost * 10000) / 10000 : null,
      currency: a.currency,
      errors: a.errors,
    }
  }).sort((x, y) => y.calls - x.calls)
}

/** 近 N 天的厂商聚合（UI「模型表现」用） */
export async function metricsSummary(days = 7) {
  try {
    const since = Date.now() - days * 86_400_000
    return aggregate(await db.metrics.where('ts').above(since).toArray())
  } catch {
    return []
  }
}

/** 最近若干条原始记录（调试 / 详情用） */
export async function recentCalls(limit = 50) {
  try {
    const all = await db.metrics.orderBy('id').reverse().limit(limit).toArray()
    return all
  } catch {
    return []
  }
}

export async function clearMetrics() {
  try { await db.metrics.clear() } catch { /* 老库无此表 */ }
}
