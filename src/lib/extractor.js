// 异步状态提取器：回合结束后在后台运行，把剧情变化写回世界状态库。
// 任务先落盘（IndexedDB 队列），页面中途关闭则下次打开补跑，diff 应用幂等。
//
// P0-4 防护（四道锁）：
//   1. 入队去重  —— enqueueTask：同一 (sessionId, assistantMsgId) 未完成的任务不重复入队
//   2. 乐观锁    —— claimTask：仅 pending 状态可领取，多标签页并发时只有一个能领到
//   3. 页内互斥  —— processPendingTasks：同页并发调用（StrictMode 双跑 / 快速切 tab）
//                   串行化为"等上一轮跑完再补跑一轮"，不重复执行
//   4. 失败退避  —— 领取时 attempts 自增，达 MAX_ATTEMPTS 转_failed，不再无限重试污染日志
import { db, getMessages, emptyState } from './db'
import { makeApi } from './api'
import { matchRules, hookPatch } from './hooks'

export const EXTRACTOR_SYS = `你是角色扮演游戏的状态记录器。读取最近一轮对话与当前世界状态，提取其中新发生的变化。
只输出严格 JSON，不输出任何其他文字、注释或代码块标记。格式：
{"characters":{"角色名":{"location":"当前位置","mood":"情绪","goal":"当前目标","inventory_add":["获得物品"],"knows_add":["新获知的信息"]}},"facts_add":["新确立的世界事实"],"events_add":["发生的事件"],"relations_add":[{"from":"角色A","to":"角色B","desc":"两人当前的关系"}]}
规则：
- 只记录本轮新发生的变化，无变化时输出 {}
- 字段均可省略；只输出有值的字段
- knows 只记录角色在剧情中实际获知的信息，不要推断
- facts 是世界观层面的事实，events 是本回合发生的具体事件
- relations 只在本轮**明确出现或明确改变**人物关系时才输出；同一对人物再次给出即覆盖旧关系
- 角色名以剧情中出现的称呼为准，保持与现有状态中的名字一致`

/** 生效的提取提示词：用户自定义（批次7）优先，留空用内置 */
export function extractorSys(settings) {
  const custom = String(settings?.extractorPrompt || '').trim()
  return custom || EXTRACTOR_SYS
}

const MAX_ATTEMPTS = 3

function parseJsonLoose(raw) {
  let s = (raw || '').trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start > 0 || end < s.length - 1) s = s.slice(Math.max(0, start), end + 1)
  return JSON.parse(s)
}

/** 事实/事件的去重键：turn + text 复合。
 *  只用 text 会"过度去重"——「第5回合王城陷落」与「第9回合王城陷落」是合法重复，
 *  吞掉任何一条都是用户发现不了的静默丢事实。 */
function entryKey(turn, text) {
  return `${turn ?? 0}\u0000${text}`
}

export function applyDiff(state, diff, turn) {
  const s = JSON.parse(JSON.stringify(state || emptyState()))
  s.characters = s.characters || {}
  s.facts = s.facts || []
  s.events = s.events || []
  s.relations = s.relations || []
  if (!diff || typeof diff !== 'object') return s

  for (const [name, ch] of Object.entries(diff.characters || {})) {
    if (!name) continue
    const cur = s.characters[name] || (s.characters[name] = { name, location: '', mood: '', goal: '', inventory: [], knows: [] })
    for (const k of ['location', 'mood', 'goal']) {
      if (typeof ch[k] === 'string' && ch[k].trim()) cur[k] = ch[k].trim()
    }
    if (Array.isArray(ch.inventory_add)) cur.inventory = [...new Set([...(cur.inventory || []), ...ch.inventory_add.filter(Boolean)])]
    if (Array.isArray(ch.knows_add)) cur.knows = [...new Set([...(cur.knows || []), ...ch.knows_add.filter(Boolean)])]
  }
  // facts / events：按 (turn, text) 去重 → 同一任务重放不会重复写入（幂等），
  // 不同 turn 的同文本合法保留（不过度去重），同一 diff 内部的重复条目也只写一条
  const factKeys = new Set(s.facts.map((f) => entryKey(f.turn, f.text)))
  for (const f of diff.facts_add || []) {
    if (!f || !String(f).trim()) continue
    const text = String(f).trim()
    const key = entryKey(turn, text)
    if (factKeys.has(key)) continue
    factKeys.add(key)
    s.facts.push({ turn, text })
  }
  // relations：按 (from, to) 定位，重复给出即覆盖 desc（关系"演变"而非堆积）。
  // 覆盖式写入天然幂等：同一 diff 重放结果完全一致。
  for (const r of diff.relations_add || []) {
    if (!r || typeof r !== 'object') continue
    const item = {
      from: String(r.from ?? '').trim(),
      to: String(r.to ?? '').trim(),
      desc: String(r.desc ?? '').trim(),
    }
    if (!item.from || !item.to) continue
    const i = s.relations.findIndex((x) => x && x.from === item.from && x.to === item.to)
    if (i >= 0) {
      if (s.relations[i].desc !== item.desc) s.relations[i] = { ...s.relations[i], desc: item.desc, turn }
    } else {
      s.relations.push({ ...item, turn })
    }
  }

  const eventKeys = new Set(s.events.map((e) => entryKey(e.turn, e.text)))
  for (const e of diff.events_add || []) {
    if (!e || !String(e).trim()) continue
    const text = String(e).trim()
    const key = entryKey(turn, text)
    if (eventKeys.has(key)) continue
    eventKeys.add(key)
    s.events.push({ turn, text })
  }
  return s
}

