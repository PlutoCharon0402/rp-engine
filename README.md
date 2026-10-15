# RP Engine

状态驱动的角色扮演引擎（PWA）。浏览器直连多家 AI 模型服务（DeepSeek / OpenAI / Kimi / 通义 / Claude / OpenRouter / 本地 Ollama…），无后端，数据全部本地存储。

## 核心概念

- **状态驱动，而非日志驱动**：每回合结束后，后台提取器把剧情变化（角色位置/情绪/目标/已知信息、事实、事件）写回结构化世界状态；上下文不再依赖长聊天记录。
- **上下文编译器**：角色卡 + 常驻世界书放在 prompt 静态前缀（命中 DeepSeek 前缀缓存，省延迟省钱）；世界状态 + 触发的世界书条目按「注入深度」插在近期对话之前。历史按「条数上限 + 当前模型上下文窗口」双重裁剪——小窗口不超窗，大窗口不多带。
- **世界书**：关键词命中近期对话时按优先级与 token 预算注入；勾选「常驻」则固定注入。支持搜索，并可单独导出/导入条目包（追加或替换）。
- **retcon**：「状态」页可直接查看/编辑角色状态、人物关系、事实与事件，也可用 JSON 模式整体改写。
- **用量可见**：对话页标题栏与会话列表显示每个故事累计消耗的 tokens 与前缀缓存命中率。
- **提取任务落盘**：状态提取是异步的，且任务队列持久化在 IndexedDB——页面中途关闭，下次打开自动补跑，不会丢状态。应用启动时会全局补跑所有待提取的会话，不再需要逐个点开故事。
- **提取可审计与回溯**：每次提取前保存状态快照（最近 20 次），「状态」页可一键撤销某次提取，或修改提取提示词 / 更换模型后从任意记录点重放之后的剧情。提取提示词可在「设置」页自定义。
- **事件钩子**：世界书页「事件规则」——本轮剧情**新发生的变化**（角色到达某地 / 获得物品 / 事实、事件关键词 / 关系建立）命中条件时，自动解锁本故事的世界书条目（剧情揭示）、注入一次性剧情提示（下一回合生效一次）。触发记录可在「状态」页查看。
- **时间线分支与存档**：消息菜单「从此分支」从任意消息另开走向（旧分支进入暗线，随时可切回）；「⚙ → 时间线与存档」可保存存档点（消息位置 + 世界状态快照），恢复后从该点写成完全不同的故事。
- **自动快照**：导入 / 恢复备份前自动把当前整库存一份（保留最近 3 张），「设置」页可一键回到导入前。
- **滚动摘要**：历史超过窗口（默认 40 条）后，窗口外的早期对话会被折叠成一段摘要塞回 prompt，不再"第 41 条一进来、第 1 条凭空消失"。摘要与本故事参数都可在对话页标题栏「⚙」里查看/清除。
- **本故事参数**：每个故事可单独覆盖模型厂商 / 模型 / 温度 / 长度 / 注入深度 / 历史条数 / 世界书预算，留空即跟随全局。
- **多模型支持**：内置 DeepSeek / OpenAI / Kimi / 通义 / Claude / OpenRouter / Ollama（本机）等预设，也可添加任何 OpenAI 兼容或 Anthropic 协议的自定义服务。对话 / 状态提取 / 剧情摘要可各走一家；主厂商故障时按「故障转移」勾选自动换备用；每次调用记录延迟 / 成功率 / token / 估算成本，可在设置页对比各家表现。架构详见 `docs/multi-provider-design.md`。

## 使用

1. 「设置」页 →「AI 模型」：给默认厂商填 API Key（如 DeepSeek，platform.deepseek.com 获取），可按需添加 / 启用其他厂商与本地服务。
2. 「角色」页创建角色卡（含开场白）。
3. 「对话」页新建故事，选角色卡即开始。
4. 对话中每回合结束后，标题栏显示「状态提取中…」，完成后到「状态」页查看变化。生成过程中标题栏出现「停止」，中断后已生成的部分会保留（该回合不做状态提取）。

## 本地开发

