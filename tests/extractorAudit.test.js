// 批次7：提取审计（stateLog）+ 撤销 + 回溯重放 + 提示词自定义。
// api.js 用 mock 顶掉（extractor 与回溯共用 makeApi），IndexedDB 用 fake。
import 'fake-indexeddb/auto'
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }))
vi.mock('../src/lib/api.js', () => ({ makeApi: () => ({ complete: completeMock }) }))

const { extractorSys, EXTRACTOR_SYS, processPendingTasks, reExtractFrom, undoExtract } = await import('../src/lib/extractor.js')
const { db } = await import('../src/lib/db.js')

const empty = { characters: {}, facts: [], events: [], relations: [] }
const settings = { apiKey: 'k' }

/** 造一个会话：stateLog 给定、消息按 (turn, user, assistant) 列表生成 */
async function seed(log, rounds, state = empty) {
  const sid = await db.sessions.add({ name: 'S', state, stateLog: log, updatedAt: 1 })
  const ids = []
  for (const [turn, u, a] of rounds) {
    const uid = await db.messages.add({ sessionId: sid, role: 'user', content: u, turn })
    const aid = await db.messages.add({ sessionId: sid, role: 'assistant', content: a, turn })
    ids.push({ turn, uid, aid })
  }
  return { sid, ids }
}

beforeAll(async () => { await db.open() })
afterAll(async () => { await db.delete(); db.close() })
beforeEach(async () => {
  await Promise.all([db.sessions.clear(), db.messages.clear(), db.tasks.clear()])
  completeMock.mockReset()
})

describe('XP · 提取提示词自定义', () => {
  it('自定义优先，空 / 纯空白回落内置', () => {
    expect(extractorSys({ extractorPrompt: '我的提示词' })).toBe('我的提示词')
    expect(extractorSys({ extractorPrompt: '   ' })).toBe(EXTRACTOR_SYS)
    expect(extractorSys({})).toBe(EXTRACTOR_SYS)
    expect(extractorSys(null)).toBe(EXTRACTOR_SYS)
  })
})

describe('XQ · processPendingTasks 写审计日志', () => {
  it('提取成功：state 更新，stateLog 记录提取前快照与 diff', async () => {
    const { sid, ids } = await seed([], [[1, '用户甲', '角色乙']])
    await db.tasks.add({ sessionId: sid, userMsgId: ids[0].uid, assistantMsgId: ids[0].aid, status: 'pending', attempts: 0 })
    completeMock.mockResolvedValue(JSON.stringify({ characters: { 沈砚: { location: '书店' } }, facts_add: ['照片背后有日期'] }))

    await processPendingTasks(sid, settings, () => {})

    const s = await db.sessions.get(sid)
    expect(s.state.characters.沈砚.location).toBe('书店')
    expect(s.state.facts).toEqual([{ turn: 1, text: '照片背后有日期' }])
    expect(s.stateLog).toHaveLength(1)
    expect(s.stateLog[0].turn).toBe(1)
    expect(s.stateLog[0].snapshot).toEqual(empty)            // 提取前快照
    expect(s.stateLog[0].diff.characters.沈砚.location).toBe('书店')
    // 任务标 done，不会反复入队
    expect((await db.tasks.where('sessionId').equals(sid).toArray()).every((t) => t.status === 'done')).toBe(true)
  })
})

