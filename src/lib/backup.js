// 全量备份（导出 / 导入）的校验与写入逻辑。
// 抽成独立模块是为了让"校验"与"落库"都能被单测覆盖：
// validateDump 是纯函数（零 IndexedDB 依赖），importDump 负责单事务写入。
import { db } from './db'

/** 四类核心数据，至少要有一类存在才算合法备份 */
export const CORE_TABLES = ['characters', 'sessions', 'messages', 'lore']
/** 可被导入的表（tasks 可选：老备份没有它） */
export const DUMP_TABLES = [...CORE_TABLES, 'tasks']
/** 导入时会被清空的表（含 tasks：exportData 已含它，避免导入后任务凭空消失） */
export const CLEAR_TABLES = [...CORE_TABLES, 'tasks']

/** 每张表的核心必填字段：只校验最关键的几个，避免过严拒绝老备份 */
const REQUIRED = {
  characters: ['name'],
  sessions: ['name'],
  messages: ['sessionId', 'role', 'content'],
  lore: ['content'],
  tasks: ['sessionId'],
}

const TABLE_LABEL = {
  characters: '角色卡',
  sessions: '故事',
  messages: '消息',
  lore: '世界书',
  tasks: '提取任务',
}

/**
 * 校验一份导入文件是否是合法的全量备份。
 * 合法 → 返回 { tables, counts }；非法 → **抛 Error**（错误信息面向最终用户，可直接展示）。
 *
 * 三种必须拦住的情况：
 * ① 单故事导出文件（.session.json）—— 顶层有 messages 数组，曾导致"清全库 + 塞入孤儿消息"；
 * ② 任意无关 JSON（如 package.json）—— 四类数据一个都没有；
 * ③ 结构不合法（某表不是数组 / 记录缺关键字段）。
 */
export function validateDump(dump) {
  if (!dump || typeof dump !== 'object' || Array.isArray(dump)) {
    throw new Error('备份文件顶层必须是 JSON 对象')
  }
  // ① 单故事导出文件：必须在"没有任何数据改动"之前拦下
  if (dump.app === 'rp-engine' && dump.type === 'session') {
    throw new Error('这是单个故事的导出文件（.session.json），请在「对话」页用「导入记录」导入。全量导入会清空整个数据库。')
  }

  const present = DUMP_TABLES.filter((t) => Array.isArray(dump[t]))
  const corePresent = CORE_TABLES.filter((t) => Array.isArray(dump[t]))
  // ② 没有可导入的数据
  if (!corePresent.length) {
    throw new Error('备份文件中没有可导入的数据（缺少 characters / sessions / messages / lore）')
  }

  // ③ 逐条结构校验；错误最多收集 5 条，避免巨型文件刷屏
  const errs = []
  for (const t of DUMP_TABLES) {
    if (dump[t] === undefined) continue
    if (!Array.isArray(dump[t])) { errs.push(`${TABLE_LABEL[t]}（${t}）不是数组`); continue }
    for (let i = 0; i < dump[t].length; i++) {
      const r = dump[t][i]
      if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`${TABLE_LABEL[t]}（${t}）第 ${i + 1} 条不是对象`); break }
      for (const f of REQUIRED[t]) {
        if (r[f] === undefined || r[f] === null) { errs.push(`${t}[${i}] 缺少字段 ${f}`); break }
      }
      if (errs.length >= 5) break
    }
    if (errs.length >= 5) break
  }
  if (errs.length) {
    throw new Error('备份文件格式不正确：' + errs.slice(0, 3).join('；') + (errs.length > 3 ? ` …等 ${errs.length} 处` : ''))
  }

  return { tables: present, counts: Object.fromEntries(present.map((t) => [t, dump[t].length])) }
}

/**
 * 把一份（已校验的）备份写入数据库。
 * 清空 + 写入放在**同一个** rw 事务里：任一步失败（如主键重复 → ConstraintError）
 * IndexedDB 会整体回滚，不会出现"清了但没写回"。
 */
export async function importDump(dump) {
  const { tables } = validateDump(dump)
  await db.transaction('rw', CLEAR_TABLES.map((t) => db.table(t)), async () => {
    for (const t of CLEAR_TABLES) await db.table(t).clear()
    for (const t of tables) await db.table(t).bulkAdd(dump[t])
  })
  return Object.fromEntries(tables.map((t) => [t, dump[t].length]))
}

/* ────────────────────────────────────────────────────────────
 * 批次3 · 全量快照（backups 表）
 *
 * 背景：全量导入是"清库后覆盖"。虽然有单事务回滚，但一旦导入成功、用户才想起导错了，
 * 就没有任何回滚手段（旧数据已被覆盖）。快照 = 一次后悔药。
 *
 * ⚠️ backups 表**不在** CLEAR_TABLES 里 —— 导入清空时它必须活下来，快照才有意义。
 * ──────────────────────────────────────────────────────────── */

/** 参与快照 / 导出的表（含 tasks：与导入清空范围对齐） */
export const SNAPSHOT_TABLES = [...DUMP_TABLES]

/** 读全库 → 可序列化的 dump 对象 */
export async function buildDump() {
  const dump = {}
  for (const t of SNAPSHOT_TABLES) dump[t] = await db.table(t).toArray()
  return dump
}

export function countDump(dump) {
  return SNAPSHOT_TABLES.reduce((n, t) => n + (dump[t]?.length || 0), 0)
}

/** 浏览器下载。**只在 UI 调用**：node 测试环境没有 document / Blob URL */
export function downloadDump(dump, name) {
  const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name || `rp-engine-backup-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

/**
 * 拍一张全量快照。返回 { id, counts }。
 * protectId：prune 时强制保留的快照（恢复场景用它保住"刚用过的那张"）。
 */
export async function snapshotBackup(reason = '手动快照', protectId = null) {
  const dump = await buildDump()
  const counts = Object.fromEntries(SNAPSHOT_TABLES.map((t) => [t, dump[t].length]))
  const id = await db.backups.add({ createdAt: Date.now(), reason, counts, dump })
  await pruneBackups(3, protectId ?? id)
  return { id, counts }
}

/** 只保留最近 keep 条（protectId 豁免）。返回删除条数 */
export async function pruneBackups(keep = 3, protectId = null) {
  const all = await db.backups.orderBy('createdAt').reverse().toArray()
  const keepers = new Set(all.slice(0, Math.max(1, keep)).map((b) => b.id))
  if (protectId != null) keepers.add(protectId)
  const drop = all.filter((b) => !keepers.has(b.id)).map((b) => b.id)
  if (drop.length) await db.backups.bulkDelete(drop)
  return drop.length
}

/** 快照清单（不含 dump 本体，避免把整库读进内存） */
export async function listBackups() {
  const all = await db.backups.orderBy('createdAt').reverse().toArray()
  return all.map((b) => ({ id: b.id, createdAt: b.createdAt, reason: b.reason, counts: b.counts }))
}

/**
 * 恢复某张快照：先给**当前**数据再拍一张（对称，恢复也能反悔），再覆盖写入。
 * 返回 { counts, undoId }：counts 是实际写入条数，undoId 是"回到恢复前"的快照 id。
 */
export async function restoreBackup(id) {
  const snap = await db.backups.get(id)
  if (!snap) throw new Error('该快照已不存在（可能已被自动清理）')
  const { id: undoId } = await snapshotBackup('恢复前自动快照', id)
  const counts = await importDump(snap.dump)
  return { counts, undoId }
}
