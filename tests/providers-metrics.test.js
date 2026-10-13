// 性能监控：recordCall 落库 + aggregate 聚合（成功率 / 延迟 / 缓存命中 / 成本估算）
import 'fake-indexeddb/auto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../src/lib/db.js'
import { recordCall, aggregate, metricsSummary, clearMetrics } from '../src/lib/providers/metrics.js'

beforeAll(async () => { await db.open() })
afterAll(async () => { await db.delete(); db.close() })
beforeEach(async () => { await db.metrics.clear() })

const rec = (o) => ({
  ts: Date.now(), purpose: 'chat', provider: 'deepseek', model: 'deepseek-chat',
  ok: true, isFallback: false, attempts: 0, totalMs: 100, ttftMs: 50,
  usage: { inputTokens: 100, outputTokens: 20, cacheRead: 80, cacheWrite: 20, totalTokens: 120, estimated: false },
  cost: { amount: 0.36, currency: 'CNY' }, sessionId: 1, ...o,
})

describe('MG1 · aggregate（纯函数）', () => {
  it('按厂商汇总：调用 / 成功率 / 平均耗时 / 首字 / token / 缓存命中 / 成本', () => {
    const rows = aggregate([
      rec({ provider: 'deepseek', totalMs: 100, ttftMs: 50 }),
      rec({ provider: 'deepseek', totalMs: 200, ttftMs: 100 }),
      rec({ provider: 'deepseek', ok: false, errorCode: 'RATE_LIMIT', totalMs: 300, usage: null, cost: null, ttftMs: null }),
      rec({ provider: 'moonshot', totalMs: 400, usage: { inputTokens: 0, outputTokens: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 10, estimated: false }, cost: null, ttftMs: null }),
    ])
    expect(rows).toHaveLength(2)
    const ds = rows.find((r) => r.provider === 'deepseek')
    expect(ds.calls).toBe(3)
    expect(ds.ok).toBe(2)
    expect(ds.okRate).toBeCloseTo(2 / 3)
    expect(ds.avgMs).toBe(200)            // (100+200+300)/3
    expect(ds.avgTtftMs).toBe(75)         // (50+100)/2
    expect(ds.tokens).toBe(240)           // 两次成功 (100+20)*2
    expect(ds.cacheHitRate).toBeCloseTo(0.8)
    expect(ds.cost).toBeCloseTo(0.72)
    expect(ds.errors).toEqual({ RATE_LIMIT: 1 })
  })

  it('空记录返回空数组；无 usage / 无价格不炸', () => {
    expect(aggregate([])).toEqual([])
    expect(aggregate([rec({ usage: null, cost: null })])).toBeTruthy()
  })
})

describe('MG2 · recordCall / metricsSummary（IndexedDB）', () => {
  it('记录落库并可按时间窗聚合', async () => {
    await recordCall(rec({ provider: 'deepseek' }))
    await recordCall(rec({ provider: 'moonshot', ok: false, errorCode: 'SERVER' }))
    expect(await db.metrics.count()).toBe(2)
    const rows = await metricsSummary(7)
    expect(rows.map((r) => r.provider).sort()).toEqual(['deepseek', 'moonshot'])
    // 时间窗外不返回
    const old = await metricsSummary(-1) // since = now + 1d → 全部排除
    expect(old).toEqual([])
  })

  it('clearMetrics 清空', async () => {
    await recordCall(rec({}))
    await clearMetrics()
    expect(await db.metrics.count()).toBe(0)
  })
})
