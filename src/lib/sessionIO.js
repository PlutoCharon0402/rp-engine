// 会话（聊天记录）导入导出
// 导出：JSON（无损，含状态/专属世界书/角色卡快照，可再导入）或 TXT（纯对话文本）
// 导入：RP Engine 会话 JSON → 重建会话；角色卡按名字复用，缺失则从快照重建
import { db, getMessages } from './db'
import { normalizeLore } from './lore'
import { snapshotOf } from './cardRef'

/** 构建无损导出对象 */
export async function buildSessionExport(sessionId) {
  const session = await db.sessions.get(sessionId)
  if (!session) throw new Error('会话不存在')
  // 故事实际使用的是快照（解耦语义）；原卡仍在时用它补齐快照没有的字段（开场白、备选开场、内嵌世界书）
  const live = session.characterId ? await db.characters.get(session.characterId) : null
  const card = session.cardSnapshot ? { ...(live || {}), ...session.cardSnapshot } : live
  const messages = await getMessages(sessionId)
  return {
    app: 'rp-engine',
    type: 'session',
    version: 1,
    exportedAt: new Date().toISOString(),
    session: {
      name: session.name,
      state: session.state,
      lore: normalizeLore(session.lore || []), // 导出即规范化，保证再导入后删 1 条只掉 1 条
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
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
    createdAt: exp.session?.createdAt || now,
    updatedAt: now,
  })
  await db.messages.bulkAdd(
    exp.messages.map((m) => ({ sessionId: sid, role: m.role, content: m.content, turn: m.turn || 0, ts: m.ts || now }))
  )
  return sid
}