/**
 * 从任务表快照里取出"有待补跑任务的会话 id"：去重、过滤掉 sessionId 缺失的脏记录。
 * 纯函数（零 IndexedDB 依赖），供 App 启动时的全局补跑使用。
 */
export function pendingSessionIds(tasks) {
  return [...new Set(
    (tasks || [])
      .filter((t) => t && t.status === 'pending' && t.sessionId != null)
      .map((t) => t.sessionId)
  )]
}

/** 入队去重：同一 (sessionId, assistantMsgId) 已有未完成任务时不重复入队，返回任务 id */
export async function enqueueTask(sessionId, userMsgId, assistantMsgId) {
  const dup = await db.tasks.where('sessionId').equals(sessionId)
    .filter((t) => t.assistantMsgId === assistantMsgId && t.status !== 'done')
    .first()
  if (dup) return dup.id
  return db.tasks.add({ sessionId, userMsgId, assistantMsgId, status: 'pending', attempts: 0, ts: Date.now() })
}

/** 乐观锁领取：事务内 check-then-act，仅当任务仍处于 pending 时才置 running 并累加 attempts。
 *  IndexedDB 读写事务对同一记录串行化，多标签页并发领同一任务时只有一个能成功。 */
export async function claimTask(id) {
  let claimed = false
  await db.transaction('rw', db.tasks, async () => {
    const t = await db.tasks.get(id)
    if (!t || t.status !== 'pending') return
    await db.tasks.update(id, { status: 'running', attempts: (t.attempts || 0) + 1, error: null })
    claimed = true
  })
  return claimed
}

/** 失败后的去向：达上限转 failed（等待设置页手动重试），否则回 pending 下次再试 */
export function failureStatus(attempts) {
  return attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
}

/** 页内互斥：同一会话的提取串行执行。
 *  已有运行中的提取时，本次调用等它结束后再补跑一轮（新入队的任务会被该轮捞到），
 *  避免 StrictMode 双跑 / 快速切 tab 反复 mount 导致同一任务被执行两次。 */
const inflight = new Map() // sessionId -> 进行中的 Promise

export async function processPendingTasks(sessionId, settings, onUpdate) {
  const prev = inflight.get(sessionId)
  const run = (async () => {
    if (prev) { try { await prev } catch { /* 上一轮失败不影响本轮补跑 */ } }
    await runPendingTasks(sessionId, settings, onUpdate)
  })()
  inflight.set(sessionId, run)
  try { await run } finally { if (inflight.get(sessionId) === run) inflight.delete(sessionId) }
}

/** 单轮提取：调用模型拿 diff（不写库）。runPendingTasks 与回溯重放共用 */
async function extractRound(api, sys, state, userMsg, aMsg, sessionId) {
  const content = `## 最近一轮对话\n用户：${userMsg.content}\n角色：${aMsg.content}\n\n## 当前状态\n${JSON.stringify(state || emptyState())}`
  const raw = await api.complete(
    [{ role: 'system', content: sys }, { role: 'user', content }],
    // purpose=extract：路由层可让状态提取走另一家（如更便宜的）模型
    { json: true, temperature: 0, purpose: 'extract', metadata: { sessionId } }
  )
  return parseJsonLoose(raw)
}

/**
 * 回溯提取（批次7）：从 stateLog 覆盖的某个回合起，用当前提取器重放之后的全部轮次。
 * 起点状态取该回合 log 条目里的「提取前快照」，因此重放与当初的路径无关、结果可复现。
 * 用途：换了提示词 / 换了模型 / 当轮提取错了，从任意记录点推倒重来。
 * @returns {Promise<number>} 重放的轮数
 */
