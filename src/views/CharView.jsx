import { useEffect, useState } from 'react'
import { db } from '../lib/db'

const blank = { name: '', description: '', personality: '', scenario: '', firstMessage: '', styleExamples: '', userPersona: '' }

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
  const [editing, setEditing] = useState(null)

  async function load() { setCards(await db.characters.toArray()) }
  useEffect(() => { load() }, [])

  async function save() {
    if (!editing.name.trim()) return
    const rec = { ...editing, name: editing.name.trim() }
    if (editing.id) await db.characters.update(editing.id, rec)
    else await db.characters.add(rec)
    setEditing(null)
    load()
  }

  async function remove(id) {
    if (!confirm('删除该角色卡？（不影响已开始的故事）')) return
    await db.characters.delete(id)
    load()
  }

  return (
    <div className="view">
      <div className="view-head">
        <h2>角色卡</h2>
        <button className="btn primary" onClick={() => setEditing({ ...blank })}>＋ 新角色</button>
      </div>

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>{editing.id ? '编辑角色' : '新角色'}</h3>
            {FIELDS.map(([k, label, ph]) => (
              <div key={k}>
                <label className="lbl">{label}</label>
                {k === 'description' || k === 'scenario' || k === 'firstMessage' || k === 'styleExamples'
                  ? <textarea className="input" rows={k === 'firstMessage' ? 4 : 3} placeholder={ph} value={editing[k]} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
                  : <input className="input" placeholder={ph} value={editing[k]} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />}
              </div>
            ))}
            <div className="row-end">
              <button className="btn" onClick={() => setEditing(null)}>取消</button>
              <button className="btn primary" disabled={!editing.name.trim()} onClick={save}>保存</button>
            </div>
          </div>
        </div>
      )}

      {!cards.length && !editing && <div className="empty-box"><p>还没有角色卡。角色卡决定角色的设定与开场。</p></div>}

      <div className="list">
        {cards.map((c) => (
          <div key={c.id} className="list-row">
            <button className="list-main" onClick={() => setEditing({ ...c })}>
              <b>{c.name}</b>
              <span className="muted ellipsis">{c.scenario || c.description || '（无设定）'}</span>
            </button>
            <button className="icon-btn danger" onClick={() => remove(c.id)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}
