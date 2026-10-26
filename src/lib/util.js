import { migrateSettings } from './providers/registry'

/** 应用版本（与 android/app/build.gradle 的 versionName 保持同步；排查问题时确认装机版本用） */
export const APP_VERSION = '0.5.0-alpha.14'

export const DEFAULT_SETTINGS = {
  endpoint: 'https://api.deepseek.com/v1',   // 老字段：迁移源（migrateSettings 据此包装 providers），UI 不再直接编辑
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 1.1,
  maxTokens: 1024,
  depth: 1,          // 状态/世界书注入深度（距末尾的消息条数；1=紧贴最新用户消息，历史全部成为可缓存前缀）
  loreBudget: 600,   // 世界书每回合 token 预算
  maxHistory: 40,    // 携带的最多历史消息条数
  extractorPrompt: '', // 批次7：自定义状态提取提示词（空 = 内置）
  // ── 多模型支持（docs/multi-provider-design.md）──
  providerId: 'deepseek',                    // 对话默认厂商
  fallbackIds: [],                           // 故障转移链（按顺序）
  routing: {                                 // 非对话用途的独立路由（空 = 跟随对话默认）
    extract: { providerId: '', model: '' },  // 状态提取（可换便宜模型）
    summary: { providerId: '', model: '' },  // 剧情摘要
  },
  // 注意：providers（用户覆盖表）刻意不在默认值里——loadSettings 需要知道
  // 存档里有没有这个字段来决定是否跑老配置迁移，给了默认值就永远检测不到了。
}

export function loadSettings() {
  try {
    return migrateSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('rp.settings') || '{}') })
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

/**
 * 会话级参数覆盖：session.params 中**已填写**的字段覆盖全局设置。
 * null / undefined / '' 都视为"未设置"→ 跟随全局（表单里清空输入框即恢复全局值）。
 */
export function effectiveSettings(global, overrides) {
  const out = { ...(global || {}) }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === null || v === undefined || v === '') continue
    out[k] = v
  }
  return out
}

/** 会话用量计数器初始值（批次4：成本统计）。新增字段，不需要升数据库版本 */
export function emptyUsage() {
  return { calls: 0, prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 }
}

/** 累计消耗 token（prompt + completion） */
export function totalTokens(u) {
  return (Number(u?.prompt) || 0) + (Number(u?.completion) || 0)
}

/** token 数紧凑显示：980 → "980"；12345 → "12.3k"；2_500_000 → "2.5M" */
export function fmtTokens(n) {
  const v = Number(n) || 0
  if (v < 1000) return String(v)
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 100_000 ? 1 : 0)}k`
  return `${(v / 1_000_000).toFixed(1)}M`
}

export function fmtTime(ts) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
