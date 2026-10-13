// 角色卡与会话的引用关系：快照解耦 + 读时兜底（P0-3）
//
// 确认的产品语义：**角色卡与已开始的故事解耦**。
// 开新故事时把角色卡关键字段快照进 `session.cardSnapshot`，此后
// 编辑 / 删除原卡都不再影响进行中的故事（故事保持自己的人设一致性）。
// 老会话没有快照 → 仍按 `characterId` 读原卡，行为与修复前一致（向后兼容）。
import { db } from './db'

/** 快照字段：影响扮演效果的全部人设文本（只取字符串，防止把数组 / 函数带进快照） */
const SNAP_FIELDS = ['name', 'description', 'personality', 'scenario', 'userPersona', 'styleExamples']

/** 会话头部的状态提示文案（验收单 F3 / F5 按常量比对，改动需同步验收单） */
export const CARD_SOURCE_LABEL = {
  snapshot: '角色卡已删除 · 使用快照',
  missing: '角色卡缺失，无法继续生成',
}

/** 卡片 → 快照对象；无有效卡片时返回 null（永不抛错） */
export function snapshotOf(card) {
  if (!card) return null
  const s = {}
  for (const k of SNAP_FIELDS) s[k] = typeof card[k] === 'string' ? card[k] : ''
  return s.name ? s : null
}

/** 有多少个故事正在引用这张卡（无索引时走全表扫描，会话量级为几十~几百，可接受） */
export function countSessionsUsingCard(cardId) {
  return db.sessions.filter((s) => s.characterId === cardId).count()
}

/**
 * 删除卡片前：把引用该卡的会话解引用（characterId → null），并补上快照。
 * 已存在快照时**保留原快照**（它才是故事一直在用的人设），只补老会话的缺失快照。
 */
export async function detachCard(cardId) {
  const card = await db.characters.get(cardId)
  const snap = snapshotOf(card)
  const sessions = await db.sessions.filter((s) => s.characterId === cardId).toArray()
  for (const s of sessions) {
    await db.sessions.update(s.id, { cardSnapshot: s.cardSnapshot || snap, characterId: null })
  }
  return { detached: sessions.length, snapshot: snap }
}

/**
 * 读时兜底：取当前故事真正使用的角色卡。
 * @returns {{card: Object|null, source: 'live'|'detached'|'snapshot'|'missing'|'none'}}
 *   live      —— 老会话（无快照）且原卡仍在：与修复前行为一致
 *   detached  —— 有快照且原卡仍在：解耦生效，编辑原卡不影响本故事
 *   snapshot  —— 有快照但原卡已删除 / 已解引用
 *   missing   —— 既无快照也无卡：无法继续生成（调用方必须禁用发送）
 */
export async function resolveCard(session) {
  if (!session) return { card: null, source: 'none' }
  const snap = session.cardSnapshot || null
  const live = session.characterId ? await db.characters.get(session.characterId) : null
  if (snap) return { card: { ...snap }, source: live ? 'detached' : 'snapshot' }
  if (live) return { card: live, source: 'live' }
  return { card: null, source: 'missing' }
}

/** 会话列表用的轻量判定：既无快照、原卡也不存在 → 角色卡缺失 */
export function isCardMissing(session, card) {
  if (!session) return false
  if (session.cardSnapshot) return false
  if (!session.characterId) return true
  return !card
}
