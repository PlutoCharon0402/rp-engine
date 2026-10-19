// P0-2 · 会话级世界书 uid 守卫（纯函数）
// 命门用例 T2-2：uid 缺失时"删 1 条"不得清空全部 —— 历史上就是这里把整组条目一次删光。
import { describe, it, expect } from 'vitest'
import { normalizeLore, upsertLore, removeLore, toggleLore } from '../src/lib/lore.js'

/** 3 条"从角色卡带入"的条目：与 cardImport 的输出一致，**没有 uid** */
const raw = () => [
  { keys: '甲', content: '甲设定', priority: 1, constant: false, enabled: true },
  { keys: '乙', content: '乙设定', priority: 2, constant: false, enabled: true },
  { keys: '丙', content: '丙设定', priority: 3, constant: false, enabled: true },
]

describe('T2 · lib/lore', () => {
  it('T2-1 normalizeLore 补齐 uid 且幂等（必须复用同一对象再比较）', () => {
    const a = normalizeLore(raw())
    expect(a).toHaveLength(3)
    for (const e of a) expect(typeof e.uid === 'string' && !!e.uid).toBe(true)
    expect(new Set(a.map((e) => e.uid)).size).toBe(3)
    expect(normalizeLore(a)).toEqual(a)
  })

  it('T2-1b normalizeLore 保留自定义字段并补默认值', () => {
    const [e] = normalizeLore([{ keys: '甲', content: '甲设定', extra: 'keep' }])
    expect(e.extra).toBe('keep')
    expect(e).toMatchObject({ priority: 0, constant: false, enabled: true })
  })

  it('T2-1c normalizeLore 把 keys 归一为字符串（数组 join、null 置空、非字符串强转）', () => {
    // 实测崩溃场景：外部构造的卡把 keys 写成数组 → matchLore 调 .split 直接 TypeError
    const [a, b, c, d] = normalizeLore([
      { keys: ['西码头', '火灾'], content: 'a' },
      { keys: null, content: 'b' },
      { keys: 123, content: 'c' },
      { content: 'd' },
    ])
    expect(a.keys).toBe('西码头，火灾')
    expect(b.keys).toBe('')
    expect(c.keys).toBe('123')
    expect(d.keys).toBe('')
    // 幂等：字符串 keys 二次归一不变
    expect(normalizeLore([{ keys: '甲，乙', content: 'x' }])[0].keys).toBe('甲，乙')
  })

  it('T2-2 命门：uid 缺失时不做任何删除（undefined / null 都不清空）', () => {
    expect(removeLore(raw(), undefined)).toHaveLength(3)
    expect(removeLore(raw(), null)).toHaveLength(3)
  })

  it('T2-3 按 uid 删除只掉 1 条；uid 不存在则原样返回', () => {
    const list = normalizeLore(raw())
    const rest = removeLore(list, list[1].uid)
    expect(rest).toHaveLength(2)
    expect(rest.map((e) => e.uid)).toEqual([list[0].uid, list[2].uid])
    expect(removeLore(list, 'not-exist')).toHaveLength(3)
  })

  it('T2-4 toggleLore 只翻转 1 条；uid 缺失时一条都不动', () => {
    const list = normalizeLore(raw())
    const next = toggleLore(list, list[0].uid)
    expect(next[0].enabled).toBe(false)
    expect(next[1].enabled).toBe(true)
    expect(next[2].enabled).toBe(true)
    expect(toggleLore(list, undefined).every((e) => e.enabled === true)).toBe(true)
  })

  it('T2-5 upsertLore：有 uid 原地更新（保留未提交字段），无 uid 追加', () => {
    const list = normalizeLore(raw())
    const updated = upsertLore(list, { content: '甲改' }, list[0].uid)
    expect(updated).toHaveLength(3)
    expect(updated[0]).toMatchObject({ content: '甲改', keys: '甲', uid: list[0].uid })

    const added = upsertLore(list, { content: '丁设定' }, null)
    expect(added).toHaveLength(4)
    expect(added[3].content).toBe('丁设定')
    expect(typeof added[3].uid === 'string' && !!added[3].uid).toBe(true)
  })
})
