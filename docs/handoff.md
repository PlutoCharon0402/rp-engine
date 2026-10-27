# RP Engine · 智能体接手 / 续开发交接文档

> 用途：把项目交给另一个 AI 智能体继续开发。读完本文件应能在 30 分钟内理解架构、跑起测试、构建 APK，并**避开前任踩过的坑**。
> 配套细文档：`docs/alpha-feedback.md`（问题追踪 + 决策日志）、`docs/card-spec.md`（角色卡规范）、`docs/multi-provider-design.md`（多厂商设计）、`docs/alpha-release.md`（发布说明）。

---

## 1. 这是什么

**RP Engine** = 一个**本地优先的角色扮演 AI 聊天应用**（Android，Capacitor 封装的 Web 应用）。

- 用户导入角色卡，与 AI 进行沉浸式 RP 对话；用户可像「导演」一样对扮演者下执导指令（文风、剧情走向等）。
- **无后端**：纯前端 + IndexedDB 本地存储，用户自己填模型 API Key，浏览器/WebView 直连模型厂商。
- 当前阶段：**Android alpha 内测**（alpha.14），分支 `feat/android-alpha`。
- 版本号 `0.5.0-alpha.14`（package.json 仍是 `0.5.0`，versionName 在 gradle 里带 alpha 后缀）。

**技术栈**（已核对 `package.json`）：
- Capacitor 8 + React 18 + Vite 5 + Dexie 4（IndexedDB）
- 测试：Vitest 2（`npm run test` = `vitest run`）
- `"type": "module"`，`node >= 18.18`
- 依赖极简：react / react-dom / dexie / capacitor-*，**没有**状态管理库、没有 UI 框架（纯手写 CSS + className）。

---

## 2. 仓库与目录结构（重点文件）

```
rp-engine/
├── src/
│   ├── App.jsx                 # 根组件：路由（会话/角色/世界书/设置）、返回键
│   ├── main.jsx / index.css    # 入口 + 全局样式（深色金主题，类名驱动）
│   ├── components/
│   │   └── Dropdown.jsx        # 自定义下拉（替代原生 <select>，主题统一）
│   ├── views/
│   │   ├── ChatView.jsx        # ★核心：对话流、生成、导演弹层、⚙参数、诊断卡
│   │   ├── SessionsView.jsx    # 会话列表（创建/导入/删除/导出）
│   │   ├── CharView.jsx        # 角色卡管理
│   │   ├── LoreView.jsx        # 世界书
│   │   ├── ModelSettings.jsx   # 厂商/模型配置（全局）
│   │   ├── SettingsView.jsx    # 设置 + 页脚版本号
│   │   └── StateView.jsx       # 世界状态（角色位置/情绪/事实/事件/关系）
│   └── lib/
│       ├── compiler.js         # ★核心：compileMessages() 拼装最终 prompt
│       ├── api.js              # makeApi() → stream() 流式封装（onUsage/onFinish）
│       ├── db.js               # Dexie 表结构（sessions/messages/tasks/lore/backups）
│       ├── providers/
│       │   ├── registry.js     # migrateSettings()：旧 endpoint 字段→providers 包装
│       │   ├── router.js       # routeChain/pickModel/planTargets：多厂商路由+降级
│       │   ├── client.js       # ChatClient：stream/重试/熔断(fallback)/指标
│       │   ├── resilience.js   # 熔断器
│       │   ├── metrics.js / errors.js / types.js
│       │   └── adapters/
│       │       ├── openaiCompat.js   # OpenAI 兼容（DeepSeek/Qwen/GLM…）
│       │       └── anthropic.js       # Claude
│       ├── extractor.js        # 世界状态提取（批次7）：从回复抽 JSON
│       ├── summarize.js        # 早期剧情摘要
│       ├── lore.js / cardImport.js / cardRef.js
│       ├── sessionIO.js        # 会话导入/导出（备份互转）
│       ├── backup.js           # 自动快照
│       ├── backRouter.js       # ★返回键消费栈（LIFO）
│       └── util.js             # DEFAULT_SETTINGS / APP_VERSION / 工具
├── android/                    # Capacitor 原生壳（gradle 构建）
│   ├── app/build.gradle        # versionCode / versionName（发布必改）
│   ├── rpengine-alpha.keystore # 签名（gitignored，绝不可丢）
│   └── keystore.properties    # 签名密码（gitignored）
├── test-cards/shenyan.chara.json   # 测试用角色卡（compileCard.test.js 依赖）
└── docs/                       # 本文 + alpha-feedback / card-spec / multi-provider-design / alpha-release
```

**最常改动的 3 个文件**：`src/lib/compiler.js`（prompt 逻辑）、`src/views/ChatView.jsx`（交互/UI）、`src/lib/providers/*`（模型调用）。

---

## 3. 架构速览

