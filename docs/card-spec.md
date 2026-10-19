# RP Engine 角色卡规范

> 版本：对应 RP Engine v0.5.0 · 权威实现：`src/lib/cardImport.js`（导入）、`src/views/CharView.jsx`（编辑）、`src/lib/compiler.js`（编译消费）、`src/lib/cardRef.js`（快照）、`src/lib/sessionIO.js`（会话导出）
>
> 本文是**数据规范文档**，供开发者对照实现与校验。

---

## 1. 支持的文件格式与扩展名

| 入口 | 扩展名 / 判定 | 内容形式 | 说明 |
|---|---|---|---|
| 酒馆卡导入 | `.json`（按 JSON 解析） | V1 / V2 / V3 JSON | 「角色」页「导入酒馆卡」 |
| 酒馆卡导入 | `.png`（MIME `image/png` 或后缀） | PNG `tEXt` 数据块，关键字 `chara` 或 `ccv3`，值为 **Base64 编码 JSON**（个别工具存明文，两种都兼容：先按明文 JSON 解析，失败回退 Base64） | 同上 |
| 全量备份导入 | `.json` | `{ characters: [...], ... }` | 角色卡随整库走（`characters` 数组即 §2 内部格式） |
| 会话导出导入 | `.json` | `{ app: 'rp-engine', type: 'session', card: {...} }` | 卡以快照形式内嵌，见 §6.3 |

**RP Engine 没有独立的角色卡导出格式**：卡数据仅通过 ① 全量备份、② 会话导出内嵌的 `card` 字段携带，两者均为内部格式（§2）。

---

## 2. 内部数据模型（`characters` 表记录）

RP Engine 存储、编辑、编译消费的**权威格式**。除 `name` 外全部字段可省，旧记录缺失时读侧兜底。

| 字段 | 类型 | 必填 | 默认值 | 用途 |
|---|---|---|---|---|
| `id` | `number` | 自动 | Dexie `++id` 自增主键（`name` 建有索引） | 主键；会话经 `characterId` 引用 |
| `name` | `string` | **必填** | 无 | 导入缺 `name` 拒绝整个文件；编辑保存时空名被拦。角色名 = `{{char}}` 宏替换值；开故事时自动创建同名世界状态角色 |
| `description` | `string` | 可选 | `''` | 外貌与背景 → prompt 静态前缀「## 你扮演的角色」 |
| `personality` | `string` | 可选 | `''` | 性格与说话方式 → 同上前缀 |
| `scenario` | `string` | 可选 | `''` | 世界观与场景。**有值才**注入「## 世界观与当前场景」段 |
| `firstMessage` | `string` | 可选 | `''` | 开场白。新建故事时宏替换后作为**第一条 assistant 消息**落库（turn 1） |
| `styleExamples` | `string` | 可选 | `''` | 文风示例，多段以 `———` 分隔。**有值才**注入「## 文风示例」段 |
| `userPersona` | `string` | 可选 | `''` | 用户扮演谁。**有值才**注入「## 用户扮演的角色」段 |
| `alternateGreetings` | `string[]` | 可选 | `[]` | 备选开场白。开故事的选择列表 = `[firstMessage, ...alternateGreetings]` |
| `embeddedLore` | `LoreEntry[]` | 可选 | `[]` | 角色专属世界书，新建故事时**一次性拷贝**进 `session.lore`（§5） |

## 3. 嵌入世界书条目 `LoreEntry`

`embeddedLore` 数组元素（与全局 `lore` 表、会话 `session.lore` 同构）：

| 字段 | 类型 | 必填 | 默认值 | 用途 |
|---|---|---|---|---|
| `keys` | `string` | 可选 | `''` | 触发关键词，**中英文逗号均可分隔**，任一命中近期对话即注入（按优先级与 token 预算裁剪）。`constant: true` 时无意义 |
| `content` | `string` | **实质必填** | `''` | 条目正文；导入时 trim 后为空的条目被**直接过滤**。支持宏 |
| `priority` | `number` | 可选 | `0` | 注入优先级，**高者优先**；预算耗尽后低优先级条目被跳过 |
| `constant` | `boolean` | 可选 | `false` | 常驻注入：每回合固定注入（进静态前缀，利于缓存），忽略 `keys` |
| `enabled` | `boolean` | 可选 | `true` | 停用条目不注入不触发；事件规则可按 `uid` 把它解锁（置 `true`） |
| `uid` | `string` | 仅会话内 | — | 条目唯一身份。**卡上的 `embeddedLore` 无 uid**，拷入会话时由 `normalizeLore` 补齐（会话内条目缺 uid 时打开页面即读时自愈补齐） |

## 4. 宏系统

