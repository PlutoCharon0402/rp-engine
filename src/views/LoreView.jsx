import { useEffect, useState } from 'react'
import { db } from '../lib/db'

const blank = { keys: '', content: '', priority: 0, constant: false, enabled: true }

// 世界书：全局（所有故事共享）+ 本故事（从角色卡带入 / 手动添加，仅当前会话）
export default function LoreView({ sessionId }) {
  const [scope, setScope] = useState('global') // global | session
  const [globalEntries, setGlobalEntries] = useState([])
  const [session, setSession] = useState(null)
  const [editing, setEditing] = useState(null) // null | {id?, ...fields}

  async function load() {
    setGlobalEntries(await db.lore.toArray())
    if (sessionId) setSession(await db.sessions.get(sessionId))
  }
  useEffect(() => { load() }, [sessionId])

  const entries = scope === 'global' ? globalEntries : (session?.lore || [])

  async function saveToScope(rec, id) {
    if (scope === 'global') {
      if (id) await db.lore.update(id, rec)
      else await db.lore.add(rec)
    } else {
      const next = [...(session?.lore || [])]
      const idx = id ? next.findIndex((e) => e.uid === id) : -1
      if (idx >= 0) next[idx] = { ...rec, uid: id }
      else next.push({ ...rec, uid: `s${Date.now()}` })
      await db.sessions.update(sessionId, { lore: next, updatedAt: Date.now() })
      setSession({ ...session, lore: next })
    }
    setEditing(null)
    load()
  }

  async function removeFromScope(id) {
    if (!confirm('删除该世界书条目？')) return
    if (scope === 'global') {
      await db.lore.delete(id)
    } else {
      const next = (session?.lore || []).filter((e) => e.uid !== id)
      await db.sessions.update(sessionId, { lore: next, updatedAt: Date.now() })
      setSession({ ...session, lore: next })
    }
    load()
  }

  async function toggleEnabled(entry) {
    if (scope === 'global') {
      await db.lore.update(entry.id, { enabled: entry.enabled === false })
    } else {
      const next = (session?.lore || []).map((e) => (e.uid === entry.uid ? { ...e, enabled: e.enabled === false } : e))
      await db.sessions.update(sessionId, { lore: next, updatedAt: Date.now() })
      setSession({ ...session, lore: next })
    }
    load()
  }

  const openEdit = (e) => setEditing({ ...blank, ...e })
  const key = (e) => (scope === 'global' ? e.id : e.uid)

  return (
    <div className="view">
      <div className="view-head">
        <h2>世界书</h2>
        <div className="head-actions">
          {sessionId && (
            <div className="seg">
              <button className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>全局</button>
              <button className={scope === 'session' ? 'active' : ''} onClick={() => setScope('session')}>本故事</button>
            </div>
          )}
          <button className="btn primary" onClick={() => setEditing({ ...blank })}>＋ 新条目</button>
        </div>
      </div>
      <p className="muted small">
        {scope === 'global'
          ? '全局条目对所有故事生效。关键词命中近期对话时注入设定（按优先级与 token 预算）；「常驻」则每回合固定注入（放静态前缀，利于缓存）。'
          : '本故事专属条目（从角色卡导入时自动带入），仅当前故事可见。触发与注入规则同全局条目。'}
        {!sessionId && ' 从「对话」页进入一个故事后，可切换查看该故事的专属条目。'}
      </p>

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing.id || editing.uid ? '编辑条目' : `新条目（${scope === 'global' ? '全局' : '本故事'}）`}</h3>
            <label className="lbl">关键词（逗号分隔，任一命中即注入）</label>
            <input className="input" value={editing.keys} onChange={(e) => setEditing({ ...editing, keys: e.target.value })} placeholder="例：王城，帝都，首都" />
            <label className="lbl">内容（支持 {'{{char}}'} 宏）</label>
            <textarea className="input" rows={6} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} placeholder="被注入的世界设定正文…" />
            <label className="lbl">优先级（高者优先注入）</label>
            <input className="input" type="number" value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) || 0 })} />
            <div className="checks">
              <label><input type="checkbox" checked={!!editing.constant} onChange={(e) => setEditing({ ...editing, constant: e.target.checked })} /> 常驻注入</label>
              <label><input type="checkbox" checked={editing.enabled !== false} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> 启用</label>
            </div>
            <div className="row-end">
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn primary" onClick={() => saveToScope({ ...editing }, editing.id || editing.uid)}>保存</button>
            </div>
          </div>
        </div>
      )}

      {!entries.length && !editing && (
        <div className="empty-box"><p>暂无条目（{scope === 'global' ? '全局' : '本故事'}）。</p></div>
      )}

      <div className="list">
        {entries
          .slice()
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .map((e) => (
            <div key={key(e)} className={`list-row ${e.enabled === false ? 'disabled' : ''}`}>
              <button className="list-main" onClick={() => openEdit(e)}>
                <b>{(e.content || '').slice(0, 24)}…</b>
                <span className="muted">
                  {e.constant ? '常驻' : `关键词：${e.keys || '（无）'}`} · 优先级 {e.priority || 0}
                  {e.enabled === false ? ' · 已停用' : ''}
                </span>
              </button>
              <button className="icon-btn" title={e.enabled === false ? '启用' : '停用'} onClick={() => toggleEnabled(e)}>{e.enabled === false ? '○' : '●'}</button>
              <button className="icon-btn danger" onClick={() => removeFromScope(key(e))}>✕</button>
            </div>
          ))}
      </div>
    </div>
  )
}
