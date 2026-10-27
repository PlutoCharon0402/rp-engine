// 导演指令遵循自检（alpha-feedback §6.3）：一键发探针，机械判定模型是否真的执行了导演指令。
// 全部为纯函数——探针构造与结果判定都可本地单测，不依赖 API / IndexedDB / React。

/** 探针固定输出串。命令式、可机械判定，与 tests/compileCard.test.js 的回归守护保持一致 */
export const PROBE_TOKEN = '325'

/** 探针指令本体。必须是命令句（弱模型判断不了「如果…就…」的前提），且要求输出在回复末尾 */
export const PROBE_INSTRUCTION = `每条回复末尾必须输出 ${PROBE_TOKEN}`

/**
 * 在不污染会话数据的前提下构造「自检用」导演指令：
 * 保留当前生效的导演指令（停用时视为无），末尾追加探针指令。
 * 返回新对象，绝不修改入参——自检是一次性诊断，不能把探针写进 session.director。
 * @param {{enabled?: boolean, notes?: Array<{id?:string,text?:string,createdAt?:number}>}} [director]
 */
export function buildProbeDirector(director) {
  const active = director && director.enabled === false ? [] : (director?.notes || [])
  const notes = active
    .map((n) => ({
      id: n?.id || `probe-base-${Math.random().toString(36).slice(2, 8)}`,
      text: String(n?.text || '').trim(),
      createdAt: n?.createdAt || 0,
    }))
    .filter((n) => n.text)
  return {
    enabled: true,
    notes: [...notes, { id: 'probe', text: PROBE_INSTRUCTION, createdAt: Date.now() }],
  }
}

/**
 * 机械判定自检结果。
 * 通过 = 回复最后一个非空行**去掉尾部标点/空白后以 325 结尾**——
 * 允许「325。」「输出：325」这类收尾变体，但正文中间偶然出现 325 不算通过
 *（否则单行回复里提到这个数字就会假阳性）。
 * @param {{text?: string, finishReason?: string|null, usage?: object|null}} r
 * @returns {{status:'pass'|'truncated'|'fail', passed:boolean, contained:boolean,
 *            tail:string, finishReason:string|null, usage:object|null, detail:string}}
 */
export function evaluateProbeResult({ text, finishReason = null, usage = null } = {}) {
  const trimmed = String(text || '').trim()
  const lines = trimmed.split('\n').map((s) => s.trim()).filter(Boolean)
  const lastLine = (lines[lines.length - 1] || '').replace(/[\s。，、．.!！?？…~～]+$/, '')
  const passed = lastLine.endsWith(PROBE_TOKEN)
  const contained = trimmed.includes(PROBE_TOKEN)
  const tail = trimmed.slice(-160)
  const base = { passed, contained, tail, finishReason, usage }

  if (passed) {
    return { ...base, status: 'pass', detail: `自检通过：回复末尾出现 ${PROBE_TOKEN}，导演指令已注入并被模型执行。` }
  }
  if (finishReason === 'length') {
    return {
      ...base,
      status: 'truncated',
      detail: `无法判定：回复被「最大生成长度」截断（finish_reason=length），末尾探针很可能被切掉。请调大 maxTokens 后重试。`,
    }
  }
  return {
    ...base,
    status: 'fail',
    detail: contained
      ? `自检未通过：回复中出现过 ${PROBE_TOKEN}，但没有收尾在末尾，遵循不完整。`
      : `自检未通过：回复末尾未出现 ${PROBE_TOKEN}。若 🔍 诊断卡显示导演指令已注入，则属于模型遵循度问题，而非保存/注入链路问题。`,
  }
}
