import { describe, it, expect } from 'vitest'
import { buildProbeDirector, evaluateProbeResult, PROBE_TOKEN, PROBE_INSTRUCTION } from '../src/lib/selfCheck.js'

describe('buildProbeDirector · 构造自检用导演指令', () => {
  it('保留当前生效指令并在末尾追加探针，且强制 enabled=true', () => {
    const director = { enabled: true, notes: [{ id: 'd1', text: '文风冷一点', createdAt: 1 }] }
    const probe = buildProbeDirector(director)
    expect(probe.enabled).toBe(true)
    expect(probe.notes).toHaveLength(2)
    expect(probe.notes[0].text).toBe('文风冷一点')
    expect(probe.notes[1].text).toBe(PROBE_INSTRUCTION)
    expect(probe.notes[1].text).toContain(PROBE_TOKEN)
  })

  it('绝不修改入参对象（自检是一次性诊断，不能污染 session.director）', () => {
    const director = { enabled: true, notes: [{ id: 'd1', text: '原始指令', createdAt: 1 }] }
    const snapshot = JSON.parse(JSON.stringify(director))
    buildProbeDirector(director)
    expect(director).toEqual(snapshot)
  })

  it('导演指令停用时只发探针（不带已停用的指令）', () => {
    const probe = buildProbeDirector({ enabled: false, notes: [{ id: 'd1', text: '不该出现', createdAt: 1 }] })
    expect(probe.notes).toHaveLength(1)
    expect(probe.notes[0].text).toBe(PROBE_INSTRUCTION)
  })

  it('空白 / 缺省指令被过滤，director 缺省也不抛错', () => {
    expect(buildProbeDirector({ enabled: true, notes: [{ id: 'x', text: '   ', createdAt: 1 }] }).notes).toHaveLength(1)
    expect(buildProbeDirector(undefined).notes).toHaveLength(1)
    expect(buildProbeDirector(undefined).notes[0].text).toBe(PROBE_INSTRUCTION)
  })
})

describe('evaluateProbeResult · 机械判定探针是否被执行', () => {
  it('回复末尾出现 325 → pass（允许尾部标点与前缀文字）', () => {
    const r = evaluateProbeResult({ text: '一段剧情……\n输出：325。', finishReason: 'stop' })
    expect(r.status).toBe('pass')
    expect(r.passed).toBe(true)
  })

  it('325 只出现在正文中间、没有收尾 → fail，且标注「遵循不完整」', () => {
    const r = evaluateProbeResult({ text: '他低声说了 325 这个数字，然后转身离开。', finishReason: 'stop' })
    expect(r.status).toBe('fail')
    expect(r.passed).toBe(false)
    expect(r.contained).toBe(true)
    expect(r.detail).toContain('没有收尾在末尾')
  })

  it('完全没有 325 → fail，提示对照诊断卡区分「注入问题」与「遵循度问题」', () => {
    const r = evaluateProbeResult({ text: '一段没有任何探针的回复。', finishReason: 'stop' })
    expect(r.status).toBe('fail')
    expect(r.contained).toBe(false)
    expect(r.detail).toContain('诊断卡')
  })

  it('finish_reason=length 且未通过 → truncated（截断优先于 fail，避免假阴性）', () => {
    const r = evaluateProbeResult({ text: '回复被切断了，末尾没', finishReason: 'length' })
    expect(r.status).toBe('truncated')
    expect(r.detail).toContain('maxTokens')
  })

  it('即使被截断，只要末尾仍有 325 就判 pass', () => {
    const r = evaluateProbeResult({ text: '正文……\n325', finishReason: 'length' })
    expect(r.status).toBe('pass')
  })

  it('空回复 → fail，不抛错', () => {
    expect(evaluateProbeResult({ text: '' }).status).toBe('fail')
    expect(evaluateProbeResult().status).toBe('fail')
  })

  it('透传 usage / finishReason，tail 只保留末尾片段', () => {
    const usage = { inputTokens: 100, outputTokens: 20 }
    const long = 'x'.repeat(500) + '\n325'
    const r = evaluateProbeResult({ text: long, finishReason: 'stop', usage })
    expect(r.usage).toEqual(usage)
    expect(r.finishReason).toBe('stop')
    expect(r.tail.length).toBeLessThanOrEqual(160)
    expect(r.tail.endsWith('325')).toBe(true)
  })
})
