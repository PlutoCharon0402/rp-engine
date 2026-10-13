import { useEffect, useRef, useState } from 'react'
import { loadSettings, saveSettings } from './lib/util'
import { db } from './lib/db'
import { processPendingTasks, pendingSessionIds } from './lib/extractor'
import { hasAnyProviderReady } from './lib/providers/registry'
import ChatView from './views/ChatView'
import SessionsView from './views/SessionsView'
import StateView from './views/StateView'
import LoreView from './views/LoreView'
import CharView from './views/CharView'
import SettingsView from './views/SettingsView'

const TABS = [
  { id: 'chat', label: '对话' },
  { id: 'state', label: '状态' },
  { id: 'lore', label: '世界书' },
  { id: 'chars', label: '角色' },
  { id: 'settings', label: '设置' },
]

export default function App() {
  const [settings, setSettings] = useState(loadSettings())
  const [tab, setTab] = useState('chat')
  const [sessionId, setSessionId] = useState(() => {
    const v = localStorage.getItem('rp.sessionId')
    return v ? Number(v) : null
  })
  const [stateVersion, setStateVersion] = useState(0)
  const [catchUp, setCatchUp] = useState(0)   // >0：正在后台补跑状态提取的故事数
  const catchUpStarted = useRef(false)

  useEffect(() => { saveSettings(settings) }, [settings])

  /**
   * 应用启动的全局补跑：
   * 1. 上次关闭时中断的 running 复位为 pending（否则这些任务永远没人领）；
   * 2. 对所有存在 pending 任务的会话跑一轮提取 —— 以前只有打开某个会话（ChatView mount）才补跑，
   *    切走就停，回到会话列表时状态其实是缺的。
   *
   * processPendingTasks 内部有按 sessionId 的 inflight 互斥，与 ChatView 里那次补跑撞车也只会跑一遍。
   * 没配 API Key 时跳过：补跑必然失败，留到用户进入会话时（Key 已填）再触发。
   */
  useEffect(() => {
    if (catchUpStarted.current) return // StrictMode 双跑 / 热更新只跑一次
    catchUpStarted.current = true
    ;(async () => {
      try { await db.tasks.filter((t) => t.status === 'running').modify({ status: 'pending' }) } catch {}
      if (!hasAnyProviderReady(settings)) return
      const pending = await db.tasks.filter((t) => t.status === 'pending').toArray()
      const ids = pendingSessionIds(pending)
      if (!ids.length) return
      setCatchUp(ids.length)
      for (const id of ids) {
        try {
          await processPendingTasks(id, settings, () => setStateVersion((v) => v + 1))
        } catch { /* 单个会话补跑失败不影响其他会话，任务仍是 pending，下次再试 */ }
      }
      setStateVersion((v) => v + 1)
    })().finally(() => setCatchUp(0))
  }, [])

  function selectSession(id) {
    setSessionId(id)
    if (id) localStorage.setItem('rp.sessionId', String(id))
    else localStorage.removeItem('rp.sessionId')
  }

  // 全量导入后：旧会话 id 已随库一起被替换，rp.sessionId 必然悬空 → 清空并回到会话列表，
  // 否则发消息会写入谁也看不到的鬼影消息（P0-1 场景 C）
  function handleDataImported() {
    localStorage.removeItem('rp.sessionId')
    setSessionId(null)
    setTab('chat')
    setStateVersion((v) => v + 1)
  }

  return (
    <div className="app">
      {catchUp > 0 && (
        <div className="banner info">正在补跑 {catchUp} 个故事的状态提取…</div>
      )}
      <main>
        {tab === 'chat' && (sessionId
          ? <ChatView
              key={sessionId}
              sessionId={sessionId}
              settings={settings}
              onExit={() => selectSession(null)}
              onSessionUpdate={() => setStateVersion((v) => v + 1)}
              onGoSettings={() => setTab('settings')}
            />
          : <SessionsView onSelect={selectSession} onGoChars={() => setTab('chars')} />)}
        {tab === 'state' && <StateView sessionId={sessionId} version={stateVersion} settings={settings} />}
        {tab === 'lore' && <LoreView sessionId={sessionId} />}
        {tab === 'chars' && <CharView />}
        {tab === 'settings' && <SettingsView settings={settings} onChange={setSettings} onDataImported={handleDataImported} />}
      </main>
      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
