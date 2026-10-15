// 批次3 · 全量快照（backups 表）
// 判据：① 快照记下六表条数（v5 起含 rules）；② 只保留最近 3 张（protectId 豁免）；
//      ③ 恢复前先给当前数据拍照（恢复也能反悔）；④ 导入不得清掉快照 —— 否则快照毫无意义。
import 'fake-indexeddb/auto'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/lib/db.js'
import { importDump, buildDump, snapshotBackup, pruneBackups, listBackups, restoreBackup } from '../src/lib/backup.js'

const TABLES = ['characters', 'sessions', 'messages', 'lore', 'tasks', 'rules']

const names = async () => (await db.characters.toArray()).map((c) => c.name)

beforeAll(async () => { await db.open() })
afterAll(async () => { await db.delete(); db.close() })

beforeEach(async () => {
  await db.transaction('rw', [...TABLES.map((t) => db.table(t)), db.backups], async () => {
    for (const t of TABLES) await db.table(t).clear()
    await db.backups.clear()
    await db.characters.bulkAdd([{ name: '卡A' }])
  })
})

describe('B1 · 快照写入', () => {
  it('buildDump 覆盖六张表；快照记录条数与 dump 本体', async () => {
    const dump = await buildDump()
    expect(Object.keys(dump).sort()).toEqual([...TABLES].sort())

    const { id, counts } = await snapshotBackup('测试快照')
    expect(counts.characters).toBe(1)

    const snap = await db.backups.get(id)
    expect(snap.reason).toBe('测试快照')
    expect(snap.dump.characters[0].name).toBe('卡A')
  })

  it('listBackups 不含 dump 本体（避免把整库读进内存）', async () => {
    await snapshotBackup('x')
    const list = await listBackups()
    expect(list.length).toBe(1)
    expect(list[0].dump).toBeUndefined()
    expect(list[0].counts.characters).toBe(1)
  })
})

describe('B2 · 快照清理', () => {
  it('只保留最近 3 张，被 protectId 指名的老快照豁免', async () => {
    const base = Date.now() - 10000
    for (let i = 0; i < 5; i++) {
      await db.backups.add({ createdAt: base + i * 1000, reason: `s${i}`, counts: {}, dump: {} })
    }
    const oldest = (await db.backups.orderBy('createdAt').toArray())[0].id

    await pruneBackups(3, oldest)
    const left = await listBackups()
    expect(left.length).toBe(4) // 最近 3 张 + 1 张豁免
    expect(left.map((b) => b.reason)).toEqual(['s4', 's3', 's2', 's0'])
  })
})

describe('B3 · 恢复', () => {
  it('恢复会先给当前数据拍照，再覆盖写入', async () => {
    await snapshotBackup('目标快照') // 此刻库里是「卡A」
    const target = (await listBackups()).find((b) => b.reason === '目标快照').id

    await db.characters.clear()
    await db.characters.add({ name: '卡B' })

    const { counts, undoId } = await restoreBackup(target)
    expect(counts.characters).toBe(1)
    expect(await names()).toEqual(['卡A'])

    // 恢复前的数据（卡B）被保住 → 恢复也能反悔
    const undo = await db.backups.get(undoId)
    expect(undo.reason).toBe('恢复前自动快照')
    expect(undo.dump.characters[0].name).toBe('卡B')
  })

  it('恢复不存在的快照会抛错，且不动现有数据', async () => {
    await expect(restoreBackup(999999)).rejects.toThrow('不存在')
    expect(await names()).toEqual(['卡A'])
  })
})

describe('B4 · 导入与快照共存', () => {
  it('全量导入后快照仍在（backups 不在清空范围）', async () => {
    await snapshotBackup('导入前自动快照')
    await importDump({ characters: [{ id: 99, name: '导入卡' }], sessions: [], messages: [], lore: [] })

    expect(await names()).toEqual(['导入卡'])
    const list = await listBackups()
    expect(list.length).toBe(1)
    expect(list[0].reason).toBe('导入前自动快照')

    // 快照能真的把数据救回来
    await restoreBackup(list[0].id)
    expect(await names()).toEqual(['卡A'])
  })
})
