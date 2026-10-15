// 批次8：事件钩子。matchRules / hookPatch 纯函数 + compileMessages 的 hints 注入。
import { describe, expect, it } from 'vitest'
import { matchRules, hookPatch } from '../src/lib/hooks.js'
import { compileMessages } from '../src/lib/compiler.js'

const rule = (o) => ({ id: 1, name: '规则', enabled: true, when: {}, then: {}, ...o })

describe('HK1 · matchRules（条件匹配）', () => {
  it('位置变化命中：限定角色 + 包含匹配 + 大小写不敏感', () => {
    const r = rule({ when: { character: '沈砚', location: '西码头' } })
    expect(matchRules([r], { characters: { 沈砚: { location: '西码头6号仓库' } } })).toHaveLength(1)
    expect(matchRules([r], { characters: { 沈砚: { location: '书店' } } })).toHaveLength(0)      // 位置不符
    expect(matchRules([r], { characters: { 别人: { location: '西码头' } } })).toHaveLength(0)    // 角色不符
    // 大小写不敏感（英文关键词场景）
    expect(matchRules([rule({ when: { location: 'west dock' } })], { characters: { 甲: { location: 'WEST DOCK' } } })).toHaveLength(1)
  })

  it('不限定角色时任意角色的位置变化都命中', () => {
    const r = rule({ when: { location: '码头' } })
    expect(matchRules([r], { characters: { 甲: { location: '南码头' } } })).toHaveLength(1)
  })

  it('匹配的是本轮 diff（变化），不是持续状态', () => {
    const r = rule({ when: { location: '书店' } })
    // diff 里只有 mood 变化，location 没动 → 不触发（哪怕全量状态里人在书店）
    expect(matchRules([r], { characters: { 沈砚: { mood: '警惕' } } })).toHaveLength(0)
  })

  it('hasItem 命中 inventory_add（包含匹配）', () => {
    const r = rule({ when: { hasItem: '铜钥匙' } })
    expect(matchRules([r], { characters: { 沈砚: { inventory_add: ['一把铜钥匙'] } } })).toHaveLength(1)
    expect(matchRules([r], { characters: { 沈砚: { inventory_add: ['铁钥匙'] } } })).toHaveLength(0)
  })

  it('factKeyword 命中事实或事件文本', () => {
    const r = rule({ when: { factKeyword: '密室' } })
    expect(matchRules([r], { facts_add: ['地下室有一间密室'] })).toHaveLength(1)
    expect(matchRules([r], { events_add: ['他们打开了密室的门'] })).toHaveLength(1)
    expect(matchRules([r], { facts_add: ['天气很好'] })).toHaveLength(0)
  })

  it('relations 命中：from / to 可只填其一', () => {
    const r = rule({ when: { relationFrom: '沈砚', relationTo: '周砚秋' } })
    expect(matchRules([r], { relations_add: [{ from: '沈砚', to: '周砚秋', desc: '师姐弟' }] })).toHaveLength(1)
    expect(matchRules([r], { relations_add: [{ from: '沈砚', to: '别人' }] })).toHaveLength(0)
    const rAnyTo = rule({ when: { relationFrom: '沈砚' } })
    expect(matchRules([rAnyTo], { relations_add: [{ from: '沈砚', to: '任何人' }] })).toHaveLength(1)
  })

  it('多条件是 AND：只满足一半不触发', () => {
    const r = rule({ when: { character: '沈砚', hasItem: '铜钥匙' } })
    expect(matchRules([r], { characters: { 沈砚: { inventory_add: ['铜钥匙'] } } })).toHaveLength(1)
    expect(matchRules([r], { characters: { 沈砚: { inventory_add: ['别的'] } } })).toHaveLength(0)
  })

  it('空条件 / 禁用 / 脏数据都不触发', () => {
    expect(matchRules([rule({ when: {} })], { characters: { 甲: { location: 'x' } } })).toHaveLength(0)   // 无条件=防呆
    expect(matchRules([rule({ enabled: false, when: { location: 'x' } })], { characters: { 甲: { location: 'x' } } })).toHaveLength(0)
    expect(matchRules([null, undefined], { facts_add: ['x'] })).toHaveLength(0)
    expect(matchRules([rule({ when: { location: 'x' } })], null)).toHaveLength(0)
    expect(matchRules(null, { facts_add: ['x'] })).toHaveLength(0)
  })
})

describe('HK2 · hookPatch（动作计算）', () => {
  it('解锁 lore：仅命中 uid 且停用的条目被启用', () => {
    const session = { lore: [
      { uid: 'a1', enabled: false, content: '藏宝图' },
      { uid: 'b2', enabled: true, content: '常驻' },
      { uid: 'c3', enabled: false, content: '无关' },
    ] }
    const fired = [rule({ id: 7, then: { activateLoreUids: ['a1', 'b2'] } })]
    const patch = hookPatch(session, fired, 3)
    expect(patch.lore.find((e) => e.uid === 'a1').enabled).toBe(true)   // 解锁
    expect(patch.lore.find((e) => e.uid === 'b2').enabled).toBe(true)   // 本来就开
    expect(patch.lore.find((e) => e.uid === 'c3').enabled).toBe(false)  // 不动
  })

  it('injectOnce 进 pendingHints（上限 5 条）；hookLog 记录（上限 50 条）', () => {
    const session = { pendingHints: Array.from({ length: 4 }, (_, i) => ({ ruleId: i, text: `t${i}` })), hookLog: Array.from({ length: 49 }, (_, i) => ({ ruleId: i, name: `r${i}`, turn: i })) }
    const fired = [rule({ id: 9, name: '新', then: { injectOnce: ' 他想起一把钥匙' } })]
    const patch = hookPatch(session, fired, 5)
    expect(patch.pendingHints).toHaveLength(5)                       // 4 + 1 截到 5
    expect(patch.pendingHints[4]).toEqual({ ruleId: 9, text: '他想起一把钥匙' }) // trim
    expect(patch.hookLog).toHaveLength(50)
    expect(patch.hookLog[49]).toMatchObject({ name: '新', turn: 5 })
  })

  it('仅记录型规则（无动作）也写 hookLog；空 fired 返回空 patch', () => {
    const patch = hookPatch({ lore: [] }, [rule({ id: 1, name: '记录' })], 1)
    expect(patch.lore).toBeUndefined()
    expect(patch.pendingHints).toBeUndefined()
    expect(patch.hookLog).toHaveLength(1)
    expect(hookPatch({}, [], 1)).toEqual({})
    expect(hookPatch(null, null, 0)).toEqual({})
  })
})

describe('HK3 · compileMessages 注入 hints', () => {
  it('动态块包含剧情事件段；空 hints 不产生多余段落', () => {
    const card = { name: '沈砚' }
    const settings = { maxHistory: 40, depth: 1, loreBudget: 600 }
    const withHints = compileMessages(card, [], null, [{ role: 'user', content: 'hi' }], settings, '', [{ ruleId: 1, text: '（他想起一把铜钥匙）' }])
    const dyn = withHints.find((m) => m.role === 'system' && m.content.includes('剧情事件'))
    expect(dyn.content).toContain('（他想起一把铜钥匙）')
    const without = compileMessages(card, [], null, [{ role: 'user', content: 'hi' }], settings, '', [])
    expect(without.some((m) => m.role === 'system' && m.content.includes('剧情事件'))).toBe(false)
  })
})
