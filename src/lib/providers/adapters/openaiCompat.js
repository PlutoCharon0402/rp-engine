/**
 * OpenAI 兼容适配器（基线）：覆盖 DeepSeek / OpenAI / Kimi / Qwen / OpenRouter / Ollama / LM Studio…
 * 绝大多数厂商只需在注册表里配 endpoint + key，即可复用本适配器（零代码接入）。
 *
 * 职责边界（见 docs/multi-provider-design.md §5）：
 *   build*Request —— 标准请求 → 厂商 HTTP 请求
 *   parseChunk    —— 网络分片 → 归一化事件（有状态，缓冲跨块行）
 *   parseResponse —— 非流式响应 → 文本 + 归一化 usage
 *   mapError      —— HTTP 错误 → ProviderError
 * 全部是纯函数 / 浅状态对象，可离线单测（fixtures 见 tests/providers-contract.test.js）。
 */
import { ProviderError, statusToCode } from '../errors'

/** 厂商原始 usage → 归一化 Usage（字段名是 OpenAI 系口径，含 DeepSeek 缓存私有字段） */
export function normalizeUsage(u = {}) {
  const input = Number(u.prompt_tokens) || 0
  const output = Number(u.completion_tokens) || 0
  return {
    inputTokens: input,
    outputTokens: output,
    cacheRead: Number(u.prompt_cache_hit_tokens) || 0,
    cacheWrite: Number(u.prompt_cache_miss_tokens) || 0,
    totalTokens: Number(u.total_tokens) || input + output,
    estimated: false,
  }
}

/** 请求体公共部分（流式 / 非流式共用） */
function commonBody(target, req) {
  const body = {
    model: target.model,
    messages: req.messages,
    temperature: req.params.temperature,
    max_tokens: req.params.maxOutputTokens,
  }
  if (req.params.jsonMode) body.response_format = { type: 'json_object' }
  if (req.params.stopSequences?.length) body.stop = req.params.stopSequences
  return body
}

function headers(target) {
  return {
    'Content-Type': 'application/json',
    ...(target.provider.apiKey ? { Authorization: `Bearer ${target.provider.apiKey}` } : {}), // 本地服务无 Key
  }
}

/** 从错误响应体里尽力抽出人话（OpenAI 系惯例：{"error":{"message":…}}） */
function extractErrMessage(text) {
  try {
    const j = JSON.parse(text)
    return j?.error?.message || j?.message || text.slice(0, 200)
  } catch {
    return String(text).slice(0, 200)
  }
}

export const openaiAdapter = {
  id: 'openai',

  /** @returns {{url:string, init:RequestInit}} */
  buildStreamRequest(target, req) {
    const base = target.provider.endpoint.replace(/\/+$/, '')
    return {
      url: `${base}/chat/completions`,
      init: {
        method: 'POST',
        headers: headers(target),
        signal: req.signal,
        body: JSON.stringify({
          ...commonBody(target, req),
          stream: true,
          stream_options: { include_usage: true }, // 末帧带 usage（DeepSeek/OpenAI 支持；不支持的厂商会被 json 忽略字段，安全）
        }),
      },
    }
  },

  /** @returns {{url:string, init:RequestInit}} */
  buildCompleteRequest(target, req) {
    const base = target.provider.endpoint.replace(/\/+$/, '')
    return {
      url: `${base}/chat/completions`,
      init: {
        method: 'POST',
        headers: headers(target),
        signal: req.signal,
        body: JSON.stringify(commonBody(target, req)),
      },
    }
  },

  /** 流解析状态：buffer 保存跨网络块的半行 */
  createState() {
    return { buf: '', usage: null, finish: null }
  },

  /**
   * 喂入一段网络文本，返回 0..n 个归一化事件。
   * 必须容忍：半行 JSON（留缓冲）、注释行、心跳行、非 data: 行。
   */
  parseChunk(state, text) {
    state.buf += text
    const events = []
    const lines = state.buf.split('\n')
    state.buf = lines.pop() ?? ''
    for (const raw of lines) {
      const s = raw.trim()
      if (!s.startsWith('data:')) continue
      const data = s.slice(5).trim()
      if (data === '[DONE]') { state.finish = state.finish || 'stop'; continue }
      let j
      try { j = JSON.parse(data) } catch { continue } // 不完整 / 非 JSON 行
      if (j.usage) state.usage = normalizeUsage(j.usage)
      const choice = j.choices?.[0]
      const d = choice?.delta?.content
      if (d) events.push({ type: 'delta', text: d })
      if (choice?.finish_reason) state.finish = choice.finish_reason
    }
    return events
  },

  /** 流结束（reader done）后：吐出累计的 usage 与结束原因 */
  endOfStream(state) {
    const out = []
    if (state.usage) out.push({ type: 'usage', usage: state.usage })
    if (state.finish) out.push({ type: 'finish', reason: state.finish })
    return out
  },

  /** 非流式响应解析 */
  parseResponse(body) {
    const j = typeof body === 'string' ? JSON.parse(body) : body
    return {
      text: j.choices?.[0]?.message?.content ?? '',
      usage: j.usage ? normalizeUsage(j.usage) : null,
      finishReason: j.choices?.[0]?.finish_reason || null,
    }
  },

  /** HTTP 错误 → ProviderError（含上下文超窗的常见文案识别） */
  mapError(status, bodyText, provider) {
    const msg = extractErrMessage(bodyText)
    const lower = String(msg).toLowerCase()
    let code = statusToCode(status)
    if (code === 'INVALID_REQUEST' && (lower.includes('context length') || lower.includes('maximum context') || lower.includes('too long'))) {
      code = 'CONTEXT_OVERFLOW'
    }
    return new ProviderError(code, `${code === 'AUTH' ? 'API Key 无效' : '请求失败'}（HTTP ${status}）：${msg}`, { status, provider })
  },
}
