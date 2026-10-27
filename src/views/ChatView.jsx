import { useEffect, useRef, useState } from 'react'
import { db, getTimeline, setTimelineHead } from '../lib/db'
import { compileMessages } from '../lib/compiler'
import { processPendingTasks, enqueueTask } from '../lib/extractor'
import { makeApi } from '../lib/api'
import { hasAnyProviderReady } from '../lib/providers/registry'
import { resolveCard, CARD_SOURCE_LABEL } from '../lib/cardRef'
import { effectiveSettings, fmtTokens } from '../lib/util'
import { summarizePlan, runSummary } from '../lib/summarize'
import { pushBackHandler } from '../lib/backRouter'
import { buildProbeDirector, evaluateProbeResult, PROBE_TOKEN } from '../lib/selfCheck'

const QUICK_CHIPS = ['（请继续）', '（时间推进到次日）', '（切换场景）']

/** 导演指令条目 id：d + 时间戳 + 随机后缀（避免同毫秒撞号） */
const newDirId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/** 参数输入框取值：未设置 → 空串（表示跟随全局） */
const numOrEmpty = (v) => (v === null || v === undefined || v === '' ? '' : v)
/** 参数输入框回写：空串 = 跟随全局；非法数字一律当空（绝不把 NaN 写进库） */
const numInput = (v) => (v === '' || !Number.isFinite(Number(v)) ? '' : Number(v))

/** 会话累计用量文案：' · 累计 12.3k tokens（缓存命中 68%）'；无数据返回空串 */
function usageText(u) {
  if (!u || !u.calls) return ''
  const total = (Number(u.prompt) || 0) + (Number(u.completion) || 0)
  const hit = Number(u.cacheHit) || 0
  const miss = Number(u.cacheMiss) || 0
  const rate = hit + miss > 0 ? Math.round((hit / (hit + miss)) * 100) : 0
  return ` · 累计 ${fmtTokens(total)} tokens（缓存命中 ${rate}%）`
}

