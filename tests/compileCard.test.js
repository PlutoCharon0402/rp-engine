// 用真实测试卡「沈砚」验证上下文编译链路（角色卡 → compileMessages → messages）
// 覆盖批次4新增的三处：早期摘要注入、人物关系注入、以及宏展开。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { compileMessages } from '../src/lib/compiler.js'
import { DEFAULT_SETTINGS } from '../src/lib/util.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const raw = JSON.parse(readFileSync(path.join(root, 'test-cards/shenyan.chara.json'), 'utf8'))
const d = raw.data

// 与 cardImport 的映射保持一致（这里不走 File API，直接映射）
const card = {
  name: d.name,
  description: d.description,
  personality: d.personality,
  scenario: d.scenario,
  firstMessage: d.first_mes,
  styleExamples: d.mes_example.split(/<START>/i).map((s) => s.trim()).filter(Boolean).join('\n\n———\n\n'),
  userPersona: d.user_persona,
}

const lore = d.character_book.entries.map((e) => ({
  keys: (e.keys || []).join('，'),
  content: e.content,
  priority: e.insertion_order || 0,
  constant: !!e.constant,
  enabled: e.enabled !== false,
}))

const state = {
  characters: {
    沈砚: {
      name: '沈砚',
      location: '拾遗书店二楼修复台',
      mood: '克制而警惕',
      goal: '弄清这本浸水旧书的来源',
      inventory: ['镊子', '棉手套'],
      knows: ['来人手里那本书浸过水', '潮气还没进到书心'],
    },
  },
  facts: [{ turn: 1, text: '西码头6号仓库三年前起火，官方结论为线路老化' }],
  events: [{ turn: 1, text: '打烊前半小时，来人抱一本浸水旧书进门' }],
  relations: [{ from: '沈砚', to: '周砚秋', desc: '师姐，三年前火灾后失踪', turn: 0 }],
}

const history = [
  { id: 1, role: 'assistant', content: card.firstMessage },
  { id: 2, role: 'user', content: '这本书是我从西码头附近的旧货摊淘来的，里头夹着一张照片。' },
]

const settings = { ...DEFAULT_SETTINGS, depth: 1, maxHistory: 40, loreBudget: 600 }

describe('C1 · 静态前缀（吃前缀缓存的部分）', () => {
  it('角色卡正文 + 常驻世界书都在第 0 条 system 里', () => {
    const msgs = compileMessages(card, lore, state, history, settings)
    const sys = msgs[0].content
    expect(msgs[0].role).toBe('system')
    expect(sys).toContain('沈砚')
    expect(sys).toContain('修复台')
    // 「拾遗书店」条目 constant=true → 固定进前缀
    expect(sys).toContain('临江路 47 号')
    // 非常驻条目不该出现在前缀里
    expect(sys).not.toContain('临时堆场')
  })

  it('文风示例按 <START> 分段后仍被保留', () => {
    const sys = compileMessages(card, lore, state, history, settings)[0].content
    expect(sys).toContain('纸有记忆')
  })
})

describe('C2 · 动态块（状态 / 世界书 / 摘要）', () => {
  const msgs = compileMessages(card, lore, state, history, settings, '三年前冬夜，西码头起火。')
  const dyn = msgs.find((m) => m.role === 'system' && m.content.includes('当前世界状态'))

  it('状态块含角色位置/情绪/目标、事实、事件', () => {
    expect(dyn).toBeTruthy()
    expect(dyn.content).toContain('拾遗书店二楼修复台')
    expect(dyn.content).toContain('西码头6号仓库三年前起火')
    expect(dyn.content).toContain('抱一本浸水旧书进门')
  })

  it('批次4：人物关系进入状态块', () => {
    expect(dyn.content).toContain('人物关系')
    expect(dyn.content).toContain('沈砚 → 周砚秋')
  })

  it('批次4：早期剧情摘要出现在动态块顶部', () => {
    // 摘要是动态块的第一段（"## " 前缀之后即为标题）
    expect(dyn.content.startsWith('## 更早的剧情摘要')).toBe(true)
    expect(dyn.content).toContain('三年前冬夜，西码头起火。')
  })

  it('关键词触发：用户提到「西码头」→ 该条目被注入', () => {
    expect(dyn.content).toContain('临时堆场')
  })

  it('depth=1：动态块紧贴最后一条用户消息之前（prompt 以用户行动收尾）', () => {
    const iDyn = msgs.indexOf(dyn)
    expect(msgs[iDyn + 1].role).toBe('user')
    expect(msgs[iDyn + 1].content).toContain('旧货摊')
    expect(iDyn).toBe(msgs.length - 2)
  })

  it('未命中关键词的条目不注入（控制 token 预算）', () => {
    const quiet = compileMessages(card, lore, state, [
      { id: 1, role: 'user', content: '今天天气不错。' },
    ], settings)
    const dyn2 = quiet.find((m) => m.role === 'system' && m.content.includes('当前世界状态'))
    expect(dyn2.content).not.toContain('临时堆场')
    expect(dyn2.content).toContain('临江路 47 号') // 常驻条目不受影响
  })
})

