import { useEffect, useRef, useState } from 'react'
import { db, getMessages } from '../lib/db'
import { compileMessages } from '../lib/compiler'
import { processPendingTasks, enqueueTask } from '../lib/extractor'
import { makeApi } from '../lib/api'
import { allProviders, getProvider, hasAnyProviderReady } from '../lib/providers/registry'
import { resolveCard, CARD_SOURCE_LABEL } from '../lib/cardRef'
import { effectiveSettings, fmtTokens } from '../lib/util'
import { summarizePlan, runSummary } from '../lib/summarize'

const QUICK_CHIPS = ['（请继续）', '（时间推进到次日）', '（切换场景）']

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
  const [menu, setMenu] = useState(null)   // 消息操作弹层：当前消息对象
  const [editText, setEditText] = useState(null) // null=非编辑态；string=正在编辑该消息
  const [showParams, setShowParams] = useState(false) // 本故事参数覆盖弹层
  const scrollRef = useRef(null)
  const abortRef = useRef(null)            // 进行中的流式请求，用于「停止」
  const busy = streaming !== null
  // 本故事参数覆盖：session.params 里填了的字段盖过全局设置，没填的跟随全局
  const eff = effectiveSettings(settings, session?.params)

  useEffect(() => {
    (async () => {
      const s = await db.sessions.get(sessionId)
      setSession(s)
      // 读时兜底：快照 → 原卡 → 缺失。角色卡被删也不会拿到 undefined 而崩在编译器里
      const { card: resolved, source } = await resolveCard(s)
      setCard(resolved)
      setCardSource(source)
      setMessages(await getMessages(sessionId))
      setError('')
      // 补跑上次未完成的状态提取
      const pending = (await db.tasks.where('sessionId').equals(sessionId).toArray()).filter((t) => t.status === 'pending')
      if (pending.length) kickExtraction(null, null, true)
    })()
    // 离开会话时中断仍在进行的生成：已生成的部分会被落库，不留"永远收不到回复"的孤儿请求
    return () => { abortRef.current?.abort() }
  }, [sessionId])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  async function refreshSession() {
    const s = await db.sessions.get(sessionId)
    setSession(s)
    onSessionUpdate && onSessionUpdate()
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

  /** 停止当前生成：abort 会让 stream 的 fetch 抛 AbortError，由 streamReply 的 catch 收尾 */
  function stopStreaming() {
    abortRef.current?.abort()
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
      const compiled = compileMessages(card, lore, session?.state, history, eff, session?.summary)
      // 续写：以指令消息收尾让模型顺着最后一段继续；指令不落库，不污染历史
      if (opts.instruction) compiled.push({ role: 'user', content: opts.instruction })
      for await (const delta of api.stream(compiled, {
        signal: controller.signal,
        onUsage: (u) => { setUsage(u); addUsage(u) },
      })) {
        acc += delta
        setStreaming(acc)
      }
      setStreaming(null)
      const lastUser = [...history].reverse().find((m) => m.role === 'user')
      const aMsg = { sessionId, role: 'assistant', content: acc, turn: history.length + 1, ts: Date.now() }
      aMsg.id = await db.messages.add(aMsg)
      setMessages([...history, aMsg])
      await db.sessions.update(sessionId, { updatedAt: Date.now() })
      kickExtraction(lastUser, aMsg) // 后台提取状态，不阻塞 UI
      maybeSummarize([...history, aMsg]) // 窗口外的旧对话折叠成摘要，失败静默
    } catch (e) {
      setStreaming(null)
      if (e?.name === 'AbortError') {
        // 主动中断：已生成的部分照常落库（内容不丢），但**不入队提取**——
        // 残缺文本不该被提取器当成既定剧情写进世界状态。
        try {
          if (acc.trim()) {
            const m = { sessionId, role: 'assistant', content: acc, turn: history.length + 1, ts: Date.now(), partial: true }
            m.id = await db.messages.add(m)
            setMessages([...history, m])
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
    const userMsg = { sessionId, role: 'user', content, turn: messages.length + 1, ts: Date.now() }
    userMsg.id = await db.messages.add(userMsg)
    const next = [...messages, userMsg]
    setMessages(next)
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
    if (!h.length) { setMessages([]); return }
    setMessages(h)
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
    setMessages((prev) => prev.filter((m) => m.id !== menu.id))
    closeMenu()
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

  // ⚙ 弹层的模型下拉数据：会话覆盖的厂商 →（无覆盖时）全局厂商
  const paramProvider = getProvider(settings, session?.params?.providerId || settings.providerId)
  const paramModels = paramProvider?.models || []

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
                </div>
                <div className="row-end">
                  <button className="btn" onClick={closeMenu}>关闭</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 本故事参数覆盖：留空 = 跟随全局 */}
      {showParams && (
        <div className="modal-mask" onClick={() => setShowParams(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>本故事参数</h3>
            <p className="muted small">留空即跟随「设置」页的全局值，只影响当前故事。</p>
            <div className="field-grid">
              <label>提供商
                <select
                  className="input"
                  value={session?.params?.providerId ?? ''}
                  onChange={(e) => { setParam('providerId', e.target.value); setParam('model', '') }}
                >
                  <option value="">跟随全局（{getProvider(settings, settings.providerId)?.displayName || settings.providerId}）</option>
                  {allProviders(settings).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}{p.noKey && !p.displayName.includes('本机') ? '（本机）' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>模型
                <select
                  className="input"
                  value={session?.params?.model ?? ''}
                  onChange={(e) => setParam('model', e.target.value)}
                >
                  <option value="">
                    跟随全局（{paramProvider?.id === settings.providerId ? settings.model : paramProvider?.defaultModel || ''}）
                  </option>
                  {session?.params?.model && !paramModels.includes(session.params.model) && (
                    <option value={session.params.model}>{session.params.model}（当前值）</option>
                  )}
                  {paramModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label>温度
                <input className="input" type="number" step="0.05" min="0" max="2" value={numOrEmpty(session?.params?.temperature)} placeholder={String(settings.temperature)}
                  onChange={(e) => setParam('temperature', numInput(e.target.value))} />
              </label>
              <label>最大生成长度
                <input className="input" type="number" min="1" value={numOrEmpty(session?.params?.maxTokens)} placeholder={String(settings.maxTokens)}
                  onChange={(e) => setParam('maxTokens', numInput(e.target.value))} />
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
