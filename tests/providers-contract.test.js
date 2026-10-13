// 适配器契约测试（docs/multi-provider-design.md §5.4）：openai 兼容基线 + anthropic。
// 两个适配器跑同一组"契约"断言：请求构造、流式事件归一、非流式解析、错误映射。
import { describe, expect, it } from 'vitest'
import { openaiAdapter, normalizeUsage } from '../src/lib/providers/adapters/openaiCompat.js'
import { anthropicAdapter } from '../src/lib/providers/adapters/anthropic.js'
import { ProviderError } from '../src/lib/providers/errors.js'

const openaiTarget = {
  provider: { id: 'deepseek', adapter: 'openai', endpoint: 'https://api.deepseek.com/v1/', apiKey: 'sk-t' },
  model: 'deepseek-chat',
}
const anthropicTarget = {
  provider: { id: 'anthropic', adapter: 'anthropic', endpoint: 'https://api.anthropic.com/v1', apiKey: 'sk-a' },
  model: 'claude-sonnet-4-5',
}
const req = (params = {}) => ({
  purpose: 'chat',
  messages: [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '你好' },
  ],
  params: { temperature: 0.7, maxOutputTokens: 512, ...params },
  signal: undefined,
})

describe('C1 · openai 兼容基线', () => {
  it('流式请求：端点、认证头、stream_options', () => {
    const { url, init } = openaiAdapter.buildStreamRequest(openaiTarget, req())
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions') // 尾斜杠已去
    expect(init.headers.Authorization).toBe('Bearer sk-t')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ model: 'deepseek-chat', stream: true, temperature: 0.7, max_tokens: 512 })
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.messages).toHaveLength(2) // system 保留在 messages 里
  })

  it('jsonMode → response_format（提取器依赖）', () => {
    const { init } = openaiAdapter.buildCompleteRequest(openaiTarget, req({ jsonMode: true }))
    expect(JSON.parse(init.body).response_format).toEqual({ type: 'json_object' })
  })

  it('无 Key（本地服务）不带 Authorization 头', () => {
    const { init } = openaiAdapter.buildStreamRequest(
      { provider: { ...openaiTarget.provider, apiKey: '' }, model: 'llama3.1' }, req()
    )
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('parseChunk：delta / usage / [DONE]，容忍半行与坏行', () => {
    const state = openaiAdapter.createState()
    const ev1 = openaiAdapter.parseChunk(state, 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"broken"')
    expect(ev1).toEqual([{ type: 'delta', text: '你' }])
    const ev2 = openaiAdapter.parseChunk(state, '}\n\ndata: {"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_cache_hit_tokens":6}}\n\n: ping\n\n')
    expect(ev2).toEqual([])
    const ev3 = openaiAdapter.parseChunk(state, 'data: [DONE]\n\n')
    expect(ev3).toEqual([])
    const tail = openaiAdapter.endOfStream(state)
    expect(tail[0]).toMatchObject({ type: 'usage' })
    expect(tail[0].usage).toMatchObject({ inputTokens: 10, outputTokens: 2, cacheRead: 6 })
    expect(tail[1]).toMatchObject({ type: 'finish', reason: 'stop' })
  })

  it('parseResponse：取 choices[0].message.content 与归一化 usage', () => {
    const r = openaiAdapter.parseResponse({ choices: [{ message: { content: '回复' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } })
    expect(r.text).toBe('回复')
    expect(r.usage).toMatchObject({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })
  })

  it('mapError：401→AUTH，429→RATE_LIMIT，超窗文案→CONTEXT_OVERFLOW', () => {
    expect(openaiAdapter.mapError(401, '{"error":{"message":"bad key"}}', 'deepseek')).toMatchObject({ code: 'AUTH', status: 401 })
    expect(openaiAdapter.mapError(429, '', 'deepseek')).toMatchObject({ code: 'RATE_LIMIT' })
    expect(openaiAdapter.mapError(400, 'This model maximum context length is 8192', 'deepseek')).toMatchObject({ code: 'CONTEXT_OVERFLOW' })
  })

  it('normalizeUsage：厂商字段全量归一', () => {
    expect(normalizeUsage({ prompt_tokens: 5, completion_tokens: 6, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2, total_tokens: 11 }))
      .toEqual({ inputTokens: 5, outputTokens: 6, cacheRead: 1, cacheWrite: 2, totalTokens: 11, estimated: false })
    expect(normalizeUsage()).toMatchObject({ inputTokens: 0, totalTokens: 0 }) // 空对象不炸
  })
})

describe('C2 · anthropic 适配器', () => {
  it('请求：system 抽到顶层、x-api-key 认证、max_tokens 必填', () => {
    const { url, init } = anthropicAdapter.buildStreamRequest(anthropicTarget, req())
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.headers['x-api-key']).toBe('sk-a')
    expect(init.headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse(init.body)
    expect(body.system).toBe('系统提示')
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }]) // system 不在 messages 里
    expect(body.max_tokens).toBe(512)
    expect(body.model).toBe('claude-sonnet-4-5')
  })

  it('jsonMode 不支持 → 参数被丢弃（不产生非法请求）', () => {
    const { init } = anthropicAdapter.buildCompleteRequest(anthropicTarget, req({ jsonMode: true }))
    expect(JSON.parse(init.body).response_format).toBeUndefined()
  })

  it('parseChunk：content_block_delta 出文本，usage 跨 message_start/delta 累计', () => {
    const state = anthropicAdapter.createState()
    const chunk1 = 'event: message_start\ndata: {"message":{"usage":{"input_tokens":20,"cache_read_input_tokens":8,"cache_creation_input_tokens":2}}}\n\n'
    const chunk2 = 'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"你好"}}\n\n'
    const evs = [
      ...anthropicAdapter.parseChunk(state, chunk1.slice(0, 30)), // 半块
      ...anthropicAdapter.parseChunk(state, chunk1.slice(30)),
      ...anthropicAdapter.parseChunk(state, chunk2),
    ]
    expect(evs).toEqual([{ type: 'delta', text: '你好' }])
    anthropicAdapter.parseChunk(state, 'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n')
    const tail = anthropicAdapter.endOfStream(state)
    expect(tail[0].usage).toEqual({ inputTokens: 20, outputTokens: 7, cacheRead: 8, cacheWrite: 2, totalTokens: 27, estimated: false })
    expect(tail[1]).toMatchObject({ type: 'finish', reason: 'end_turn' })
  })

  it('parseChunk：error 事件 → 归一化错误事件', () => {
    const state = anthropicAdapter.createState()
    const evs = anthropicAdapter.parseChunk(state, 'event: error\ndata: {"error":{"message":"overloaded"}}\n\n')
    expect(evs[0].type).toBe('error')
    expect(evs[0].error).toBeInstanceOf(ProviderError)
  })

  it('parseResponse：content 数组的 text 块拼接', () => {
    const r = anthropicAdapter.parseResponse({ content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }], usage: { input_tokens: 1, output_tokens: 2 } })
    expect(r.text).toBe('第一段第二段')
    expect(r.usage).toMatchObject({ inputTokens: 1, outputTokens: 2, totalTokens: 3 })
  })

  it('mapError：错误体里的人话被抽出', () => {
    expect(anthropicAdapter.mapError(401, '{"error":{"message":"invalid x-api-key"}}', 'anthropic')).toMatchObject({ code: 'AUTH' })
    expect(anthropicAdapter.mapError(529, 'overloaded', 'anthropic')).toMatchObject({ code: 'SERVER' })
  })
})