export default function ChatView({ sessionId, settings, onExit, onSessionUpdate, onGoSettings }) {
  const [session, setSession] = useState(null)
  const [card, setCard] = useState(null)
  const [cardSource, setCardSource] = useState('none') // live | detached | snapshot | missing | none
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(null) // null=未在生成，string=增量文本
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('') // 非错误提示（如"已停止生成"），info 样式
  const [usage, setUsage] = useState(null) // 最近一次生成的 usage（含缓存命中）
  const [lastPrompt, setLastPrompt] = useState(null) // 诊断快照：上一回合发送的完整 prompt
  const [menu, setMenu] = useState(null)   // 消息操作弹层：当前消息对象
  const [editText, setEditText] = useState(null) // null=非编辑态；string=正在编辑该消息
  const [showParams, setShowParams] = useState(false) // 本故事参数覆盖弹层
  const [dirDraft, setDirDraft] = useState(null)      // C8：导演指令弹层的本地草稿（null=关闭）；关闭时统一写库
  const [probing, setProbing] = useState(false)       // 导演遵循自检进行中
  const [probeResult, setProbeResult] = useState(null) // 自检结果（pass/truncated/fail/error/aborted）
  const scrollRef = useRef(null)
  const abortRef = useRef(null)            // 进行中的流式请求，用于「停止」
  const probeAbortRef = useRef(null)       // 自检的独立中断器（与正式生成互不干扰）
  const busy = streaming !== null || probing
  // 本故事参数覆盖：session.params 里填了的字段盖过全局设置，没填的跟随全局。
  // 模型/厂商已从会话参数中移除（用户决定：全局唯一入口在「设置 → AI 模型」），
  // 历史会话 params 里残留的 providerId/model 在读取时剥离，避免旧覆盖值钉死模型。
  const { providerId: _legacyProviderId, model: _legacyModel, ...paramOverrides } = session?.params || {}
  const eff = effectiveSettings(settings, paramOverrides)
  // 导演指令状态（老会话无 director 字段 → 读侧兜底为「启用 + 空列表」）
  const director = session?.director || { enabled: true, notes: [] }
  const activeDirNotes = (director.notes || []).filter((n) => String(n?.text || '').trim())
  const directorOn = director.enabled !== false && activeDirNotes.length > 0

  useEffect(() => {
    (async () => {
      const s = await db.sessions.get(sessionId)
      setSession(s)
      // 读时兜底：快照 → 原卡 → 缺失。角色卡被删也不会拿到 undefined 而崩在编译器里
      const { card: resolved, source } = await resolveCard(s)
      setCard(resolved)
      setCardSource(source)
      setMessages(await getTimeline(sessionId))
      setError('')
      setProbeResult(null)
      // 补跑上次未完成的状态提取
      const pending = (await db.tasks.where('sessionId').equals(sessionId).toArray()).filter((t) => t.status === 'pending')
      if (pending.length) kickExtraction(null, null, true)
    })()
    // 离开会话时中断仍在进行的生成与自检：已生成的部分会被落库，不留"永远收不到回复"的孤儿请求
    return () => { abortRef.current?.abort(); probeAbortRef.current?.abort() }
  }, [sessionId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  // P0：返回键优先关弹层（导演弹层关闭时顺带保存草稿），而不是退出会话——
  // 否则编辑到一半按返回键，导演指令会被整包丢弃（实测「时灵时不灵」的主因）
  useEffect(() => {
    return pushBackHandler(() => {
      if (dirDraft) { closeDirector(); return true }
      if (editText !== null) { setEditText(null); return true }
      if (menu) { closeMenu(); return true }
      if (showParams) { setShowParams(false); return true }
      return false
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirDraft, editText, menu, showParams])

  async function refreshSession() {
    const s = await db.sessions.get(sessionId)
    setSession(s)
    onSessionUpdate && onSessionUpdate()
  }

  /* ── 导演指令（C8）：用户对扮演者的执导要求，注入 prompt 但不属于剧情 ── */

  /** 打开弹层：以库内数据为草稿起点 */
  function openDirector() {
    setDirDraft({ enabled: director.enabled !== false, notes: (director.notes || []).map((n) => ({ ...n })), newText: '' })
  }

  /** 草稿 → 库（清洗：trim、丢空条、newText 并入）。P1：每次增删改/失焦即调用，防任何路径丢草稿 */
  async function persistDirector(draft) {
    if (!draft || !sessionId) return
    const notes = draft.notes
      .map((n) => ({ id: n.id, text: String(n.text || '').trim(), createdAt: n.createdAt }))
      .filter((n) => n.text)
    const add = String(draft.newText || '').trim()
    if (add) notes.push({ id: newDirId(), text: add, createdAt: Date.now() })
    await db.sessions.update(sessionId, { director: { enabled: draft.enabled !== false, notes }, updatedAt: Date.now() })
    refreshSession()
  }

  /** 关闭弹层：兜底落盘（正常路径下增删改已各自落库，这里防漏） */
  async function closeDirector() {
    if (dirDraft) await persistDirector(dirDraft)
    setDirDraft(null)
  }

  /** 更新草稿并立即落盘（开关 / 添加 / 删除用；输入框在失焦时落盘，避免每键一次写入） */
  function updateDir(next) {
    setDirDraft(next)
    persistDirector(next)
  }

  /** 累计本次生成的 token 到会话（modify 函数内自增，避免读改写竞态）。
   *  u 是多模型层的归一化 Usage（inputTokens/outputTokens/cacheRead/cacheWrite） */
  async function addUsage(u) {
    if (!u) return
    try {
      await db.sessions.where('id').equals(sessionId).modify((s) => {
        s.usage = s.usage || { calls: 0, prompt: 0, completion: 0, cacheHit: 0, cacheMiss: 0 }
        s.usage.calls += 1
        s.usage.prompt += Number(u.inputTokens) || 0
        s.usage.completion += Number(u.outputTokens) || 0
        s.usage.cacheHit += Number(u.cacheRead) || 0
        s.usage.cacheMiss += Number(u.cacheWrite) || 0
      })
      refreshSession() // 让标题栏的累计数立即跟上
    } catch { /* 统计失败绝不影响对话 */ }
  }

  /** 滚动摘要：窗口外的早期对话折叠成摘要写回会话，失败静默（下回合带更多消息重试） */
  async function maybeSummarize(history) {
    if (!sessionId) return
    const maxHistory = Number(eff.maxHistory) || 40
    const plan = summarizePlan(history, maxHistory, session?.summaryUpTo || 0)
    if (!plan) return
    try {
      const { summary, summaryUpTo } = await runSummary({
        plan,
        prevSummary: session?.summary,
        settings: eff,
      })
      await db.sessions.update(sessionId, { summary, summaryUpTo })
      refreshSession()
    } catch { /* 摘要失败不影响对话 */ }
  }

  function kickExtraction(userMsg, aMsg, catchUpOnly = false) {
    setExtracting(true)
    ;(async () => {
      try {
        if (!catchUpOnly && userMsg && aMsg) {
          await enqueueTask(sessionId, userMsg.id, aMsg.id) // 入队去重：同 assistantMsgId 不重复入队
        }
        await processPendingTasks(sessionId, eff, refreshSession)
      } catch { /* 提取失败不阻塞对话，任务保持 pending，下次补跑 */ }
      finally { setExtracting(false) }
    })()
  }

  /** 停止当前生成 / 自检：abort 会让 stream 的 fetch 抛 AbortError，由对应 catch 收尾 */
  function stopStreaming() {
    abortRef.current?.abort()
    probeAbortRef.current?.abort()
  }

  /**
   * 导演遵循自检（alpha-feedback §6.3）：把探针指令临时追加到当前导演指令后发一次请求，
   * 机械判定模型是否真的在回复末尾输出 325。
   * 刻意不落库、不消费 pendingHints、不写世界状态、不计入会话用量——这是一次性诊断，
   * 不能污染故事本身。结果只在弹层内展示。
   */
  async function runDirectorSelfCheck() {
    if (busy) return
    if (!hasAnyProviderReady(settings)) {
      setProbeResult({ status: 'error', detail: '尚未配置任何模型的 API Key，无法自检。请到「设置」页完成配置。' })
      return
    }
    if (cardSource === 'missing') {
      setProbeResult({ status: 'error', detail: CARD_SOURCE_LABEL.missing })
      return
    }
    const controller = new AbortController()
    probeAbortRef.current = controller
    setProbing(true)
    setProbeResult(null)
    let acc = ''
    try {
      const lore = [...(await db.lore.toArray()), ...(session?.lore || [])]
      const api = makeApi(eff)
      const compiled = compileMessages(
        card, lore, session?.state, messages, eff,
        session?.summary, session?.pendingHints, buildProbeDirector(director),
      )
      let finishReason = null
      let usage = null
      for await (const delta of api.stream(compiled, {
        signal: controller.signal,
        onUsage: (u) => { usage = u },
        onFinish: (reason) => { finishReason = reason },
      })) {
        acc += delta
      }
      setProbeResult(evaluateProbeResult({ text: acc, finishReason, usage }))
    } catch (e) {
      if (e?.name === 'AbortError') {
        setProbeResult({ status: 'aborted', detail: '自检已取消。' })
      } else {
        setProbeResult({ status: 'error', detail: `自检失败：${String(e?.message || e)}` })
      }
    } finally {
      setProbing(false)
      if (probeAbortRef.current === controller) probeAbortRef.current = null
    }
  }

  /**
   * 生成前守卫。**必须在改动数据之前调用**：
   * - send 会先落库用户消息，若等到 streamReply 里才发现没 Key，就留下一条永远收不到回复的孤儿消息；
   * - regenerate 会先删掉末尾 assistant，若此时才发现没 Key，等于白白删掉一条已有回复。
   */
  function canGenerate() {
    if (!hasAnyProviderReady(settings)) {
      setError('尚未配置任何模型：请到「设置」页填写 API Key，或添加本机模型服务')
      onGoSettings && onGoSettings()
      return false
    }
    if (cardSource === 'missing') { setError(CARD_SOURCE_LABEL.missing); return false }
    return true
  }

  async function streamReply(history, opts = {}) {
    if (!hasAnyProviderReady(settings)) { setError('尚未配置任何模型：请到「设置」页填写 API Key'); onGoSettings && onGoSettings(); return }
    // 无角色卡可用：直接拒绝，绝不留一条永远收不到回复的孤儿用户消息
    if (cardSource === 'missing') { setError(CARD_SOURCE_LABEL.missing); return }
    const controller = new AbortController()
    abortRef.current = controller
    setStreaming('')
    setError('')
    setNotice('')
    let acc = ''
    try {
      const lore = [...(await db.lore.toArray()), ...(session?.lore || [])] // 全局 + 本故事专属
      const api = makeApi(eff)
      // 批次8：pendingHints 是事件钩子排队的一次性剧情提示，注入本回合后即被消费清空
      // alpha.14：续写指令移入编译器第 9 参（保证导演提醒排在它之后、prompt 绝对末尾）
      const compiled = compileMessages(card, lore, session?.state, history, eff, session?.summary, session?.pendingHints, session?.director, opts.instruction)
      // 诊断快照：上一回合实际发送的完整 prompt（⚙ 弹层「诊断」卡可查看，排查导演指令是否注入）
      setLastPrompt(compiled.map((m) => ({ role: m.role, content: m.content })))
      let finishReason = null
      for await (const delta of api.stream(compiled, {
        signal: controller.signal,
        onUsage: (u) => { setUsage(u); addUsage(u) },
        onFinish: (reason) => { finishReason = reason },
      })) {
        acc += delta
        setStreaming(acc)
      }
      setStreaming(null)
      // alpha.13：撞 maxTokens 被截断时明确提示——此前该信号被静默丢弃，
      // 回复末尾内容（如导演探针）被切掉却无任何解释
      if (finishReason === 'length') {
        setNotice(`⚠ 这条回复被「最大生成长度」截断了，末尾内容丢失。当前上限 ${eff.maxTokens}，可在 ⚙ 本故事参数或「设置」页调大。`)
      }
      const lastUser = [...history].reverse().find((m) => m.role === 'user')
      // 批次9：新消息接在当前时间线末尾之后（parent 链），落库后活动指针前移
      const parentId = history.length ? history[history.length - 1].id : null
      const aMsg = { sessionId, role: 'assistant', content: acc, turn: history.length + 1, ts: Date.now(), parentId }
      aMsg.id = await db.messages.add(aMsg)
      setMessages([...history, aMsg])
      await db.sessions.update(sessionId, {
        updatedAt: Date.now(),
        activeMsgId: aMsg.id,
        // 消费已注入的一次性提示（生成成功才清——失败/中断保留，下回合重试）
        ...(session?.pendingHints?.length ? { pendingHints: [] } : {}),
      })
      kickExtraction(lastUser, aMsg) // 后台提取状态，不阻塞 UI
      maybeSummarize([...history, aMsg]) // 窗口外的旧对话折叠成摘要，失败静默
    } catch (e) {
      setStreaming(null)
      if (e?.name === 'AbortError') {
        // 主动中断：已生成的部分照常落库（内容不丢），但**不入队提取**——
        // 残缺文本不该被提取器当成既定剧情写进世界状态。
        try {
          if (acc.trim()) {
            const parentId = history.length ? history[history.length - 1].id : null
            const m = { sessionId, role: 'assistant', content: acc, turn: history.length + 1, ts: Date.now(), partial: true, parentId }
            m.id = await db.messages.add(m)
            setMessages([...history, m])
            await db.sessions.update(sessionId, { updatedAt: Date.now(), activeMsgId: m.id })
            setNotice('已停止生成，保留了中断前的部分内容（本回合未做状态提取）。')
          } else {
            setNotice('已停止生成。上一条消息还没收到回复，可点「重生成」重试。')
          }
        } catch (e2) {
          setError(`停止后保存失败：${e2?.message || e2}`)
        }
      } else {
        setError(String(e?.message || e))
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  async function send(text) {
    const content = (text ?? input).trim()
    if (!content || busy || !sessionId) return
    if (!canGenerate()) return // 先确认能生成，再落库（否则就是一条注定没有回复的孤儿消息）
    setInput('')
    setError('')
    const parentId = messages.length ? messages[messages.length - 1].id : null
    const userMsg = { sessionId, role: 'user', content, turn: messages.length + 1, ts: Date.now(), parentId }
    userMsg.id = await db.messages.add(userMsg)
    const next = [...messages, userMsg]
    setMessages(next)
    await setTimelineHead(sessionId, userMsg.id) // 批次9：活动指针随新消息前移
    await streamReply(next)
  }

  /** 续写：不新增用户消息，让模型顺着最后一段继续叙事 */
  async function continueStory() {
    if (busy || !messages.length) return
    if (!canGenerate()) return
    setError('')
    await streamReply(messages, {
      instruction: '（继续叙事：从最后一段的中断处自然续写，不要重复已有内容，不要替用户的角色说话或行动）',
    })
  }

  /**
   * 重生成。两条路径：
   * - 末尾是 assistant：删掉末尾连续的 assistant（含被中断残留的 partial），重新生成；
   * - 末尾是 user（孤儿回合：消息已落库但没收到回复 / 生成失败 / 中断且无内容）：
   *   while 循环不动，直接以该 user 为结尾重新请求 —— 这就是孤儿回合的恢复路径。
   */
  async function regenerate() {
    if (busy || !messages.length) return
    if (!canGenerate()) return // 关键：放在删除末尾 assistant **之前**，否则没 Key 时会白删一条已有回复
    setError('')
    setNotice('')
    const h = [...messages]
    const removed = []
    while (h.length && h[h.length - 1].role === 'assistant') {
      const m = h.pop()
      removed.push(m.id)
      await db.messages.delete(m.id)
    }
    // 清掉指向已删消息的提取任务，避免悬挂（pending / running / failed 都要清，done 除外）
    if (removed.length) {
      const tasks = await db.tasks.where('sessionId').equals(sessionId).toArray()
      for (const t of tasks) {
        if (t.status !== 'done' && removed.includes(t.assistantMsgId)) await db.tasks.delete(t.id)
      }
    }
    if (!h.length) { setMessages([]); await setTimelineHead(sessionId, null); return }
    setMessages(h)
    await setTimelineHead(sessionId, h[h.length - 1].id) // 删除末尾后活动指针回退
    await streamReply(h)
  }

  // 孤儿回合标记：最后一条是用户消息且尚无回复 —— 此时只能「重生成」，不能「续写」
  const trailingUser = !!messages.length && messages[messages.length - 1].role === 'user'

  /* ────────── 消息级操作（批次4） ────────── */

  function openMenu(m) {
    if (busy) return // 生成中不允许改历史，避免上下文在脚下被抽走
    setError('')
    setNotice('')
    setEditText(null)
    setMenu(m)
  }

  function closeMenu() { setMenu(null); setEditText(null) }

  async function saveMsgEdit() {
    if (!menu) return
    const content = (editText ?? '').trim()
    if (!content) { setError('内容不能为空'); return }
    await db.messages.update(menu.id, { content })
    setMessages((prev) => prev.map((m) => (m.id === menu.id ? { ...m, content } : m)))
    closeMenu()
    setNotice('已保存。编辑不会重跑状态提取——若改动涉及剧情事实，请到「状态」页手动修正。')
  }

  async function deleteMsg() {
    if (!menu) return
    if (!confirm('删除这条消息？此操作不可撤销。')) return
    await db.messages.delete(menu.id)
    // 删的是 assistant → 清掉指向它的未完成提取任务，避免任务悬挂在已不存在的消息上
    if (menu.role === 'assistant') {
      const tasks = await db.tasks.where('sessionId').equals(sessionId).toArray()
      for (const t of tasks) {
        if (t.status !== 'done' && t.assistantMsgId === menu.id) await db.tasks.delete(t.id)
      }
    }
    // 批次9：删的是**当前时间线**上的消息 → 缝合 parent 链，活动指针按需回退。
    // 删的是暗线（其他分支）上的消息则不碰活动线。
    const idx = messages.findIndex((m) => m.id === menu.id)
    if (idx >= 0) {
      const prev = messages[idx - 1]
      const next = messages[idx + 1]
      if (next) await db.messages.update(next.id, { parentId: prev?.id ?? null })
      else await setTimelineHead(sessionId, prev?.id ?? null)
    }
    setMessages((prev) => prev.filter((m) => m.id !== menu.id))
    closeMenu()
  }

  /* ────────── 批次9：时间线分支 ────────── */

  /** 从菜单消息处开新分支：活动指针移过去，其后的旧消息进入暗线（仍可再切回） */
  async function branchFrom() {
    if (!menu) return
    const isHead = messages.length && messages[messages.length - 1].id === menu.id
    await setTimelineHead(sessionId, menu.id)
    setMessages(await getTimeline(sessionId))
    closeMenu()
    setNotice(isHead
      ? '已定位到这条消息（它就是当前时间线末尾）。'
      : '已从此处分支。之后的旧消息进入暗线（仍在库中，随时可再从那条消息切回）。')
  }

  /** 在当前时间线末尾创建存档（消息位置 + 世界状态快照，可随时恢复） */
  async function saveSnapshot() {
    const name = prompt('存档名称：', `存档 ${new Date().toLocaleString()}`)
    if (!name?.trim()) return
    const snap = {
      id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      msgId: messages.length ? messages[messages.length - 1].id : null,
      name: name.trim(),
      state: session?.state || { characters: {}, facts: [], events: [], relations: [] },
      ts: Date.now(),
    }
    await db.sessions.update(sessionId, { snapshots: [...(session?.snapshots || []), snap].slice(-20) })
    refreshSession()
    setNotice('已存档。可在「⚙ → 时间线与存档」中恢复。')
  }

  /** 恢复存档：回到存档时的消息位置与世界状态（提示与触发日志保留） */
  async function restoreSnapshot(snap) {
    if (!confirm(`恢复存档「${snap.name}」？\n\n时间线回到存档位置，世界状态恢复为存档时的快照（提取审计记录仍保留，可再回溯）。`)) return
    await db.sessions.update(sessionId, {
      activeMsgId: snap.msgId,
      state: snap.state,
      updatedAt: Date.now(),
    })
    setMessages(await getTimeline(sessionId))
    refreshSession()
    setNotice(`已恢复存档「${snap.name}」。`)
  }

  async function removeSnapshot(snapId) {
    await db.sessions.update(sessionId, { snapshots: (session?.snapshots || []).filter((s) => s.id !== snapId) })
    refreshSession()
  }

  async function copyMsg() {
    try {
      await navigator.clipboard.writeText(menu.content)
      setNotice('已复制到剪贴板。')
    } catch {
      setNotice('复制失败（浏览器可能未授权），请长按手动选择。')
    }
  }

  /* ────────── 本故事参数覆盖（批次4） ────────── */

  /** 写入 session.params；'' / null 表示"跟随全局"。不改动 updatedAt（避免打乱会话列表排序） */
  async function setParam(k, v) {
    if (!sessionId) return
    const params = { ...(session?.params || {}), [k]: v }
    await db.sessions.update(sessionId, { params })
    refreshSession()
  }

  return (
    <div className="chat">
      <header className="chat-head">
        <button className="icon-btn" onClick={onExit}>‹</button>
        <div className="chat-title">
          <b>{session?.name || '…'}</b>
          <span className="muted">
            {extracting ? '状态提取中…' : card?.name || ''}
            {!extracting && usageText(session?.usage)}
          </span>
          {cardSource === 'snapshot' && <span className="badge">{CARD_SOURCE_LABEL.snapshot}</span>}
          {cardSource === 'missing' && <span className="badge err">{CARD_SOURCE_LABEL.missing}</span>}
        </div>
        <div className="head-actions">
          <button
            className={`icon-btn ${directorOn ? 'is-on' : ''}`}
            title={directorOn ? `导演指令（${activeDirNotes.length} 条生效中）` : '导演指令'}
            onClick={() => openDirector()}
          >
            🎬{directorOn ? <span className="dir-count">{activeDirNotes.length}</span> : null}
          </button>
          <button className="icon-btn" title="本故事参数" onClick={() => setShowParams(true)}>⚙</button>
          {busy ? (
            <button className="btn small danger-text" onClick={stopStreaming}>停止</button>
          ) : (
            <>
              <button className="btn small" onClick={continueStory} disabled={!messages.length || cardSource === 'missing' || trailingUser}>续写</button>
              <button className="btn small" onClick={regenerate} disabled={!messages.length || cardSource === 'missing'}>重生成</button>
            </>
          )}
        </div>
      </header>

      {!hasAnyProviderReady(settings) && (
        <div className="banner warn" onClick={onGoSettings}>
          尚未配置任何模型的 API Key，点击前往设置 →
        </div>
      )}
      {error && (
        <div className="banner error flex">
          <span className="grow">{error}</span>
          {/* 孤儿回合（末尾是 user）的直接恢复入口：重新请求这条消息的回复 */}
          {trailingUser && !busy && <button className="btn small" onClick={regenerate}>重试</button>}
          <button className="icon-btn" onClick={() => setError('')}>✕</button>
        </div>
      )}
      {notice && <div className="banner info" onClick={() => setNotice('')}>{notice}</div>}

      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <div
            key={m.id}
            className={`bubble ${m.role}${busy ? '' : ' tappable'}`}
            onClick={() => openMenu(m)}
          >
            {m.role === 'assistant' && <div className="bubble-name">{card?.name}</div>}
            {m.content}
            {m.partial && <div className="bubble-flag">（中断生成）</div>}
          </div>
        ))}
        {streaming !== null && (
          <div className="bubble assistant">
            <div className="bubble-name">{card?.name}</div>
            {streaming || '…'}
            <span className="cursor">▍</span>
          </div>
        )}
        {!messages.length && streaming === null && (
          <div className="empty-box"><p>故事从这里开始。</p></div>
        )}
      </div>

      <div className="composer">
        <div className="chips">
          {QUICK_CHIPS.map((c) => (
            <button key={c} className="chip" disabled={busy} onClick={() => setInput((v) => (v ? v + c : c))}>{c}</button>
          ))}
        </div>
        <div className="composer-row">
          <textarea
            className="input grow"
            rows={2}
            placeholder="输入你的行动 / 对话…（Ctrl+Enter 发送）"
            value={input}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } }}
          />
          <button className="btn primary send" disabled={busy || !input.trim() || cardSource === 'missing'} onClick={() => send()}>发送</button>
        </div>
      </div>

      {/* 消息操作：编辑 / 复制 / 删除（生成中不可打开，避免上下文在脚下被抽走） */}
      {menu && (
        <div className="modal-mask" onClick={closeMenu}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{menu.role === 'user' ? '你的消息' : `${card?.name || '角色'}的消息`}</h3>
            {editText !== null ? (
              <>
                <textarea
                  className="input"
                  rows={10}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                />
                <p className="muted small">保存后不会重跑状态提取；若改动涉及剧情事实，请到「状态」页手动修正。</p>
                <div className="row-end">
                  <button className="btn" onClick={() => setEditText(null)}>取消</button>
                  <button className="btn primary" onClick={saveMsgEdit}>保存</button>
                </div>
              </>
            ) : (
              <>
                <div className="card">
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 14 }}>{menu.content}</pre>
                </div>
                {menu.partial && <p className="muted small">这条是被中断生成留下的部分内容。</p>}
                <div className="row">
                  <button className="btn" onClick={() => setEditText(menu.content || '')}>编辑</button>
                  <button className="btn" onClick={copyMsg}>复制</button>
                  <button className="btn danger-text" onClick={deleteMsg}>删除</button>
                  {/* 批次9：在这条消息处开分支（之后的旧消息进入暗线） */}
                  <button className="btn" disabled={busy} onClick={branchFrom}>从此分支</button>
                </div>
                <div className="row-end">
                  <button className="btn" onClick={closeMenu}>关闭</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 导演指令（C8）：执导要求注入 prompt，但不属于剧情 */}
      {dirDraft && (
        <div className="modal-mask" onClick={closeDirector}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>导演指令</h3>
            <p className="muted small">
              写给扮演者的执导要求——怎么演、文风怎么改。AI 会遵循，但不会把它当剧情内容。增删改后自动保存，下一回合生效。
              测试是否生效用命令句（如「每条回复末尾必须输出 325」），不要用「如果…就…」条件句——弱模型判断不了前提。
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: '8px 0' }}>
              <input
                type="checkbox"
                checked={dirDraft.enabled !== false}
                onChange={(e) => updateDir({ ...dirDraft, enabled: e.target.checked })}
              />
              启用（停用时保留内容，只是不再注入）
            </label>
            {dirDraft.notes.map((n, i) => (
              <div className="row" key={n.id} style={{ alignItems: 'flex-start' }}>
                <textarea
                  className="input" rows={2} value={n.text}
                  onChange={(e) => setDirDraft({ ...dirDraft, notes: dirDraft.notes.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })}
                  onBlur={() => persistDirector(dirDraft)}
                />
                <button
                  className="btn small danger-text" style={{ flexShrink: 0 }}
                  onClick={() => updateDir({ ...dirDraft, notes: dirDraft.notes.filter((_, j) => j !== i) })}
                >删</button>
              </div>
            ))}
            <div className="row">
              <input
                className="input" value={dirDraft.newText}
                placeholder="例：文风再冷一点，少用感叹号。测试指令用命令句：每条回复末尾必须输出 325"
                onChange={(e) => setDirDraft({ ...dirDraft, newText: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target.value.trim()) {
                    e.preventDefault()
                    updateDir({ ...dirDraft, notes: [...dirDraft.notes, { id: newDirId(), text: e.target.value.trim(), createdAt: Date.now() }], newText: '' })
                  }
                }}
              />
              <button
                className="btn"
                onClick={() => {
                  const t = String(dirDraft.newText || '').trim()
                  if (!t) return
                  updateDir({ ...dirDraft, notes: [...dirDraft.notes, { id: newDirId(), text: t, createdAt: Date.now() }], newText: '' })
                }}
              >添加</button>
            </div>
            <p className="muted small">
              {dirDraft.notes.length} 条 · 约 {dirDraft.notes.reduce((a, n) => a + String(n.text || '').length, 0)} 字
              {dirDraft.enabled === false ? ' · 已停用' : ''}
            </p>

            {/* 遵循自检（alpha-feedback §6.3）：一键发探针，把验收从「用户肉眼找 325」变成「按钮出结论」 */}
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-title"><b>遵循自检</b></div>
              <p className="muted small">
                向当前模型发一次探针指令（要求回复末尾输出 {PROBE_TOKEN}），自动判定导演指令是否真的被执行。
                自检结果不会写进对话历史，也不影响世界状态与用量统计。
              </p>
              <div className="row">
                <button className="btn" disabled={busy} onClick={runDirectorSelfCheck}>
                  {probing ? '自检中…' : '运行自检'}
                </button>
                {probing && <button className="btn danger-text" onClick={stopStreaming}>取消</button>}
              </div>
              {probeResult && (
                <div
                  className={`banner ${probeResult.status === 'pass' ? 'info' : probeResult.status === 'truncated' || probeResult.status === 'aborted' ? 'warn' : 'error'}`}
                  style={{ marginTop: 8 }}
                  onClick={() => setProbeResult(null)}
                >
                  {probeResult.detail}
                  {probeResult.tail && (
                    <pre className="small muted" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, maxHeight: '8em', overflowY: 'auto' }}>
                      …{probeResult.tail}
                    </pre>
                  )}
                  {probeResult.usage && (
                    <p className="muted small" style={{ margin: '6px 0 0' }}>
                      本次自检消耗 {fmtTokens((Number(probeResult.usage.inputTokens) || 0) + (Number(probeResult.usage.outputTokens) || 0))} tokens
                      {probeResult.finishReason === 'length' ? ' · 已被最大生成长度截断' : ''}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="row-end">
              <button className="btn" onClick={closeDirector}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 本故事参数覆盖：留空 = 跟随全局 */}
      {showParams && (
        <div className="modal-mask" onClick={() => setShowParams(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>本故事参数</h3>
            <p className="muted small">留空即跟随「设置」页的全局值，只影响当前故事。模型与厂商请在「设置 → AI 模型」中更改。</p>
            <div className="field-grid">
              <label>温度
                <input className="input" type="number" step="0.05" min="0" max="2" value={numOrEmpty(session?.params?.temperature)} placeholder={String(settings.temperature)}
                  onChange={(e) => setParam('temperature', numInput(e.target.value))} />
              </label>
              <label>最大生成长度
                <input className="input" type="number" min="1" value={numOrEmpty(session?.params?.maxTokens)} placeholder={String(settings.maxTokens)}
                  onChange={(e) => setParam('maxTokens', numInput(e.target.value))} />
                {session?.params?.maxTokens !== '' && session?.params?.maxTokens != null && (
                  <span className="muted">已覆盖全局（{settings.maxTokens}）——改「设置」页不会影响本故事，清空本框即跟随全局。推理模型建议 4096+。</span>
                )}
              </label>
              <label>注入深度
                <input className="input" type="number" min="0" max="20" value={numOrEmpty(session?.params?.depth)} placeholder={String(settings.depth)}
                  onChange={(e) => setParam('depth', numInput(e.target.value))} />
              </label>
              <label>历史消息上限
                <input className="input" type="number" min="4" max="200" value={numOrEmpty(session?.params?.maxHistory)} placeholder={String(settings.maxHistory)}
                  onChange={(e) => setParam('maxHistory', numInput(e.target.value))} />
              </label>
              <label>世界书 token 预算
                <input className="input" type="number" min="0" value={numOrEmpty(session?.params?.loreBudget)} placeholder={String(settings.loreBudget)}
                  onChange={(e) => setParam('loreBudget', numInput(e.target.value))} />
              </label>
            </div>

            {/* 批次9：时间线与存档 */}
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-title">
                <b>时间线与存档</b>
                <button className="btn small" disabled={busy || !messages.length} onClick={saveSnapshot}>在此存档</button>
              </div>
              <p className="muted small">
                当前时间线 {messages.length} 条消息。存档 = 消息位置 + 世界状态快照；恢复后从该点继续，写成另一个走向。
                消息菜单里的「从此分支」只切时间线（不动状态），存档恢复则两者一起回退。
              </p>
              {session?.pendingHints?.length > 0 && (
                <p className="small">⏳ 有 {session.pendingHints.length} 条事件提示待注入（下一回合生成时生效一次）。</p>
              )}
              <div className="list">
                {[...(session?.snapshots || [])].reverse().map((snap) => (
                  <div key={snap.id} className="list-row">
                    <span className="list-main">
                      {snap.name}
                      <span className="muted">
                        {messages.length && messages[messages.length - 1].id === snap.msgId ? '当前位置' : `T·回到 ${new Date(snap.ts).toLocaleDateString()}`}
                      </span>
                    </span>
                    <button className="btn small" disabled={busy} onClick={() => restoreSnapshot(snap)}>恢复</button>
                    <button className="icon-btn danger" onClick={() => removeSnapshot(snap.id)}>✕</button>
                  </div>
                ))}
              </div>
              {!session?.snapshots?.length && <p className="muted small">暂无存档。</p>}
            </div>

            {session?.summary && (
              <div className="card" style={{ marginTop: 12 }}>
                <div className="card-title">
                  <b>早期剧情摘要</b>
                  <button className="icon-btn danger" onClick={async () => {
                    await db.sessions.update(sessionId, { summary: '', summaryUpTo: 0 })
                    refreshSession()
                  }}>清除</button>
                </div>
                <div className="small muted" style={{ whiteSpace: 'pre-wrap', maxHeight: '12em', overflowY: 'auto' }}>{session.summary}</div>
              </div>
            )}

            {/* alpha.14 诊断卡：上一回合实际发送的完整 prompt——排查「导演指令不生效」
                时一眼可见：指令在里面而模型不执行 → 模型遵循度问题；不在里面 → 保存/注入问题 */}
            <div className="card" style={{ marginTop: 12 }}>
              <div className="card-title">
                <b>🔍 诊断：上一回合的 prompt</b>
                {lastPrompt && (
                  <span className={`small ${lastPrompt.some((m) => String(m.content).includes('导演指令')) ? 'ok-text' : 'err-text'}`}>
                    {lastPrompt.some((m) => String(m.content).includes('导演指令')) ? '✓ 导演指令已注入' : '✗ 导演指令未注入'}
                  </span>
                )}
              </div>
              {lastPrompt ? (
                <>
                  <p className="muted small">
                    上一回合发给模型的完整内容（{lastPrompt.length} 条消息，从上到下即发送顺序）。
                    「导演指令」应出现在动态块与最后一条消息的末尾两处。
                  </p>
                  <pre className="small muted" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, maxHeight: '16em', overflowY: 'auto' }}>
                    {lastPrompt.map((m, i) => `── [${i}] ${m.role.toUpperCase()} ──\n${m.content}`).join('\n\n')}
                  </pre>
                  <div className="row-end" style={{ marginTop: 8 }}>
                    <button className="btn small" onClick={async () => {
                      const text = lastPrompt.map((m) => `# ${m.role}\n${m.content}`).join('\n\n---\n\n')
                      try { await navigator.clipboard.writeText(text); setNotice('已复制完整 prompt（可粘贴给开发者排查）') }
                      catch { setNotice('复制失败：浏览器未授予剪贴板权限') }
                    }}>复制完整 prompt</button>
                  </div>
                </>
              ) : (
                <p className="muted small">本会话还没有生成过回复。</p>
              )}
            </div>

            <div className="row-end">
              <button className="btn" onClick={async () => { await db.sessions.update(sessionId, { params: {} }); refreshSession() }}>全部恢复全局</button>
              <button className="btn primary" onClick={() => setShowParams(false)}>完成</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
