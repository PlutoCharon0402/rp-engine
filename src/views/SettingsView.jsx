import { useEffect, useRef, useState } from 'react'
import { db } from '../lib/db'
import { fmtTime, APP_VERSION } from '../lib/util'
import { validateDump, importDump, buildDump, downloadDump, countDump, snapshotBackup, listBackups, restoreBackup } from '../lib/backup'
import ModelSettings from './ModelSettings'
import { EXTRACTOR_SYS } from '../lib/extractor'

export default function SettingsView({ settings, onChange, onDataImported }) {
  const fileRef = useRef(null)
  const [msg, setMsg] = useState(null)  // { ok, text }：必须区分成功/失败，否则错误永远是蓝色 info 横幅
  const [importing, setImporting] = useState(false) // 导入中：防连点重复清库
  const [failedCount, setFailedCount] = useState(0) // failed 提取任务数（T2-2 自愈入口）
  const [retrying, setRetrying] = useState(false)
  const [backups, setBackups] = useState([])       // 自动快照清单
  const [snapping, setSnapping] = useState(false)
  const [restoring, setRestoring] = useState(null) // 正在恢复的快照 id

  const refreshBackups = async () => {
    try { setBackups(await listBackups()) } catch { /* 库未就绪 / 老版本库无此表时静默 */ }
  }

  // 进入设置页时查一次失败任务数与快照列表
  useEffect(() => {
    (async () => {
      try { setFailedCount(await db.tasks.where('status').equals('failed').count()) } catch { /* 库未就绪时静默 */ }
    })()
    refreshBackups()
  }, [])

  /** T2-2 failed 任务自愈入口：重置为 pending 并清零 attempts，用户回到对话页后自动补跑 */
  async function retryFailedTasks() {
    if (retrying || !failedCount) return
    setRetrying(true)
    try {
      await db.tasks.where('status').equals('failed')
        .modify((t) => { t.status = 'pending'; t.attempts = 0; t.error = null })
      setMsg({ ok: true, text: `已重置 ${failedCount} 条失败任务。回到「对话」页进入故事后将自动补跑。` })
      setFailedCount(0)
    } catch (e) {
      setMsg({ ok: false, text: `重置失败任务时出错：${e.message}` })
    } finally {
      setRetrying(false)
    }
  }

  function set(k, v) { onChange({ ...settings, [k]: v }) }

  async function exportData() {
    const dump = await buildDump() // 含 tasks：与导入时的清空范围对齐
    downloadDump(dump)
    setMsg({ ok: true, text: `已导出备份文件（共 ${countDump(dump)} 条记录）。` })
  }

  /** 手动创建一张快照 */
  async function takeSnapshot() {
    if (snapping) return
    setSnapping(true)
    try {
      await snapshotBackup('手动快照')
      await refreshBackups()
      setMsg({ ok: true, text: '已创建快照。' })
    } catch (e) {
      setMsg({ ok: false, text: `创建快照失败：${e.message}` })
    } finally {
      setSnapping(false)
    }
  }

  /** 恢复快照：restoreBackup 内部会先给当前数据再拍一张，所以恢复也能反悔 */
  async function restore(id, reason) {
    if (restoring) return
    const ok = confirm(
      `即将用快照「${reason}」覆盖当前全部数据。\n\n` +
      '当前数据会先自动存为一张新快照，之后仍可再恢复回来。\n\n确定继续？'
    )
    if (!ok) return
    setRestoring(id)
    try {
      const { counts } = await restoreBackup(id)
      const done = Object.entries(counts).map(([k, v]) => `${k} ${v} 条`).join('、')
      setMsg({ ok: true, text: `已恢复：${done}` })
      await refreshBackups()
      // 会话 id 已被覆盖替换，清空当前引用，避免写入谁也看不到的鬼影消息
      onDataImported && onDataImported()
    } catch (e) {
      setMsg({ ok: false, text: `恢复失败：${e.message}` })
    } finally {
      setRestoring(null)
    }
  }

  /**
   * 导入备份。顺序必须是：**先校验 → 再告知（文件名 + 条数） → 后破坏 → 单事务 → 报告真实结果**。
   * 任一环节失败都在"数据零改动"的状态下退出。
   */
  async function importData(file) {
    if (importing) return
    setMsg(null)

    let dump
    try {
      dump = JSON.parse(await file.text())
    } catch {
      setMsg({ ok: false, text: '导入已取消：文件不是合法的 JSON' })
      return
    }

    let report
    try {
      report = validateDump(dump)
    } catch (e) {
      // 校验失败 = 一行数据都没动过
      setMsg({ ok: false, text: `导入已取消：${e.message}` })
      return
    }

    const summary = Object.entries(report.counts).map(([k, v]) => `${k} ${v}`).join('、')
    const ok = confirm(
      `即将用「${file.name}」覆盖当前全部数据。\n\n` +
      `将导入：${summary}\n\n` +
      '当前全部数据（角色 / 故事 / 消息 / 世界书 / 提取任务）会被清空，且不可撤销。\n\n' +
      '确定继续？'
    )
    if (!ok) {
      setMsg({ ok: false, text: '已取消导入，数据未改动。' })
      return
    }

    setImporting(true)
    try {
      // 破坏前先拍快照：导入成功后旧数据就被覆盖了，这张快照是唯一的回滚手段。
      // 快照失败 → 直接取消导入：此时清库没有任何兜底，风险不可接受。
      try {
        await snapshotBackup('导入前自动快照')
      } catch (e) {
        setMsg({ ok: false, text: `已取消导入（数据未改动）：自动快照失败 —— ${e.message}。请先手动「导出备份」并确认文件可保存，再重试导入。` })
        return
      }
      const counts = await importDump(dump)
      const done = Object.entries(counts).map(([k, v]) => `${k} ${v} 条`).join('、')
      setMsg({ ok: true, text: `导入完成：${done}。导入前的数据已存为快照，可在下方「自动快照」中恢复。` })
      await refreshBackups()
      // 通知 App 重置当前会话引用，避免 rp.sessionId 指向已不存在的会话（鬼影消息）
      onDataImported && onDataImported()
    } catch (e) {
      setMsg({ ok: false, text: `导入失败，数据已回滚到导入前的状态：${e.message}` })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="view">
      <div className="view-head"><h2>设置</h2></div>

      <ModelSettings settings={settings} onChange={onChange} />

      {/* 批次7：提取提示词自定义——换提示词后可到「状态」页从任意记录点回溯重放 */}
      <h3>状态提取</h3>
      <p className="muted small">
        每回合结束后自动把剧情变化（角色位置 / 情绪 / 事实 / 事件 / 关系）写进世界状态。
        自定义提示词会整体替换内置版本——<b>必须保留「只输出严格 JSON」与格式说明</b>，否则提取会失败并留在队列重试。
        修改后到「状态」页的「提取记录」里点「从此重放」，可用新提示词重跑历史。
      </p>
      <textarea
        className="input mono" rows={6}
        placeholder="留空使用内置提示词"
        value={settings.extractorPrompt || ''}
        onChange={(e) => set('extractorPrompt', e.target.value)}
      />
      {(settings.extractorPrompt || '').trim() && (
        <div className="row">
          <button className="btn small" onClick={() => set('extractorPrompt', '')}>恢复内置提示词</button>
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary className="muted small" style={{ cursor: 'pointer' }}>查看内置提示词</summary>
        <pre className="card small" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{EXTRACTOR_SYS}</pre>
      </details>

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
      {failedCount > 0 && (
        <div className="banner error">
          有 {failedCount} 条状态提取任务失败（通常是 API Key 余额 / 网络问题）。修复后可重试：
          <div className="row-end" style={{ marginTop: 8 }}>
            <button className="btn small" disabled={retrying} onClick={retryFailedTasks}>
              {retrying ? '重置中…' : `重试失败任务（${failedCount} 条）`}
            </button>
          </div>
        </div>
      )}
      <div className="row">
        <button className="btn" disabled={importing} onClick={exportData}>导出备份</button>
        <button className="btn" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? '导入中…' : '导入备份'}</button>
        <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = '' }} />
      </div>
      <h3>自动快照</h3>
      <p className="muted small">导入 / 恢复前会自动把当前整库存一份（最多保留最近 3 张）。导入后若发现导错了，可在这里一键回到导入前。</p>
      <div className="row">
        <button className="btn" disabled={snapping} onClick={takeSnapshot}>{snapping ? '创建中…' : '立即创建快照'}</button>
      </div>
      <div className="list">
        {backups.map((b) => {
          const total = Object.values(b.counts || {}).reduce((n, v) => n + v, 0)
          return (
            <div key={b.id} className="list-row">
              <span className="list-main">
                {b.reason}
                <span className="muted">{fmtTime(b.createdAt)} · 共 {total} 条</span>
              </span>
              <button className="btn small" disabled={restoring !== null} onClick={() => restore(b.id, b.reason)}>
                {restoring === b.id ? '恢复中…' : '恢复'}
              </button>
            </div>
          )
        })}
      </div>
      {!backups.length && <p className="muted small">暂无快照（首次导入备份时会自动创建）。</p>}
      <p className="muted small">所有数据只存在本机浏览器（IndexedDB）。各模型厂商的 API Key 仅存于本机 localStorage，浏览器直连模型服务，不经过任何第三方服务器（不支持直连的服务需自建代理）。换设备前记得导出备份。</p>
      {msg && <div className={`banner ${msg.ok ? 'info' : 'error'}`} onClick={() => setMsg(null)}>{msg.text}</div>}
      <p className="muted small" style={{ textAlign: 'center', marginTop: 24 }}>RP Engine {APP_VERSION}（APK 版本以设置页此处为准，排查问题请先核对）</p>
    </div>
  )
}
