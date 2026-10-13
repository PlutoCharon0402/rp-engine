// 批次4 · 世界书导入包校验
// 判据：三种错文件必须被拦下（全量备份 / 单故事导出 / 无关 JSON），且校验失败时零改动。
import { describe, it, expect } from 'vitest'
import { validateLorePack, buildLorePack } from '../src/lib/lore.js'

const ok = { app: 'rp-engine', type: 'lore', version: 1, entries: [{ keys: '王城', content: '王城是都城' }] }

describe('L1 · validateLorePack 拦截错文件', () => {
  it('全量备份文件：不能当世界书导入（导入它会清库）', () => {
    expect(() => validateLorePack({ characters: [], sessions: [], messages: [], lore: [] })).toThrow('全量备份')
  })

  it('单故事导出文件：该走「对话」页的导入记录', () => {
    expect(() => validateLorePack({ app: 'rp-engine', type: 'session', entries: [] })).toThrow('导入记录')
  })

  it('无关 JSON / 结构不对：顶层非对象、缺 entries、entries 为空', () => {
    expect(() => validateLorePack(null)).toThrow('JSON 对象')
    expect(() => validateLorePack([1, 2])).toThrow('JSON 对象')
    expect(() => validateLorePack({})).toThrow('entries')
    expect(() => validateLorePack({ entries: [] })).toThrow('没有条目')
  })

  it('条目必须带非空 content，否则整包拒绝', () => {
    expect(() => validateLorePack({ entries: [{ keys: 'x' }] })).toThrow('content')
    expect(() => validateLorePack({ entries: [{ content: '   ' }] })).toThrow('content')
    expect(() => validateLorePack({ entries: [null, '字符串'] })).toThrow('content')
  })

  it('rp-engine 出品但 type 不对 → 拒绝', () => {
    expect(() => validateLorePack({ app: 'rp-engine', type: 'character', entries: [{ content: 'x' }] })).toThrow('世界书')
  })
})

describe('L2 · 合法导入包', () => {
  it('返回规范化条目：补 uid、补默认字段', () => {
    const list = validateLorePack(ok)
    expect(list.length).toBe(1)
    expect(typeof list[0].uid).toBe('string')
    expect(list[0].enabled).toBe(true)
    expect(list[0].content).toBe('王城是都城')
  })

  it('只保留合法条目，脏条目被丢弃后仍有内容则放行', () => {
    const list = validateLorePack({ entries: [{ content: 'A' }, { keys: '无内容' }, { content: 'B', uid: 'dup' }, { content: 'C', uid: 'dup' }] })
    expect(list.map((e) => e.content)).toEqual(['A', 'B', 'C'])
    // 重复 uid 会被 normalizeLore 重新分配，绝不留下两条同 uid（否则删 1 条会掉 2 条）
    expect(new Set(list.map((e) => e.uid)).size).toBe(list.length)
  })
})

describe('L3 · buildLorePack 往返', () => {
  it('导出 → 校验 → 导入，条目内容不变', () => {
    const pack = buildLorePack([{ keys: 'a', content: '正文', priority: 3, constant: true }])
    const back = validateLorePack(JSON.parse(JSON.stringify(pack)))
    expect(back.length).toBe(1)
    expect(back[0].content).toBe('正文')
    expect(back[0].priority).toBe(3)
    expect(back[0].constant).toBe(true)
  })

  it('导出的条目不含 uid（全局表用自增 id，uid 属会话级身份）', () => {
    const pack = buildLorePack([{ uid: 's1', content: 'x' }])
    expect(pack.entries[0].uid).toBeUndefined()
  })
})
