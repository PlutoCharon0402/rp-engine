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

/** keys 字段容错归一：规范为字符串（数组 join、其他强转），外部工具产的卡可能给数组 */
function loreKeys(e) {
  const raw = Array.isArray(e.keys) ? e.keys.join('，') : e.keys
  return String(raw ?? '')
    .split(/[,，]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

/** 关键词触发世界书：常驻条目恒注入，其余按近期文本命中；按优先级排序、token 预算裁剪 */
export function matchLore(entries, recentText, budget = 600) {
  const text = (recentText || '').toLowerCase()
  const hits = (entries || [])
    .filter((e) => e.enabled !== false)
    .filter((e) => {
      if (e.constant) return true
      const keys = loreKeys(e)
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
 * 布局（前缀缓存友好）：[system: 角色卡+常驻设定] → 全部历史 →
 *   [system: 状态+触发世界书+导演指令] → 最后 depth 条消息 → [user: 续写指令] →
 *   末条消息后缀：导演指令最终提醒
 * 导演指令两处刻意重复（动态块完整版 + 绝对末尾提醒，flash/pro 档遵循度）。
 * alpha.14：末尾提醒从独立 system 消息改为**最后一条消息的后缀**——部分推理模型的
 * chat 模板会丢弃/挪动末尾 system 消息，后缀形式保证任何模板下模型都能读到；
 * 续写指令移入编译器（第 9 参 tailUser），保证提醒始终排在它之后（绝对末尾）。
 * 静态前缀+历史构成逐字节稳定的前缀（历史只增不改），缓存命中率随对话增长趋近上限。
 * @param hints 事件钩子的一次性剧情提示（批次8）：注入后由调用方消费清空
 * @param director 导演指令（C8）：{ enabled, notes: [{ id, text, createdAt }] }——用户对扮演者的
 *                 执导要求。与角色卡解耦：卡是「角色是谁」，导演指令是「用户要求 AI 怎么演」
 * @param tailUser 续写指令（不落库的收尾 user 消息，原由 ChatView 编译后自 push）
 */
export function compileMessages(card, lore, state, history, settings, summary, hints, director, tailUser) {
  const constant = (lore || []).filter((e) => e.enabled !== false && e.constant).map((e) => substMacros(e.content, card))
  const directorNotes = (director && director.enabled === false ? [] : (director?.notes || []))
    .map((n) => String(n?.text || '').trim())
    .filter(Boolean)
    .map((t) => substMacros(t, card))
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
    // 批次8：事件钩子的一次性提示（规则触发后只在下一回合注入一次，随后被消费清空）
    hints?.length && `## 剧情事件（刚发生的事件触发了以下提示，只提示这一次）\n${hints.map((h) => h.text).join('\n')}`,
    triggered.length && `## 世界书补充设定\n${triggered.map((t) => substMacros(t, card)).join('\n\n')}`,
    // C8：导演指令放动态块**末尾**（紧贴生成点，遵循度最高）；强制语气 + 编号列表
    directorNotes.length &&
      `## 导演指令（用户对你的执导要求，必须遵守，优先级高于你的默认文风；这是导演给你的要求，不是剧情内容，不要复述或提及）\n` +
      directorNotes.map((t, i) => `${i + 1}. ${t}`).join('\n'),
  ].filter(Boolean).join('\n\n')

  for (const m of head) messages.push({ role: m.role, content: m.content })
  if (dyn.trim()) messages.push({ role: 'system', content: dyn })
  for (const m of tail) messages.push({ role: m.role, content: m.content })

  // 续写指令（不落库）：收尾 user 消息，排在导演提醒之前
  if (tailUser) messages.push({ role: 'user', content: tailUser })

  // alpha.14：导演指令最终提醒 = 最后一条消息的**后缀**（prompt 绝对末尾）。
  // 弱指令模型（flash 档）对 prompt 末尾内容的遵循度压倒前文；部分推理模型的
  // chat 模板会丢弃/挪动末尾独立 system 消息，后缀形式在任何模板下都能被读到。
  // 与动态块完整版是刻意重复（两处注入提权）。「格式放大器」一句专为
  // 「在回复末尾输出特定内容」类指令（325 探针）补一道保险。
  if (directorNotes.length) {
    const reminder =
      `〔导演指令·最终提醒：必须执行以下要求，优先级最高；这不是用户发言，不属于剧情内容，不要提及〕\n` +
      directorNotes.map((t, i) => `${i + 1}. ${t}`).join('\n') +
      `\n若某条指令要求在回复末尾输出特定内容，必须在正文结束后原样输出，不得省略。\n现在生成你的回复。`
    const last = messages[messages.length - 1]
    if (last && messages.length > 1) last.content = `${last.content}\n\n${reminder}`
    else messages.push({ role: 'user', content: reminder })
  }
  return messages
}
