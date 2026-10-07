// P0-1 · importDump 的事务性（需要 IndexedDB：用 fake-indexeddb 提供运行环境）
// 判据：中途失败（重复主键）时，五张表的记录数必须与调用前**完全一致**——不能出现"清了但没写回"。
import 'fake-indexeddb/auto'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/lib/db.js'
import { importDump } from '../src/lib/backup.js'

const TABLES = ['characters', 'sessions', 'messages', 'lore', 'tasks']

const counts = async () => Object.fromEntries(
  await Promise.all(TABLES.map(async (t) => [t, await db.table(t).count()]))
)

beforeAll(async () => { await db.open() })
afterAll(async () => { await db.delete(); db.close() })

beforeEach(async () => {
  await db.transaction('rw', TABLES.map((t) => db.table(t)), async () => {
    for (const t of TABLES) await db.table(t).clear()
    await db.characters.bulkAdd([{ name: '卡A' }, { name: '卡B' }, { name: '卡C' }])
    await db.lore.bulkAdd([{ content: '全局条目1' }])
  })
})

describe('T1-4 · importDump 单事务', () => {
  it('重复主键导致失败时整体回滚，五表记录数与调用前一致', async () => {
    const before = await counts()
    const bad = { characters: [{ id: 1, name: 'A' }, { id: 1, name: 'B' }] }
    await expect(importDump(bad)).rejects.toThrow()
    expect(await counts()).toEqual(before)
  })

  it('合法备份：清空后写入，条数与备份一致', async () => {
    const dump = {
      characters: [{ id: 11, name: '卡X' }],
      sessions: [{ id: 21, name: '故事X', cardSnapshot: { name: '卡X' } }],
      messages: [{ id: 31, sessionId: 21, role: 'user', content: 'hi' }],
      lore: [{ id: 41, content: '条目X' }],
      tasks: [{ id: 51, sessionId: 21, status: 'pending' }],
    }
    const counts2 = await importDump(dump)
    expect(counts2).toEqual({ characters: 1, sessions: 1, messages: 1, lore: 1, tasks: 1 })
    // 导入是"覆盖"语义：原有的 3 张卡与 1 条全局条目已被替换
    expect((await db.characters.toArray()).map((c) => c.name)).toEqual(['卡X'])
  })

  it('写入后不会产生无 sessionId 的孤儿消息', async () => {
    await importDump({
      characters: [{ id: 1, name: '卡A' }],
      sessions: [{ id: 1, name: '故事1' }],
      messages: [{ id: 1, sessionId: 1, role: 'user', content: 'hi' }],
      lore: [],
    })
    const msgs = await db.messages.toArray()
    expect(msgs.every((m) => typeof m.sessionId === 'number')).toBe(true)
  })
})
