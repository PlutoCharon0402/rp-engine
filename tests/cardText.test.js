// P0-3 · 角色卡缺失时的编译防御
// 命门用例 T3-1：cardText 对 null / undefined 都不能抛 TypeError
// —— 历史上正是这里抛错，导致删卡后的故事"每发一条就多一条永远收不到回复的孤儿消息"。
import { describe, it, expect } from 'vitest'
import { cardText } from '../src/lib/compiler.js'
import { snapshotOf } from '../src/lib/cardRef.js'

describe('T3 · 角色卡缺失防御', () => {
  it('T3-1 cardText(null) / cardText(undefined) / cardText({}) 均不抛错', () => {
    for (const c of [null, undefined, {}]) {
      expect(() => cardText(c)).not.toThrow()
      const t = cardText(c)
      expect(typeof t).toBe('string')
      expect(t).toContain('未命名')
    }
  })

  it('T3-1b 正常卡片不受影响（人设字段全部进入前缀）', () => {
    const t = cardText({ name: '林晚', description: '背景', personality: '性格', scenario: '场景', userPersona: '用户', styleExamples: '文风' })
    expect(t).toContain('林晚')
    expect(t).toContain('背景')
    expect(t).toContain('场景')
    expect(t).toContain('文风')
  })

  it('T3-2 snapshotOf：无卡返回 null；只取字符串人设字段', () => {
    expect(snapshotOf(null)).toBe(null)
    expect(snapshotOf(undefined)).toBe(null)
    expect(snapshotOf({ description: 'x' })).toBe(null) // 没有 name → 视为无效快照
    const s = snapshotOf({ name: '林晚', description: 'd', personality: 'p', scenario: 's', userPersona: 'u', styleExamples: 'e', embeddedLore: [1, 2], firstMessage: 'hi' })
    expect(s).toEqual({ name: '林晚', description: 'd', personality: 'p', scenario: 's', userPersona: 'u', styleExamples: 'e' })
    expect(s.embeddedLore).toBeUndefined()
    expect(s.firstMessage).toBeUndefined()
  })
})
