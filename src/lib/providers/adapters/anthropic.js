/**
 * Anthropic 适配器：协议与 OpenAI 系不同，故独立实现（对照表见 docs/multi-provider-design.md §5.3）。
 * 差异点：
 *   - 认证：x-api-key + anthropic-version（浏览器直连需加 anthropic-dangerous-direct-browser-access）
 *   - 系统提示：不在 messages 里，是顶层 system 字段
 *   - 流式：SSE 事件流（event: xxx + data: {...}），文本在 content_block_delta
 *   - usage：input 在 message_start，output 在 message_delta，缓存字段是 cache_read/creation_input_tokens
 *   - JSON 模式：无原生 response_format → 丢弃参数（系统提示词已强制 JSON，parseJsonLoose 兜底）
 *   - max_tokens：必填
 */
import { ProviderError, statusToCode } from '../errors'

function toAnthropicMessages(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content)
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }))
  return { system: system.join('\n\n'), messages: rest }
}

function body(target, req, stream) {
  const { system, messages } = toAnthropicMessages(req.messages)
  const b = {
    model: target.model,
    messages,
    max_tokens: req.params.maxOutputTokens || 1024, // Anthropic 必填
    stream,
  }
  if (system) b.system = system
  if (req.params.temperature != null) b.temperature = req.params.temperature
  if (req.params.stopSequences?.length) b.stop_sequences = req.params.stopSequences
  // jsonMode：Anthropic 无原生支持，丢弃（提示词已约束，提取器侧有宽松解析兜底）
  return b
}

function headers(target) {
  return {
    'Content-Type': 'application/json',
    'x-api-key': target.provider.apiKey,
    'anthropic-version': '2023-06-01',
    // 官方支持的浏览器直连开关（否则 CORS 预检失败）
    'anthropic-dangerous-direct-browser-access': 'true',
  }
}

export const anthropicAdapter = {
  id: 'anthropic',

  buildStreamRequest(target, req) {
    const base = target.provider.endpoint.replace(/\/+$/, '')
    return {
      url: `${base}/messages`,
      init: { method: 'POST', headers: headers(target), signal: req.signal, body: JSON.stringify(body(target, req, true)) },
    }
  },

  buildCompleteRequest(target, req) {
    const base = target.provider.endpoint.replace(/\/+$/, '')
    return {
      url: `${base}/messages`,
      init: { method: 'POST', headers: headers(target), signal: req.signal, body: JSON.stringify(body(target, req, false)) },
    }
  },

  /** 事件按空行分块，buffer 保存最后一个不完整块 */
  createState() {
    return { buf: '', usage: null, finish: null }
  },

  parseChunk(state, text) {
    state.buf += text
    const events = []
    const blocks = state.buf.split('\n\n')
    state.buf = blocks.pop() ?? ''
    for (const block of blocks) {
      const lines = block.split('\n')
      const evName = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim()
      const dataLine = lines.find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      let j
      try { j = JSON.parse(dataLine.slice(5).trim()) } catch { continue }

      if (evName === 'content_block_delta' && j.delta?.type === 'text_delta') {
        events.push({ type: 'delta', text: j.delta.text })
      } else if (evName === 'message_start') {
        const u = j.message?.usage || {}
        state.usage = {
          inputTokens: Number(u.input_tokens) || 0,
          outputTokens: 0, // output_tokens 到 message_delta 才有
          cacheRead: Number(u.cache_read_input_tokens) || 0,
          cacheWrite: Number(u.cache_creation_input_tokens) || 0,
          totalTokens: Number(u.input_tokens) || 0,
          estimated: false,
        }
      } else if (evName === 'message_delta') {
        if (state.usage && j.usage?.output_tokens != null) {
          state.usage.outputTokens = Number(j.usage.output_tokens) || 0
          state.usage.totalTokens = state.usage.inputTokens + state.usage.outputTokens
        }
        if (j.delta?.stop_reason) state.finish = j.delta.stop_reason
      } else if (evName === 'error') {
        events.push({ type: 'error', error: new ProviderError('SERVER', `模型服务错误：${j.error?.message || '未知'}`, { provider: state.providerId }) })
      } else if (evName === 'message_stop') {
        state.finish = state.finish || 'stop'
      }
    }
    return events
  },

  endOfStream(state) {
    const out = []
    if (state.usage) out.push({ type: 'usage', usage: state.usage })
    if (state.finish) out.push({ type: 'finish', reason: state.finish })
    return out
  },

  /** 非流式：文本在 content 数组的 text 块里（可能有多个，拼接） */
  parseResponse(j) {
    const text = (j.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('')
    const u = j.usage || {}
    return {
      text,
      usage: {
        inputTokens: Number(u.input_tokens) || 0,
        outputTokens: Number(u.output_tokens) || 0,
        cacheRead: Number(u.cache_read_input_tokens) || 0,
        cacheWrite: Number(u.cache_creation_input_tokens) || 0,
        totalTokens: (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0),
        estimated: false,
      },
      finishReason: j.stop_reason || null,
    }
  },

  mapError(status, bodyText, provider) {
    let msg = bodyText
    try { msg = JSON.parse(bodyText)?.error?.message || bodyText } catch { /* 保底用原文 */ }
    const code = statusToCode(status)
    return new ProviderError(code, `请求失败（HTTP ${status}）：${String(msg).slice(0, 200)}`, { status, provider })
  },
}