### 3.1 一次生成的完整数据流
```
用户发消息 → ChatView.streamReply(history)
  → compileMessages(card, lore, state, history, settings, summary, hints, director, tailUser)
        ⤷ 产出 messages[]：
          [0] system: 角色卡 + 常驻世界书
          → 全部历史（可缓存前缀）
          → system: 状态 + 触发世界书 + 早期摘要 + 事件钩子 + 导演指令(动态块)
          → 最近 depth 条消息
          → user: 续写指令(tailUser，可选)
          → 最后一条消息后缀：导演指令最终提醒
  → makeApi(eff).stream(compiled, { onUsage, onFinish })
        ⤷ providers/router → client → adapter(OpenAI/Anthropic) → 厂商 API（SSE 流式）
        ⤷ 事件：delta / usage / finish(reason)
  → 累加到 assistant 消息 → 落库(db.messages) → 触发 extractor 写世界状态
```

### 3.2 三个子系统
- **compiler（prompt 组装）**：纯函数，无副作用，是「导演指令是否进 prompt」这类 bug 的天然本地可测点（见 §5）。
- **providers（模型调用）**：registry 存厂商配置；router 负责主备降级（主厂商失败自动切备用）；client 负责重试+熔断；adapter 把厂商响应归一为 `{delta, usage, finish}`。
- **persistence（Dexie）**：sessions / messages / tasks / lore / backups。会话级覆盖参数 `session.params`、导演指令 `session.director` 都挂在这里。

### 3.3 关键数据约定
- `session.director = { enabled: true, notes: [{ id, text, createdAt }] }` —— 导演指令（C8）。注入在编译期，不污染对话历史。
- `compileMessages` 当前签名（alpha.14）：
  `compileMessages(card, lore, state, history, settings, summary, hints, director, tailUser)`
- 会话级参数覆盖全局：`effectiveSettings(settings, session.params)` —— `params` 里**空值**表示跟随全局（不是 0/null 覆盖）。

---

## 4. 构建与运行

```bash
npm install

npm run dev        # Web 开发服务器（HMR）；浏览器直连模型需厂商支持 CORS
npm run test       # Vitest 跑全部单测（纯前端，无需 Key/设备）
npm run build      # 仅 Vite 产物

# 出 Android APK（一条命令）：vite build → cap sync → gradlew assembleRelease
npm run apk
# 产物：android/app/build/outputs/apk/release/app-release.apk
```

**版本号规则**（发布前必改 `android/app/build.gradle`）：
- `versionName` 跟随语义 + alpha 后缀，如 `0.5.0-alpha.15`
- `versionCode` **每次 +1**（当前 14）。忘了递增 → Android 拒绝覆盖安装。

**签名**（已在 `alpha-release.md` 详述）：
- `android/rpengine-alpha.keystore` + `android/keystore.properties` 均 gitignored。
- **keystore 丢失 = 旧 APK 无法覆盖安装（只能卸载重装，丢数据）**，务必备份。

**安装到手机**：传 APK → 允许未知来源安装 → 覆盖安装保留 IndexedDB 数据与 localStorage 的 Key（卸载才清零）。

**环境依赖**：JDK 21（Capacitor 8 工程要求）、Android SDK (platform-36，见 `android/variables.gradle`)、Gradle 8.14.3（gradlew 自动下载）。

> ⚠️ **git push 注意**：本开发环境曾出现 SSH 连 GitHub 被网络层中断（`Connection closed by UNKNOWN port 65535`）。本地 `git commit` 正常；若 `git push` 失败，请确认环境出网或手动推送。

---

## 5. ⚠️ 接手必读：避坑铁律（前任踩了 6 个构建才总结出）

这些是从 `alpha.8→alpha.14`「导演指令不生效」复盘得来的，**违反任一条都会重蹈覆辙**：

### 5.1 真实测试档案（每次修复只对此验证）
- 用户实跑 **`flash` / `pro` 档**（**不是 chat**）。**禁止在 chat 上验证后宣称「已修」**——档位不同，遵循度/截断行为完全不同。
- `pro` 档开推理，`max_tokens` **含思维链** → 默认上限（1024）偏低易截断；pro 建议 ≥4096。
- 截断信号：`finish_reason='length'` 时回复尾部丢失（探针常驻位置）——已透传到 UI 横幅提示。
- 版本核对：设置页页脚显示 `APP_VERSION`，报问题前先核对装机版本。

### 5.2 诊断优先于猜测
- **⚙ 弹层最下方「🔍 诊断」卡**：展示上一回合实际发送的完整 prompt（消息列表 + 角色 + 顺序），并标注 `✓/✗ 导演指令已注入`，可一键复制。
- **遇到「某功能不生效」类 bug，第一动作是看诊断卡 / 写本地断言，不是猜原因改代码。**

### 5.3 决策日志（试过什么 / 排除了什么）
导演指令弧的已知结论（已在 `alpha-feedback.md §6.2`）：
- alpha.8 注入静态前缀 → 被长卡设定稀释（弱模型对前缀注意力低）→ 否
- alpha.12 移动态块末尾 + 立即保存 + 返回键消费栈 → 解决保存/注入链路，但档位错配掩盖成效
- alpha.13 发现 `finish_reason` 在 client 被静默丢弃（截断无信号）+ flash 需绝对末尾 → 透传 finish + 末尾 system 提醒
- alpha.14 末尾独立 system 被推理模型 chat 模板丢弃 → 改**末尾消息后缀**；补诊断卡
- 根因 = 档位错配 + 截断无信号 + 末尾 system 被丢。**诊断卡本该 alpha.8 就该有。**

