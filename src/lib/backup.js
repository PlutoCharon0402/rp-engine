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
