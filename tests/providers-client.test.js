// ChatClient 集成测试：路由 → 重试 → 熔断 → 跨厂商降级 → 指标。
// mock fetch 序列 + 注入 sleep（零真实等待）；熔断器是模块态，每个用例前复位。
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChatClient } from '../src/lib/providers/client.js'
import { resetBreakers } from '../src/lib/providers/resilience.js'

const enc = new TextEncoder()
const noSleep = async () => {}

/** SSE 流 Response 替身 */
function streamRes(chunks, { ok = true, status = 200 } = {}) {
  let i = 0
  return {
    ok, status,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }) }) },
    text: async () => chunks.join(''),
  }
}

/** 读到一半断流的 Response 替身（触发"已 yield 后失败"路径） */
function brokenStream(goodChunks) {
  let i = 0
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => {
      if (i < goodChunks.length) return { done: false, value: enc.encode(goodChunks[i++]) }
      throw new TypeError('connection reset')
    } }) },
    text: async () => '',
  }
}

const errRes = (status, text = 'boom') => ({ ok: false, status, text: async () => text })
const jsonRes = (j) => ({ ok: true, json: async () => j })

/** 按序返回的 fetch mock：数组耗尽后重复最后一个 */
function seqFetch(mocks) {
  let i = 0
  const fn = vi.fn(async (url, opts) => {
    const m = mocks[Math.min(i, mocks.length - 1)]
    i++
    return typeof m === 'function' ? m(url, opts) : m
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const delta = (t) => sse({ choices: [{ delta: { content: t } }] })

const S = {
  providerId: 'deepseek',
  fallbackIds: ['moonshot'],
  providers: {
    deepseek: { id: 'deepseek', adapter: 'openai', displayName: 'DeepSeek', endpoint: 'https://api.deepseek.com/v1', apiKey: 'a', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
    moonshot: { id: 'moonshot', adapter: 'openai', displayName: 'Kimi', endpoint: 'https://api.moonshot.cn/v1', apiKey: 'b', models: ['kimi-latest'], defaultModel: 'kimi-latest' },
  },
}

const client = () => createChatClient(S, { sleep: noSleep })
async function drain(gen) { const evs = []; for await (const ev of gen) evs.push(ev); return evs }

beforeEach(() => { resetBreakers() })
afterEach(() => { vi.unstubAllGlobals() })

describe('CL1 · 流式', () => {
  it('成功：delta + 归一化 usage 事件', async () => {
    seqFetch([streamRes([delta('你'), delta('好'), sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8 } }), 'data: [DONE]\n\n'])])
    const evs = await drain(client().stream({ purpose: 'chat', messages: [{ role: 'user', content: 'hi' }], params: {} }))
    expect(evs.map((e) => e.type)).toEqual(['delta', 'delta', 'usage'])
    expect(evs[0].text).toBe('你')
    expect(evs[2].usage).toMatchObject({ inputTokens: 10, cacheRead: 8 })
  })

  it('降级：主厂商 500（重试 1 次仍失败）→ 自动切到备用厂商并成功', async () => {
    const fn = seqFetch([
      errRes(500), errRes(500),                                                                    // deepseek 两次尝试
      streamRes([delta('备'), delta('用'), 'data: [DONE]\n\n']),                                    // moonshot
    ])
    const evs = await drain(client().stream({ purpose: 'chat', messages: [{ role: 'user', content: 'hi' }], params: {} }))
    expect(evs.filter((e) => e.type === 'delta').map((e) => e.text).join('')).toBe('备用')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(fn.mock.calls[2][0]).toContain('api.moonshot.cn') // 第三次才是备用厂商
  })

  it('停止（abort）：抛 name=AbortError 的错误，不降级', async () => {
    const controller = new AbortController()
    const fn = seqFetch([streamRes([])])
    // fetch 收到 signal 后由调用方 abort；这里直接模拟 fetch 抛 AbortError
    fn.mockImplementation(async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e })
    await expect(drain(client().stream({
      purpose: 'chat', messages: [{ role: 'user', content: 'hi' }], params: {}, signal: controller.signal,
    }))).rejects.toMatchObject({ name: 'AbortError', code: 'ABORTED' })
  })

  it('已产出内容后流中断：不换厂商（避免输出重复），错误直接上抛', async () => {
    const fn = seqFetch([brokenStream([delta('半截')])])
    await expect(drain(client().stream({ purpose: 'chat', messages: [{ role: 'user', content: 'hi' }], params: {} })))
      .rejects.toMatchObject({ code: 'NETWORK' })
    expect(fn).toHaveBeenCalledTimes(1) // 没有重试也没有降级
  })

  it('显式选择了未配置的厂商 → AUTH 错误引导配置，不静默换家', async () => {
    const fn = seqFetch([streamRes(['data: [DONE]\n\n'])])
    await expect(drain(client().stream({
      purpose: 'chat', messages: [{ role: 'user', content: 'hi' }], params: {},
      override: { providerId: 'openai' }, // S 中不存在 → 既无 Key 也非本地服务
    }))).rejects.toMatchObject({ code: 'AUTH' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('全部厂商失败 → 聚合错误带完整尝试链', async () => {
    seqFetch([errRes(500), errRes(500), errRes(429), errRes(429)])
    await expect(drain(client().stream({ purpose: 'chat', messages: [{ role: 'user', content: 'hi' }], params: {} })))
      .rejects.toThrow(/deepseek.*moonshot|moonshot.*deepseek/)
  })
})

describe('CL2 · 非流式 complete', () => {
  it('成功：返回文本与实际服务的厂商', async () => {
    seqFetch([jsonRes({ choices: [{ message: { content: '好的' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })])
    const r = await client().complete({ purpose: 'extract', messages: [{ role: 'user', content: 'x' }], params: { jsonMode: true } })
    expect(r.text).toBe('好的')
    expect(r.provider).toBe('deepseek')
    expect(r.model).toBe('deepseek-chat')
  })

  it('降级：主厂商 AUTH（不可重试）→ 立即换备用', async () => {
    const fn = seqFetch([errRes(401), jsonRes({ choices: [{ message: { content: '备用回复' } }] })])
    const r = await client().complete({ purpose: 'summary', messages: [{ role: 'user', content: 'x' }], params: {} })
    expect(r.text).toBe('备用回复')
    expect(r.provider).toBe('moonshot')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('全链失败 → 抛聚合错误', async () => {
    seqFetch([errRes(500), errRes(500), errRes(500), errRes(500)])
    await expect(client().complete({ purpose: 'chat', messages: [], params: {} })).rejects.toThrow('全部模型厂商均失败')
  })

  it('没有可用厂商（未配置任何 Key）→ UNSUPPORTED', async () => {
    const c = createChatClient({}, { sleep: noSleep })
    await expect(c.complete({ purpose: 'chat', messages: [], params: {} })).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })
})

describe('CL3 · 能力与就绪查询', () => {
  it('capabilities 返回上下文窗口', () => {
    const caps = client().capabilities('deepseek')
    expect(caps).toMatchObject({ context: 65536, streaming: true })
  })

  it('readyProviders 列出可用厂商', () => {
    const ids = client().readyProviders().map((p) => p.id)
    expect(ids).toContain('deepseek')
    expect(ids).toContain('moonshot')
  })
})
