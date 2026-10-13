// util.js 纯函数覆盖：token 估算、格式化、设置读写的容错
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, estTokens, fmtTokens, fmtTime, loadSettings, saveSettings } from '../src/lib/util.js'

describe('E · estTokens（启发式估算）', () => {
  it('E1 空串 / 未传 → 0', () => {
    expect(estTokens('')).toBe(0)
    expect(estTokens()).toBe(0)
  })

  it('E2 中文按 0.7 token/字向上取整', () => {
    expect(estTokens('你好')).toBe(2)        // 1.4 → 2
    expect(estTokens('中')).toBe(1)          // 0.7 → 1
  })

  it('E3 拉丁文本按 1/4 估算', () => {
    expect(estTokens('abcd')).toBe(1)
    expect(estTokens('a'.repeat(100))).toBe(25)
  })

  it('E4 中英混排：两段分别估算后相加', () => {
    expect(estTokens('你好abcd')).toBe(estTokens('你好') + estTokens('abcd'))
  })
})

describe('F · fmtTokens（紧凑显示）', () => {
  it('F1 <1000 原样输出', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(980)).toBe('980')
  })

  it('F2 千位：小于 10 万保留一位小数，否则取整', () => {
    expect(fmtTokens(12345)).toBe('12.3k')
    expect(fmtTokens(150000)).toBe('150k')
  })

  it('F3 百万位：保留一位小数 + M', () => {
    expect(fmtTokens(2_500_000)).toBe('2.5M')
  })

  it('F4 非法输入回落 0', () => {
    expect(fmtTokens(null)).toBe('0')
    expect(fmtTokens('abc')).toBe('0')
  })
})

describe('FT · fmtTime', () => {
  it('月/日 时:分，时与分补零', () => {
    expect(fmtTime(new Date(2026, 0, 5, 9, 5).getTime())).toBe('1/5 09:05')
    expect(fmtTime(new Date(2026, 11, 25, 18, 30).getTime())).toBe('12/25 18:30')
  })
})

describe('LS · loadSettings / saveSettings', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('LS1 无存储 / 存储损坏 → 返回可用设置（绝不因脏数据白屏）', () => {
    vi.stubGlobal('localStorage', { getItem: () => null })
    // loadSettings 会跑老配置迁移（附加 providers 覆盖表），故用 matchObject 断言关键字段
    expect(loadSettings()).toMatchObject(DEFAULT_SETTINGS)
    vi.stubGlobal('localStorage', { getItem: () => '{不是JSON' })
    expect(loadSettings()).toMatchObject(DEFAULT_SETTINGS)
  })

  it('LS2 正常读取：与默认值合并，缺省字段补默认', () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ model: 'qwen-plus', temperature: 0.5 }) })
    const s = loadSettings()
    expect(s.model).toBe('qwen-plus')
    expect(s.temperature).toBe(0.5)
    expect(s.maxTokens).toBe(DEFAULT_SETTINGS.maxTokens)
  })

  it('LS3 保存：写入的是可解析 JSON', () => {
    const store = {}
    vi.stubGlobal('localStorage', { setItem: (k, v) => { store[k] = v } })
    saveSettings({ ...DEFAULT_SETTINGS, model: 'm1' })
    expect(JSON.parse(store['rp.settings']).model).toBe('m1')
  })
})
