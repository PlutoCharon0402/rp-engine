import { useEffect, useRef, useState } from 'react'
import { db } from '../lib/db'
import { fmtTime } from '../lib/util'
import { substMacros } from '../lib/compiler'
import { buildSessionExport, transcriptText, downloadFile, safeFileName, importSessionFile } from '../lib/sessionIO'

export default function SessionsView({ onSelect, onGoChars }) {
  const [sessions, setSessions] = useState([])
  const [cards, setCards] = useState([])
  const [creating, setCreating] = useState(false)
  const [picked, setPicked] = useState(null)
  const [greetingIdx, setGreetingIdx] = useState(0)
  const [name, setName] = useState('')
  const [exportTarget, setExportTarget] = useState(null) // 待导出会话 id → 弹格式选择
  const [importErr, setImportErr] = useState('')
  const fileRef = useRef(null)

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
      lore: (card.embeddedLore || []).map((e) => ({ ...e })), // 会话级隔离：拷贝角色专属世界书
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const greetings = [card.firstMessage, ...(card.alternateGreetings || [])]
    const chosen = (greetings[greetingIdx] || greetings[0] || '').trim()
    if (chosen) {
      await db.messages.add({ sessionId: sid, role: 'assistant', content: substMacros(chosen, card), turn: 1, ts: Date.now() })
    }
    onSelect(sid)
  }

  async function exportAs(fmt) {
    const sid = exportTarget
    setExportTarget(null)
    try {
      const exp = await buildSessionExport(sid)
      if (fmt === 'txt') {
        downloadFile(`${safeFileName(exp.session.name)}.txt`, transcriptText(exp), 'text/plain')
      } else {
        downloadFile(`${safeFileName(exp.session.name)}.session.json`, JSON.stringify(exp), 'application/json')
      }
    } catch (e) {
      alert(`导出失败：${e.message}`)
    }
  }

  async function onImportFile(file) {
    setImportErr('')
    try {
      const sid = await importSessionFile(file)
      onSelect(sid)
    } catch (e) {
      setImportErr(`导入失败：${e.message}`)
    }
  }

  async function remove(id) {
    if (!confirm('删除该会话及其全部消息？此操作不可撤销。')) return
    await db.messages.where('sessionId').equals(id).delete()
    await db.tasks.where('sessionId').equals(id).delete()
    await db.sessions.delete(id)
    load()
  }

  const pickedCard = picked ? cards.find((c) => c.id === picked) : null
  const greetings = pickedCard ? [pickedCard.firstMessage, ...(pickedCard.alternateGreetings || [])].filter((g) => g?.trim()) : []

  return (
    <div className="view">
      <div className="view-head">
        <h2>会话</h2>
        <div className="head-actions">
          <button className="btn" onClick={() => fileRef.current?.click()}>导入记录</button>
          <button className="btn primary" onClick={() => { setCreating(true); setPicked(null); setGreetingIdx(0); setName('') }}>＋ 新故事</button>
        </div>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden
          onChange={(e) => { if (e.target.files[0]) onImportFile(e.target.files[0]); e.target.value = '' }} />
      </div>
      {importErr && <div className="banner error" onClick={() => setImportErr('')}>{importErr}</div>}

      {exportTarget && (
        <div className="modal-mask" onClick={() => setExportTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>导出聊天记录</h3>
            <button className="pick-row" style={{ width: '100%' }} onClick={() => exportAs('json')}>
              <div>
                <b>JSON（含世界状态与专属世界书）</b>
                <div className="muted">无损备份，可在任意设备再次导入继续玩</div>
              </div>
            </button>
            <button className="pick-row" style={{ width: '100%' }} onClick={() => exportAs('txt')}>
              <div>
                <b>纯文本（仅对话）</b>
                <div className="muted">可读的聊天记录，适合存档或分享</div>
              </div>
            </button>
          </div>
        </div>
      )}

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
                      <input type="radio" name="card" checked={picked === c.id} onChange={() => { setPicked(c.id); setGreetingIdx(0) }} />
                      <div>
                        <b>{c.name}</b>
                        <div className="muted ellipsis">{c.scenario || c.description || '（无设定）'}</div>
                      </div>
                    </label>
                  ))}
                </div>

                {greetings.length > 1 && (
                  <>
                    <label className="lbl">选择开场白</label>
                    <div className="card-list">
                      {greetings.map((g, i) => (
                        <label key={i} className={`pick-row ${greetingIdx === i ? 'picked' : ''}`} style={{ alignItems: 'flex-start' }}>
                          <input type="radio" name="greeting" checked={greetingIdx === i} onChange={() => setGreetingIdx(i)} />
                          <div className="small" style={{ maxHeight: '4.5em', overflow: 'hidden' }}>{g.replace(/\n+/g, ' ').slice(0, 120)}…</div>
                        </label>
                      ))}
                    </div>
                  </>
                )}

                {pickedCard?.embeddedLore?.length > 0 && (
                  <p className="muted small">将带入 {pickedCard.embeddedLore.length} 条该角色专属的世界书条目（仅本故事可见）。</p>
                )}
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
              <span className="muted">{fmtTime(s.updatedAt)} · {Object.keys(s.state?.characters || {}).length} 个角色在册{s.lore?.length ? ` · 专属世界书 ${s.lore.length} 条` : ''}</span>
            </button>
            <button className="icon-btn" title="导出" onClick={() => setExportTarget(s.id)}>↓</button>
            <button className="icon-btn danger" onClick={() => remove(s.id)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}
