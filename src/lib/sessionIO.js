// 会话（聊天记录）导入导出
// 导出：JSON（无损，含状态/专属世界书/角色卡快照，可再导入）或 TXT（纯对话文本）
// 导入：RP Engine 会话 JSON → 重建会话；角色卡按名字复用，缺失则从快照重建
import { db, getTimeline } from './db'
import { normalizeLore } from './lore'
import { snapshotOf } from './cardRef'
import { emptyUsage } from './util'

/** 构建无损导出对象 */
export async function buildSessionExport(sessionId) {
  const session = await db.sessions.get(sessionId)
  if (!session) throw new Error('会话不存在')
  // 故事实际使用的是快照（解耦语义）；原卡仍在时用它补齐快照没有的字段（开场白、备选开场、内嵌世界书）
  const live = session.characterId ? await db.characters.get(session.characterId) : null
  const card = session.cardSnapshot ? { ...(live || {}), ...session.cardSnapshot } : live
  // 批次9：导出当前时间线（暗线分支不导出——导入端按线性链重建 parent 关系）
  const messages = await getTimeline(sessionId)
  return {
    app: 'rp-engine',
    type: 'session',
    version: 1,
    exportedAt: new Date().toISOString(),
    session: {
      name: session.name,
      state: session.state,
      lore: normalizeLore(session.lore || []), // 导出即规范化，保证再导入后删 1 条只掉 1 条
      summary: session.summary || '',          // 批次4：早期剧情摘要（导入后进度归零，摘要本身保留）
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      // 批次8/9：时间线与钩子数据（老版本导出文件没有这些字段，导入时按空处理）
      activeMsgIndex: (() => { // 活动指针转为"时间线下标"（导入端消息 id 是新建的，旧 id 无意义）
        const ids = messages.map((m) => m.id)
        const idx = session.activeMsgId != null ? ids.lastIndexOf(session.activeMsgId) : -1
        return idx >= 0 ? idx : messages.length - 1
      })(),
      snapshots: (session.snapshots || []).map((s) => ({
        name: s.name,
        state: s.state,
        ts: s.ts,
        msgIndex: (() => { const ids = messages.map((m) => m.id); const i = s.msgId != null ? ids.lastIndexOf(s.msgId) : -1; return i >= 0 ? i : null })(),
      })),
      hookLog: session.hookLog || [],
      pendingHints: session.pendingHints || [],
    },
    card: card ? {
      name: card.name,
      description: card.description || '',
      personality: card.personality || '',
      scenario: card.scenario || '',
      firstMessage: card.firstMessage || '',
      styleExamples: card.styleExamples || '',
      userPersona: card.userPersona || '',
      alternateGreetings: card.alternateGreetings || [],
      embeddedLore: card.embeddedLore || [],
    } : null,
    messages: messages.map((m) => ({ role: m.role, content: m.content, turn: m.turn || 0, ts: m.ts || Date.now() })),
  }
}

/** 纯文本转录（仅对话，供阅读/分享） */
export function transcriptText(exp) {
  const cardName = exp.card?.name || '角色'
  const head = `${exp.session.name}\n（导出自 RP Engine · ${new Date(exp.exportedAt).toLocaleString()} · ${exp.messages.length} 条消息）`
  const body = exp.messages.map((m) => `${m.role === 'user' ? '你' : cardName}：\n${m.content}`)
  return [head, ...body].join('\n\n')
}

export function downloadFile(name, text, mime = 'application/json') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

export function safeFileName(s) {
  return String(s || 'session').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
}

/** 导入会话文件 → 新会话 id；角色卡按名字复用，缺失则从快照重建 */
export async function importSessionFile(file) {
  let exp
  try { exp = JSON.parse(await file.text()) } catch { throw new Error('JSON 解析失败') }
  if (exp?.app !== 'rp-engine' || exp?.type !== 'session') throw new Error('不是 RP Engine 的会话导出文件')
  if (!Array.isArray(exp.messages) || !exp.messages.length) throw new Error('文件中没有消息数据')

  // 角色卡：同名复用，否则用快照重建（无快照则用会话名建占位卡）
  let card = exp.card?.name ? (await db.characters.where('name').equals(exp.card.name).first()) : null
  if (!card) {
    const cardObj = exp.card?.name
      ? { ...exp.card }
      : { name: exp.session?.name || '导入角色', description: '', personality: '', scenario: '', firstMessage: '', styleExamples: '', userPersona: '', alternateGreetings: [], embeddedLore: [] }
    const cid = await db.characters.add(cardObj)
    card = await db.characters.get(cid)
  }

  const now = Date.now()
  const sid = await db.sessions.add({
    name: exp.session?.name || `${card.name}的导入故事`,
    characterId: card.id,
    cardSnapshot: snapshotOf(card),
    state: exp.session?.state || { characters: {}, facts: [], events: [], relations: [] },
    lore: normalizeLore(exp.session?.lore), // 老导出文件可能无 uid，导入时补齐
    params: {},           // 导入的故事默认全部跟随全局参数
    usage: emptyUsage(),  // 导入的故事从零开始统计
    summary: exp.session?.summary || '',
    summaryUpTo: 0,       // 消息 id 是新建的，旧摘要进度无意义
    createdAt: exp.session?.createdAt || now,
    updatedAt: now,
    // 批次8/9：钩子数据与存档直接带回；activeMsgId / 存档 msgId 等消息建好后回填
    hookLog: exp.session?.hookLog || [],
    pendingHints: exp.session?.pendingHints || [],
  })

  // 批次9：逐条建消息并接 parent 链（导入端消息 id 是新建的，必须知道前一条的新 id）
  const newIds = []
  let prevId = null
  for (const m of exp.messages) {
    const id = await db.messages.add({
      sessionId: sid, role: m.role, content: m.content, turn: m.turn || 0, ts: m.ts || now, parentId: prevId,
    })
    newIds.push(id)
    prevId = id
  }
  const activeIndex = Number.isInteger(exp.session?.activeMsgIndex) ? exp.session.activeMsgIndex : newIds.length - 1
  const snapshots = (exp.session?.snapshots || [])
    .filter((s) => Number.isInteger(s?.msgIndex) && s.msgIndex >= 0 && s.msgIndex < newIds.length)
    .map((s) => ({ id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: s.name, state: s.state, ts: s.ts, msgId: newIds[s.msgIndex] }))
  if (newIds.length) {
    await db.sessions.update(sid, {
      activeMsgId: newIds[Math.min(Math.max(activeIndex, 0), newIds.length - 1)],
      ...(snapshots.length ? { snapshots } : {}),
    })
  }
  return sid
}