describe('C3 · 宏与边界', () => {
  it('{{char}} 展开为角色名', () => {
    const withMacro = { ...card, scenario: '{{char}}站在柜台后。' }
    const sys = compileMessages(withMacro, [], state, history, settings)[0].content
    expect(sys).toContain('沈砚站在柜台后。')
    expect(sys).not.toContain('{{char}}')
  })

  it('空状态 / 空世界书 / 空历史都不抛错，且动态块仍带状态头', () => {
    const msgs = compileMessages(card, [], null, [], settings)
    expect(msgs.length).toBeGreaterThanOrEqual(1)
    expect(msgs[0].role).toBe('system')
  })

  it('世界书 token 预算：超预算的触发条目被丢弃', () => {
    const msgs = compileMessages(card, lore, state, history, { ...settings, loreBudget: 1 })
    const dyn3 = msgs.find((m) => m.role === 'system' && m.content.includes('当前世界状态'))
    expect(dyn3.content).not.toContain('临时堆场')
  })
})

describe('C4 · 导演指令（C8：用户对扮演者的执导要求）', () => {
  const director = {
    enabled: true,
    notes: [
      { id: 'd1', text: '文风再冷一点，少用感叹号', createdAt: 1 },
      { id: 'd2', text: '{{char}}先别揭穿他，吊着', createdAt: 2 },
    ],
  }

  it('注入动态块末尾（紧贴生成点），多条指令都在且带宏替换', () => {
    const msgs = compileMessages(card, lore, state, history, settings, null, null, director)
    const dyn = msgs.find((m) => m.role === 'system' && m.content.includes('导演指令'))
    expect(dyn).toBeTruthy()
    expect(dyn.content).toContain('必须遵守')
    expect(dyn.content).toContain('1. 文风再冷一点，少用感叹号')
    expect(dyn.content).toContain('2. 沈砚先别揭穿他，吊着') // 指令支持 {{char}} 宏
    expect(dyn.content).not.toContain('{{char}}')
  })

  it('enabled=false 时整段不注入（保留数据，只是不进 prompt）', () => {
    const msgs = compileMessages(card, lore, state, history, settings, null, null, { ...director, enabled: false })
    expect(msgs.every((m) => !String(m.content).includes('导演指令'))).toBe(true)
  })

  it('空指令列表 / 纯空白文本 / director 缺省：都不注入', () => {
    const all = (d) => compileMessages(card, lore, state, history, settings, null, null, d).every((m) => !String(m.content).includes('导演指令'))
    expect(all({ enabled: true, notes: [] })).toBe(true)
    expect(all({ enabled: true, notes: [{ id: 'x', text: '   ', createdAt: 1 }] })).toBe(true)
    expect(all(undefined)).toBe(true)
  })

  it('不进静态前缀（第 0 条 system），只在动态块——alpha.8 曾放前缀被稀释，已纠正', () => {
    const msgs = compileMessages(card, lore, state, history, settings, '摘要', null, director)
    expect(msgs[0].content).not.toContain('导演指令')
    const dyn = msgs.find((m) => m.role === 'system' && m.content.includes('导演指令'))
    // 动态块中导演指令位于世界书补充之后（末尾）
    expect(dyn.content.indexOf('导演指令')).toBeGreaterThan(dyn.content.indexOf('世界书补充设定'))
  })
})
