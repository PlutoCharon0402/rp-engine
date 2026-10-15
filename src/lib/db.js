import Dexie from 'dexie'

export const db = new Dexie('rp-engine')

/* ────────────────────────────────────────────────────────────
 * ⚠️ 数据库迁移规则（改动前务必阅读）
 *
 * 1. version(1) 是历史版本，**永远不要修改**它的 stores()。
 *    直接改 v1 会让存量用户打开时抛 VersionError —— 全库不可访问，且没有导出入口。
 * 2. 需要【新增 / 删除 / 改名索引】或【新增表】→ 追加 db.version(n + 1).stores(...)。
 * 3. 只给记录【新增普通字段】（不用于 where / orderBy 查询）→ **不需要升版本**，
 *    直接写即可，旧版本代码读取时自动忽略。
 *    例：`session.cardSnapshot`、`lore[].uid`、`task.attempts` —— 全部无需迁移。
 * 4. version(n) 一旦发布就【不可回退】：本地 DB 版本号只增不减，
 *    回退代码会抛 VersionError。上线前必须在测试库上验证 upgrade。
 * 5. 改动 db.js 后必须重新构建并发布：Service Worker 的缓存名由
 *    vite.config.js 在构建时注入，旧 bundle（只声明到 v1）打开 v2 库会直接崩。
 * ──────────────────────────────────────────────────────────── */

db.version(1).stores({                       // ← 冻结，勿改
  characters: '++id, name',
  sessions: '++id, updatedAt',
  messages: '++id, sessionId',
  lore: '++id',
  tasks: '++id, sessionId, status',
})

// v3：新增 backups 表（导入 / 恢复前的自动快照，给"清库覆盖"一次后悔药）。
// 同样只加表、不改既有数据形状（未挂 upgrade → 数据零改动，向后兼容）。
// ⚠️ backups **不参与导入清空**：importDump 的 CLEAR_TABLES 刻意不含它，快照才活得过导入。
db.version(3).stores({
  characters: '++id, name',
  sessions: '++id, updatedAt, characterId',      // P0-3：按角色卡查引用该卡的会话
  messages: '++id, sessionId, [sessionId+id]',   // 按会话取历史时可用复合索引排序
  lore: '++id',
  tasks: '++id, sessionId, status, [sessionId+status]',
  backups: '++id, createdAt',                    // 批次3：全量快照（自动 / 手动）
})

// v4：新增 metrics 表（多模型性能监控：每次模型调用一条记录，按厂商聚合对比）。
// 同样只加表；⚠️ metrics **不参与导入清空**——历史表现数据不应被导入备份抹掉。
db.version(4).stores({
  characters: '++id, name',
  sessions: '++id, updatedAt, characterId',
  messages: '++id, sessionId, [sessionId+id]',
  lore: '++id',
  tasks: '++id, sessionId, status, [sessionId+status]',
  backups: '++id, createdAt',
  metrics: '++id, ts, provider, purpose',        // 多模型：调用记录（保留最近 500 条）
})

// v5（批次8+9 合并迁移）：
//   - 新增 rules 表：事件钩子规则（条件→动作，全局共享）
//   - messages 加 parentId 索引：时间线分支（消息树，按 parent 链回溯当前时间线）
// 仍只加表 / 加索引，不改既有数据形状（未挂 upgrade → 数据零改动，向后兼容）。
// rules 与 lore 同级属于用户数据 → 参与全量备份的导出与清空（见 backup.js）。
db.version(5).stores({
  characters: '++id, name',
  sessions: '++id, updatedAt, characterId',
  messages: '++id, sessionId, [sessionId+id], parentId',  // parentId：上一条消息 id（null=链头）
  lore: '++id',
  tasks: '++id, sessionId, status, [sessionId+status]',
  backups: '++id, createdAt',
  metrics: '++id, ts, provider, purpose',
  rules: '++id, enabled',                       // 批次8：事件规则（++id, enabled）
})

// 多标签页 / 多窗口：别的连接未关闭时升级会被阻塞，给出明确指引而不是静默失败
db.on('blocked', () => {
  console.warn('[rp-engine] 数据库升级被其他标签页阻塞，请关闭本应用的其他标签页后刷新。')
})
// 别的标签页要升级时，本标签页主动让路（关闭连接后对方可继续）
db.on('versionchange', () => { db.close() })

export async function getMessages(sessionId) {
  return (await db.messages.where('sessionId').equals(sessionId).toArray())
    .sort((a, b) => a.id - b.id)
}

/**
 * 时间线感知取历史（批次9）：
 *   - 旧会话（没有任何 parentId）→ 全量按 id 升序（行为与旧版完全一致）
 *   - 有 parentId 的会话 → 从 session.activeMsgId（缺省取最新一条）沿 parent 链回溯
 *     到链头，得到"当前时间线"；被切走的旧分支仍在库里，只是不显示。
 * 防御：activeMsgId 失效（指向已删消息）时回退全量，绝不返回空历史。
 */
export async function getTimeline(sessionId) {
  const all = await getMessages(sessionId)
  if (!all.length || !all.some((m) => m.parentId != null)) return all
  const s = await db.sessions.get(sessionId)
  const byId = new Map(all.map((m) => [m.id, m]))
  let cur = s?.activeMsgId != null ? byId.get(s.activeMsgId) : null
  if (!cur) cur = all[all.length - 1] // 活动指针缺失 → 最新消息
  const chain = []
  while (cur) {
    chain.unshift(cur)
    cur = cur.parentId != null ? byId.get(cur.parentId) : null
  }
  return chain.length ? chain : all
}

/** 把会话的活动时间线指针移到某条消息（批次9「从此分支」/ 存档恢复用） */
export async function setTimelineHead(sessionId, msgId) {
  await db.sessions.update(sessionId, { activeMsgId: msgId })
}

export function emptyState() {
  return { characters: {}, facts: [], events: [], relations: [] }
}

// 开发环境调试入口：仅在 DEV 下暴露到 window，便于 Console 里跑验证脚本。
// 生产构建下 import.meta.env.DEV === false → 死代码被 tree-shake，零运行时影响。
// typeof 守卫是为了让 vitest（node 环境、无 window）也能直接 import 本模块。
if (import.meta.env.DEV && typeof window !== 'undefined') window.__db = db
