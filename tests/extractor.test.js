// P0-4 · applyDiff 幂等（批次 2 范围）
//
// ⚠️ 说明（不要误读为"用例已通过"）：
// P0-4 属于**批次 2**，本次范围（批次 0 + 1）约定**不改 src/lib/extractor.js**，
// 所以下面这条断言在当前代码上**必然失败**。这里用 it.fails 把缺陷现状固化成可执行断言：
//   · 现在：applyDiff 不幂等 → 用例按预期失败 → 套件保持绿色；
//   · 批次 2 修好 applyDiff 后：该用例会转为"失败"（因为不再失败）→ 提示把 it.fails 改回 it。
// 这不是伪造通过，而是把"已知的待修缺陷"显式登记在测试里，避免它被遗忘。
import { describe, it, expect } from 'vitest'
import { applyDiff } from '../src/lib/extractor.js'

describe('T4 · applyDiff 幂等（P0-4，批次 2）', () => {
  it.fails('T4-1 命门：同一 diff 应用两次，facts / events 不重复', () => {
    const diff = { facts_add: ['王城已陷落'], events_add: ['夜袭王城'] }
    const empty = { characters: {}, facts: [], events: [], relations: [] }
    const a = applyDiff(empty, diff, 5)
    const b = applyDiff(a, diff, 5)
    expect(b.facts).toEqual([{ turn: 5, text: '王城已陷落' }])
    expect(b.events).toEqual([{ turn: 5, text: '夜袭王城' }])
  })
})
