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

const EXTRACTOR_SYS = `你是角色扮演游戏的状态记录器。读取最近一轮对话与当前世界状态，提取其中新发生的变化。
只输出严格 JSON，不输出任何其他文字、注释或代码块标记。格式：
{"characters":{"角色名":{"location":"当前位置","mood":"情绪","goal":"当前目标","inventory_add":["获得物品"],"knows_add":["新获知的信息"]}},"facts_add":["新确立的世界事实"],"events_add":["发生的事件"]}
规则：
- 只记录本轮新发生的变化，无变化时输出 {}
- 字段均可省略；只输出有值的字段
- knows 只记录角色在剧情中实际获知的信息，不要推断
- facts 是世界观层面的事实，events 是本回合发生的具体事件
- 角色名以剧情中出现的称呼为准，保持与现有状态中的名字一致`

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

/** 处理某会话所有 pending 提取任务；串行执行，失败则停（下次再试） */
async function runPendingTasks(sessionId, settings, onUpdate) {
  const tasks = (await db.tasks.where('sessionId').equals(sessionId).toArray())
    .filter((t) => t.status === 'pending')
    .sort((a, b) => a.id - b.id)
  if (!tasks.length) return

  const api = makeApi(settings)
  const msgs = await getMessages(sessionId)

  for (const t of tasks) {
    // 乐观锁：抢不到说明已被其他标签页领走（或状态已变），跳过
    if (!(await claimTask(t.id))) continue
    try {
      const session = await db.sessions.get(sessionId)
      const userMsg = msgs.find((m) => m.id === t.userMsgId)
      const aMsg = msgs.find((m) => m.id === t.assistantMsgId)
      if (!userMsg || !aMsg) { await db.tasks.update(t.id, { status: 'done' }); continue }

      const content = `## 最近一轮对话\n用户：${userMsg.content}\n角色：${aMsg.content}\n\n## 当前状态\n${JSON.stringify(session.state || emptyState())}`
      const raw = await api.complete(
        [{ role: 'system', content: EXTRACTOR_SYS }, { role: 'user', content }],
        { json: true, temperature: 0 }
      )
      const diff = parseJsonLoose(raw)
      // applyDiff 幂等：即使本任务曾被部分应用（写状态成功、标 done 失败）后重跑，也不会重复写入
      const next = applyDiff(session.state, diff, aMsg.turn || 0)
      await db.sessions.update(sessionId, { state: next, updatedAt: Date.now() })
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
