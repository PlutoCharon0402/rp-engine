// DeepSeek (OpenAI 兼容) API 客户端：浏览器直连，已验证支持 CORS

export function makeApi(settings) {
  const base = (settings.endpoint || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${settings.apiKey}`,
  }
  const model = settings.model || 'deepseek-chat'

  if (!settings.apiKey) throw new Error('未配置 API Key，请到「设置」页填写')

  return {
    /** 流式对话，yield 增量文本 */
    async *stream(messages, opts = {}) {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        signal: opts.signal,
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: opts.temperature ?? settings.temperature ?? 1.1,
          max_tokens: opts.maxTokens ?? settings.maxTokens ?? 1024,
        }),
      })
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          const s = line.trim()
          if (!s.startsWith('data:')) continue
          const data = s.slice(5).trim()
          if (data === '[DONE]') return
          try {
            const j = JSON.parse(data)
            if (j.usage && opts.onUsage) opts.onUsage(j.usage)
            const delta = j.choices?.[0]?.delta?.content
            if (delta) yield delta
          } catch { /* 忽略不完整行 */ }
        }
      }
    },

    /** 非流式调用（状态提取器用），返回文本 */
    async complete(messages, opts = {}) {
      const body = {
        model,
        messages,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 600,
      }
      if (opts.json) body.response_format = { type: 'json_object' }
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
      const j = await res.json()
      return j.choices[0].message.content
    },
  }
}
