import { useEffect, useState } from 'react'
import { db, emptyState } from '../lib/db'

// 世界状态面板：查看/直接编辑角色状态与事实 —— retcon 的入口
export default function StateView({ sessionId, version }) {
  const [session, setSession] = useState(null)
  const [mode, setMode] = useState('pretty')
  const [raw, setRaw] = useState('')
  const [err, setErr] = useState('')
  const [newFact, setNewFact] = useState('')
  const [newEvent, setNewEvent] = useState('')

  useEffect(() => {
    (async () => {
      setSession(sessionId ? await db.sessions.get(sessionId) : null)
      setErr('')
    })()
  }, [sessionId, version])

  if (!sessionId || !session) {
    return (
      <div className="view">
        <div className="view-head"><h2>世界状态</h2></div>
        <div className="empty-box"><p>从「对话」页进入一个故事后，这里显示它的世界状态。</p></div>
      </div>
    )
  }

  const state = session.state || emptyState()

  async function save(next) {
    await db.sessions.update(sessionId, { state: next, updatedAt: Date.now() })
    setSession({ ...session, state: next })
  }

  function updChar(name, patch) {
    const chars = { ...state.characters, [name]: { ...state.characters[name], ...patch } }
    save({ ...state, characters: chars })
  }

  async function applyRaw() {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed !== 'object' || !parsed) throw new Error('顶层必须是对象')
      await save({ ...emptyState(), ...parsed })
      setErr('')
      setMode('pretty')
    } catch (e) {
      setErr(`JSON 解析失败：${e.message}`)
    }
  }

  const chars = Object.values(state.characters || {})

  return (
    <div className="view">
      <div className="view-head">
        <h2>世界状态</h2>
        <div className="seg">
          <button className={mode === 'pretty' ? 'active' : ''} onClick={() => setMode('pretty')}>面板</button>
          <button className={mode === 'raw' ? 'active' : ''} onClick={() => { setRaw(JSON.stringify(state, null, 2)); setMode('raw') }}>JSON</button>
        </div>
      </div>
      <p className="muted small">状态由每回合后的提取器自动维护，也可在此直接修改（retcon）。</p>

      {mode === 'raw' ? (
        <>
          <textarea className="input mono" rows={18} value={raw} onChange={(e) => setRaw(e.target.value)} />
          {err && <div className="banner error">{err}</div>}
          <div className="row-end">
            <button className="btn" onClick={() => setMode('pretty')}>取消</button>
            <button className="btn primary" onClick={applyRaw}>应用</button>
          </div>
        </>
      ) : (
        <>
          <h3>角色（{chars.length}）</h3>
          {chars.map((c) => (
            <div key={c.name} className="card">
              <div className="card-title">
                <b>{c.name}</b>
                <button className="icon-btn danger" onClick={() => {
                  const chars = { ...state.characters }
                  delete chars[c.name]
                  save({ ...state, characters: chars })
                }}>✕</button>
              </div>
              <div className="field-grid">
                <label>位置<input className="input" value={c.location || ''} onChange={(e) => updChar(c.name, { location: e.target.value })} /></label>
                <label>情绪<input className="input" value={c.mood || ''} onChange={(e) => updChar(c.name, { mood: e.target.value })} /></label>
                <label>目标<input className="input" value={c.goal || ''} onChange={(e) => updChar(c.name, { goal: e.target.value })} /></label>
                <label>持有（逗号分隔）<input className="input" value={(c.inventory || []).join('，')} onChange={(e) => updChar(c.name, { inventory: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} /></label>
                <label className="span2">已知信息（分号分隔，角色只会说已知的内容）<input className="input" value={(c.knows || []).join('；')} onChange={(e) => updChar(c.name, { knows: e.target.value.split(/[;；]/).map((s) => s.trim()).filter(Boolean) })} /></label>
              </div>
            </div>
          ))}
          <button className="btn" onClick={() => {
            const name = prompt('新角色名')
            if (!name?.trim()) return
            updChar(name.trim(), {})
          }}>＋ 添加角色</button>

          <h3>既定事实（{state.facts?.length || 0}）</h3>
          <div className="list">
            {(state.facts || []).map((f, i) => (
              <div key={i} className="list-row">
                <span className="list-main">{f.text}</span>
                <button className="icon-btn danger" onClick={() => save({ ...state, facts: state.facts.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
          </div>
          <div className="row">
            <input className="input grow" placeholder="添加事实…" value={newFact} onChange={(e) => setNewFact(e.target.value)} />
            <button className="btn" onClick={() => { if (newFact.trim()) { save({ ...state, facts: [...(state.facts || []), { turn: 0, text: newFact.trim() }] }); setNewFact('') } }}>添加</button>
          </div>

          <h3>事件线（{state.events?.length || 0}）</h3>
          <div className="list">
            {(state.events || []).map((e, i) => (
              <div key={i} className="list-row">
                <span className="list-main"><span className="muted">T{e.turn}</span> {e.text}</span>
                <button className="icon-btn danger" onClick={() => save({ ...state, events: state.events.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
          </div>
          <div className="row">
            <input className="input grow" placeholder="添加事件…" value={newEvent} onChange={(e) => setNewEvent(e.target.value)} />
            <button className="btn" onClick={() => { if (newEvent.trim()) { save({ ...state, events: [...(state.events || []), { turn: 0, text: newEvent.trim() }] }); setNewEvent('') } }}>添加</button>
          </div>
        </>
      )}
    </div>
  )
}
