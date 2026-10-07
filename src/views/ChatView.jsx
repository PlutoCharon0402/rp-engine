import { useEffect, useRef, useState } from 'react'
import { db, getMessages } from '../lib/db'
import { compileMessages } from '../lib/compiler'
import { processPendingTasks } from '../lib/extractor'
import { makeApi } from '../lib/api'
import { resolveCard, CARD_SOURCE_LABEL } from '../lib/cardRef'

const QUICK_CHIPS = ['（请继续）', '（时间推进到次日）', '（切换场景）']

export default function ChatView({ sessionId, settings, onExit, onSessionUpdate, onGoSettings }) {
  const [session, setSession] = useState(null)
  const [card, setCard] = useState(null)
  const [cardSource, setCardSource] = useState('none') // live | detached | snapshot | missing | none
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(null) // null=未在生成，string=增量文本
  const [extracting, setExtracting] = useState(false)
  const [error, setError] = useState('')
  const [usage, setUsage] = useState(null) // 最近一次生成的 usage（含缓存命中）
  const scrollRef = useRef(null)
  const busy = streaming !== null

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

  function kickExtraction(userMsg, aMsg, catchUpOnly = false) {
    setExtracting(true)
    ;(async () => {
      try {
        if (!catchUpOnly && userMsg && aMsg) {
          await db.tasks.add({ sessionId, userMsgId: userMsg.id, assistantMsgId: aMsg.id, status: 'pending', ts: Date.now() })
        }
        await processPendingTasks(sessionId, settings, refreshSession)
      } catch { /* 提取失败不阻塞对话，任务保持 pending，下次补跑 */ }
      finally { setExtracting(false) }
    })()
  }

  async function streamReply(history, opts = {}) {
    if (!settings.apiKey) { setError('未配置 API Key'); onGoSettings && onGoSettings(); return }
    // 无角色卡可用：直接拒绝，绝不留一条永远收不到回复的孤儿用户消息
    if (cardSource === 'missing') { setError(CARD_SOURCE_LABEL.missing); return }
    setStreaming('')
    try {
      const lore = [...(await db.lore.toArray()), ...(session?.lore || [])] // 全局 + 本故事专属
      const api = makeApi(settings)
      const compiled = compileMessages(card, lore, session?.state, history, settings)
      // 续写：以指令消息收尾让模型顺着最后一段继续；指令不落库，不污染历史
      if (opts.instruction) compiled.push({ role: 'user', content: opts.instruction })
      let acc = ''
      for await (const delta of api.stream(compiled, {
        onUsage: (u) => setUsage(u),
      })) {
        acc += delta
        setStreaming(acc)
      }
      const lastUser = [...history].reverse().find((m) => m.role === 'user')
      const aMsg = { sessionId, role: 'assistant', content: acc, turn: history.length + 1, ts: Date.now() }
      aMsg.id = await db.messages.add(aMsg)
      setStreaming(null)
      setMessages([...history, aMsg])
      await db.sessions.update(sessionId, { updatedAt: Date.now() })
      kickExtraction(lastUser, aMsg) // 后台提取状态，不阻塞 UI
    } catch (e) {
      setStreaming(null)
      setError(String(e?.message || e))
    }
  }

  async function send(text) {
    const content = (text ?? input).trim()
    if (!content || busy || !sessionId) return
    if (cardSource === 'missing') { setError(CARD_SOURCE_LABEL.missing); return }
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
    setError('')
    await streamReply(messages, {
      instruction: '（继续叙事：从最后一段的中断处自然续写，不要重复已有内容，不要替用户的角色说话或行动）',
    })
  }

  async function regenerate() {
    if (busy || !messages.length) return
    const h = [...messages]
    const removed = []
    while (h.length && h[h.length - 1].role === 'assistant') {
      const m = h.pop()
      removed.push(m.id)
      await db.messages.delete(m.id)
    }
    // 清掉指向已删消息的提取任务，避免悬挂
    if (removed.length) {
      const tasks = await db.tasks.where('sessionId').equals(sessionId).toArray()
      for (const t of tasks) {
        if (t.status === 'pending' && removed.includes(t.assistantMsgId)) await db.tasks.delete(t.id)
      }
    }
    if (!h.length) { setMessages([]); return }
    setMessages(h)
    await streamReply(h)
  }

  return (
    <div className="chat">
      <header className="chat-head">
        <button className="icon-btn" onClick={onExit}>‹</button>
        <div className="chat-title">
          <b>{session?.name || '…'}</b>
          <span className="muted">
            {extracting ? '状态提取中…' : card?.name || ''}
            {usage && !extracting && ` · 缓存命中 ${usage.prompt_cache_hit_tokens ?? 0}/${(usage.prompt_cache_hit_tokens ?? 0) + (usage.prompt_cache_miss_tokens ?? 0)} tokens`}
          </span>
          {cardSource === 'snapshot' && <span className="badge">{CARD_SOURCE_LABEL.snapshot}</span>}
          {cardSource === 'missing' && <span className="badge err">{CARD_SOURCE_LABEL.missing}</span>}
        </div>
        <div className="head-actions">
          <button className="btn small" onClick={continueStory} disabled={busy || !messages.length || cardSource === 'missing'}>续写</button>
          <button className="btn small" onClick={regenerate} disabled={busy || !messages.length || cardSource === 'missing'}>重生成</button>
        </div>
      </header>

      {!settings.apiKey && (
        <div className="banner warn" onClick={onGoSettings}>
          尚未配置 DeepSeek API Key，点击前往设置 →
        </div>
      )}
      {error && <div className="banner error" onClick={() => setError('')}>{error}</div>}

      <div className="chat-scroll" ref={scrollRef}>
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.role === 'assistant' && <div className="bubble-name">{card?.name}</div>}
            {m.content}
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
    </div>
  )
}