```bash
npm install
npm run dev      # 开发服务器
npm run build    # 产物在 dist/
npm run preview  # 本地预览构建产物
npm run test     # 单元测试（vitest）：编译器 / 提取器 / 世界书 / 会话 IO / API 客户端 / 备份快照
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
   例：`session.cardSnapshot`、`lore[].uid`、`task.attempts`、`message.partial` 都是这么加的。
   ⚠️ 例外：**新增表**必须升版本。v3 为 `backups` 表（导入前自动快照）、v4 为 `metrics` 表（多模型性能记录）、v5 为 `rules` 表（事件规则）+ `messages.parentId` 索引（时间线分支）所加。
   `backups` 与 `metrics` 都**不在** `CLEAR_TABLES` 里 —— 导入清空时它们必须活下来（快照与历史表现不该被导入抹掉）；`rules` 与 lore 同为用户数据，**随全量备份导出与清空**。
4. `version(n)` 一旦发布就**不可回退**：本地库版本号只增不减，回退代码会抛 `VersionError`。
5. **改了 `db.js` 必须重新构建并整体发布**：Service Worker 的缓存名由 `vite.config.js`
   在构建时注入（`package.json` 版本 + 构建时刻），**不需要手工改 `public/sw.js`**。
   旧 bundle（只声明到 v1）打开已升到 v2 的库会直接崩，所以二者必须同批发布。

## 部署到手机

### 方式一：Android APK（推荐，离线可用）

```bash
npm run apk    # 产物：android/app/build/outputs/apk/release/app-release.apk
```

Capacitor 封装，数据存设备本地 IndexedDB，API Key 存 localStorage。首次构建前需
JDK 17+ 与 Android SDK（命令行安装即可，无需 Android Studio）；签名与版本号规则见
`docs/alpha-release.md`。**更新请覆盖安装（数据保留），不要卸载重装（数据清零）**。

### 方式二：PWA 安装（需 HTTPS）

1. `npm run build`
2. 打开 https://dash.cloudflare.com → Workers & Pages → Create → Pages → **Upload assets**（直接拖入 `dist` 文件夹，无需 Git）
3. 部署完成后用手机浏览器打开站点 → 菜单 →「添加到主屏幕」

（GitHub Pages 也可以：把仓库推上去，Settings → Pages → GitHub Actions → 部署 `dist`。注意仓库需为 public 或配 actions。）

换设备前在「设置 → 导出备份」，新设备「导入备份」。

## 技术说明

- CORS：DeepSeek / OpenAI / Kimi / OpenRouter / Anthropic 均支持浏览器跨域直连；通义（DashScope 兼容模式）等不支持的服务需自建代理（设置页的厂商编辑里会提示）。多模型统一入口、路由与降级见 `src/lib/providers/`（设计文档 `docs/multi-provider-design.md`）。
- 隐私：API Key 仅存本机 localStorage，所有数据仅存本机 IndexedDB，不经过任何第三方服务器。
- 提取器使用 `response_format: json_object`、temperature 0，输出 diff 后应用到状态库。
- 崩溃兜底：顶层错误边界捕获渲染异常，崩溃界面上仍可直接「导出备份」，不会出现"数据还在但取不出来"的白屏。
- 角色卡与已开始的故事**解耦**：开新故事时把角色卡快照进 `session.cardSnapshot`，
  之后编辑 / 删除原卡都不影响进行中的故事；删除角色卡时也会自动补快照并解引用。
- dev server 下可在 Console 用 `window.__db`（完整的 Dexie 实例）查数据；生产构建下不存在，
  验证请改用原生 IndexedDB。

## 路线图（未实现）

- 世界书语义检索（embedding 触发，替代/叠加关键词）
- 多角色群聊（独立角色 agent）

已完成：事件钩子（剧情事件触发世界书规则）、时间线分支与存档点、多模型支持、
提取审计与回溯、消息级编辑、滚动摘要、自动快照等——详见提交历史与上文功能说明。

> 版本状态：**Alpha（0.5.0）**。核心功能可日常使用；多角色群聊与世界书语义检索尚未实现。
> 数据全部本地存储，升级 / 迁移前请先「设置 → 导出备份」。
