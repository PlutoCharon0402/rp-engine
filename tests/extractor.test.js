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

// 批次4 · relations：字段此前一直是"定义了但没人用"的僵尸，现在启用
describe('R · relations（人物关系）', () => {
  it('R1 新增关系，记录 turn', () => {
    const s = applyDiff(empty(), { relations_add: [{ from: '林越', to: '沈昭', desc: '表面师徒' }] }, 4)
    expect(s.relations).toEqual([{ from: '林越', to: '沈昭', desc: '表面师徒', turn: 4 }])
  })

  it('R2 同一对人物再次给出 → 覆盖 desc（关系演变，而不是堆积）', () => {
    const a = applyDiff(empty(), { relations_add: [{ from: '林越', to: '沈昭', desc: '师徒' }] }, 4)
    const b = applyDiff(a, { relations_add: [{ from: '林越', to: '沈昭', desc: '决裂' }] }, 9)
    expect(b.relations).toEqual([{ from: '林越', to: '沈昭', desc: '决裂', turn: 9 }])
  })

  it('R3 幂等：同一 diff 重放不新增、不改内容', () => {
    const diff = { relations_add: [{ from: 'A', to: 'B', desc: '同伴' }] }
    const a = applyDiff(empty(), diff, 3)
    const b = applyDiff(a, diff, 3)
    expect(b.relations).toEqual(a.relations)
    expect(b.relations.length).toBe(1)
  })

  it('R4 脏数据守卫：缺 from / to 的条目跳过，非对象跳过', () => {
    const s = applyDiff(empty(), {
      relations_add: [{ to: 'B', desc: '缺 from' }, { from: 'A', desc: '缺 to' }, null, '字符串'],
    }, 2)
    expect(s.relations).toEqual([])
  })

  it('R5 desc 缺省时仍记录关系（空描述，交给状态页补）', () => {
    const s = applyDiff(empty(), { relations_add: [{ from: 'A', to: 'B' }] }, 2)
    expect(s.relations).toEqual([{ from: 'A', to: 'B', desc: '', turn: 2 }])
  })
})