### 5.4 探针 / 验收信号规范
- **命令式**，不写条件句（「如果…就…」弱模型判断不了前提 → 假阴性）。
- **可机械判定**（输出固定串如 `325`，肉眼/脚本可验）。
- 放在模型注意力最高的位置（prompt **绝对末尾**）。
- 已有本地回归守护：`tests/compileCard.test.js` C4「回归守护：探针类指令…同时出现在动态块与 prompt 绝对末尾」。

### 5.5 下次同类「某功能不生效」4 问（动手前自检）
1. 我验证的模型/配置，**等于**用户真实跑的吗？
2. 有没有一条**本地断言**能立刻判定「功能进没进 prompt / 进逻辑」？
3. 这 bug **必须上真机**，还是纯逻辑本地能拦？
4. 探针是否命令式、可机械判定？

### 5.6 授权边界
默认「诊断 + 方案」，用户说「开始」才动代码。

---

## 6. 当前进度（alpha.14 已完成）

| 模块 | 状态 |
|---|---|
| 边缘到边缘适配（状态栏/手势条避让） | ✅ alpha.5（MainActivity 原生直写） |
| 模型列表同步（测试连接后写回 models） | ✅ alpha.6 |
| 世界书 `keys` 数组崩溃防御 | ✅ alpha.7 |
| 自定义下拉替代原生 select（深色金主题） | ✅ alpha.8 |
| 导演指令（C8）：注入/启停/宏/立即保存/返回键消费 | ✅ alpha.8~14 |
| 多厂商路由 + 主备降级 + 重试/熔断 | ✅ providers/* |
| finish_reason 透传 + 截断提示 | ✅ alpha.13 |
| prompt 末尾导演提醒（后缀式，兼容推理模型） | ✅ alpha.14 |
| ⚙ 诊断卡（看实际 prompt） | ✅ alpha.14 |
| 应用内版本号显示 | ✅ alpha.14 |
| PM 规范文档 + 本地回归守护 | ✅ 本批 |

---

## 7. 已知问题 / Backlog（详见 `alpha-feedback.md`）

**体验问题 A1–A4**：edge-to-edge（已修待验）、UI 对齐、模型列表同步（已修）、世界书崩溃（已修）。

**改进建议 B1–B6**：边缘避让背景一致(B1)、外部数据全面防御(B2)、连接覆盖/合并选择(B3)、孤儿回合丢弃选项(B4)、移动端诊断信息(B5)、UI 一致性已做(B6)。

**后续想法 C1–C8**：
- C1 角色卡规范文档 ✅；C2 角色卡独立导出；C3 事件钩子/时间线分支（web 已做，待移动端验收）；C4 状态栏颜色联动；C5 移动端交互（下拉刷新/手势返回/通知）；C6 多模态；C7 合并 main + 发布流程；**C8 导演指令（已交付，见 §5）**。

**待决策 D1–D4**：edge-to-edge 仍无效是否允许 adb logcat；修复验收结果；合并 main 时机；外部数据防御是否独立排期。

**★ 建议的下一个小任务**：`alpha-feedback.md §6.3` 提到的 **app 内置「导演遵循自检」按钮**——一键发探针并自动判定 `325` 是否出现，把验收从「用户手动看」变成「按钮点一下」。纯前端 + 现有流式链路，风险低。

---

## 8. 关键文件索引（按改动频率）

| 想改什么 | 改哪 |
|---|---|
| prompt 拼装 / 导演指令注入位置 | `src/lib/compiler.js` |
| 对话交互 / 导演弹层 / 诊断卡 / ⚙参数 | `src/views/ChatView.jsx` |
| 模型调用 / 路由 / 重试 / 熔断 | `src/lib/providers/*` |
| 流式封装 / usage/finish 回调 | `src/lib/api.js` |
| 厂商配置默认值 | `src/lib/util.js`（DEFAULT_SETTINGS） |
| 全局样式主题 | `src/index.css` |
| 会话/消息/世界状态数据模型 | `src/lib/db.js` + `src/views/*` |
| 测试（prompt 逻辑） | `tests/compileCard.test.js`（依赖 `test-cards/shenyan.chara.json`） |
| 发布版本号 | `android/app/build.gradle` |

---

## 9. 给接手智能体的最后忠告

1. **先在 `npm run test` 全绿的状态下工作**；改 compiler/providers 后务必跑测试，不要靠「装 APK 到手机用真实 Key 测」来验收纯逻辑。
2. **改任何影响 prompt 的东西，先看 ⚙ 诊断卡确认实际发出去的内容**，再判断是否生效。
3. **验证环境用 flash/pro，不是 chat。** 这是前任最大的教训。
4. **每解决一个问题，顺手更新 `alpha-feedback.md` 的决策日志**（§6.2）——下一个接手的会感谢你。
5. **别动 keystore / keystore.properties**，且确保每次构建 `versionCode +1`。
6. 文档与测试改动**不升版本号、不出 APK**；只有运行时行为变化才需要 alpha.N + APK。
