// P0-1 · 全量导入校验（纯函数，无需 IndexedDB）
// 命门用例 T1-1：.session.json 必须被拦截 —— 这是"点 3 下就静默清库"的最危险路径。
import { describe, it, expect } from 'vitest'
import { validateDump } from '../src/lib/backup.js'

/** 应用自己导出的单故事文件（.session.json）：顶层含 messages 数组，曾被真实写回成孤儿消息 */
const sessionFile = () => ({
  app: 'rp-engine',
  type: 'session',
  version: 1,
  exportedAt: new Date().toISOString(),
  session: { name: '林晚的新故事', state: {}, lore: [], createdAt: 1, updatedAt: 1 },
  card: { name: '林晚', description: 'd', personality: 'p', scenario: 's' },
  messages: [{ role: 'user', content: '你好', turn: 1, ts: 1 }],
})

const validDump = () => ({
  characters: [{ id: 1, name: '卡A' }, { id: 2, name: '卡B' }],
  sessions: [{ id: 1, name: '故事1', characterId: 1 }],
  messages: [{ id: 1, sessionId: 1, role: 'user', content: 'hi' }],
  lore: [{ id: 1, content: '王城设定' }],
})

describe('T1 · validateDump', () => {
  it('T1-1 命门：.session.json 必须被拦截', () => {
    expect(() => validateDump(sessionFile())).toThrow(/单个故事的导出文件/)
  })

  it('T1-1b 会话文件即使带 characters 也仍然被拦截', () => {
    expect(() => validateDump({ ...sessionFile(), characters: [{ name: '卡A' }] })).toThrow(/单个故事的导出文件/)
  })

  it('T1-2 参数化拒绝：null / 数组 / 空对象 / 类型错误 / 空记录 / 缺字段', () => {
    for (const bad of [null, undefined, 42, '{}', [], {}]) {
      expect(() => validateDump(bad), `应拒绝 ${JSON.stringify(bad)}`).toThrow()
    }
    expect(() => validateDump({ characters: 'x' })).toThrow(/不是数组|没有可导入的数据/)
    expect(() => validateDump({ characters: [null] })).toThrow(/不是对象/)
    expect(() => validateDump({ characters: [{}] })).toThrow(/缺少字段 name/)
    expect(() => validateDump({ characters: [{ name: 'A' }], sessions: 'x' })).toThrow(/不是数组/)
    expect(() => validateDump({ messages: [{ role: 'user', content: 'x' }] })).toThrow(/缺少字段 sessionId/)
  })

  it('T1-3 接受合法备份并返回正确的表与条数', () => {
    const r = validateDump(validDump())
    expect(r.tables).toEqual(['characters', 'sessions', 'messages', 'lore'])
    expect(r.counts).toEqual({ characters: 2, sessions: 1, messages: 1, lore: 1 })
  })

  it('T1-3b 含 tasks 的备份也接受，且 tasks 排在最后（confirm 文案可读）', () => {
    const r = validateDump({ ...validDump(), tasks: [{ id: 1, sessionId: 1, status: 'pending' }] })
    expect(r.tables).toEqual(['characters', 'sessions', 'messages', 'lore', 'tasks'])
    expect(r.counts.tasks).toBe(1)
  })
})