describe('XR · undoExtract 撤销', () => {
  it('回到该次提取之前，丢弃该次及之后的记录', async () => {
    const s1 = { ...empty, facts: [{ turn: 1, text: 'F1' }] }
    const s2 = { ...empty, facts: [{ turn: 1, text: 'F1' }, { turn: 2, text: 'F2' }] }
    const log = [
      { turn: 1, ts: 1, diff: { facts_add: ['F1'] }, snapshot: empty },
      { turn: 2, ts: 2, diff: { facts_add: ['F2'] }, snapshot: s1 },
    ]
    const { sid } = await seed(log, [[1, 'u', 'a'], [2, 'u', 'a']], s2)

    await undoExtract(sid, 2)
    const s = await db.sessions.get(sid)
    expect(s.state).toEqual(s1)                       // 回到第 2 轮提取前
    expect(s.stateLog.map((e) => e.turn)).toEqual([1]) // 第 2 条记录被丢弃
  })

  it('没有该回合记录 → 报错且不动数据', async () => {
    const { sid } = await seed([], [], empty)
    await expect(undoExtract(sid, 99)).rejects.toThrow('没有该回合的提取记录')
    expect((await db.sessions.get(sid)).state).toEqual(empty)
  })
})

describe('XS · reExtractFrom 回溯重放', () => {
  it('从记录点重放：起点快照 + 依次应用每轮 diff，日志替换', async () => {
    const after = { ...empty, facts: [{ turn: 1, text: '旧的' }, { turn: 2, text: '旧的2' }] }
    const log = [{ turn: 1, ts: 1, diff: { facts_add: ['旧的'] }, snapshot: empty }]
    const { sid } = await seed(log, [[1, 'u1', 'a1'], [2, 'u2', 'a2']], after)
    // 重放两轮，各产出一条新事实
    completeMock
      .mockResolvedValueOnce(JSON.stringify({ facts_add: ['新的F1'] }))
      .mockResolvedValueOnce(JSON.stringify({ facts_add: ['新的F2'] }))

    const progress = []
    const n = await reExtractFrom(sid, 1, settings, (done, total) => progress.push([done, total]))

    expect(n).toBe(2)
    expect(progress).toEqual([[1, 2], [2, 2]])
    const s = await db.sessions.get(sid)
    expect(s.state.facts.map((f) => f.text)).toEqual(['新的F1', '新的F2']) // 旧结果被推倒重来
    expect(s.stateLog).toHaveLength(2)
    expect(s.stateLog[0].snapshot).toEqual(empty)                     // 第 1 轮提取前
    expect(s.stateLog[1].snapshot.facts.map((f) => f.text)).toEqual(['新的F1']) // 第 2 轮提取前
    expect(completeMock).toHaveBeenCalledTimes(2)
  })

  it('孤儿轮（无 assistant）被跳过，不参与重放', async () => {
    const log = [{ turn: 1, ts: 1, diff: {}, snapshot: empty }]
    const { sid, ids } = await seed(log, [[1, 'u1', 'a1'], [2, 'u2', 'a2']])
    await db.messages.delete(ids[1].aid) // 第 2 轮 assistant 删掉 → 不完整
    completeMock.mockResolvedValue('{}')

    const n = await reExtractFrom(sid, 1, settings, () => {})
    expect(n).toBe(1)
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('起点无记录 / 会话不存在 → 报错', async () => {
    const { sid } = await seed([], [])
    await expect(reExtractFrom(sid, 5, settings, () => {})).rejects.toThrow('没有该回合的提取记录')
    await expect(reExtractFrom(9999, 1, settings, () => {})).rejects.toThrow('会话不存在')
  })

  it('重放中途失败：状态不被写坏（update 只在全部轮完成后执行）', async () => {
    const after = { ...empty, facts: [{ turn: 1, text: '旧' }] }
    const log = [{ turn: 1, ts: 1, diff: {}, snapshot: empty }]
    const { sid } = await seed(log, [[1, 'u1', 'a1'], [2, 'u2', 'a2']], after)
    completeMock
      .mockResolvedValueOnce(JSON.stringify({ facts_add: ['新'] }))
      .mockRejectedValueOnce(new Error('API 挂了'))

    await expect(reExtractFrom(sid, 1, settings, () => {})).rejects.toThrow('API 挂了')
    const s = await db.sessions.get(sid)
    expect(s.state.facts.map((f) => f.text)).toEqual(['旧']) // 保持原状
  })
})
