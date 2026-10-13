/**
 * 多模型层 · 错误归一化
 *
 * 所有厂商的失败最终都收敛为 ProviderError + 9 个归一错误码，
 * 上层（重试 / 熔断 / 降级 / UI）只看 code，不看厂商原始报文。
 */

/** 归一错误码（含义与可重试性见 RETRYABLE） */
export const ERROR_CODES = [
  'AUTH',             // 401/403：Key 无效或无权限
  'RATE_LIMIT',       // 429：限流
  'INVALID_REQUEST',  // 400/404/422：请求不合法
  'CONTEXT_OVERFLOW', // 上下文超窗（部分厂商 400，需适配器识别）
  'SERVER',           // 5xx：服务端故障
  'NETWORK',          // 网络不可达 / CORS 拦截
  'TIMEOUT',          // 超时
  'UNSUPPORTED',      // 能力不满足（如没有可用厂商）
  'ABORTED',          // 用户主动停止——不是故障，永不重试
  'PARSE',            // 响应解析失败
]

/** 可重试错误码：退避后重试有意义；其余立即走降级或失败 */
export const RETRYABLE = new Set(['RATE_LIMIT', 'SERVER', 'NETWORK', 'TIMEOUT'])

export class ProviderError extends Error {
  /**
   * @param {string} code ERROR_CODES 之一
   * @param {string} message 面向用户的中文提示
   * @param {{status?:number, provider?:string, retryAfterMs?:number, raw?:unknown}} [info]
   */
  constructor(code, message, info = {}) {
    super(message)
    // name 对齐 AbortError：上层（ChatView 停止生成）按 e.name === 'AbortError' 分支，无需感知新错误类型
    this.name = code === 'ABORTED' ? 'AbortError' : 'ProviderError'
    this.code = code
    this.status = info.status
    this.provider = info.provider
    this.retryAfterMs = info.retryAfterMs
    this.raw = info.raw
  }

  get retryable() { return RETRYABLE.has(this.code) }
}

export function providerError(code, message, info) { return new ProviderError(code, message, info) }

/** HTTP 状态码 → 归一错误码（粗映射；适配器可结合响应体细化，如上下文超窗） */
export function statusToCode(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status >= 500) return 'SERVER'
  return 'INVALID_REQUEST'
}

/** fetch / 读流阶段的异常 → ProviderError（含浏览器 CORS 拦截的典型形态） */
export function fromFetchError(e, provider) {
  if (e instanceof ProviderError) return e
  if (e?.name === 'AbortError' || e?.code === 20) {
    return new ProviderError('ABORTED', '已停止生成', { provider })
  }
  // 浏览器 CORS 失败 / 断网都表现为 TypeError: Failed to fetch
  if (e?.name === 'TypeError') {
    return new ProviderError('NETWORK', `网络错误（服务不可达，或被浏览器 CORS 拦截）：${e.message}`, { provider })
  }
  if (e?.name === 'TimeoutError') {
    return new ProviderError('TIMEOUT', '请求超时', { provider })
  }
  return new ProviderError('NETWORK', String(e?.message || e), { provider })
}

/** 错误码 → 用户可读的一句话（UI 展示用） */
export const FRIENDLY = {
  AUTH: 'API Key 无效或没有权限',
  RATE_LIMIT: '触发限流，稍后会自动重试',
  INVALID_REQUEST: '请求被拒绝（参数或模型名可能不对）',
  CONTEXT_OVERFLOW: '对话超出模型上下文窗口',
  SERVER: '模型服务端故障',
  NETWORK: '网络错误（服务不可达或被 CORS 拦截）',
  TIMEOUT: '请求超时',
  UNSUPPORTED: '没有满足要求的可用模型',
  ABORTED: '已停止生成',
  PARSE: '响应解析失败',
}

export function friendlyMessage(err) {
  if (!err) return '未知错误'
  return err.code ? FRIENDLY[err.code] || err.message : String(err.message || err)
}
