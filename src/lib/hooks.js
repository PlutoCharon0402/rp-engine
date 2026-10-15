/**
 * 事件钩子（批次8）：剧情事件 → 规则匹配 → 动作执行。
 *
 * 数据模型（rules 表，全局共享）：
 *   { id, name, enabled,
 *     when: { character, location, hasItem, factKeyword, relationFrom, relationTo },
 *     then: { activateLoreUids: [], injectOnce, note } }
 *
 * 匹配语义（关键设计决策）：
 *   - 条件匹配的是**本轮 diff**（新发生的变化），不是全量状态——
 *     否则"角色在书店"这类持续状态会每回合都触发。
 *   - 同一规则内多个条件是 **AND**：全部非空条件都被本轮变化满足才触发；
 *     一个条件都不填的规则不触发（防呆，等价于死规则）。
 *   - 文本类条件（location / factKeyword / hasItem）用包含匹配，大小写不敏感。
 *
 * 动作语义：
 *   - activateLoreUids：把本故事世界书里对应 uid 的条目启用（"剧情解锁"：条目
 *     默认停用埋着，事件发生才亮出来。注意：只影响 session.lore，不碰全局 lore）
 *   - injectOnce：写入 session.pendingHints，**下一回合**编译时注入（标记"只提示一次"），
 *     生成成功后由 ChatView 消费清空
 *   - 触发本身写 session.hookLog（审计，与 stateLog 同样可查）
 */
import { db } from './db'

/** 单条规则的 when 是否被本轮 diff 满足（纯函数） */
function ruleFired(rule, diff) {
  const w = rule.when || {}
  const checks = []
  if (w.character || w.location) {
    checks.push(Object.entries(diff.characters || {}).some(([name, ch]) => {
      if (w.character && name !== w.character) return false
      if (w.location && !String(ch.location || '').toLowerCase().includes(w.location.toLowerCase())) return false
      return true
    }))
  }
  if (w.hasItem) {
    const item = w.hasItem.toLowerCase()
    checks.push(Object.values(diff.characters || {}).some((ch) =>
      (ch.inventory_add || []).some((it) => String(it || '').toLowerCase().includes(item))))
  }
  if (w.factKeyword) {
    const kw = w.factKeyword.toLowerCase()
    const texts = [...(diff.facts_add || []), ...(diff.events_add || [])].map(String)
    checks.push(texts.some((t) => t.toLowerCase().includes(kw)))
  }
  if (w.relationFrom || w.relationTo) {
    checks.push((diff.relations_add || []).some((r) =>
      (!w.relationFrom || r.from === w.relationFrom) && (!w.relationTo || r.to === w.relationTo)))
  }
  if (!checks.length) return false // 没有任何条件 → 永不触发
  return checks.every(Boolean)
}

/**
 * 规则匹配（纯函数，可单测）：返回被本轮 diff 命中的规则列表。
 * @param {Array} rules rules 表全量
 * @param {object} diff 本轮提取产生的 diff
 */
export function matchRules(rules, diff) {
  if (!diff || typeof diff !== 'object') return []
  return (rules || []).filter((r) => r && r.enabled !== false && ruleFired(r, diff))
}

/**
 * 计算命中规则要写到 session 上的 patch（纯函数，方便调用方与其他更新合并成单次写库）。
 * @param {object} session 提取前的会话对象（lore / pendingHints / hookLog 的基底）
 * @param {Array} fired matchRules 命中的规则
 * @param {number} turn 本轮回合号
 * @returns {object} Dexie update patch（可能为空对象 = 没有任何动作要执行）
 */
export function hookPatch(session, fired, turn) {
  if (!fired?.length) return {}
  const s = session || {}
  const patch = {}
  const lore = [...(s.lore || [])]
  let loreChanged = false
  const uids = new Set(fired.flatMap((r) => (r.then?.activateLoreUids || []).filter(Boolean)))
  for (const e of lore) {
    if (uids.has(e.uid) && e.enabled === false) { e.enabled = true; loreChanged = true }
  }
  if (loreChanged) patch.lore = lore
  const hints = fired.filter((r) => r.then?.injectOnce?.trim())
  if (hints.length) {
    patch.pendingHints = [...(s.pendingHints || []), ...hints.map((r) => ({ ruleId: r.id, text: r.then.injectOnce.trim() }))].slice(-5)
  }
  patch.hookLog = [...(s.hookLog || []), ...fired.map((r) => ({ ruleId: r.id, name: r.name, turn, ts: Date.now() }))].slice(-50)
  return patch
}
