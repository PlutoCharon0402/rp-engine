// 酒馆（SillyTavern）角色卡导入：PNG tEXt(chara/ccv3) 与 JSON 文件 → RP Engine 字段
// 兼容 V1（顶层裸字段）/ V2（spec: chara_card_v2）/ V3（spec: chara_card_v3）

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** 解析文件（.png / .json）→ { card, loreEntries, warnings } */
export async function parseCardFile(file) {
  const warnings = []
  let json
  if (file.type === 'image/png' || /\.png$/i.test(file.name)) {
    json = await extractPngCard(await file.arrayBuffer())
  } else {
    json = JSON.parse(await file.text())
  }

  const d = json?.data && (json.spec || json.spec_version) ? json.data : json
  if (!d || typeof d !== 'object' || !d.name) throw new Error('文件中没有有效的角色卡数据（缺少 name 字段）')
  if (json?.spec === 'chara_card_v3') warnings.push('V3 卡：仅导入通用字段，group_only_greetings/assets 等被忽略')

  const card = {
    name: String(d.name).trim() || '导入角色',
    description: s(d.description),
    personality: s(d.personality),
    scenario: s(d.scenario),
    firstMessage: s(d.first_mes),
    styleExamples: convMesExample(d.mes_example, warnings),
    userPersona: s(d.user_persona),
    alternateGreetings: (Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [])
      .map((g) => String(g || '').trim()).filter(Boolean),
  }

  // 内嵌世界书：V2 规范为对象数组；少数旧导出是 [keys, content, ...] 位置数组，做兜底
  let entries = d.character_book?.entries || []
  if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
    entries = Object.values(entries)
  }
  const loreEntries = entries
    .map((e, i) => {
      if (Array.isArray(e)) { // 旧式位置数组
        return { keys: (e[0] || []).join('，'), content: String(e[1] || '').trim(), priority: 0, constant: false, enabled: true }
      }
      return {
        keys: (e.keys || []).join('，'),
        content: String(e.content || '').trim(),
        priority: Number(e.insertion_order ?? e.priority) || 0,
        constant: !!e.constant,
        enabled: e.enabled !== false,
      }
    })
    .filter((e) => e.content)

  if (d.system_prompt?.trim() || d.post_history_instructions?.trim()) {
    warnings.push('该卡含 system_prompt / post_history_instructions，RP Engine 有自己的指令结构，已忽略')
  }
  return { card, loreEntries, warnings }
}

/** 从 PNG ArrayBuffer 提取 tEXt chunk 中的角色卡 JSON */
async function extractPngCard(buf) {
  const dv = new DataView(buf)
  for (let i = 0; i < 8; i++) {
    if (dv.getUint8(i) !== PNG_SIG[i]) throw new Error('不是有效的 PNG 文件')
  }
  const texts = {}
  let off = 8
  while (off + 12 <= buf.byteLength) {
    const len = dv.getUint32(off)
    const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7))
    if (type === 'tEXt') {
      const data = new Uint8Array(buf, off + 8, len)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const kw = latin1(data.subarray(0, nul))
        if (kw === 'chara' || kw === 'ccv3') texts[kw] = latin1(data.subarray(nul + 1))
      }
    }
    off += 12 + len
    if (type === 'IEND') break
  }
  const raw = texts.ccv3 || texts.chara
  if (!raw) throw new Error('PNG 中未找到角色卡数据（缺少 chara/ccv3 数据块）')
  const t = raw.trim()
  // 常规为 Base64 编码 JSON；个别工具存明文，两种都试
  try { return JSON.parse(t) } catch { /* 尝试 base64 */ }
  const bytes = Uint8Array.from(atob(t), (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder('utf-8').decode(bytes))
}

/** mes_example 转译：按 <START> 切分，去掉 {{char}}:/{{user}}: 行前缀，保留宏 */
function convMesExample(ex, warnings) {
  if (!ex || !String(ex).trim()) return ''
  if (String(ex).includes('<START>')) {
    warnings.push('mes_example 的多段示例已合并进文风示例（按 <START> 分段）')
  }
  return String(ex)
    .split(/<START>/i)
    .map((blk) =>
      blk.trim()
        .replace(/^\{\{char\}\}\s*:/i, '')
        .replace(/^\{\{user\}\}\s*:/i, '')
        .trim()
    )
    .filter(Boolean)
    .join('\n\n———\n\n')
}

function s(v) { return String(v ?? '').trim() }
function latin1(bytes) { let out = ''; for (const b of bytes) out += String.fromCharCode(b); return out }
