// 上下文编译器：静态前缀（角色卡+常驻世界书，吃前缀缓存）+ 动态后缀（状态+触发世界书+近期对话）
import { estTokens } from './util'
import { emptyState } from './db'

/** 宏替换：{{char}}→角色名，{{user}}→「你」（酒馆卡导入后保留宏，编译时才展开） */
export function substMacros(text, card) {
  if (!text) return text
  return String(text)
    .replace(/\{\{char\}\}/gi, card?.name || '角色')
    .replace(/\{\{user\}\}/gi, '你')
}

export function cardText(card) {
  const p = []
  p.push('你正在与用户进行沉浸式角色扮演。保持角色一致，用生动的叙述推进剧情，不要跳出角色，不要替用户角色说话或行动，不要复述用户的话。')
  p.push(substMacros(`## 你扮演的角色\n姓名：${card.name || '未命名'}\n${card.description ? `外貌与背景：${card.description}\n` : ''}${card.personality ? `性格与说话方式：${card.personality}` : ''}`, card))
  if (card.scenario) p.push(substMacros(`## 世界观与当前场景\n${card.scenario}`, card))
  if (card.userPersona) p.push(substMacros(`## 用户扮演的角色\n${card.userPersona}`, card))
  if (card.styleExamples) p.push(substMacros(`## 文风示例\n${card.styleExamples}`, card))
  return p.filter(Boolean).join('\n\n')
}

/** 关键词触发世界书：常驻条目恒注入，其余按近期文本命中；按优先级排序、token 预算裁剪 */
export function matchLore(entries, recentText, budget = 600) {
  const text = (recentText || '').toLowerCase()
  const hits = (entries || [])
    .filter((e) => e.enabled !== false)
    .filter((e) => {
      if (e.constant) return true
      const keys = (e.keys || '').split(/[,，]/).map((s) => s.trim().toLowerCase()).filter(Boolean)
      return keys.some((k) => text.includes(k))
    })
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
  const out = []
  let used = 0
  for (const e of hits) {
    const t = estTokens(e.content || '')
    if (used + t > budget) continue
    out.push(e.content)
    used += t
  }
  return out
}

export function stateSummary(state) {
  const s = state || emptyState()
  const lines = []
  const chars = Object.values(s.characters || {})
  if (chars.length) {
    lines.push('## 当前世界状态（由系统维护，剧情必须与此保持一致，不得矛盾）')
    for (const c of chars) {
      const seg = [c.location && `位置：${c.location}`, c.mood && `情绪：${c.mood}`, c.goal && `目标：${c.goal}`]
        .filter(Boolean).join('，')
      lines.push(`- ${c.name}${seg ? `（${seg}）` : ''}`)
      if (c.knows?.length) lines.push(`  - 已知信息：${c.knows.join('；')}`)
      if (c.inventory?.length) lines.push(`  - 持有：${c.inventory.join('、')}`)
    }
  }
  if (s.facts?.length) {
    lines.push('## 既定事实\n' + s.facts.slice(-8).map((f) => `- ${f.text}`).join('\n'))
  }
  if (s.events?.length) {
    lines.push('## 近期事件\n' + s.events.slice(-6).map((e) => `- ${e.text}`).join('\n'))
  }
  return lines.join('\n')
}

/**
 * 编译最终 messages。
 * 布局（前缀缓存友好）：[system: 角色卡+常驻设定] → 全部历史 → [system: 状态+触发世界书] → 最后 depth 条消息
 * depth=1 时：动态块紧贴最新用户消息之前——prompt 仍以用户行动收尾（扮演效果好），
 * 且静态前缀+历史构成逐字节稳定的前缀（历史只增不改），缓存命中率随对话增长趋近上限。
 * 每轮未命中部分恒定 ≈ 上一轮新回复 + 动态块 + 新用户消息。
 */
export function compileMessages(card, lore, state, history, settings) {
  const constant = (lore || []).filter((e) => e.enabled !== false && e.constant).map((e) => substMacros(e.content, card))
  const messages = [{ role: 'system', content: [cardText(card), ...constant].filter(Boolean).join('\n\n') }]

  const hist = (history || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-(settings.maxHistory || 40))

  const depth = Math.max(0, settings.depth ?? 1)
  const cut = Math.max(0, hist.length - depth)
  const head = hist.slice(0, cut)
  const tail = hist.slice(cut)

  // 世界书触发扫描窗口独立于注入深度：始终看最近 4 条消息，避免 depth=1 时触发面过窄
  const scanText = hist.slice(-4).map((m) => m.content).join('\n')
  const triggered = matchLore(lore, scanText, settings.loreBudget ?? 600)
  const dyn = [
    stateSummary(state),
    triggered.length && `## 世界书补充设定\n${triggered.map((t) => substMacros(t, card)).join('\n\n')}`,
  ].filter(Boolean).join('\n\n')

  for (const m of head) messages.push({ role: m.role, content: m.content })
  if (dyn.trim()) messages.push({ role: 'system', content: dyn })
  for (const m of tail) messages.push({ role: m.role, content: m.content })
  return messages
}
