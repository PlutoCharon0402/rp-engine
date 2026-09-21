const CACHE = 'rp-engine-v2'
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
