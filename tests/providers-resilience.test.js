// 弹性层：withRetry 退避重试 + per-provider 熔断（sleep 注入，测试零真实等待）
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  withRetry, backoffMs, breakerIsOpen, breakerRecord, breakerSnapshot, resetBreakers, BREAKER,
} from '../src/lib/providers/resilience.js'
import { ProviderError } from '../src/lib/providers/errors.js'

const noSleep = async () => {} // 测试注入：不真等
const retryable = (msg = '限流') => new ProviderError('RATE_LIMIT', msg)
const fatal = () => new ProviderError('AUTH', 'Key 无效')

beforeEach(() => { resetBreakers() })

describe('RR1 · withRetry', () => {
  it('一次成功不重试', async () => {
    const fn = vi.fn(async () => 'ok')
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('可重试错误：重试后成功', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(retryable())
      .mockResolvedValueOnce('ok')
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('不可重试错误（AUTH）立即上抛，不消耗重试', async () => {
    const fn = vi.fn().mockRejectedValue(fatal())
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ code: 'AUTH' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('ABORTED（用户停止）永不重试', async () => {
    const fn = vi.fn().mockRejectedValue(new ProviderError('ABORTED', '停止'))
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('重试预算耗尽 → 抛最后一次的错误', async () => {
    const fn = vi.fn().mockRejectedValue(retryable('一直失败'))
    await expect(withRetry(fn, { maxRetries: 2, sleep: noSleep })).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(fn).toHaveBeenCalledTimes(3) // 1 + 2 次重试
  })
})

describe('RR2 · backoffMs', () => {
  it('指数增长且封顶 8s；Retry-After 优先', () => {
    expect(backoffMs(0)).toBeLessThan(700)
    expect(backoffMs(1)).toBeLessThan(1100)
    expect(backoffMs(10)).toBeLessThanOrEqual(8000)
    expect(backoffMs(0, 3000)).toBe(3000)
  })
})

describe('RR3 · 熔断器', () => {
  it('连续失败达阈值 → 开路，期间 isOpen 为 true', () => {
    expect(breakerIsOpen('p1')).toBe(false)
    breakerRecord('p1', false)
    breakerRecord('p1', false)
    expect(breakerIsOpen('p1')).toBe(false) // 未达阈值
    breakerRecord('p1', false)
    expect(breakerIsOpen('p1')).toBe(true)
  })

  it('成功复位：开路前一次成功清零计数', () => {
    breakerRecord('p2', false)
    breakerRecord('p2', false)
    breakerRecord('p2', true) // 清零
    breakerRecord('p2', false)
    expect(breakerIsOpen('p2')).toBe(false)
  })

  it('各厂商互不影响；snapshot 可观测', () => {
    for (let i = 0; i < BREAKER.threshold; i++) breakerRecord('a', false)
    expect(breakerIsOpen('a')).toBe(true)
    expect(breakerIsOpen('b')).toBe(false)
    expect(breakerSnapshot().a.failures).toBe(BREAKER.threshold)
  })
})
