export const DEFAULT_SETTINGS = {
  endpoint: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 1.1,
  maxTokens: 1024,
  depth: 1,          // 状态/世界书注入深度（距末尾的消息条数；1=紧贴最新用户消息，历史全部成为可缓存前缀）
  loreBudget: 600,   // 世界书每回合 token 预算
  maxHistory: 40,    // 携带的最多历史消息条数
}

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('rp.settings') || '{}') }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s) {
  localStorage.setItem('rp.settings', JSON.stringify(s))
}

// 粗略 token 估算：CJK 约 0.7 token/字，拉丁文本约 1/4
export function estTokens(s = '') {
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  return Math.ceil(cjk * 0.7 + (s.length - cjk) / 4)
}

export function fmtTime(ts) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
