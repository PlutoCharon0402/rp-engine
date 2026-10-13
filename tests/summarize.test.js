// 批次4 · 长对话滚动摘要的纯函数部分
// 判据：够不着的窗口不触发；触发时折叠"窗口之外的那截"，且 upTo 精确落在最后一条被折叠消息上。
import { describe, it, expect } from 'vitest'
import { summarizePlan, foldText } from '../src/lib/summarize.js'

// CHUNK = 10：未摘要消息数 > maxHistory + 10 才值得跑一次摘要
const msgs = (n, startId = 1) => Array.from({ length: n }, (_, i) => ({
  id: startId + i,
  role: i % 2 ? 'assistant' : 'user',
  content: `第${i + 1}句`,
}))

describe('S1 · summarizePlan 触发条件', () => {
  it('未摘要消息未超过「窗口 + 10」时不触发', () => {
    expect(summarizePlan(msgs(15), 5, 0)).toBeNull()      // 15 = 5 + 10，刚好不触发
    expect(summarizePlan(msgs(10), 40, 0)).toBeNull()
    expect(summarizePlan([], 5, 0)).toBeNull()
  })

  it('超过阈值才触发，且只折叠窗口之外的部分', () => {
    const plan = summarizePlan(msgs(16), 5, 0)
    expect(plan).not.toBeNull()
    expect(plan.keep).toBe(5)
    expect(plan.fold.length).toBe(11)   // 16 - 5
    expect(plan.upTo).toBe(11)          // 折叠到第 11 条
    expect(plan.fold[0].id).toBe(1)
  })

  it('已摘要过的消息不再计入（避免每回合重复折叠）', () => {
    // 20 条消息，但前 10 条已被摘要覆盖 → 未摘要只剩 10 条，不触发
    expect(summarizePlan(msgs(20), 5, 10)).toBeNull()
    // 未摘要 16 条（10 之后还有 16 条）→ 触发，且 fold 从 id=11 开始
    const plan = summarizePlan(msgs(26), 5, 10)
    expect(plan.fold[0].id).toBe(11)
    expect(plan.upTo).toBe(21)
  })

  it('边界：maxHistory 非法值退化为默认 40；消息无 id 时放弃（无法标记进度）', () => {
    expect(summarizePlan(msgs(60), 0, 0).keep).toBe(40)
    expect(summarizePlan(msgs(60), 'abc', 0).keep).toBe(40)
    expect(summarizePlan(msgs(60), undefined, 0).keep).toBe(40)
    expect(summarizePlan(msgs(60), 1, 0).keep).toBe(1)
    const noId = Array.from({ length: 30 }, (_, i) => ({ role: 'user', content: `${i}` }))
    expect(summarizePlan(noId, 5, 0)).toBeNull()
    expect(summarizePlan(null, 5, 0)).toBeNull()
  })
})

describe('S2 · foldText', () => {
  it('用户消息标记「你」，其余标记「角色」', () => {
    const text = foldText([
      { role: 'user', content: '我拔剑' },
      { role: 'assistant', content: '他后退' },
    ])
    expect(text).toBe('你：我拔剑\n角色：他后退')
  })
})
