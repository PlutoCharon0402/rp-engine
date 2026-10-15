// 批次9：时间线分支。getTimeline 树感知遍历 + sessionIO 导入导出往返（含 parent 链 / 存档）。
import 'fake-indexeddb/auto'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db, getTimeline, setTimelineHead, getMessages } from '../src/lib/db.js'
import { buildSessionExport, importSessionFile } from '../src/lib/sessionIO.js'

beforeAll(async () => { await db.open() })
afterAll(async () => { await db.delete(); db.close() })
beforeEach(async () => {
  await Promise.all([db.sessions.clear(), db.messages.clear(), db.characters.clear()])
})

/** 建线性链 A→B→C（带 parent），返回 {sid, ids} */
async function seedChain() {
  const sid = await db.sessions.add({ name: 'S', state: { characters: {}, facts: [], events: [], relations: [] } })
  const ids = []
  let prev = null
  for (const [role, content] of [['assistant', 'A'], ['user', 'B'], ['assistant', 'C']]) {
    const id = await db.messages.add({ sessionId: sid, role, content, turn: ids.length + 1, ts: 1, parentId: prev })
    ids.push(id)
    prev = id
  }
  await db.sessions.update(sid, { activeMsgId: ids[ids.length - 1] })
  return { sid, ids }
}

describe('TL1 · getTimeline（树感知遍历）', () => {
  it('旧会话（无任何 parentId）→ 全量线性，行为与旧版一致', async () => {
    const sid = await db.sessions.add({ name: 'S' })
    await db.messages.bulkAdd([
      { sessionId: sid, role: 'user', content: 'u1', ts: 1 },
      { sessionId: sid, role: 'assistant', content: 'a1', ts: 2 },
    ])
    const tl = await getTimeline(sid)
    expect(tl.map((m) => m.content)).toEqual(['u1', 'a1'])
  })

  it('线性链全量返回；从中间分支后只显示活动链', async () => {
    const { sid, ids } = await seedChain()
    expect((await getTimeline(sid)).map((m) => m.content)).toEqual(['A', 'B', 'C'])
    // 从 B 分支出 D：D.parent = B，活动指针 = D
    const dId = await db.messages.add({ sessionId: sid, role: 'assistant', content: 'D', turn: 3, ts: 2, parentId: ids[1] })
    await setTimelineHead(sid, dId)
    expect((await getTimeline(sid)).map((m) => m.content)).toEqual(['A', 'B', 'D']) // C 进入暗线
  })

  it('切回旧分支：活动指针指回 C 即恢复原线', async () => {
    const { sid, ids } = await seedChain()
    const dId = await db.messages.add({ sessionId: sid, role: 'assistant', content: 'D', turn: 3, ts: 2, parentId: ids[1] })
    await setTimelineHead(sid, dId)
    await setTimelineHead(sid, ids[2])
    expect((await getTimeline(sid)).map((m) => m.content)).toEqual(['A', 'B', 'C'])
  })

  it('activeMsgId 失效（指向已删消息）→ 回退到最新消息的链，绝不返回空', async () => {
    const { sid, ids } = await seedChain()
    await db.sessions.update(sid, { activeMsgId: 99999 })
    const tl = await getTimeline(sid)
    expect(tl.length).toBeGreaterThan(0)
    expect(tl[tl.length - 1].content).toBe('C')
  })

  it('getMessages 仍返回全量（含暗线）——分支数据没有丢', async () => {
    const { sid, ids } = await seedChain()
    await db.messages.add({ sessionId: sid, role: 'assistant', content: 'D', turn: 3, ts: 2, parentId: ids[1] })
    expect((await getMessages(sid))).toHaveLength(4)
  })
})

describe('TL2 · 导出 / 导入往返（时间线感知）', () => {
  it('导出的是当前时间线（暗线不导出），活动位置与存档按下标还原', async () => {
    const { sid, ids } = await seedChain()
    // 分支：B→D，活动指针在 D；再放一个存档（消息位置 B + 状态快照）
    const dId = await db.messages.add({ sessionId: sid, role: 'assistant', content: 'D', turn: 3, ts: 2, parentId: ids[1] })
    await db.sessions.update(sid, {
      activeMsgId: dId,
      hookLog: [{ ruleId: 1, name: '规则A', turn: 2, ts: 1 }],
      pendingHints: [{ ruleId: 1, text: '提示' }],
      snapshots: [{ id: 's1', name: '存档1', state: { characters: {}, facts: [{ turn: 1, text: 'F' }], events: [], relations: [] }, ts: 1, msgId: ids[1] }],
    })

    const exp = await buildSessionExport(sid)
    expect(exp.messages.map((m) => m.content)).toEqual(['A', 'B', 'D']) // C 在暗线，不导出
    expect(exp.session.activeMsgIndex).toBe(2)                          // 指向 D
    expect(exp.session.snapshots[0].msgIndex).toBe(1)                   // 指向 B
    expect(exp.session.hookLog).toHaveLength(1)
    expect(exp.session.pendingHints).toEqual([{ ruleId: 1, text: '提示' }])

    // 导入：parent 链重建、活动指针与存档指向新消息
    const sid2 = await importSessionFile({ text: async () => JSON.stringify(exp) })
    const s2 = await db.sessions.get(sid2)
    const msgs2 = await getMessages(sid2)
    expect(msgs2.map((m) => m.content)).toEqual(['A', 'B', 'D'])
    expect(msgs2.map((m) => m.parentId)).toEqual([null, msgs2[0].id, msgs2[1].id]) // 链完整
    expect(s2.activeMsgId).toBe(msgs2[2].id)
    expect(s2.snapshots[0].msgId).toBe(msgs2[1].id)
    expect(s2.snapshots[0].state.facts).toEqual([{ turn: 1, text: 'F' }])
    expect(s2.hookLog).toHaveLength(1)
    expect(s2.pendingHints).toEqual([{ ruleId: 1, text: '提示' }])
    // 导入后 getTimeline 正常工作（有 parentId → 走链回溯）
    expect((await getTimeline(sid2)).map((m) => m.content)).toEqual(['A', 'B', 'D'])
  })

  it('老格式导出（无 activeMsgIndex / snapshots）→ 导入后按全量线性 + 指针指向末尾', async () => {
    const exp = {
      app: 'rp-engine', type: 'session',
      session: { name: '老故事', state: { characters: {}, facts: [], events: [], relations: [] }, lore: [] },
      card: null,
      messages: [
        { role: 'assistant', content: '开场', turn: 0, ts: 1 },
        { role: 'user', content: 'u', turn: 1, ts: 2 },
      ],
    }
    const sid = await importSessionFile({ text: async () => JSON.stringify(exp) })
    const s = await db.sessions.get(sid)
    const msgs = await getMessages(sid)
    expect(s.activeMsgId).toBe(msgs[1].id)
    expect((await getTimeline(sid))).toHaveLength(2)
  })
})
