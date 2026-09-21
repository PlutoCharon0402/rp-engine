import { useEffect, useState } from 'react'
import { db } from '../lib/db'

const blank = { keys: '', content: '', priority: 0, constant: false, enabled: true }

export default function LoreView() {
  const [entries, setEntries] = useState([])
  const [editing, setEditing] = useState(null) // null | {id?, ...fields}

  async function load() { setEntries(await db.lore.toArray()) }
  useEffect(() => { load() }, [])

  async function save() {
    if (!editing.content.trim()) return
    const rec = { ...editing, keys: editing.keys.trim(), content: editing.content.trim() }
    if (editing.id) await db.lore.update(editing.id, rec)
    else await db.lore.add(rec)
    setEditing(null)
    load()
  }

  async function remove(id) {
    if (!confirm('删除该世界书条目？')) return
    await db.lore.delete(id)
    load()
  }

  return (
    <div className="view">
      <div className="view-head">
        <h2>世界书</h2>
        <button className="btn primary" onClick={() => setEditing({ ...blank })}>＋ 新条目</button>
      </div>
      <p className="muted small">
        关键词命中近期对话时注入设定（按优先级与 token 预算）；勾选「常驻」则每回合固定注入（放静态前缀，利于缓存）。
      </p>

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editing.id ? '编辑条目' : '新条目'}</h3>
            <label className="lbl">关键词（逗号分隔，任一命中即注入）</label>
            <input className="input" value={editing.keys} onChange={(e) => setEditing({ ...editing, keys: e.target.value })} placeholder="例：王城，帝都，首都" />
            <label className="lbl">内容</label>
            <textarea className="input" rows={6} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} placeholder="被注入的世界设定正文…" />
            <label className="lbl">优先级（高者优先注入）</label>
            <input className="input" type="number" value={editing.priority} onChange={(e) => setEditing({ ...editing, priority: Number(e.target.value) || 0 })} />
            <div className="checks">
              <label><input type="checkbox" checked={!!editing.constant} onChange={(e) => setEditing({ ...editing, constant: e.target.checked })} /> 常驻注入</label>
              <label><input type="checkbox" checked={editing.enabled !== false} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> 启用</label>
            </div>
            <div className="row-end">
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn primary" onClick={save}>保存</button>
            </div>
          </div>
        </div>
      )}

      {!entries.length && !editing && <div className="empty-box"><p>暂无条目。世界书用于存放地点、组织、配角、设定规则等按需注入的信息。</p></div>}

      <div className="list">
        {entries
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .map((e) => (
            <div key={e.id} className={`list-row ${e.enabled === false ? 'disabled' : ''}`}>
              <button className="list-main" onClick={() => setEditing({ ...e })}>
                <b>{(e.content || '').slice(0, 24)}…</b>
                <span className="muted">
                  {e.constant ? '常驻' : `关键词：${e.keys || '（无）'}`} · 优先级 {e.priority || 0}
                  {e.enabled === false ? ' · 已停用' : ''}
                </span>
              </button>
              <button className="icon-btn danger" onClick={() => remove(e.id)}>✕</button>
            </div>
          ))}
      </div>
    </div>
  )
}
