// P0-4 · applyDiff 幂等 + 不过度去重护栏
//
// 幂等：同一 diff（同 turn）重放不重复写入——修复"写状态成功、标 done 失败"后重跑的重复污染。
// 护栏（同样重要）：去重键必须含 turn。若只按 text 去重，「第5回合王城陷落」与
// 「第9回合王城陷落」这类**合法重复**会被吞掉一条——静默丢事实，用户无法察觉。
import { describe, it, expect } from 'vitest'
import { applyDiff } from '../src/lib/extractor.js'

const empty = () => ({ characters: {}, facts: [], events: [], relations: [] })

describe('T4 · applyDiff 幂等（P0-4，批次 2 已修复）', () => {
  it('T4-1 命门：同一 diff 应用两次，facts / events 不重复', () => {
    const diff = { facts_add: ['王城已陷落'], events_add: ['夜袭王城'] }
    const a = applyDiff(empty(), diff, 5)
    const b = applyDiff(a, diff, 5)
    expect(b.facts).toEqual([{ turn: 5, text: '王城已陷落' }])
    expect(b.events).toEqual([{ turn: 5, text: '夜袭王城' }])
  })

  it('T4-2 护栏：不同 turn 的同文本是合法重复，不得被去重吞掉', () => {
    const a = applyDiff(empty(), { facts_add: ['王城陷落'] }, 5)
    const b = applyDiff(a, { facts_add: ['王城陷落'] }, 9)
    expect(b.facts).toEqual([
      { turn: 5, text: '王城陷落' },
      { turn: 9, text: '王城陷落' },
    ])
  })

  it('T4-3 同一 diff 内部的重复条目也只写入一条', () => {
    const a = applyDiff(empty(), { facts_add: ['夜袭开始', '夜袭开始'], events_add: ['号角响起', '号角响起'] }, 3)
    expect(a.facts).toEqual([{ turn: 3, text: '夜袭开始' }])
    expect(a.events).toEqual([{ turn: 3, text: '号角响起' }])
  })

  it('T4-4 events 与 facts 同样按 (turn, text) 幂等', () => {
    const diff = { events_add: ['角色发现了密道'] }
    const a = applyDiff(empty(), diff, 7)
    const b = applyDiff(a, diff, 7)
    expect(b.events).toEqual([{ turn: 7, text: '角色发现了密道' }])
  })
})
