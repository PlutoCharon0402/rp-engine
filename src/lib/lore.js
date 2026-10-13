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
 * 世界书导入包校验（批次4）。合法 → 返回规范化后的条目数组（带 uid）；非法 → **抛 Error**。
 *
 * 三种必须拦下的文件：
 * ① 全量备份（有 characters / sessions / messages 顶层键）—— 导入它会清库；
 * ② 单故事导出（app=rp-engine & type=session）—— 该走「对话」页的导入记录；
 * ③ 任意无关 JSON（没有 entries 或条目无 content）。
 */
export function validateLorePack(dump) {
  if (!dump || typeof dump !== 'object' || Array.isArray(dump)) {
    throw new Error('文件顶层必须是 JSON 对象')
  }
  if (dump.app === 'rp-engine' && dump.type === 'session') {
    throw new Error('这是单个故事的导出文件（.session.json），请在「对话」页用「导入记录」导入')
  }
  if (dump.characters || dump.sessions || dump.messages) {
    throw new Error('这是全量备份文件，请在「设置」页用「导入备份」导入（会覆盖整个数据库）')
  }
  if (dump.app === 'rp-engine' && dump.type !== 'lore') {
    throw new Error('不是 RP Engine 的世界书导出文件')
  }
  if (!Array.isArray(dump.entries)) throw new Error('缺少 entries 数组')
  if (!dump.entries.length) throw new Error('文件中没有条目')

  const entries = dump.entries.filter((e) => e && typeof e === 'object' && typeof e.content === 'string' && e.content.trim())
  if (!entries.length) throw new Error('没有可导入的条目（每条至少要有一个非空的 content）')
  return normalizeLore(entries)
}

/** 构建世界书导出包 */
export function buildLorePack(entries) {
  return {
    app: 'rp-engine',
    type: 'lore',
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: normalizeLore(entries).map((e) => ({
      keys: e.keys || '',
      content: e.content || '',
      priority: Number(e.priority) || 0,
      constant: !!e.constant,
      enabled: e.enabled !== false,
    })),
  }
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
