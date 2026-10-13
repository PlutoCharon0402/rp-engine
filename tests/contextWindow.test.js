// 批次6：上下文窗口感知裁剪。trimHistory 纯函数 + compileMessages 集成。
import { describe, expect, it } from 'vitest'
import { trimHistory, compileMessages } from '../src/lib/compiler.js'

const msg = (role, content, turn) => ({ id: turn, role, content, turn })

describe('W1 · trimHistory', () => {
  const history = [
    msg('user', '旧消息一', 1),
    msg('assistant', '旧回复一', 1),
    msg('user', '新消息', 2),
    msg('assistant', '新回复', 2),
  ]

  it('条数上限生效（从最新往回保留）', () => {
    expect(trimHistory(history, 2, 1e9).map((m) => m.content)).toEqual(['新消息', '新回复'])
  })

  it('token 预算生效：从最新往回装，装不下即止', () => {
    // 预算只够最后 1 条（中文约 0.7 token/字 + 4 开销）
    const out = trimHistory(history, 40, 10)
    expect(out.map((m) => m.content)).toEqual(['新回复'])
  })

  it('预算极小也至少保留最新 1 条（截断好过空历史）', () => {
    const out = trimHistory(history, 40, 1)
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('新回复')
  })

  it('预算充足 = 条数上限说了算；非对话角色被过滤', () => {
    const withTool = [...history, msg('tool', 'x', 0)]
    expect(trimHistory(withTool, 40, 1e9)).toHaveLength(4)
    expect(trimHistory(null, 40, 1e9)).toEqual([])
    expect(trimHistory(history, 0, 1e9)).toHaveLength(4)  // 0 视为未设置 → 默认 40（与旧版语义一致）
    expect(trimHistory(history, -5, 1e9)).toHaveLength(1) // 负数 → 只留最新 1 条
  })
})

describe('W2 · compileMessages 窗口感知', () => {
  const card = { name: '沈砚', description: '修复师' }
  // 长消息（约 46 token/条）：让 token 预算成为有效约束
  const mkHistory = (n) => Array.from({ length: n }, (_, i) => msg(i % 2 ? 'assistant' : 'user', '字'.repeat(60), Math.floor(i / 2) + 1))
  const base = { maxHistory: 200, depth: 1, loreBudget: 600 }

  it('大窗口厂商：历史按条数上限全带（行为与旧版一致）', () => {
    const s = { ...base, providerId: 'deepseek', providers: { deepseek: { id: 'deepseek', apiKey: 'k', context: 65536 } } }
    const out = compileMessages(card, [], null, mkHistory(20), s)
    const hist = out.filter((m) => m.role !== 'system')
    expect(hist).toHaveLength(20)
  })

  it('小窗口厂商：历史按 token 预算裁剪，不超窗', () => {
    const s = { ...base, providerId: 'smol', providers: { smol: { id: 'smol', adapter: 'openai', apiKey: 'k', models: ['m'], defaultModel: 'm', context: 2048 } } }
    const out = compileMessages(card, [], null, mkHistory(40), s)
    const hist = out.filter((m) => m.role !== 'system')
    expect(hist.length).toBeLessThan(40)   // 被预算裁了
    expect(hist.length).toBeGreaterThanOrEqual(1)
    // 静态前缀 + 裁剪后历史 ≈ 不超过窗口（粗校验：估算 token 总量 < context）
    const total = out.reduce((n, m) => n + Math.ceil(m.content.length * 0.7) + 4, 0)
    expect(total).toBeLessThan(2048)
  })

  it('无厂商信息：保守按 32k 窗口，不抛错', () => {
    const out = compileMessages(card, [], null, mkHistory(30), { ...base })
    expect(out.filter((m) => m.role !== 'system')).toHaveLength(30)
  })
})
