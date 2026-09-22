import { useEffect, useRef, useState } from 'react'
import { db } from '../lib/db'
import { parseCardFile } from '../lib/cardImport'

const blank = { name: '', description: '', personality: '', scenario: '', firstMessage: '', styleExamples: '', userPersona: '', alternateGreetings: [], embeddedLore: [] }

const FIELDS = [
  ['name', '角色名', '例：林晚'],
  ['description', '外貌与背景', '身份、经历、外貌特征…'],
  ['personality', '性格与说话方式', '例：外冷内热，说话简短，紧张时会咬字'],
  ['scenario', '世界观与当前场景', '故事发生的时代、地点、开场处境…'],
  ['firstMessage', '开场白（角色的第一条消息）', '…'],
  ['styleExamples', '文风示例（可选）', '粘贴几段符合期望文风的文字…'],
  ['userPersona', '用户角色设定（可选）', '用户扮演谁…'],
]

export default function CharView() {
  const [cards, setCards] = useState([])
  const [editing, setEditing] = useState(null) // null | {id?, ...fields}
  const [importLore, setImportLore] = useState(null) // 导入时的世界书条目勾选列表
  const [importWarn, setImportWarn] = useState([])
  const [importErr, setImportErr] = useState('')
  const fileRef = useRef(null)

  async function load() { setCards(await db.characters.toArray()) }
  useEffect(() => { load() }, [])

  async function save() {
    if (!editing.name.trim()) return
    const rec = { ...editing, name: editing.name.trim() }
    // 导入模式下：把未勾选的条目从 embeddedLore 中剔除
    if (importLore) rec.embeddedLore = editing.embeddedLore.filter((e) => importLore.some((c) => c.entry === e && c.checked))
    if (editing.id) await db.characters.update(editing.id, rec)
    else await db.characters.add(rec)
    setEditing(null)
    setImportLore(null)
    setImportWarn([])
    load()
  }

  async function remove(id) {
    if (!confirm('删除该角色卡？（不影响已开始的故事）')) return
    await db.characters.delete(id)
    load()
  }

  async function onImportFile(file) {
    setImportErr('')
    try {
      const { card, loreEntries, warnings } = await parseCardFile(file)
      setEditing({ ...blank, ...card, embeddedLore: loreEntries })
      setImportLore(loreEntries.map((entry) => ({ entry, checked: true })))
      setImportWarn(warnings)
    } catch (e) {
      setImportErr(`导入失败：${e.message}`)
      setImportLore(null)
      setImportWarn([])
    }
  }

  const editingLore = editing?.embeddedLore || []

  return (
    <div className="view">
      <div className="view-head">
        <h2>角色卡</h2>
        <div className="head-actions">
          <button className="btn" onClick={() => fileRef.current?.click()}>导入酒馆卡</button>
          <button className="btn primary" onClick={() => { setEditing({ ...blank }); setImportLore(null); setImportWarn([]) }}>＋ 新角色</button>
          <input ref={fileRef} type="file" accept=".png,.json,image/png,application/json" hidden
            onChange={(e) => { if (e.target.files[0]) onImportFile(e.target.files[0]); e.target.value = '' }} />
        </div>
      </div>
      {importErr && <div className="banner error" onClick={() => setImportErr('')}>{importErr}</div>}

      {editing && (
        <div className="modal-mask" onClick={() => { setEditing(null); setImportLore(null); setImportWarn([]) }}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>{editing.id ? '编辑角色' : importLore ? '导入角色卡（可修改后保存）' : '新角色'}</h3>
            {importWarn.map((w, i) => <div key={i} className="banner info">{w}</div>)}
            {FIELDS.map(([k, label, ph]) => (
              <div key={k}>
                <label className="lbl">{label}</label>
                {k === 'description' || k === 'scenario' || k === 'firstMessage' || k === 'styleExamples'
                  ? <textarea className="input" rows={k === 'firstMessage' ? 4 : 3} placeholder={ph} value={editing[k]} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
                  : <input className="input" placeholder={ph} value={editing[k]} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />}
              </div>
            ))}

            {editing.alternateGreetings?.length > 0 && (
              <div>
                <label className="lbl">备选开场白（{editing.alternateGreetings.length} 条，开新故事时可选）</label>
                {editing.alternateGreetings.map((g, i) => (
                  <div key={i} className="muted small ellipsis">{i + 1}. {g.replace(/\n/g, ' ').slice(0, 60)}…</div>
                ))}
              </div>
            )}

            {importLore && importLore.length > 0 && (
              <div>
                <label className="lbl">随卡导入的世界书条目（{importLore.filter((c) => c.checked).length}/{importLore.length} 勾选，存为该角色专属，开新故事时带入）</label>
                {importLore.map((c, i) => (
                  <label key={i} className="pick-row" style={{ padding: '6px 10px' }}>
                    <input type="checkbox" checked={c.checked} onChange={(e) => {
                      const next = [...importLore]
                      next[i] = { ...c, checked: e.target.checked }
                      setImportLore(next)
                    }} />
                    <div>
                      <b className="small">{c.entry.content.slice(0, 30)}…</b>
                      <div className="muted">{c.entry.constant ? '常驻' : `关键词：${c.entry.keys || '（无）'}`}</div>
                    </div>
                  </label>
                ))}
              </div>
            )}

            <div className="row-end">
              <button className="btn" onClick={() => { setEditing(null); setImportLore(null); setImportWarn([]) }}>取消</button>
              <button className="btn primary" disabled={!editing.name.trim()} onClick={save}>保存</button>
            </div>
          </div>
        </div>
      )}

      {!cards.length && !editing && <div className="empty-box"><p>还没有角色卡。可创建，或点「导入酒馆卡」直接导入 SillyTavern 的 PNG/JSON 角色卡。</p></div>}

      <div className="list">
        {cards.map((c) => (
          <div key={c.id} className="list-row">
            <button className="list-main" onClick={() => { setEditing({ ...blank, ...c }); setImportLore(null); setImportWarn([]) }}>
              <b>{c.name}</b>
              <span className="muted ellipsis">
                {c.scenario || c.description || '（无设定）'}
                {(c.embeddedLore?.length || c.alternateGreetings?.length) ? ` · 世界书 ${c.embeddedLore?.length || 0} 条 · 备选开场 ${c.alternateGreetings?.length || 0}` : ''}
              </span>
            </button>
            <button className="icon-btn danger" onClick={() => remove(c.id)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}
