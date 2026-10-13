// summarize.js 的异步部分：runSummary（唯一会打 API 的环节），用 mock 顶掉 api.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock 会被提升到 import 之前，因此 mock 用的函数必须由 vi.hoisted 提供
const { completeMock } = vi.hoisted(() => ({ completeMock: vi.fn() }))
vi.mock('../src/lib/api.js', () => ({ makeApi: () => ({ complete: completeMock }) }))

const { runSummary } = await import('../src/lib/summarize.js')

const plan = {
  fold: [
    { id: 1, role: 'user', content: '甲' },
    { id: 2, role: 'assistant', content: '乙' },
  ],
  keep: 40,
  upTo: 2,
}

beforeEach(() => { completeMock.mockReset() })
afterEach(() => { vi.restoreAllMocks() })

describe('RS · runSummary（摘要生成）', () => {
  it('RS1 返回新摘要与进度标记 upTo', async () => {
    completeMock.mockResolvedValue('  合并后的摘要  ')
    const r = await runSummary({ plan, prevSummary: '旧摘要', settings: { apiKey: 'k' } })
    expect(r).toEqual({ summary: '合并后的摘要', summaryUpTo: 2 })  // 去空白
    expect(completeMock).toHaveBeenCalledTimes(1)
  })

  it('RS2 已有摘要与新对话都进 prompt；无旧摘要时写「（无）」', async () => {
    completeMock.mockResolvedValue('x')
    await runSummary({ plan, prevSummary: '旧摘要', settings: { apiKey: 'k' } })
    const [messages, opts] = completeMock.mock.calls[0]
    const userMsg = messages[1].content
    expect(userMsg).toContain('## 已有摘要\n旧摘要')
    expect(userMsg).toContain('你：甲')
    expect(userMsg).toContain('角色：乙')
    expect(opts).toMatchObject({ temperature: 0.3, maxTokens: 700 })

    completeMock.mockClear()
    await runSummary({ plan, prevSummary: '', settings: { apiKey: 'k' } })
    expect(completeMock.mock.calls[0][0][1].content).toContain('（无）')
  })

  it('RS3 maxTokens 可被覆盖', async () => {
    completeMock.mockResolvedValue('x')
    await runSummary({ plan, prevSummary: '', settings: { apiKey: 'k' }, maxTokens: 300 })
    expect(completeMock.mock.calls[0][1].maxTokens).toBe(300)
  })

  it('RS4 模型返回空 / 纯空白 → 抛错（不把空摘要写进会话）', async () => {
    completeMock.mockResolvedValue('   \n ')
    await expect(runSummary({ plan, prevSummary: '', settings: { apiKey: 'k' } })).rejects.toThrow('空摘要')
    completeMock.mockResolvedValue('')
    await expect(runSummary({ plan, prevSummary: '', settings: { apiKey: 'k' } })).rejects.toThrow('空摘要')
  })

  it('RS5 plan 为空或无可折叠内容 → 直接抛错，不打 API', async () => {
    await expect(runSummary({ plan: null, prevSummary: '', settings: { apiKey: 'k' } })).rejects.toThrow('没有需要摘要的内容')
    await expect(runSummary({ plan: { fold: [], keep: 40, upTo: 0 }, prevSummary: '', settings: { apiKey: 'k' } })).rejects.toThrow('没有需要摘要的内容')
    expect(completeMock).not.toHaveBeenCalled()
  })
})
