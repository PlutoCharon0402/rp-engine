// 批次4 · 会话级参数覆盖与用量格式化
import { describe, it, expect } from 'vitest'
import { effectiveSettings, fmtTokens, totalTokens, emptyUsage } from '../src/lib/util.js'

const GLOBAL = { temperature: 1.1, maxTokens: 1024, depth: 1, model: 'deepseek-chat' }

describe('P1 · effectiveSettings（会话参数覆盖）', () => {
  it('填了的字段覆盖全局，没填的跟随全局', () => {
    const out = effectiveSettings(GLOBAL, { temperature: 0.7, maxTokens: null })
    expect(out.temperature).toBe(0.7)
    expect(out.maxTokens).toBe(1024)
    expect(out.model).toBe('deepseek-chat')
  })

  it('null / undefined / 空串都视为「未设置」，不改变全局值', () => {
    for (const v of [null, undefined, '']) {
      expect(effectiveSettings(GLOBAL, { model: v }).model).toBe('deepseek-chat')
    }
  })

  it('overrides 为空 / 缺失时等于全局；返回新对象，不改原对象', () => {
    expect(effectiveSettings(GLOBAL, {})).toEqual(GLOBAL)
    expect(effectiveSettings(GLOBAL, null)).toEqual(GLOBAL)
    const copy = { ...GLOBAL }
    effectiveSettings(GLOBAL, { temperature: 0.1 })
    expect(GLOBAL).toEqual(copy)
  })

  it('允许覆盖全局里原本没有的键（如未来的新参数）', () => {
    expect(effectiveSettings(GLOBAL, { foo: 'bar' }).foo).toBe('bar')
  })
})

describe('P2 · 用量统计', () => {
  it('totalTokens = prompt + completion，缺失字段按 0 计', () => {
    expect(totalTokens({ prompt: 100, completion: 50 })).toBe(150)
    expect(totalTokens(null)).toBe(0)
    expect(totalTokens({})).toBe(0)
  })

  it('fmtTokens 紧凑显示', () => {
    expect(fmtTokens(980)).toBe('980')
    expect(fmtTokens(12345)).toBe('12.3k')
    expect(fmtTokens(123456)).toBe('123k')
    expect(fmtTokens(2_500_000)).toBe('2.5M')
    expect(fmtTokens(undefined)).toBe('0')
  })

  it('emptyUsage 五项全 0', () => {
    expect(emptyUsage()).toEqual({ calls: 0, prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 })
  })
})
