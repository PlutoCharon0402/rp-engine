// makeApi（多模型统一入口的兼容外壳）覆盖：
//   SSE 增量解析、usage 归一化回传、请求构造、abort 透传、错误、缺 Key 行为。
// 用假 fetch 喂构造好的 SSE 分片，零网络依赖。适配器层细节见 providers-contract.test.js。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeApi } from '../src/lib/api.js'

const enc = new TextEncoder()

/** 依次吐出若干字符串块的 Response 替身（模拟网络分包） */
function streamRes(chunks, { ok = true, status = 200 } = {}) {
  let i = 0
  return {
    ok,
    status,
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true }),
      }),
    },
    text: async () => chunks.join(''),
  }
}

/** 用替身 fetch 替换全局 fetch，并记住最后一次调用的 url / opts */
function stubFetch(res) {
  let last = null
  const fn = vi.fn(async (url, opts) => { last = { url, opts }; return res })
  vi.stubGlobal('fetch', fn)
  return { fn, last: () => last }
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`
const delta = (t) => sse({ choices: [{ delta: { content: t } }] })

/** 消费一次流式调用，返回拼接文本与最后一次归一化 usage */
async function collect(chunks, opts = {}, settings = { apiKey: 'k' }) {
  const stub = stubFetch(streamRes(chunks))
  let usage = null
  let text = ''
  for await (const d of makeApi(settings).stream([{ role: 'user', content: 'hi' }], { ...opts, onUsage: (u) => { usage = u } })) {
    text += d
  }
  return { text, usage, stub }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('A1 · 流式解析', () => {
  it('增量拼接成完整文本，usage 以归一化字段回传', async () => {
    const { text, usage } = await collect([
      delta('你'),
      delta('好'),
      sse({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 2 } }),
      'data: [DONE]\n\n',
    ])
    expect(text).toBe('你好')
    // 归一化 Usage：厂商字段（prompt_tokens 等）不再外泄到业务层
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 2, cacheRead: 8, cacheWrite: 2, totalTokens: 12, estimated: false })
  })

  it('一行被拆成两个网络块时仍能正确拼出（缓冲跨块保留）', async () => {
    const line = delta('跨块')
    const { text } = await collect([line.slice(0, 12), line.slice(12), 'data: [DONE]\n\n'])
    expect(text).toBe('跨块')
  })

  it('非 data: 行与不完整 JSON 行被忽略，不抛错', async () => {
    const { text } = await collect([': ping\n\n', 'data: {"broken"\n\n', delta('正常'), 'data: [DONE]\n\n'])
    expect(text).toBe('正常')
  })

  it('没有 [DONE] 也能随流结束正常收尾', async () => {
    const { text } = await collect([delta('收尾')])
    expect(text).toBe('收尾')
  })

  it('空 delta（无 content）不产生空字符串增量', async () => {
    const { text } = await collect([sse({ choices: [{ delta: {} }] }), delta('后'), 'data: [DONE]\n\n'])
    expect(text).toBe('后')
  })
})

describe('A2 · 请求构造', () => {
  it('老配置（无 endpoint/model）迁移后仍指向默认端点与默认模型', async () => {
    const { text, stub } = await collect(['data: [DONE]\n\n'])
    expect(text).toBe('')
    expect(stub.last().url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(JSON.parse(stub.last().opts.body).model).toBe('deepseek-chat')
  })

  it('老配置的 endpoint 尾斜杠被去掉，不产生双斜杠', async () => {
    const { stub } = await collect(['data: [DONE]\n\n'], {}, { apiKey: 'k', endpoint: 'https://x.dev/v1/', model: 'gw-model' })
    expect(stub.last().url).toBe('https://x.dev/v1/chat/completions')
  })

  it('temperature / max_tokens 取设置值，可被 opts 覆盖', async () => {
    const { stub } = await collect(
      ['data: [DONE]\n\n'],
      { temperature: 0.2, maxTokens: 100 },
      { apiKey: 'k', temperature: 1.1, maxTokens: 1024 }
    )
    expect(JSON.parse(stub.last().opts.body)).toMatchObject({ temperature: 0.2, max_tokens: 100, stream: true })
  })

  it('abort 信号原样透传给 fetch（停止生成依赖它）', async () => {
    const controller = new AbortController()
    const { stub } = await collect(['data: [DONE]\n\n'], { signal: controller.signal })
    expect(stub.last().opts.signal).toBe(controller.signal)
  })
})

describe('A3 · 错误处理', () => {
  it('流式：非 2xx 抛错并带上厂商与错误码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, text: async () => 'unauthorized' })))
    await expect((async () => {
      for await (const _ of makeApi({ apiKey: 'k' }).stream([{ role: 'user', content: 'hi' }])) { /* 消费 */ }
    })()).rejects.toThrow(/deepseek（AUTH：/) // alpha.9 起错误信息带服务端详情，断言到「详情开始」即可
  })

  it('非流式：正常返回文本', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '你好' } }] }) })))
    await expect(makeApi({ apiKey: 'k' }).complete([{ role: 'user', content: 'hi' }])).resolves.toBe('你好')
  })

  it('非流式：json:true 时带 response_format（提取器依赖）', async () => {
    const fn = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }))
    vi.stubGlobal('fetch', fn)
    await makeApi({ apiKey: 'k' }).complete([{ role: 'user', content: 'hi' }], { json: true })
    expect(JSON.parse(fn.mock.calls[0][1].body).response_format).toEqual({ type: 'json_object' })
  })

  it('非流式：非 2xx 抛错（可重试错误会先重试再报）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, text: async () => 'boom' })))
    await expect(makeApi({ apiKey: 'k' }).complete([])).rejects.toThrow(/deepseek（SERVER：/)
  })

  it('缺 Key：构造不抛错，调用时抛"尚未配置"且不发请求', async () => {
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    await expect((async () => {
      for await (const _ of makeApi({}).stream([{ role: 'user', content: 'hi' }])) { /* 消费 */ }
    })()).rejects.toThrow('尚未配置')
    expect(fn).not.toHaveBeenCalled()
  })
})
