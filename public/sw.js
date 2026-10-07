// ⚠️ 缓存名不要手工改：版本占位符由 vite.config.js 在构建时注入
// （package.json 版本 + 构建时刻），每次构建都不同，新产物必定触发 install/activate。
// public/ 下的文件不参与 Vite 编译，所以由 swVersionPlugin 在写出阶段替换该占位符。
// dev server 下 sw.js 未经替换，typeof 守卫保证不会 ReferenceError（退化成 'dev' 缓存名）。
const CACHE = 'rp-engine-v' + (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev')
const CORE = ['./', './index.html', './manifest.webmanifest', './icon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))))
  self.clients.claim()
})

async function cacheFirst(req) {
  const hit = await caches.match(req)
  if (hit) return hit
  const res = await fetch(req)
  const copy = res.clone()
  caches.open(CACHE).then((c) => c.put(req, copy))
  return res
}

// 文档（导航）请求：网络优先，保证新部署立即生效；离线时回退缓存，再回退到首页壳
async function navigationFirst(req) {
  try {
    const res = await fetch(req)
    const copy = res.clone()
    caches.open(CACHE).then((c) => c.put(req, copy))
    return res
  } catch {
    const hit = await caches.match(req, { ignoreSearch: true })
    return hit || (await caches.match('./index.html'))
  }
}

// 同源 GET 走 SW；API 请求（跨域）不经过 SW
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (e.request.mode === 'navigate') {
    e.respondWith(navigationFirst(e.request))
  } else {
    e.respondWith(cacheFirst(e.request))
  }
})
