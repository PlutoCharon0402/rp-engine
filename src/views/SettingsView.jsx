import { useRef, useState } from 'react'
import { db } from '../lib/db'
import { DEFAULT_SETTINGS } from '../lib/util'

export default function SettingsView({ settings, onChange }) {
  const fileRef = useRef(null)
  const [msg, setMsg] = useState('')
  const [models, setModels] = useState(null) // 从 /models 接口获取的可用模型列表
  const [testing, setTesting] = useState(false)
  const [testMsg, setTestMsg] = useState(null) // { ok, text }

  function set(k, v) { onChange({ ...settings, [k]: v }) }

  /** 测试连接：调用官方 /models 接口，验证 Key 并获取可用模型清单 */
  async function testConnection() {
    setTesting(true)
    setTestMsg(null)
    const base = (settings.endpoint || DEFAULT_SETTINGS.endpoint).replace(/\/+$/, '')
    try {
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${settings.apiKey}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 120)}`)
      const j = await res.json()
      const ids = (j.data || []).map((m) => m.id).filter(Boolean)
      if (!ids.length) throw new Error('接口未返回任何模型')
      setModels(ids)
      setTestMsg({ ok: true, text: `连接正常，可用模型 ${ids.length} 个` })
    } catch (e) {
      setModels(null)
      setTestMsg({ ok: false, text: `连接失败：${e.message}` })
    } finally {
      setTesting(false)
    }
  }

  async function exportData() {
    const dump = {}
    for (const t of ['characters', 'sessions', 'messages', 'lore']) dump[t] = await db.table(t).toArray()
    const blob = new Blob([JSON.stringify(dump)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `rp-engine-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    setMsg('已导出备份文件。')
  }

  async function importData(file) {
    try {
      const dump = JSON.parse(await file.text())
      if (!confirm('导入将覆盖当前全部数据（角色/会话/消息/世界书），确定？')) return
      for (const t of ['characters', 'sessions', 'messages', 'lore', 'tasks']) await db.table(t).clear()
      for (const t of ['characters', 'sessions', 'messages', 'lore']) {
        if (Array.isArray(dump[t])) await db.table(t).bulkAdd(dump[t])
      }
      setMsg('导入完成。')
    } catch (e) {
      setMsg(`导入失败：${e.message}`)
    }
  }

  return (
    <div className="view">
      <div className="view-head"><h2>设置</h2></div>

      <h3>DeepSeek API</h3>
      <label className="lbl">API Key（<a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">platform.deepseek.com</a> 获取）</label>
      <input className="input" type="password" placeholder="sk-…" value={settings.apiKey} onChange={(e) => set('apiKey', e.target.value)} />
      <div className="row">
        <button className="btn" disabled={testing || !settings.apiKey} onClick={testConnection}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        {testMsg && (
          <span className={`small ${testMsg.ok ? 'ok-text' : 'err-text'}`}>
            {testMsg.ok ? '✓ ' : ''}{testMsg.text}
            {testMsg.ok && models && `：${models.join('、')}`}
          </span>
        )}
      </div>
      <label className="lbl">接口地址（兼容 OpenAI 格式的服务均可）</label>
      <input className="input" value={settings.endpoint} onChange={(e) => { set('endpoint', e.target.value); setModels(null); setTestMsg(null) }} placeholder={DEFAULT_SETTINGS.endpoint} />
      <label className="lbl">模型{models ? '（来自接口的可用清单）' : '（测试连接后可下拉选择）'}</label>
      {models ? (
        <select className="input" value={settings.model} onChange={(e) => set('model', e.target.value)}>
          {/* 当前值不在清单中时保留为选项，避免静默切换 */}
          {!models.includes(settings.model) && settings.model && <option value={settings.model}>{settings.model}（当前值）</option>}
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      ) : (
        <input className="input" value={settings.model} onChange={(e) => set('model', e.target.value)} placeholder="deepseek-chat / deepseek-reasoner" />
      )}

      <h3>生成参数</h3>
      <div className="field-grid">
        <label>温度（RP 建议 1.0–1.3）<input className="input" type="number" step="0.05" min="0" max="2" value={settings.temperature} onChange={(e) => set('temperature', Number(e.target.value))} /></label>
        <label>最大生成长度<input className="input" type="number" value={settings.maxTokens} onChange={(e) => set('maxTokens', Number(e.target.value) || 1024)} /></label>
      </div>

      <h3>上下文编译</h3>
      <div className="field-grid">
        <label>注入深度（1=紧贴最新消息，缓存最优）<input className="input" type="number" min="0" max="20" value={settings.depth} onChange={(e) => set('depth', Number(e.target.value))} /></label>
        <label>历史消息上限（条）<input className="input" type="number" min="4" max="200" value={settings.maxHistory} onChange={(e) => set('maxHistory', Number(e.target.value) || 40)} /></label>
        <label className="span2">世界书 token 预算<input className="input" type="number" min="0" value={settings.loreBudget} onChange={(e) => set('loreBudget', Number(e.target.value) || 600)} /></label>
      </div>
      <p className="muted small">角色卡与常驻世界书放在 prompt 静态前缀以命中 DeepSeek 前缀缓存；历史消息只增不改，同样是可缓存前缀。状态与触发条目注入在最后 depth 条消息之前（默认 1，即紧贴最新用户消息）——每轮仅这部分与新增消息按全价计费。</p>

      <h3>数据</h3>
      <div className="row">
        <button className="btn" onClick={exportData}>导出备份</button>
        <button className="btn" onClick={() => fileRef.current?.click()}>导入备份</button>
        <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = '' }} />
      </div>
      <p className="muted small">所有数据只存在本机浏览器（IndexedDB）。API Key 仅存于本机 localStorage，不经过任何第三方服务器——浏览器直连 DeepSeek。换设备前记得导出备份。</p>
      {msg && <div className="banner info">{msg}</div>}
    </div>
  )
}
