// 上下文编译器：静态前缀（角色卡+常驻世界书，吃前缀缓存）+ 动态后缀（状态+触发世界书+近期对话）
import { estTokens } from './util'
import { emptyState } from './db'
import { getProvider } from './providers/registry'

/** 宏替换：{{char}}→角色名，{{user}}→「你」（酒馆卡导入后保留宏，编译时才展开） */
export function substMacros(text, card) {
  if (!text) return text
  return String(text)
    .replace(/\{\{char\}\}/gi, card?.name || '角色')
    .replace(/\{\{user\}\}/gi, '你')
}

/** 角色卡 → 静态前缀文本。对 null / undefined / 空对象都必须返回兜底文本，绝不抛错 */
export function cardText(card) {
  const c = card || {}
  const p = []
  p.push('你正在与用户进行沉浸式角色扮演。保持角色一致，用生动的叙述推进剧情，不要跳出角色，不要替用户角色说话或行动，不要复述用户的话。')
  p.push(substMacros(`## 你扮演的角色\n姓名：${c.name || '未命名'}\n${c.description ? `外貌与背景：${c.description}\n` : ''}${c.personality ? `性格与说话方式：${c.personality}` : ''}`, c))
  if (c.scenario) p.push(substMacros(`## 世界观与当前场景\n${c.scenario}`, c))
  if (c.userPersona) p.push(substMacros(`## 用户扮演的角色\n${c.userPersona}`, c))
  if (c.styleExamples) p.push(substMacros(`## 文风示例\n${c.styleExamples}`, c))
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
  const rels = (s.relations || []).filter((r) => r && r.from && r.to)
  if (rels.length) {
    lines.push('## 人物关系\n' + rels.slice(-8).map((r) => `- ${r.from} → ${r.to}：${r.desc || '（未描述）'}`).join('\n'))
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
 * 当前模型的上下文窗口（token）。来自厂商配置（32k~200k 不等），无厂商信息时保守取 32k。
 * 这是批次6"窗口感知裁剪"的核心：小窗口不超窗，大窗口不多带。
 */
function contextWindowTokens(settings) {
  const p = getProvider(settings, settings?.providerId)
  return Number(p?.context) > 0 ? Number(p.context) : 32768
}

/**
 * 双重裁剪历史：条数上限（maxHistory，用户可调）+ token 预算（按模型窗口换算）。
 * 从最新往回装，预算用尽即止；无论预算多紧都保留最新 1 条（截断好过空历史）。
 * 纯函数，可单测。
 */
export function trimHistory(history, maxHistory, budgetTokens) {
  const list = (history || []).filter((m) => m.role === 'user' || m.role === 'assistant')
  const capped = list.slice(-Math.max(1, Number(maxHistory) || 40))
  let used = 0
  let cut = 0 // 默认全保留
  for (let i = capped.length - 1; i >= 0; i--) {
    used += estTokens(capped[i].content || '') + 4 // +4：role 与消息边界的粗略开销
    if (used > (Number(budgetTokens) || 0)) {
      // 连最新一条都装不下时仍保留它（截断好过空历史）；否则丢弃 i 及更早的
      cut = Math.max(Math.min(i + 1, capped.length - 1), 0)
      break
    }
  }
  return capped.slice(cut)
}

/**
 * 编译最终 messages。
 * 布局（前缀缓存友好）：[system: 角色卡+常驻设定] → 全部历史 → [system: 状态+触发世界书] → 最后 depth 条消息
 * depth=1 时：动态块紧贴最新用户消息之前——prompt 仍以用户行动收尾（扮演效果好），
 * 且静态前缀+历史构成逐字节稳定的前缀（历史只增不改），缓存命中率随对话增长趋近上限。
 * 每轮未命中部分恒定 ≈ 上一轮新回复 + 动态块 + 新用户消息。
 */
export function compileMessages(card, lore, state, history, settings, summary) {
  const constant = (lore || []).filter((e) => e.enabled !== false && e.constant).map((e) => substMacros(e.content, card))
  const messages = [{ role: 'system', content: [cardText(card), ...constant].filter(Boolean).join('\n\n') }]

  // 窗口预算 = 模型上下文 − 静态前缀 − 输出预留 − 动态块粗略预留（状态/世界书/摘要）
  const ctx = contextWindowTokens(settings)
  const reserve = (Number(settings.maxTokens) || 1024) + 1600
  const budget = Math.max(1000, ctx - reserve - estTokens(messages[0].content))
  const hist = trimHistory(history, settings.maxHistory, budget)

  const depth = Math.max(0, settings.depth ?? 1)
  const cut = Math.max(0, hist.length - depth)
  const head = hist.slice(0, cut)
  const tail = hist.slice(cut)

  // 世界书触发扫描窗口独立于注入深度：始终看最近 4 条消息，避免 depth=1 时触发面过窄
  const scanText = hist.slice(-4).map((m) => m.content).join('\n')
  const triggered = matchLore(lore, scanText, settings.loreBudget ?? 600)
  // 早期剧情摘要：窗口外的旧对话靠它保持连贯（无摘要时这一项为空，dyn 不变）
  const dyn = [
    summary && `## 更早的剧情摘要（已发生的情节，不得与之矛盾）\n${summary}`,
    stateSummary(state),
    triggered.length && `## 世界书补充设定\n${triggered.map((t) => substMacros(t, card)).join('\n\n')}`,
  ].filter(Boolean).join('\n\n')

  for (const m of head) messages.push({ role: m.role, content: m.content })
  if (dyn.trim()) messages.push({ role: 'system', content: dyn })
  for (const m of tail) messages.push({ role: m.role, content: m.content })
  return messages
}