export async function reExtractFrom(sessionId, fromTurn, settings, onProgress) {
  const session = await db.sessions.get(sessionId)
  if (!session) throw new Error('会话不存在')
  const entry = (session.stateLog || []).find((e) => e.turn === fromTurn)
  if (!entry) throw new Error('没有该回合的提取记录（可回溯范围仅限最近 20 次提取）')

  const msgs = await getMessages(sessionId)
  // 按回合配对 user / assistant（同一轮消息的 turn 相同）
  const byTurn = new Map()
  for (const m of msgs) {
    if (!m.turn) continue
    const pair = byTurn.get(m.turn) || {}
    pair[m.role] = m
    byTurn.set(m.turn, pair)
  }
  const turns = [...byTurn.keys()]
    .filter((t) => t >= fromTurn && byTurn.get(t).user && byTurn.get(t).assistant)
    .sort((a, b) => a - b)
  if (!turns.length) throw new Error('该回合之后没有完整的对话轮')

  const api = makeApi(settings)
  const sys = extractorSys(settings)
  let state = entry.snapshot
  const newLog = []
  let done = 0
  for (const t of turns) {
    const { user, assistant } = byTurn.get(t)
    const diff = await extractRound(api, sys, state, user, assistant, sessionId)
    const before = state
    state = applyDiff(state, diff, t)
    newLog.push({ turn: t, ts: Date.now(), diff, snapshot: before })
    done += 1
    onProgress && onProgress(done, turns.length)
  }
  // 合并审计日志：起点之前的旧记录保留，之后全部由重放结果替换；仍只留最近 20 条
  const merged = [...(session.stateLog || []).filter((e) => e.turn < fromTurn), ...newLog].slice(-20)
  await db.sessions.update(sessionId, { state, stateLog: merged, updatedAt: Date.now() })
  return turns.length
}

/**
 * 撤销一次提取（批次7）：回到该次提取**之前**的状态，并丢弃该次及之后的记录。
 * 之后可从更早的记录点回溯重放（reExtractFrom）。
 */
export async function undoExtract(sessionId, turn) {
  const session = await db.sessions.get(sessionId)
  const log = session?.stateLog || []
  const entry = log.find((e) => e.turn === turn)
  if (!entry) throw new Error('没有该回合的提取记录')
  await db.sessions.update(sessionId, {
    state: entry.snapshot,
    stateLog: log.filter((e) => e.turn < turn).slice(-20),
    updatedAt: Date.now(),
  })
}

/** 处理某会话所有 pending 提取任务；串行执行，失败则停（下次再试） */
async function runPendingTasks(sessionId, settings, onUpdate) {
  const tasks = (await db.tasks.where('sessionId').equals(sessionId).toArray())
    .filter((t) => t.status === 'pending')
    .sort((a, b) => a.id - b.id)
  if (!tasks.length) return

  const api = makeApi(settings)
  const sys = extractorSys(settings)
  const msgs = await getMessages(sessionId)
  const rules = await db.rules.toArray().catch(() => []) // 老库无 rules 表时静默跳过钩子

  for (const t of tasks) {
    // 乐观锁：抢不到说明已被其他标签页领走（或状态已变），跳过
    if (!(await claimTask(t.id))) continue
    try {
      const session = await db.sessions.get(sessionId)
      const userMsg = msgs.find((m) => m.id === t.userMsgId)
      const aMsg = msgs.find((m) => m.id === t.assistantMsgId)
      if (!userMsg || !aMsg) { await db.tasks.update(t.id, { status: 'done' }); continue }

      const diff = await extractRound(api, sys, session.state, userMsg, aMsg, sessionId)
      // applyDiff 幂等：即使本任务曾被部分应用（写状态成功、标 done 失败）后重跑，也不会重复写入
      const next = applyDiff(session.state, diff, aMsg.turn || 0)
      // 审计（批次7）：应用前快照 + diff 落 stateLog（session 普通字段，无需升库版本），供撤销 / 回溯
      const stateLog = [...(session.stateLog || []), { turn: aMsg.turn || 0, ts: Date.now(), diff, snapshot: session.state }].slice(-20)
      // 事件钩子（批次8）：diff 命中规则 → 解锁世界书 / 排队一次性提示 / 记触发日志。
      // patch 与状态更新合并成**单次写库**，避免多标签页下互相覆盖。
      const fired = matchRules(rules, diff)
      const hooks = fired.length ? hookPatch(session, fired, aMsg.turn || 0) : {}
      await db.sessions.update(sessionId, { state: next, stateLog, updatedAt: Date.now(), ...hooks })
      await db.tasks.update(t.id, { status: 'done' })
      onUpdate && onUpdate()
    } catch (e) {
      // 失败退避：attempts 已在领取时自增（本地 t 是旧快照，需 +1 还原当前值）；
      // 达上限转 failed——不再无限 pending 重试，等用户在设置页点「重试失败任务」
      const status = failureStatus((t.attempts || 0) + 1)
      await db.tasks.update(t.id, { status, error: String(e?.message || e) })
      break
    }
  }
}
