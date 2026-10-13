import { useEffect, useRef, useState } from 'react'
import { db } from '../lib/db'
import { normalizeLore, upsertLore, removeLore, toggleLore, validateLorePack, buildLorePack } from '../lib/lore'
import { downloadFile } from '../lib/sessionIO'

const blank = { keys: '', content: '', priority: 0, constant: false, enabled: true }

// 世界书：全局（所有故事共享）+ 本故事（从角色卡带入 / 手动添加，仅当前会话）
export default function LoreView({ sessionId }) {
  const [scope, setScope] = useState('global') // global | session
  const [globalEntries, setGlobalEntries] = useState([])
  const [session, setSession] = useState(null)
  const [editing, setEditing] = useState(null) // null | {id?, ...fields}
  const [q, setQ] = useState('')                // 批次4：搜索关键词（匹配关键词与内容）
  const [importPack, setImportPack] = useState(null) // 待导入的世界书条目（校验通过后待确认合并方式）
  const [ioMsg, setIoMsg] = useState('')        // 导入导出反馈
  const fileRef = useRef(null)

  async function load() {
    setGlobalEntries(await db.lore.toArray())
    if (!sessionId) { setSession(null); return }
    let s = await db.sessions.get(sessionId)
    // 读时自愈：存量会话（条目无 uid）首次打开即补齐。
    // ⚠️ 必须同步 `s = { ...s, lore }`：否则 state 里仍是旧的无 uid 列表，
    //    删除时 uid === undefined 会触发守卫 → 用户点 ✕ "没反应"。
    if (s && Array.isArray(s.lore) && s.lore.some((e) => !e || !e.uid)) {
      const lore = normalizeLore(s.lore)
      await db.sessions.update(sessionId, { lore }) // 不改 updatedAt，避免打乱会话排序
      s = { ...s, lore }
    }
    setSession(s)
  }
  useEffect(() => { load() }, [sessionId])

  const entries = scope === 'global' ? globalEntries : (session?.lore || [])

  async function saveToScope(rec, id) {
    if (scope === 'global') {
      if (id) await db.lore.update(id, rec)
      else await db.lore.add(rec)
    } else {
      const next = upsertLore(session?.lore || [], rec, id)
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
      const next = removeLore(session?.lore || [], id) // id 缺失时守卫生效：一条都不删
      await db.sessions.update(sessionId, { lore: next, updatedAt: Date.now() })
      setSession({ ...session, lore: next })
    }
    load()
  }

  async function toggleEnabled(entry) {
    if (scope === 'global') {
      await db.lore.update(entry.id, { enabled: entry.enabled === false })
    } else {
      const next = toggleLore(session?.lore || [], entry.uid)
      await db.sessions.update(sessionId, { lore: next, updatedAt: Date.now() })
      setSession({ ...session, lore: next })
    }
    load()
  }

  /* ────────── 批次4：搜索 + 世界书独立导入导出 ────────── */

  // 搜索匹配"关键词 + 内容"，大小写不敏感；空串不过滤
  const kw = q.trim().toLowerCase()
  const visible = kw
    ? entries.filter((e) => `${e.keys || ''}\n${e.content || ''}`.toLowerCase().includes(kw))
    : entries

  function exportPack() {
    const list = normalizeLore(entries)
    if (!list.length) { setIoMsg('当前作用域没有条目可导出。'); return }
    const label = scope === 'global' ? '全局' : '本故事'
    downloadFile(`lore-${label}-${list.length}条.json`, JSON.stringify(buildLorePack(list), null, 2))
    setIoMsg(`已导出 ${list.length} 条（${label}）。`)
  }

  async function onPickFile(file) {
    setIoMsg('')
    let dump
    try { dump = JSON.parse(await file.text()) } catch { setIoMsg('导入失败：文件不是合法的 JSON'); return }
    try {
      // validateLorePack 会拦下全量备份 / 单故事导出 / 无 content 的条目 —— 校验不过零改动
      setImportPack(validateLorePack(dump))
    } catch (e) {
      setIoMsg(`导入失败：${e.message}`)
    }
  }

  /** 写入目标作用域。mode: 'append' 追加 / 'replace' 替换 */
  async function applyImport(mode) {
    const list = importPack || []
    setImportPack(null)
    try {
      if (scope === 'global') {
        if (mode === 'replace') await db.lore.clear()
        // 全局表身份是自增 id，导入条目的 uid 属会话级身份，不写入
        await db.lore.bulkAdd(list.map(({ uid, ...rest }) => ({ ...rest })))
      } else {
        const next = mode === 'replace' ? list : [...normalizeLore(session?.lore || []), ...list]
        await db.sessions.update(sessionId, { lore: next, updatedAt: Date.now() })
        setSession({ ...session, lore: next })
      }
      setIoMsg(`已导入 ${list.length} 条（${mode === 'replace' ? '替换' : '追加'}）。`)
      load()
    } catch (e) {
      setIoMsg(`导入失败：${e.message}`)
    }
  }

  const openEdit = (e) => setEditing({ ...blank, ...e })
  // 会话级条目以 uid 为身份；兜底 e.id 仅为兼容，渲染时再兜底下标，避免 React key 重复
  const key = (e) => (scope === 'global' ? e.id : (e.uid ?? e.id))

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

      <div className="row">
        <input className="input grow" placeholder="搜索关键词或内容…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => fileRef.current?.click()}>导入</button>
        <button className="btn" onClick={exportPack}>导出</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden
          onChange={(e) => { if (e.target.files[0]) onPickFile(e.target.files[0]); e.target.value = '' }} />
      </div>
      {kw && <p className="muted small">匹配 {visible.length} / {entries.length} 条</p>}
      {ioMsg && <div className="banner info" onClick={() => setIoMsg('')}>{ioMsg}</div>}

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

      {!visible.length && !editing && (
        <div className="empty-box">
          <p>{kw ? `没有匹配「${q.trim()}」的条目。` : `暂无条目（${scope === 'global' ? '全局' : '本故事'}）。`}</p>
        </div>
      )}

      {importPack && (
        <div className="modal-mask" onClick={() => setImportPack(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>导入 {importPack.length} 条条目</h3>
            <p className="muted small">
              目标：{scope === 'global' ? '全局' : '本故事'}。追加保留现有条目；替换会先清空该作用域的现有条目。
            </p>
            <div className="card-list">
              {importPack.slice(0, 5).map((e, i) => (
                <div key={i} className="card">
                  <b>{(e.content || '').slice(0, 40)}…</b>
                  <div className="muted">{e.constant ? '常驻' : `关键词：${e.keys || '（无）'}`}</div>
                </div>
              ))}
            </div>
            {importPack.length > 5 && <p className="muted small">…共 {importPack.length} 条</p>}
            <div className="row-end">
              <button className="btn" onClick={() => setImportPack(null)}>取消</button>
              <button className="btn" onClick={() => applyImport('append')}>追加</button>
              <button className="btn danger-text" onClick={() => {
                if (confirm(`替换会清空当前${scope === 'global' ? '全局' : '本故事'}的全部条目，确定？`)) applyImport('replace')
              }}>替换</button>
            </div>
          </div>
        </div>
      )}

      <div className="list">
        {visible
          .slice()
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .map((e, i) => (
            <div key={key(e) ?? `i${i}`} className={`list-row ${e.enabled === false ? 'disabled' : ''}`}>
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
