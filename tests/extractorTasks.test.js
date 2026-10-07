// P0-4 · 任务队列四道锁的集成验证（需要 IndexedDB：fake-indexeddb 提供运行环境）
// 覆盖：enqueueTask 入队去重 / claimTask 乐观锁与 attempts 单次自增 / failureStatus 退避阈值。
// processPendingTasks 的页内互斥依赖模块级 Map，属运行时行为，由验收单 G 组手工项覆盖。
import 'fake-indexeddb/auto'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { db } from '../src/lib/db.js'
import { enqueueTask, claimTask, failureStatus } from '../src/lib/extractor.js'

beforeAll(async () => { await db.open() })
afterAll(async () => { await db.delete(); db.close() })

beforeEach(async () => { await db.tasks.clear() })

describe('T4 · 任务队列（P0-4）', () => {
  it('enqueueTask：同一 assistantMsgId 不重复入队，返回已有任务 id', async () => {
    const a = await enqueueTask(1, 10, 20)
    const b = await enqueueTask(1, 10, 20)
    expect(await db.tasks.count()).toBe(1)
    expect(b).toBe(a)
  })

  it('enqueueTask：不同 assistantMsgId 正常入队', async () => {
    await enqueueTask(1, 10, 20)
    await enqueueTask(1, 11, 21)
    expect(await db.tasks.count()).toBe(2)
  })

  it('enqueueTask：已 done 的同消息可重新入队（重生成场景）', async () => {
    const id = await enqueueTask(1, 10, 20)
    await db.tasks.update(id, { status: 'done' })
    await enqueueTask(1, 10, 20)
    expect(await db.tasks.count()).toBe(2)
  })

  it('claimTask：仅 pending 可领取，领取后 attempts 自增一次；非 pending 抢不到', async () => {
    const id = await enqueueTask(1, 10, 20)
    // 第一次领取成功
    expect(await claimTask(id)).toBe(true)
    let t = await db.tasks.get(id)
    expect(t.status).toBe('running')
    expect(t.attempts).toBe(1)
    // 已 running（模拟另一标签页并发领取）：抢不到，且 attempts 不重复自增
    expect(await claimTask(id)).toBe(false)
    t = await db.tasks.get(id)
    expect(t.attempts).toBe(1)
    expect(t.status).toBe('running')
  })

  it('claimTask：done / failed 状态同样抢不到', async () => {
    for (const status of ['done', 'failed']) {
      const id = await db.tasks.add({ sessionId: 1, userMsgId: 1, assistantMsgId: 1, status, attempts: 0 })
      expect(await claimTask(id)).toBe(false)
      expect((await db.tasks.get(id)).status).toBe(status)
    }
  })

  it('failureStatus：未达上限回 pending，达上限（3 次）转 failed', () => {
    expect(failureStatus(1)).toBe('pending')
    expect(failureStatus(2)).toBe('pending')
    expect(failureStatus(3)).toBe('failed')
    expect(failureStatus(4)).toBe('failed')
  })
})
