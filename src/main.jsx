import React from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import App from './App'
import ErrorBoundary from './ErrorBoundary'
import './index.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* 顶层兜底：渲染异常时至少能把数据导出来，而不是白屏 */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)

// Service Worker 只在浏览器环境注册：
//   - Capacitor（APK）里资源已本地打包，SW 缓存无意义且可能干扰覆盖更新；
//   - 浏览器（PWA 部署）仍需要 SW 做离线与缓存版本管理。
if ('serviceWorker' in navigator && !Capacitor.isNativePlatform()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  })
}
