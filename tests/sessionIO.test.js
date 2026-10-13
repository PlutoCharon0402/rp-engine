// sessionIO.js 覆盖：文件名 / 转录文本两个纯函数 + 导出、导入往返（需要 IndexedDB）
import 'fake-indexeddb/auto'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/lib/db.js'
import {
  buildSessionExport,
  transcriptText,
  safeFileName,
  importSessionFile,
} from '../src/lib/sessionIO.js'

const TABLES = ['characters', 'sessions', 'messages', 'lore']

/** 会话文件替身：实现只用 file.text() */
const asFile = (obj) => ({ text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) })

const CARD = {
  name: '沈砚',
  description: '修复师',
  personality: '话少',
  scenario: '雾屿市',
  firstMessage: '打烊前半小时。',
  styleExamples: '示例',
  userPersona: '来客',
  alternateGreetings: ['备选开场'],
  embeddedLore: [],
}

beforeAll(async () => { await db.open() })
afterAll(async () => { await db.delete(); db.close() })

beforeEach(async () => {
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) await db.table(t).clear()
  })
})

async function seed() {
  const cid = await db.characters.add({ ...CARD })
  const sid = await db.sessions.add({
    name: '浸水的旧书',
    characterId: cid,
    cardSnapshot: { name: '沈砚' },
    state: { characters: {}, facts: [{ text: '事实1' }], events: [], relations: [] },
    lore: [{ content: '本故事条目' }],
    summary: '早期摘要',
    createdAt: 1000,
    updatedAt: 2000,
  })
  await db.messages.bulkAdd([
    { sessionId: sid, role: 'user', content: '我带来一本书', turn: 1, ts: 10 },
    { sessionId: sid, role: 'assistant', content: '坐下说', turn: 2, ts: 20 },
  ])
  return { cid, sid }
}

describe('X1 · safeFileName（下载文件名）', () => {
  it('非法字符、空白替换为下划线', () => {
    expect(safeFileName('a/b:c*d?e"f<g>h|i j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('超长截断到 40，空值回落 session', () => {
    expect(safeFileName('字'.repeat(100))).toHaveLength(40)
    expect(safeFileName('')).toBe('session')
    expect(safeFileName(null)).toBe('session')
    expect(safeFileName(undefined)).toBe('session')
  })
})

describe('X2 · transcriptText（TXT 转录）', () => {
  it('含会话名与消息数，user 显示为「你」，assistant 显示为角色名', () => {
    const t = transcriptText({
      card: { name: '沈砚' },
      session: { name: '浸水的旧书' },
      exportedAt: new Date(0).toISOString(),
      messages: [
        { role: 'user', content: '甲' },
        { role: 'assistant', content: '乙' },
      ],
    })
    expect(t).toContain('浸水的旧书')
    expect(t).toContain('2 条消息')
    expect(t).toContain('你：\n甲')
    expect(t).toContain('沈砚：\n乙')
  })

  it('无角色卡时回落「角色」', () => {
    const t = transcriptText({ session: { name: 'S' }, exportedAt: new Date(0).toISOString(), messages: [{ role: 'assistant', content: '乙' }] })
    expect(t).toContain('角色：\n乙')
  })
})

describe('X3 · buildSessionExport（无损导出）', () => {
  it('导出结构与字段完整：原卡补齐快照没有的字段（开场白 / 备选开场）', async () => {
    const { sid } = await seed()
    const exp = await buildSessionExport(sid)
    expect(exp).toMatchObject({ app: 'rp-engine', type: 'session', version: 1 })
    expect(exp.session.name).toBe('浸水的旧书')
    expect(exp.session.summary).toBe('早期摘要')
    expect(exp.session.state.facts).toEqual([{ text: '事实1' }])
    expect(exp.card.name).toBe('沈砚')
    expect(exp.card.firstMessage).toBe('打烊前半小时。')   // 来自原卡
    expect(exp.card.alternateGreetings).toEqual(['备选开场'])
    expect(exp.messages).toHaveLength(2)
    expect(exp.messages[0]).toMatchObject({ role: 'user', content: '我带来一本书', turn: 1 })
  })

  it('导出的本故事世界书带 uid（再导入后删 1 条只掉 1 条）', async () => {
    const { sid } = await seed()
    const exp = await buildSessionExport(sid)
    expect(exp.session.lore[0].uid).toBeTruthy()
  })

  it('会话不存在时抛错', async () => {
    await expect(buildSessionExport(999999)).rejects.toThrow('会话不存在')
  })
})

describe('X4 · importSessionFile（导入）', () => {
  it('坏 JSON / 非本应用文件 / 空消息：三类输入都被拒绝', async () => {
    await expect(importSessionFile(asFile('{不是JSON'))).rejects.toThrow('JSON 解析失败')
    await expect(importSessionFile(asFile({ app: 'other', type: 'session' }))).rejects.toThrow('不是 RP Engine')
    await expect(importSessionFile(asFile({ app: 'rp-engine', type: 'session', messages: [] }))).rejects.toThrow('没有消息数据')
  })

  it('合法文件：建卡 + 建会话 + 建消息，统计从零开始', async () => {
    const sid = await importSessionFile(asFile({
      app: 'rp-engine',
      type: 'session',
      session: { name: '导入的故事', state: { characters: {}, facts: [], events: [], relations: [] }, lore: [{ content: '条目' }], summary: '摘要' },
      card: { ...CARD },
      messages: [{ role: 'user', content: '甲' }, { role: 'assistant', content: '乙' }],
    }))
    const s = await db.sessions.get(sid)
    expect(s.name).toBe('导入的故事')
    expect(s.summary).toBe('摘要')
    expect(s.summaryUpTo).toBe(0)          // 消息 id 是新建的，旧进度无意义
    expect(s.params).toEqual({})           // 导入故事默认跟随全局
    expect(s.usage).toEqual({ calls: 0, prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 })
    expect(s.lore[0].uid).toBeTruthy()     // 老导出无 uid 时补齐
    expect(await db.messages.where('sessionId').equals(sid).count()).toBe(2)
    expect(await db.characters.count()).toBe(1)
  })

  it('同名角色卡被复用（不重复建卡）', async () => {
    const file = asFile({
      app: 'rp-engine',
      type: 'session',
      session: { name: 'S1' },
      card: { ...CARD },
      messages: [{ role: 'user', content: '甲' }],
    })
    await importSessionFile(file)
    await importSessionFile(file)
    expect(await db.characters.where('name').equals('沈砚').count()).toBe(1)
  })

  it('无角色卡快照时用会话名建占位卡', async () => {
    const sid = await importSessionFile(asFile({
      app: 'rp-engine',
      type: 'session',
      session: { name: '无名故事' },
      card: null,
      messages: [{ role: 'user', content: '甲' }],
    }))
    const s = await db.sessions.get(sid)
    const c = await db.characters.get(s.characterId)
    expect(c.name).toBe('无名故事')
  })

  it('导出 → 导入 往返：消息与状态保持一致', async () => {
    const { sid } = await seed()
    const exp = await buildSessionExport(sid)
    const sid2 = await importSessionFile(asFile(exp))
    const s2 = await db.sessions.get(sid2)
    expect(s2.name).toBe('浸水的旧书')
    expect(s2.state.facts).toEqual([{ text: '事实1' }])
    const msgs = await db.messages.where('sessionId').equals(sid2).toArray()
    expect(msgs).toHaveLength(2)
    expect(msgs[1].content).toBe('坐下说')
  })
})
