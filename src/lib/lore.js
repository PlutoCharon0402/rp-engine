// 世界书条目的身份与增删改：全部为纯函数，便于单测（零 IndexedDB 依赖）。
//
// 背景（P0-2）：会话级条目（从角色卡带入 / 从会话文件导入）历史上**没有 uid**，
// 而 LoreView 用 `e.uid === id` 当身份判定 → id 为 undefined 时命中全部条目，
// 表现为"删 1 条清空全部 / 启停 1 条全部翻转 / 编辑 1 条变成新增副本"。
// 因此这里把 uid 作为会话级条目的唯一身份来源，并对"缺失身份"做守卫生。

const DEFAULTS = { keys: '', content: '', priority: 0, constant: false, enabled: true }

/** 生成条目 uid。带随机后缀，避免同一毫秒内新增两条时撞号 */
export const newUid = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/**
 * 规范化条目列表：补 uid、去 uid 重复、补默认字段、剔除非法项。
 * 对已规范化的输入是**幂等**的（uid 与字段都不再变化），可安全重复调用。
 */
export function normalizeLore(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  return list.map((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null
    let uid = typeof e.uid === 'string' && e.uid && !seen.has(e.uid) ? e.uid : null
    if (!uid) { do { uid = newUid() } while (seen.has(uid)) }
    seen.add(uid)
    return { ...DEFAULTS, ...e, uid }
  }).filter(Boolean)
}

/**
 * 新增或更新一条。
 * @param {Array} list 当前条目列表
 * @param {Object} rec 要写入的字段
 * @param {string|number|null} uid 有值则原地更新（保留未提交字段），null/undefined 则追加
 */
export function upsertLore(list, rec, uid) {
  const src = normalizeLore(list)
  const i = uid == null ? -1 : src.findIndex((e) => e.uid === uid)
  if (i >= 0) return src.map((e, j) => (j === i ? { ...e, ...rec, uid } : e))
  return [...src, { ...DEFAULTS, ...rec, uid: newUid() }]
}

/**
 * 删除一条。**守卫**：uid 为 null/undefined 时不做任何删除（只返回规范化结果）。
 * 这是 P0-2 的核心防线——历史上 `filter(e => e.uid !== undefined)` 会把所有无 uid 条目一次删光。
 */
export function removeLore(list, uid) {
  if (uid == null) return normalizeLore(list)
  return normalizeLore(list).filter((e) => e.uid !== uid)
}

/**
 * 启停一条。同样带 uid 守卫：uid 缺失时不变更任何条目（避免"全部翻转"）。
 */
export function toggleLore(list, uid) {
  if (uid == null) return normalizeLore(list)
  const src = normalizeLore(list)
  const i = src.findIndex((e) => e.uid === uid)
  if (i < 0) return src
  return src.map((e, j) => (j === i ? { ...e, enabled: e.enabled === false } : e))
}
