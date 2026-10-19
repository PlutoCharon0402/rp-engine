// 设置页 · AI 模型管理（多模型支持的核心 UI）：
//   厂商注册表（内置 + 自定义）→ 编辑 / 测试 / 设为默认；对话默认模型；
//   模型路由（状态提取 / 剧情摘要走哪家）；故障转移链；各厂商性能表现（metrics 聚合）。
import { useEffect, useState } from 'react'
import {
  allProviders, getProvider, providerReady, BUILTIN_PROVIDERS, CUSTOM_TEMPLATE,
} from '../lib/providers/registry'
import { metricsSummary, clearMetrics } from '../lib/providers/metrics'
import { fmtTokens } from '../lib/util'

/** 模型列表文本（换行 / 逗号分隔）↔ 数组 */
const parseModels = (s) => String(s || '').split(/[\n,，]+/).map((x) => x.trim()).filter(Boolean)
const isBuiltin = (id) => BUILTIN_PROVIDERS.some((b) => b.id === id)

export default function ModelSettings({ settings, onChange }) {
  const providers = allProviders(settings)
  const overrides = settings.providers || {}
  const routing = settings.routing || { extract: { providerId: '', model: '' }, summary: { providerId: '', model: '' } }
  const defaultProvider = getProvider(settings, settings.providerId)

  const [editing, setEditing] = useState(null)     // 编辑中的厂商副本；null = 关闭弹层
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState(null)           // { ok, text, ids }
  const [perf, setPerf] = useState(null)           // 近 7 天厂商表现

  useEffect(() => { metricsSummary(7).then(setPerf) }, [])

  /* ── 厂商 CRUD ── */

  function saveProvider(p) {
    const next = { ...settings, providers: { ...overrides, [p.id]: p } }
    // 新添加的自定义厂商保存后立即成为对话默认（最常见的添加动机）
    if (!isBuiltin(p.id) && !overrides[p.id] && settings.providerId !== p.id) {
      next.providerId = p.id
      next.model = p.defaultModel || p.models[0] || ''
    }
    onChange(next)
    setEditing(null)
    setTest(null)
  }

  function addCustom() {
    setEditing({ ...CUSTOM_TEMPLATE, id: `custom-${Date.now().toString(36)}` })
    setTest(null)
  }

  /** 删除 = 清除用户覆盖（内置回到出厂，自定义直接消失），并清理所有引用 */
  function removeProvider(id) {
    const next = { ...overrides }
    delete next[id]
    const clearRef = (r) => (r && r.providerId === id ? { providerId: '', model: '' } : r || { providerId: '', model: '' })
    onChange({
      ...settings,
      providers: next,
      providerId: settings.providerId === id ? 'deepseek' : settings.providerId,
      model: settings.providerId === id ? 'deepseek-chat' : settings.model,
      fallbackIds: (settings.fallbackIds || []).filter((x) => x !== id),
      routing: { extract: clearRef(routing.extract), summary: clearRef(routing.summary) },
    })
    setEditing(null)
  }

  function setDefault(p) {
    onChange({ ...settings, providerId: p.id, model: p.defaultModel || p.models[0] || '' })
  }

  function toggleFallback(id) {
    const cur = settings.fallbackIds || []
    onChange({ ...settings, fallbackIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
  }

  function setRouting(purpose, patch) {
    onChange({ ...settings, routing: { ...routing, [purpose]: { ...routing[purpose], ...patch } } })
  }

  /* ── 测试连接（对编辑中的厂商调 /models）── */

  async function testConnection(p) {
    if (testing) return
    setTesting(true)
    setTest(null)
    const base = (p.endpoint || '').replace(/\/+$/, '')
    try {
      const headers = p.adapter === 'anthropic'
        ? { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
        : (p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {})
      const res = await fetch(`${base}/models`, { headers })
      if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 120)}`)
      const j = await res.json()
      const ids = (j.data || []).map((m) => m.id).filter(Boolean)
      if (!ids.length) throw new Error('接口未返回任何模型')
      setTest({ ok: true, text: `连接正常，可用模型 ${ids.length} 个`, ids })
    } catch (e) {
      setTest({ ok: false, text: `连接失败：${e.message}` })
    } finally {
      setTesting(false)
    }
  }

  /* ── 渲染 ── */

  const statusText = (p) => {
    if (p.noKey) return '本机服务 · 无需 Key'
    if (!p.apiKey) return '未配置 Key'
    if (!p.browserSafe) return '已配置 · ⚠️ 浏览器直连受限，可能需自建代理'
    return '已配置'
  }

  return (
    <>
      <h3>AI 模型</h3>
      <p className="muted small">
        支持多家模型厂商，对话 / 状态提取 / 剧情摘要可各用一家；某家故障时自动切换到勾选的备用厂商。
        OpenAI 兼容的服务（DeepSeek / Kimi / 通义 / OpenRouter / Ollama …）均可接入。
      </p>

      <div className="list">
        {providers.map((p) => (
          <div key={p.id} className="list-row">
            <span className="list-main">
              {p.displayName}
              <span className="muted">{statusText(p)}</span>
            </span>
            {settings.providerId === p.id ? (
              <span className="btn small is-current">对话默认</span>
            ) : (
              <button className="btn small" onClick={() => setDefault(p)}>设为默认</button>
            )}
            <button className="btn small" onClick={() => { setEditing({ ...p }); setTest(null) }}>编辑</button>
          </div>
        ))}
      </div>
      <div className="row">
        <button className="btn" onClick={addCustom}>＋ 添加自定义厂商</button>
      </div>

      {/* 对话默认模型 */}
      <label className="lbl">对话默认模型</label>
      <div className="field-grid">
        <select
          className="input"
          value={settings.providerId}
          onChange={(e) => {
            const p = getProvider(settings, e.target.value)
            onChange({ ...settings, providerId: e.target.value, model: p?.defaultModel || p?.models[0] || '' })
          }}
        >
          {providers.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
        </select>
        <select
          className="input"
          value={settings.model}
          onChange={(e) => onChange({ ...settings, model: e.target.value })}
        >
          {!defaultProvider?.models?.includes(settings.model) && settings.model && (
            <option value={settings.model}>{settings.model}（当前值）</option>
          )}
          {(defaultProvider?.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>

      {/* 模型路由：非对话用途 */}
      <label className="lbl">模型路由（留空 = 跟随对话默认）</label>
      {[['extract', '状态提取'], ['summary', '剧情摘要']].map(([key, label]) => {
        const p = getProvider(settings, routing[key]?.providerId)
        return (
          <div key={key} className="field-grid">
            <label>{label}
              <select
                className="input"
                value={routing[key]?.providerId || ''}
                onChange={(e) => setRouting(key, { providerId: e.target.value, model: '' })}
              >
                <option value="">跟随对话默认</option>
                {providers.map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
              </select>
            </label>
            <label>模型
              <select
                className="input"
                value={routing[key]?.model || ''}
                onChange={(e) => setRouting(key, { model: e.target.value })}
              >
                <option value="">默认</option>
                {(p?.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>
        )
      })}

      {/* 故障转移链 */}
      <label className="lbl">故障转移（对话厂商失败时，按勾选顺序自动换）</label>
      <div className="list">
        {providers.filter((p) => p.id !== settings.providerId).map((p) => (
          <label key={p.id} className="list-row" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={(settings.fallbackIds || []).includes(p.id)}
              onChange={() => toggleFallback(p.id)}
              disabled={!providerReady(p)}
            />
            <span className="list-main">{p.displayName}<span className="muted">{providerReady(p) ? '' : '（未配置，不可作为备用）'}</span></span>
          </label>
        ))}
      </div>

      {/* 模型表现 */}
      <label className="lbl">模型表现（近 7 天 · 成本为估算值）</label>
      {perf && perf.length > 0 ? (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr className="muted">
                <th style={{ textAlign: 'left' }}>厂商</th><th>调用</th><th>成功率</th><th>均耗时</th>
                <th>首字</th><th>tokens</th><th>缓存命中</th><th>估算成本</th>
              </tr>
            </thead>
            <tbody>
              {perf.map((r) => (
                <tr key={r.provider}>
                  <td style={{ textAlign: 'left' }}>{r.provider}</td>
                  <td style={{ textAlign: 'center' }}>{r.calls}</td>
                  <td style={{ textAlign: 'center' }}>{Math.round(r.okRate * 100)}%</td>
                  <td style={{ textAlign: 'center' }}>{r.avgMs}ms</td>
                  <td style={{ textAlign: 'center' }}>{r.avgTtftMs != null ? `${r.avgTtftMs}ms` : '—'}</td>
                  <td style={{ textAlign: 'center' }}>{fmtTokens(r.tokens)}</td>
                  <td style={{ textAlign: 'center' }}>{r.cacheHitRate != null ? `${Math.round(r.cacheHitRate * 100)}%` : '—'}</td>
                  <td style={{ textAlign: 'center' }}>
                    {r.cost != null ? `${r.cost} ${r.currency || ''}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row-end" style={{ marginTop: 8 }}>
            <button className="btn small" onClick={async () => { await clearMetrics(); setPerf([]) }}>清空记录</button>
          </div>
        </div>
      ) : (
        <p className="muted small">暂无调用记录（对话 / 提取 / 摘要每次调用都会记一笔，用于对比各家表现）。</p>
      )}

      {/* 厂商编辑弹层 */}
      {editing && (
        <div className="modal-mask" onClick={() => { setEditing(null); setTest(null) }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{isBuiltin(editing.id) ? `编辑：${editing.displayName}` : '自定义厂商'}</h3>
            <div className="field-grid">
              <label>名称
                <input className="input" value={editing.displayName} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} />
              </label>
              <label>协议
                <select className="input" value={editing.adapter} onChange={(e) => setEditing({ ...editing, adapter: e.target.value })}>
                  <option value="openai">OpenAI 兼容（绝大多数服务）</option>
                  <option value="anthropic">Anthropic（Claude）</option>
                </select>
              </label>
              <label className="span2">接口地址
                <input className="input" value={editing.endpoint} onChange={(e) => setEditing({ ...editing, endpoint: e.target.value })} placeholder="https://…/v1" />
              </label>
              <label className="span2">API Key{editing.noKey ? '（本机服务无需填写）' : ''}
                <input className="input" type="password" value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder="sk-…" />
              </label>
              <label className="span2">模型列表（每行一个）
                <textarea
                  className="input" rows={4}
                  value={Array.isArray(editing.models) ? editing.models.join('\n') : ''}
                  onChange={(e) => setEditing({ ...editing, models: parseModels(e.target.value) })}
                />
              </label>
              <label>默认模型
                <select className="input" value={editing.defaultModel} onChange={(e) => setEditing({ ...editing, defaultModel: e.target.value })}>
                  <option value="">（列表第一个）</option>
                  {(editing.models || []).map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label>上下文窗口（token）
                <input className="input" type="number" value={editing.context} onChange={(e) => setEditing({ ...editing, context: Number(e.target.value) || 32768 })} />
              </label>
              <label>价格（元 / 百万输入 token）
                <input className="input" type="number" value={editing.pricing?.inputPerMTok ?? ''} placeholder="留空 = 不估算"
                  onChange={(e) => setEditing({ ...editing, pricing: e.target.value === '' ? null : { ...(editing.pricing || { currency: 'CNY', outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }), inputPerMTok: Number(e.target.value) || 0 } })} />
              </label>
              <label>价格（元 / 百万输出 token）
                <input className="input" type="number" value={editing.pricing?.outputPerMTok ?? ''} placeholder="留空 = 不估算"
                  onChange={(e) => setEditing({ ...editing, pricing: e.target.value === '' ? null : { ...(editing.pricing || { currency: 'CNY', inputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 }), outputPerMTok: Number(e.target.value) || 0 } })} />
              </label>
              <label className="span2" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={!!editing.noKey} onChange={(e) => setEditing({ ...editing, noKey: e.target.checked })} />
                本机服务，无需 API Key（如 Ollama / LM Studio）
              </label>
              {!editing.browserSafe && (
                <p className="span2 small err-text">⚠️ 该服务默认不允许浏览器直连（CORS）。若测试失败，需自建代理转发，或选择支持直连的服务。</p>
              )}
            </div>

            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn" disabled={testing || (!editing.apiKey && !editing.noKey)} onClick={() => testConnection(editing)}>
                {testing ? '测试中…' : '测试连接'}
              </button>
              {test && (
                <span className={`small ${test.ok ? 'ok-text' : 'err-text'}`}>
                  {test.ok ? '✓ ' : ''}{test.text}{test.ok && test.ids ? `：${test.ids.slice(0, 8).join('、')}${test.ids.length > 8 ? '…' : ''}` : ''}
                </span>
              )}
            </div>

            <div className="row-end" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => { setEditing(null); setTest(null) }}>取消</button>
              <button className="btn primary" onClick={() => saveProvider(editing)}>保存</button>
            </div>
            {!isBuiltin(editing.id) && (
              <div className="row-end" style={{ marginTop: 4 }}>
                <button className="btn small danger-text" onClick={() => removeProvider(editing.id)}>删除该厂商</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
