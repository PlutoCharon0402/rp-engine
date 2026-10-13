import { useEffect, useState } from 'react'
import { db, emptyState } from '../lib/db'
import { undoExtract, reExtractFrom } from '../lib/extractor'
import { fmtTime } from '../lib/util'
import { hasAnyProviderReady } from '../lib/providers/registry'

/** 提取记录的变更摘要：'+ 角色 1、事实 2'；无变化显示占位 */
function diffSummary(diff) {
  if (!diff) return '（无记录）'
  const parts = []
  const c = Object.keys(diff.characters || {}).length
  if (c) parts.push(`角色 ${c}`)
  const f = (diff.facts_add || []).length
  if (f) parts.push(`事实 ${f}`)
  const e = (diff.events_add || []).length
  if (e) parts.push(`事件 ${e}`)
  const r = (diff.relations_add || []).length
  if (r) parts.push(`关系 ${r}`)
  return parts.length ? `+ ${parts.join('、')}` : '（无变化）'
}

// 世界状态面板：查看/直接编辑角色状态与事实 —— retcon 的入口
export default function StateView({ sessionId, version, settings }) {
  const [session, setSession] = useState(null)
  const [mode, setMode] = useState('pretty')
  const [raw, setRaw] = useState('')
  const [err, setErr] = useState('')
  const [newFact, setNewFact] = useState('')
  const [newEvent, setNewEvent] = useState('')
  const [relA, setRelA] = useState('')   // 批次4：人物关系 A → B
  const [relB, setRelB] = useState('')
  const [relDesc, setRelDesc] = useState('')
  const [replay, setReplay] = useState(null) // 批次7：回溯重放进度 {done,total}；null=未进行

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
  const log = session.stateLog || []

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

  /* ── 批次7：提取审计（撤销 / 回溯重放）── */

  async function refresh() {
    setSession(await db.sessions.get(sessionId))
  }

  async function onUndo(turn) {
    if (replay) return
    if (!confirm(`撤销第 ${turn} 回合的提取？\n\n世界状态会回到该次提取之前，之后的提取记录一并丢弃。`)) return
    try {
      await undoExtract(sessionId, turn)
      await refresh()
    } catch (e) {
      setErr(e.message)
    }
  }

  async function onReplay(turn) {
    if (replay) return
    if (!hasAnyProviderReady(settings)) { setErr('尚未配置任何模型，无法重放提取'); return }
    if (!confirm(`从第 ${turn} 回合起重放提取？\n\n会以该回合提取前的状态为起点，用当前的模型与提示词重跑之后的每一轮对话（每轮消耗一次提取调用）。`)) return
    setReplay({ done: 0, total: 0 })
    try {
      const n = await reExtractFrom(sessionId, turn, settings, (done, total) => setReplay({ done, total }))
      setErr('')
      await refresh()
      setMode('pretty')
      alert(`重放完成：共重跑 ${n} 轮提取。`)
    } catch (e) {
      setErr(`回溯提取失败：${e.message}`)
    } finally {
      setReplay(null)
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

          <h3>人物关系（{state.relations?.length || 0}）</h3>
          <div className="list">
            {(state.relations || []).map((r, i) => (
              <div key={i} className="list-row">
                <span className="list-main">
                  {r.from} → {r.to}
                  <span className="muted">{r.desc || '（未描述）'}</span>
                </span>
                <button className="icon-btn danger" onClick={() => save({ ...state, relations: state.relations.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
          </div>
          <div className="field-grid">
            <label>A<input className="input" value={relA} onChange={(e) => setRelA(e.target.value)} placeholder="角色名" /></label>
            <label>B<input className="input" value={relB} onChange={(e) => setRelB(e.target.value)} placeholder="角色名" /></label>
            <label className="span2">关系描述
              <input className="input" value={relDesc} onChange={(e) => setRelDesc(e.target.value)} placeholder="例：表面师徒，实则互相提防" />
            </label>
          </div>
          <div className="row">
            <button className="btn" onClick={() => {
              const from = relA.trim(), to = relB.trim(), desc = relDesc.trim()
              if (!from || !to) { setErr('两个角色名都要填'); return }
              // 同一对人物只保留一条：后来的描述覆盖旧的（与提取器的覆盖语义一致）
              const rest = (state.relations || []).filter((r) => !(r.from === from && r.to === to))
              save({ ...state, relations: [...rest, { from, to, desc, turn: 0 }] })
              setRelA(''); setRelB(''); setRelDesc(''); setErr('')
            }}>添加关系</button>
          </div>

          {/* 批次7：提取审计——每回合提取前都有快照，可撤销或换提示词/模型后重放 */}
          <h3>提取记录（{log.length}）</h3>
          {replay && (
            <div className="banner info">回溯重放中… {replay.done}/{replay.total || '?'} 轮</div>
          )}
          {log.length > 0 ? (
            <div className="list">
              {[...log].reverse().map((e) => (
                <div key={e.turn} className="list-row">
                  <span className="list-main">
                    <span className="muted">T{e.turn}</span> {diffSummary(e.diff)}
                    <span className="muted">{fmtTime(e.ts)}</span>
                  </span>
                  <button className="btn small" disabled={!!replay} onClick={() => onUndo(e.turn)}>撤销</button>
                  <button className="btn small" disabled={!!replay} onClick={() => onReplay(e.turn)}>从此重放</button>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted small">暂无提取记录（保留最近 20 次）。对话几轮后会出现在这里，可撤销某次提取，或修改提示词 / 更换模型后从任意记录点重放。</p>
          )}

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
