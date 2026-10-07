# RP Engine

状态驱动的角色扮演引擎（PWA）。浏览器直连 DeepSeek API，无后端，数据全部本地存储。

## 核心概念

- **状态驱动，而非日志驱动**：每回合结束后，后台提取器把剧情变化（角色位置/情绪/目标/已知信息、事实、事件）写回结构化世界状态；上下文不再依赖长聊天记录。
- **上下文编译器**：角色卡 + 常驻世界书放在 prompt 静态前缀（命中 DeepSeek 前缀缓存，省延迟省钱）；世界状态 + 触发的世界书条目按「注入深度」插在近期对话之前。
- **世界书**：关键词命中近期对话时按优先级与 token 预算注入；勾选「常驻」则固定注入。
- **retcon**：「状态」页可直接查看/编辑角色状态、事实与事件，也可用 JSON 模式整体改写。
- **提取任务落盘**：状态提取是异步的，且任务队列持久化在 IndexedDB——页面中途关闭，下次打开自动补跑，不会丢状态。

## 使用

1. 「设置」页填入 DeepSeek API Key（platform.deepseek.com 获取）。
2. 「角色」页创建角色卡（含开场白）。
3. 「对话」页新建故事，选角色卡即开始。
4. 对话中每回合结束后，标题栏显示「状态提取中…」，完成后到「状态」页查看变化。

## 本地开发

```bash
npm install
npm run dev      # 开发服务器
npm run build    # 产物在 dist/
npm run preview  # 本地预览构建产物
npm run test     # 单元测试（vitest）
```

### ⚠️ 环境准备：换机器 / 换平台一律重装依赖

`node_modules/` **不可跨机器、跨平台拷贝**（也不要从容器、CI 产物、共享卷里拷出来用）。
npm 对 `@rollup/*`、`@esbuild/*` 这类**平台相关的可选依赖**按「安装时的 host 平台」裁剪，
在 Linux 上装出来的目录拿到 macOS 上会 `MODULE_NOT_FOUND: rollup-darwin-arm64`。

```bash
rm -rf node_modules && npm ci     # 换机器 / 换平台 / 出现 MODULE_NOT_FOUND 时的标准动作
```

`.npmrc` 已开 `engine-strict=true`，Node < 18.18 会直接报错而不是装出残缺依赖树。

## 数据库迁移规则（改 `src/lib/db.js` 前必读）

1. `db.version(1)` **永远不要改**。改了它，存量用户打开会抛 `VersionError` —— 全库不可访问，且没有导出入口。
2. 要新增 / 删除 / 改名**索引**，或新增**表** → 追加 `db.version(n + 1).stores(...)`。
3. 只给记录**新增普通字段**（不用于 `where` / `orderBy`）→ **不需要升版本**，直接写即可，旧代码读取时自动忽略。
   例：`session.cardSnapshot`、`lore[].uid`、`task.attempts` 都是这么加的。
4. `version(n)` 一旦发布就**不可回退**：本地库版本号只增不减，回退代码会抛 `VersionError`。
5. **改了 `db.js` 必须重新构建并整体发布**：Service Worker 的缓存名由 `vite.config.js`
   在构建时注入（`package.json` 版本 + 构建时刻），**不需要手工改 `public/sw.js`**。
   旧 bundle（只声明到 v1）打开已升到 v2 的库会直接崩，所以二者必须同批发布。

## 部署到手机（PWA 安装）

PWA 安装需要 HTTPS，推荐 Cloudflare Pages（免费）：

1. `npm run build`
2. 打开 https://dash.cloudflare.com → Workers & Pages → Create → Pages → **Upload assets**（直接拖入 `dist` 文件夹，无需 Git）
3. 部署完成后用手机浏览器打开站点 → 菜单 →「添加到主屏幕」

（GitHub Pages 也可以：把仓库推上去，Settings → Pages → GitHub Actions → 部署 `dist`。注意仓库需为 public 或配 actions。）

换设备前在「设置 → 导出备份」，新设备「导入备份」。

## 技术说明

- CORS：DeepSeek API 已验证允许浏览器跨域直连（含 Authorization 头），无需代理。接口地址可在设置中改为任何 OpenAI 兼容服务。
- 隐私：API Key 仅存本机 localStorage，所有数据仅存本机 IndexedDB，不经过任何第三方服务器。
- 提取器使用 `response_format: json_object`、temperature 0，输出 diff 后应用到状态库。
- 角色卡与已开始的故事**解耦**：开新故事时把角色卡快照进 `session.cardSnapshot`，
  之后编辑 / 删除原卡都不影响进行中的故事；删除角色卡时也会自动补快照并解引用。
- dev server 下可在 Console 用 `window.__db`（完整的 Dexie 实例）查数据；生产构建下不存在，
  验证请改用原生 IndexedDB。

## 路线图（未实现）

- 世界书语义检索（embedding 触发，替代/叠加关键词）
- 时间线分支与存档点
- 多角色群聊（独立角色 agent）
- 事件钩子（剧情事件触发世界书规则）

**正在测试开发中，上传仓库是为了方便管理。目前一些功能仍在设想，暂不建议使用，谢谢大家！**
