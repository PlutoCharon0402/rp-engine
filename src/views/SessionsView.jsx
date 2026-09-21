import { useEffect, useState } from 'react'
import { db } from '../lib/db'
import { fmtTime } from '../lib/util'

export default function SessionsView({ onSelect, onGoChars }) {
  const [sessions, setSessions] = useState([])
  const [cards, setCards] = useState([])
  const [creating, setCreating] = useState(false)
  const [picked, setPicked] = useState(null)
  const [name, setName] = useState('')

  async function load() {
    setSessions(await db.sessions.orderBy('updatedAt').reverse().toArray())
    setCards(await db.characters.toArray())
  }
  useEffect(() => { load() }, [])

  async function create() {
    if (!picked) return
    const card = cards.find((c) => c.id === picked)
    if (!card) return
    const state = {
      characters: {
        [card.name]: { name: card.name, location: '', mood: '', goal: '', inventory: [], knows: [] },
      },
      facts: [], events: [], relations: [],
    }
    const sid = await db.sessions.add({
      name: name.trim() || `${card.name}的新故事`,
      characterId: card.id,
      state,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    if (card.firstMessage?.trim()) {
      await db.messages.add({ sessionId: sid, role: 'assistant', content: card.firstMessage.trim(), turn: 1, ts: Date.now() })
    }
    onSelect(sid)
  }

  async function remove(id) {
    if (!confirm('删除该会话及其全部消息？此操作不可撤销。')) return
    await db.messages.where('sessionId').equals(id).delete()
    await db.tasks.where('sessionId').equals(id).delete()
    await db.sessions.delete(id)
    load()
  }

  return (
    <div className="view">
      <div className="view-head">
        <h2>会话</h2>
        <button className="btn primary" onClick={() => { setCreating(true); setPicked(null); setName('') }}>＋ 新故事</button>
      </div>

      {creating && (
        <div className="modal-mask" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>开始新故事</h3>
            {!cards.length ? (
              <div className="empty-box">
                <p>还没有角色卡。先创建一个角色，再开始故事。</p>
                <button className="btn primary" onClick={onGoChars}>去创建角色</button>
              </div>
            ) : (
              <>
                <div className="card-list">
                  {cards.map((c) => (
                    <label key={c.id} className={`pick-row ${picked === c.id ? 'picked' : ''}`}>
                      <input type="radio" name="card" checked={picked === c.id} onChange={() => setPicked(c.id)} />
                      <div>
                        <b>{c.name}</b>
                        <div className="muted ellipsis">{c.scenario || c.description || '（无设定）'}</div>
                      </div>
                    </label>
                  ))}
                </div>
                <input className="input" placeholder="故事名（可留空）" value={name} onChange={(e) => setName(e.target.value)} />
                <div className="row-end">
                  <button className="btn" onClick={() => setCreating(false)}>取消</button>
                  <button className="btn primary" disabled={!picked} onClick={create}>开始</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {!sessions.length && !creating && (
        <div className="empty-box">
          <p>还没有进行中的故事。<br />点「＋ 新故事」，选择角色卡即可开始。</p>
        </div>
      )}

      <div className="list">
        {sessions.map((s) => (
          <div key={s.id} className="list-row">
            <button className="list-main" onClick={() => onSelect(s.id)}>
              <b>{s.name}</b>
              <span className="muted">{fmtTime(s.updatedAt)} · {Object.keys(s.state?.characters || {}).length} 个角色在册</span>
            </button>
            <button className="icon-btn danger" onClick={() => remove(s.id)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}
