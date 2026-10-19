// 编译器纯函数补齐覆盖：世界书触发匹配（搜索与注入都依赖它）、宏替换、状态摘要
// 这些都是纯函数（零 IndexedDB / 零网络），单测成本最低、回归价值最高。
import { describe, it, expect } from 'vitest'
import { matchLore, substMacros, stateSummary } from '../src/lib/compiler.js'

/** 造一条世界书条目：默认值代表"启用的普通条目" */
const e = (o) => ({ enabled: true, priority: 0, keys: '', content: '', ...o })

describe('M · matchLore（世界书触发）', () => {
  it('M1 关键词命中：中英文逗号都能分隔', () => {
    const entries = [e({ keys: '西码头，火灾', content: '仓库起火' })]
    expect(matchLore(entries, '三年前西码头那场火')).toEqual(['仓库起火'])
    expect(matchLore([e({ keys: 'a,b' })], 'xxx b yyy')).toEqual([''])
  })

  it('M2 未命中不注入', () => {
    expect(matchLore([e({ keys: '西码头', content: 'x' })], '今天天气不错')).toEqual([])
  })

  it('M3 常驻条目恒注入，与近期文本无关', () => {
    expect(matchLore([e({ constant: true, content: '常驻设定' })], '任意文本')).toEqual(['常驻设定'])
  })

  it('M4 enabled:false 被跳过（常驻也不例外）', () => {
    const entries = [e({ enabled: false, content: '关掉的' }), e({ enabled: false, constant: true, content: '关掉的常驻' })]
    expect(matchLore(entries, '任意')).toEqual([])
  })

  it('M5 多条命中时按 priority 降序', () => {
    const entries = [
      e({ keys: '码头', priority: 5, content: '低优先级' }),
      e({ keys: '码头', priority: 20, content: '高优先级' }),
    ]
    expect(matchLore(entries, '码头')).toEqual(['高优先级', '低优先级'])
  })

  it('M6 预算裁剪：跳过超预算的条目，但继续装后面的小条目（continue 而非 break）', () => {
    const big = '字'.repeat(1000)   // estTokens ≈ 700 > 默认预算 600
    const entries = [
      e({ keys: '码头', priority: 30, content: big }),
      e({ keys: '码头', priority: 20, content: '小条目' }),
    ]
    expect(matchLore(entries, '码头', 600)).toEqual(['小条目'])
  })

  it('M7 预算为 0 / 极小 → 一条都装不进去', () => {
    expect(matchLore([e({ constant: true, content: '常驻' })], '任意', 0)).toEqual([])
  })

  it('M8 关键词大小写不敏感、首尾空格被 trim', () => {
    expect(matchLore([e({ keys: ' WEST ' })], '他们走向 the west side')).toEqual([''])
  })

  it('M9 空输入返回空数组，不抛错', () => {
    expect(matchLore(null, 'x')).toEqual([])
    expect(matchLore([], 'x')).toEqual([])
    expect(matchLore([e({ keys: '码头', content: 'c' })], null)).toEqual([])
  })

  it('M10 keys 是数组也不崩，且能正常命中（外部工具产的卡防御）', () => {
    // 实测崩溃场景：手工/转换工具构造的卡把 keys 写成数组 → .split TypeError
    const entry = { enabled: true, priority: 0, keys: ['西码头', '火灾'], content: '仓库设定' }
    expect(matchLore([entry], '西码头那场火')).toEqual(['仓库设定'])
    expect(matchLore([entry], '无关文本')).toEqual([])
    // 其他脏形状：数字、对象 → 强转字符串不崩
    expect(() => matchLore([e({ keys: 123, content: 'c' })], 'x')).not.toThrow()
    expect(() => matchLore([e({ keys: { a: 1 }, content: 'c' })], 'x')).not.toThrow()
    expect(() => matchLore([e({ keys: null, content: 'c' })], 'x')).not.toThrow()
  })
})

describe('S · substMacros（宏替换）', () => {
  it('S1 {{char}}→角色名，{{user}}→你', () => {
    expect(substMacros('{{char}}看着{{user}}', { name: '沈砚' })).toBe('沈砚看着你')
  })

  it('S2 大小写不敏感', () => {
    expect(substMacros('{{CHAR}} / {{User}}', { name: '林晚' })).toBe('林晚 / 你')
  })

  it('S3 无卡 / 无名字 → 回落「角色」，绝不抛错', () => {
    expect(substMacros('{{char}}说', null)).toBe('角色说')
    expect(substMacros('{{char}}说', {})).toBe('角色说')
  })

  it('S4 空值原样返回', () => {
    expect(substMacros('', { name: 'x' })).toBe('')
    expect(substMacros(null, { name: 'x' })).toBe(null)
  })
})

describe('T · stateSummary（状态块）', () => {
  it('T1 空状态返回空字符串（不产生多余空行）', () => {
    expect(stateSummary({})).toBe('')
    expect(stateSummary({ characters: {}, facts: [], events: [], relations: [] })).toBe('')
  })

  it('T2 角色：位置 / 情绪 / 目标 / 已知 / 持有', () => {
    const s = {
      characters: { 沈砚: { name: '沈砚', location: '书店二楼', mood: '警惕', goal: '查清火灾', knows: ['照片背面有日期'], inventory: ['修复刀'] } },
    }
    const t = stateSummary(s)
    expect(t).toContain('- 沈砚（位置：书店二楼，情绪：警惕，目标：查清火灾）')
    expect(t).toContain('已知信息：照片背面有日期')
    expect(t).toContain('持有：修复刀')
  })

  it('T3 角色缺字段时不产出空括号', () => {
    const t = stateSummary({ characters: { a: { name: '无名' } } })
    expect(t).toContain('- 无名')
    expect(t).not.toContain('（）')
  })

  it('T4 关系：只取最后 8 条，且过滤缺 from / to 的脏数据', () => {
    const rels = Array.from({ length: 10 }, (_, i) => ({ from: `A${i}`, to: `B${i}`, desc: `关系${i}` }))
    rels.push({ from: '缺 to' })          // 脏数据
    rels.push({ to: '缺 from' })          // 脏数据
    const t = stateSummary({ relations: rels })
    expect(t).toContain('- A9 → B9：关系9')   // 最后一条在
    expect(t).not.toContain('A0 → B0')        // 超出 8 条被丢弃
    expect(t).not.toContain('缺 to')
    expect(t).not.toContain('缺 from')
  })

  it('T5 关系缺描述时显示占位', () => {
    expect(stateSummary({ relations: [{ from: 'A', to: 'B' }] })).toContain('- A → B：（未描述）')
  })

  it('T6 事实取最后 8 条、事件取最后 6 条', () => {
    const facts = Array.from({ length: 10 }, (_, i) => ({ text: `事实${i}` }))
    const events = Array.from({ length: 8 }, (_, i) => ({ text: `事件${i}` }))
    const t = stateSummary({ facts, events })
    expect(t).toContain('事实9')
    expect(t).not.toContain('事实0\n')
    expect(t).toContain('事件7')
    expect(t).not.toContain('事件0\n')
  })
})
