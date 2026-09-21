// 异步状态提取器：回合结束后在后台运行，把剧情变化写回世界状态库。
// 任务先落盘（IndexedDB 队列），页面中途关闭则下次打开补跑，diff 应用幂等。
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

function parseJsonLoose(raw) {
  let s = (raw || '').trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start > 0 || end < s.length - 1) s = s.slice(Math.max(0, start), end + 1)
  return JSON.parse(s)
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
  for (const f of diff.facts_add || []) {
    if (f && String(f).trim()) s.facts.push({ turn, text: String(f).trim() })
  }
  for (const e of diff.events_add || []) {
    if (e && String(e).trim()) s.events.push({ turn, text: String(e).trim() })
  }
  return s
}

/** 处理某会话所有 pending 提取任务；串行执行，失败则停（下次再试） */
export async function processPendingTasks(sessionId, settings, onUpdate) {
  const tasks = (await db.tasks.where('sessionId').equals(sessionId).toArray())
    .filter((t) => t.status === 'pending')
    .sort((a, b) => a.id - b.id)
  if (!tasks.length) return

  const api = makeApi(settings)
  const msgs = await getMessages(sessionId)

  for (const t of tasks) {
    try {
      await db.tasks.update(t.id, { status: 'running' })
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
      const next = applyDiff(session.state, diff, aMsg.turn || 0)
      await db.sessions.update(sessionId, { state: next, updatedAt: Date.now() })
      await db.tasks.update(t.id, { status: 'done' })
      onUpdate && onUpdate()
    } catch (e) {
      await db.tasks.update(t.id, { status: 'pending', error: String(e?.message || e) })
      break
    }
  }
}
