// 动态路由：优先级（显式选择 > purpose 路由 > 对话默认 > 故障转移链）、就绪过滤、模型挑选
import { describe, expect, it } from 'vitest'
import { routeChain, explicitUnavailable } from '../src/lib/providers/router.js'

/** 基础设置：deepseek 与 moonshot 就绪，openai 未配 Key */
const base = {
  providerId: 'deepseek',
  providers: {
    deepseek: { id: 'deepseek', apiKey: 'a', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat' },
    moonshot: { id: 'moonshot', apiKey: 'b', models: ['kimi-latest'], defaultModel: 'kimi-latest' },
    openai: { id: 'openai', apiKey: '', models: ['gpt-4o'], defaultModel: 'gpt-4o' },
    ollama: { id: 'ollama', noKey: true, models: ['llama3.1'], defaultModel: 'llama3.1' },
  },
}

describe('RT1 · 优先级与过滤', () => {
  it('chat：默认走对话默认厂商', () => {
    const chain = routeChain(base, 'chat', {})
    expect(chain.map((t) => t.provider.id)).toEqual(['deepseek'])
    expect(chain[0].model).toBe('deepseek-chat')
  })

  it('chat：显式选择（会话覆盖）优先于全局默认', () => {
    const chain = routeChain(base, 'chat', { providerId: 'moonshot', model: 'kimi-latest' })
    expect(chain[0].provider.id).toBe('moonshot')
    expect(chain[0].model).toBe('kimi-latest')
  })

  it('未就绪厂商（没 Key 且非本地）被静默跳过，本地服务放行', () => {
    const chain = routeChain({ ...base, providerId: 'openai' }, 'chat', {})
    expect(chain.map((t) => t.provider.id)).toEqual(['deepseek']) // openai 跳过 → 兜底 deepseek
    const withOllama = routeChain({ ...base, fallbackIds: ['openai', 'ollama'] }, 'chat', {})
    expect(withOllama.map((t) => t.provider.id)).toContain('ollama')
    expect(withOllama.map((t) => t.provider.id)).not.toContain('openai')
  })

  it('非 chat 用途：routing 配置优先，显式选择（override）不生效', () => {
    const s = { ...base, routing: { extract: { providerId: 'moonshot', model: 'kimi-latest' } } }
    const chain = routeChain(s, 'extract', { providerId: 'ollama' }) // override 只属于 chat
    expect(chain[0].provider.id).toBe('moonshot')
    expect(chain[0].model).toBe('kimi-latest')
  })

  it('routing 未配置的非 chat 用途回落对话默认', () => {
    const chain = routeChain(base, 'summary', {})
    expect(chain[0].provider.id).toBe('deepseek')
  })

  it('故障转移链按用户顺序追加，且去重', () => {
    const chain = routeChain({ ...base, fallbackIds: ['moonshot', 'ollama', 'deepseek', 'moonshot'] }, 'chat', {})
    expect(chain.map((t) => t.provider.id)).toEqual(['deepseek', 'moonshot', 'ollama'])
  })

  it('没有任何就绪厂商 → 空链', () => {
    expect(routeChain({}, 'chat', {})).toEqual([])
  })

  it('模型挑选：对话默认厂商用 settings.model，其他厂商用 defaultModel', () => {
    const chain = routeChain({ ...base, model: 'deepseek-reasoner' }, 'chat', {})
    expect(chain[0].model).toBe('deepseek-reasoner')
    const chain2 = routeChain({ ...base, fallbackIds: ['moonshot'] }, 'chat', {})
    expect(chain2[1].model).toBe('kimi-latest')
  })
})

describe('RT2 · 显式选择校验 explicitUnavailable', () => {
  it('显式选择了未配置的厂商 → 返回该厂商（client 据此报错，不静默换家）', () => {
    const r = explicitUnavailable(base, { providerId: 'openai' })
    expect(r).toMatchObject({ id: 'openai' })
  })

  it('就绪 / 未显式选择 → null', () => {
    expect(explicitUnavailable(base, { providerId: 'deepseek' })).toBe(null)
    expect(explicitUnavailable(base, {})).toBe(null)
    expect(explicitUnavailable(base, { providerId: '不存在的' })).toBeTruthy()
  })
})