| 宏 | 替换为 | 适用字段 |
|---|---|---|
| `{{char}}`（大小写不敏感，含 `{{CHAR}}` 等） | `card.name`，无卡时兜底「角色」 | `description`、`personality`、`scenario`、`styleExamples`、`userPersona`、`firstMessage`、`alternateGreetings`、lore `content` |
| `{{user}}`（大小写不敏感） | 固定文本「你」 | 同上 |

替换时机：① 开场白在**落库时**完成替换（库内消息已是成品）；② 其余字段在**每次编译 prompt 时**替换（编辑卡后下一回合生效）。

## 5. 生命周期与字段流转

```
酒馆卡（.json / .png）
   │ parseCardFile：字段映射 + mes_example 转译 + 内嵌世界书提取 + 导入勾选
   ▼
characters 表记录（§2 权威格式）
   │ 新建故事（一次性拷贝，此后与原卡解耦）
   ├─→ session.cardSnapshot   仅 6 个纯文本字段：name / description / personality /
   │                            scenario / userPersona / styleExamples
   ├─→ session.lore           normalizeLore(embeddedLore)：拷贝 + 补 uid
   └─→ messages[0]            所选开场白（宏替换后落库，turn 1）
```

**快照不含** `firstMessage` / `alternateGreetings`（开场白已落库为消息）、`embeddedLore`（已拷为会话世界书）。原卡缺失时读侧回退快照；删除原卡时自动补快照并解引用（`characterId → null`），故事不受影响。会话文件导入时按 `name` **复用**已有卡，无同名卡则从内嵌 `card` 重建。

## 6. 导入格式规范（酒馆卡）

### 6.1 三种 JSON 版本

| 版本 | 结构判定 | 说明 |
|---|---|---|
| V1 | 顶层裸字段 | 无 `spec` / `spec_version` 包裹 |
| V2 | `{ "spec": "chara_card_v2", "data": {...} }` | 字段在 `data` 内 |
| V3 | `{ "spec": "chara_card_v3", "data": {...} }` | 仅导入通用字段；`group_only_greetings`、`assets` 等忽略并警告 |

判定：`json.data && (json.spec || json.spec_version)` → 解包 `data`，否则整个对象即字段容器。

### 6.2 源字段 → 内部字段映射

| 酒馆字段 | → 内部字段 | 转换规则 |
|---|---|---|
| `name` | `name` | `String().trim()`，空串落为「导入角色」；**整个文件缺 name → 拒绝** |
| `description` | `description` | `String().trim()` |
| `personality` | `personality` | 同上 |
| `scenario` | `scenario` | 同上 |
| `first_mes` | `firstMessage` | 同上 |
| `mes_example` | `styleExamples` | **转译**：按 `<START>`（不区分大小写）切段 → 每段去行首 `{{char}}:` / `{{user}}:` 前缀 → 空段丢弃 → 段间以 `\n\n———\n\n` 连接。含 `<START>` 时提示「多段示例已合并」 |
| `user_persona` | `userPersona` | `String().trim()` |
| `alternate_greetings` | `alternateGreetings` | 数组各项 `String().trim()` 过滤空串；非数组视为 `[]` |
| `character_book.entries` | `embeddedLore` | 见 6.2.1 |
| `system_prompt`、`post_history_instructions` | 忽略 | 有值时警告「RP Engine 有自己的指令结构，已忽略」 |

#### 6.2.1 `character_book.entries` 解析

- **标准**：对象数组，每项 `{ keys: string[], content, insertion_order?, priority?, constant?, enabled? }`
  - `keys` 数组 → `join('，')`（中文逗号）
  - `priority` 取 `insertion_order ?? priority`，`Number() || 0`
  - `constant` 强制布尔；`enabled` 默认 `true`（仅显式 `false` 关闭）
- **兼容 ①**：`entries` 为对象（键值 map）→ `Object.values()` 转数组
- **兼容 ②**：旧式位置数组 `[keys[], content, ...]` → `{ keys: join('，'), content, priority: 0, constant: false, enabled: true }`
- **过滤**：`content` trim 后为空的条目一律丢弃

### 6.3 会话导出内嵌的 `card`

= §2 的 9 个内容字段（`name`…`embeddedLore`），无 `id`。`card` 为 `null` 的会话文件用会话名建占位卡。

## 7. 依赖与互斥关系

| 关系 | 规则 |
|---|---|
| `name` | 唯一硬必填；无 `name` 的快照视为无效（`snapshotOf` 返回 `null`） |
| `constant` ⊃ `keys` | 常驻条目恒注入，`keys` 被忽略（可留空） |
| `keys` 空且非常驻 | 条目**永不触发**（保留在列表但等效死条目） |
| `alternateGreetings` | 依赖开故事 UI；开场列表 = `[firstMessage, ...alternateGreetings]`，全空则故事以空消息列表开始 |
| `embeddedLore` → 会话 | 仅建故事瞬间拷贝一次；此后卡上条目变化不影响既有故事 |
| 事件规则 → `uid` | 规则动作按 `uid` 解锁**会话内**条目；卡上条目无 uid（须先建故事） |
| 指令互斥 | 酒馆的 `system_prompt` / `post_history_instructions` 一律忽略（RP Engine 有固定编译结构） |
| `firstMessage` 与快照 | 开场白不进快照；删卡后故事的既有开场消息与重生成不受影响 |

