import { useEffect, useState } from 'react'
import { loadSettings, saveSettings } from './lib/util'
import { db } from './lib/db'
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

  useEffect(() => { saveSettings(settings) }, [settings])

  // 应用启动：把上次页面关闭时中断的 running 任务复位为 pending，待会话打开后补跑
  useEffect(() => {
    (async () => {
      try { await db.tasks.filter((t) => t.status === 'running').modify({ status: 'pending' }) } catch {}
    })()
  }, [])

  function selectSession(id) {
    setSessionId(id)
    if (id) localStorage.setItem('rp.sessionId', String(id))
    else localStorage.removeItem('rp.sessionId')
  }

  return (
    <div className="app">
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
        {tab === 'state' && <StateView sessionId={sessionId} version={stateVersion} />}
        {tab === 'lore' && <LoreView sessionId={sessionId} />}
        {tab === 'chars' && <CharView />}
        {tab === 'settings' && <SettingsView settings={settings} onChange={setSettings} />}
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
