import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

/**
 * 应用版本常量：`package.json` 版本 + 构建时刻（UTC，精确到秒）。
 * 每次构建都不同 → Service Worker 缓存名随之变化 → 新产物必定触发 install/activate。
 * src/ 下通过 `define` 注入；public/sw.js 由下面的插件做同样的替换（见插件注释）。
 */
const APP_VERSION = `${pkg.version}+${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`

/**
 * public/ 目录下的文件由 Vite **原样拷贝**，不参与编译，因此 `define` 对它们无效
 * （这正是"只写 define 就完事"不成立的原因）。本插件在构建写出阶段读取 public/sw.js，
 * 把其中的 __APP_VERSION__ 替换为真实版本号后覆盖 dist/sw.js，实现"缓存名自动递增"。
 *
 * 时序：Vite 在 rollup 写出产物【之前】拷贝 public/（prepareOutDir），
 * 而 writeBundle 属于产物写出阶段，因此这里的覆盖不会被拷贝动作覆盖回去。
 */
function swVersionPlugin() {
  let outDir = path.join(root, 'dist')
  return {
    name: 'rp-engine-sw-version',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    writeBundle() {
      const src = path.join(root, 'public', 'sw.js')
      const dst = path.join(outDir, 'sw.js')
      if (!fs.existsSync(src)) {
        this.warn(`[sw-version] 未找到 ${src}，跳过版本注入`)
        return
      }
      const code = fs.readFileSync(src, 'utf8').replace(/__APP_VERSION__/g, JSON.stringify(APP_VERSION))
      fs.writeFileSync(dst, code)
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), swVersionPlugin()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
})