## 8. 版本兼容性

- **内部格式**：核心字段自 v0.1 稳定；`userPersona` / `alternateGreetings` / `embeddedLore` 为后续新增，旧记录缺省读作空值，**无需数据迁移**。
- **导入**：V1 / V2 / V3 全支持；V3 扩展字段显式忽略并警告。
- **兜底**：旧式位置数组条目、对象 map 形态、明文 / Base64 PNG 均兼容。
- **向前规则**：只增可选字段、不改已有字段语义 → 旧版本可安全读取新数据（多余字段忽略）。

## 9. 最小可用示例

**最小内部卡**（新建即用，无开场白则故事从空列表开始）：

```json
{ "name": "林晚" }
```

**最小导入文件**（V2）：

```json
{
  "spec": "chara_card_v2",
  "data": {
    "name": "林晚",
    "description": "26 岁的旧书店店员，说话简短。",
    "first_mes": "（风铃响了。）欢迎光临——今天想找什么书？"
  }
}
```

## 10. 完整示例（全部字段）

```json
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "data": {
    "name": "沈砚",
    "description": "34 岁，瘦高。雾屿市临江路「拾遗书店」第三代店主，宋元刻本修补手艺人，左手食指有一道旧疤。",
    "personality": "话少但不冷。克制、精确，紧张时会不自觉把纸页压平。{{char}}不轻易承诺，承诺必做到底。",
    "scenario": "架空近现代沿海城市「雾屿市」，终年多雨。开场：傍晚，雨，距打烊还有半小时，{{user}}抱着一本浸过水的旧书推门进来。",
    "first_mes": "（雨声。门上的铜铃只响了半声。）\n\n沈砚从二楼的修复台抬起头。\n\n「打烊前半小时。伞在门后，自己拿。」",
    "mes_example": "<START>\n{{user}}：这书还能修好吗？\n{{char}}：纸有记忆。压平、补洞、重新缝线，它就会想起自己原来是本书。给我两周。\n<START>\n{{user}}：你不怕像三年前一样什么都查不到吗？\n{{char}}：（沉默两秒）怕。但怕和停手是两回事。",
    "user_persona": "你是雾屿市本地人，二十六岁，在旧货摊上淘到一本浸过水的旧书，书页里夹着一张不属于你的照片。",
    "alternate_greetings": [
      "（午后，没下雨。书店里只有一台老风扇在转。）\n\n「随便看。楼梯口那摞是论斤卖的。」",
      "（晚上九点，雨停了，书店已经打烊。）\n\n沈砚拉开门时手里还戴着棉手套：「这个点来，要么是好消息，要么是坏消息。」"
    ],
    "character_book": {
      "entries": [
        {
          "keys": ["拾遗书店", "书店"],
          "content": "拾遗书店在旧城区临江路 47 号，一楼卖旧书与旧地图，二楼是{{char}}的修复台和十二个卷宗柜。",
          "insertion_order": 10,
          "enabled": true
        },
        {
          "keys": ["西码头", "火灾"],
          "content": "三年前冬夜，西码头 6 号仓库起火，官方结论是线路老化。{{char}}不认这个结论。",
          "insertion_order": 20,
          "constant": false,
          "enabled": true
        },
        {
          "keys": [],
          "content": "雾屿市是南方沿海工业城市，全年约一百四十天有雨，旧城区正在改造。",
          "constant": true,
          "enabled": true
        }
      ]
    }
  }
}
```

导入后得到：`styleExamples` 为两段（`———` 分隔、已去 `{{user}}:`/`{{char}}:` 前缀）、`embeddedLore` 3 条（第三条常驻恒注入）。

## 11. 开发者校验清单

- [ ] 无 `name` 的 JSON / PNG → 导入被拒（「缺少 name」）
- [ ] V2/V3 的字段取自 `data`；V1 取顶层；`spec_version` 同样触发解包
- [ ] `mes_example`：`<START>` 切分、前缀剥离、`———` 连接
- [ ] `entries` 的对象数组 / 对象 map / 位置数组三形态都可解析；空 `content` 条目被过滤
- [ ] `constant: true` 条目注入静态前缀，与 `keys` 无关
- [ ] 宏替换：开场白落库时已替换；其余字段编译时替换
- [ ] 删除原卡后故事继续可用（快照解引用），「角色卡已删除 · 使用快照」标记出现
- [ ] 会话导出 → 导入往返后，`card` 字段与消息、世界书内容一致
