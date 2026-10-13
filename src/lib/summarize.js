// 长对话滚动摘要：把"超出上下文窗口的早期对话"压缩成一段摘要塞回 prompt，
// 避免 maxHistory 硬截断导致的突然失忆（第 41 条消息一进来，第 1 条就凭空消失）。
//
// 与状态提取器的分工：
//   提取器 → 结构化世界状态（谁在哪、情绪、事实、事件、关系）
//   摘要   → 叙事层面的连贯记忆（情节脉络、语气、未回收的伏笔）
// 两者互补，都写进 session，但摘要是"滚动"的：新摘要 = 旧摘要 + 新折叠的对话。

import { makeApi } from './api'

/** 未摘要消息超过「窗口 + CHUNK」才值得跑一次摘要：避免每回合都调一次 API */
const CHUNK = 10

const SUMMARY_SYS = `你是角色扮演游戏的剧情记录员。把"已有摘要"与"新对话"合并成一份连贯的新摘要。
要求：
- 只输出摘要正文，不输出任何标题、解释或代码块标记
- 用中文，第三人称，控制在 600 字以内
- 保留：人物关系变化、关键事件与因果、未回收的伏笔、当前场景与目标
- 丢弃：寒暄、重复表述、与主线无关的枝节
- 与已有摘要冲突时，以**新对话**为准（新对话是后发生的）`

/**
 * 计算这一轮要折叠哪些消息。纯函数（零 IndexedDB / 零 API 依赖），便于单测。
 *
 * @param {Array<{id:number, role:string, content:string}>} messages 按 id 升序的完整历史
 * @param {number} maxHistory 上下文窗口（要保留完整原文的消息条数）
 * @param {number} summaryUpTo 已被摘要覆盖到的最后一条消息 id（0 = 从未摘要）
 * @returns {null|{fold:Array, keep:number, upTo:number}} null = 暂时不需要摘要
 */
export function summarizePlan(messages, maxHistory, summaryUpTo) {
  const list = Array.isArray(messages) ? messages : []
  // maxHistory 非法（0 / NaN / 非数字）一律退化为默认 40 —— 绝不因为配置脏就把窗口压到 1 条
  const raw = Number(maxHistory)
  const keep = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 40
  const pending = list.filter((m) => m && m.id > (Number(summaryUpTo) || 0))
  if (pending.length <= keep + CHUNK) return null
  const fold = pending.slice(0, pending.length - keep)
  const last = fold[fold.length - 1]
  // 兜底：消息没有 id（导入的旧数据）时无法标记进度，直接放弃，避免反复重跑
  if (!last || last.id == null) return null
  return { fold, keep, upTo: last.id }
}

/** 需要并入摘要的对话文本（折叠段） */
export function foldText(fold) {
  return (fold || [])
    .map((m) => `${m.role === 'user' ? '你' : '角色'}：${m.content}`)
    .join('\n')
}

/**
 * 生成新摘要。只负责算，不负责写库（调用方决定存哪儿，方便测试与复用）。
 * @returns {Promise<{summary:string, summaryUpTo:number}>}
 */
export async function runSummary({ plan, prevSummary, settings, maxTokens = 700 }) {
  if (!plan || !plan.fold.length) throw new Error('没有需要摘要的内容')
  const api = makeApi(settings)
  const content =
    `## 已有摘要\n${prevSummary ? prevSummary : '（无）'}\n\n` +
    `## 需要并入的新对话\n${foldText(plan.fold)}\n\n` +
    '请输出合并后的新摘要。'
  const raw = await api.complete(
    [{ role: 'system', content: SUMMARY_SYS }, { role: 'user', content }],
    // purpose=summary：摘要可路由到与对话不同的模型（设置页「模型路由」）
    { temperature: 0.3, maxTokens, purpose: 'summary' }
  )
  const summary = String(raw || '').trim()
  if (!summary) throw new Error('模型返回了空摘要')
  return { summary, summaryUpTo: plan.upTo }
}
