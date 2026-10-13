// 注册表：内置预设合并、就绪判定、老配置迁移（多模型落地的第一道关）
import { describe, expect, it } from 'vitest'
import {
  allProviders, getProvider, providerReady, hasAnyProviderReady, migrateSettings, BUILTIN_PROVIDERS,
} from '../src/lib/providers/registry.js'

describe('R1 · allProviders 合并', () => {
  it('无覆盖时 = 内置预设原样', () => {
    expect(allProviders({})).toEqual(BUILTIN_PROVIDERS.map((b) => ({ ...b })))
  })

  it('用户覆盖按 id 合入（改端点 / 填 Key），其余字段保持内置', () => {
    const list = allProviders({ providers: { deepseek: { id: 'deepseek', apiKey: 'sk-1', endpoint: 'https://x/v1' } } })
    const ds = list.find((p) => p.id === 'deepseek')
    expect(ds.apiKey).toBe('sk-1')
    expect(ds.endpoint).toBe('https://x/v1')
    expect(ds.displayName).toBe('DeepSeek') // 未覆盖字段来自内置
    expect(ds.models).toEqual(BUILTIN_PROVIDERS[0].models)
  })

  it('自定义厂商（id 不在内置表）追加在列表尾部', () => {
    const list = allProviders({ providers: { 'my-gw': { id: 'my-gw', displayName: '网关', endpoint: 'https://g/v1', models: ['m1'] } } })
    expect(list.some((p) => p.id === 'my-gw')).toBe(true)
    expect(list[0].id).toBe('deepseek') // 内置顺序不乱
  })

  it('getProvider 查不存在返回 null', () => {
    expect(getProvider({}, 'deepseek')).toBeTruthy()
    expect(getProvider({}, 'nope')).toBe(null)
    expect(getProvider({}, '')).toBe(null)
  })
})

describe('R2 · 就绪判定', () => {
  it('云端厂商需 Key；本地服务（noKey）需被用户编辑启用（_userEdited）才算就绪', () => {
    expect(providerReady({ id: 'x', apiKey: '' })).toBe(false)
    expect(providerReady({ id: 'x', apiKey: 'sk' })).toBe(true)
    expect(providerReady({ id: 'ollama', noKey: true, apiKey: '' })).toBe(false)          // 内置未启用
    expect(providerReady({ id: 'ollama', noKey: true, apiKey: '', _userEdited: true })).toBe(true) // 编辑保存过
  })

  it('hasAnyProviderReady：一家就绪即可', () => {
    expect(hasAnyProviderReady({})).toBe(false) // 内置全没 Key
    expect(hasAnyProviderReady({ providers: { deepseek: { id: 'deepseek', apiKey: 'k' } } })).toBe(true)
    expect(hasAnyProviderReady({ providers: { ollama: { id: 'ollama', apiKey: '' } } })).toBe(true) // 内置本地服务
  })
})

describe('R3 · 老配置迁移 migrateSettings', () => {
  it('endpoint 缺省 → 迁到 DeepSeek 预设（保 Key 与模型）', () => {
    const s = migrateSettings({ apiKey: 'sk-old', model: 'deepseek-reasoner' })
    expect(s.providerId).toBe('deepseek')
    expect(s.providers.deepseek.apiKey).toBe('sk-old')
    expect(s.providers.deepseek.defaultModel).toBe('deepseek-reasoner')
    expect(s.providers.deepseek.models).toContain('deepseek-reasoner')
  })

  it('endpoint 指向内置预设 → 归到该预设', () => {
    const s = migrateSettings({ endpoint: 'https://api.moonshot.cn/v1/', apiKey: 'k', model: 'kimi-latest' })
    expect(s.providerId).toBe('moonshot')
    expect(s.providers.moonshot.endpoint).toBe('https://api.moonshot.cn/v1/')
  })

  it('未知 endpoint → 建自定义厂商，模型继承旧值', () => {
    const s = migrateSettings({ endpoint: 'https://my-gw.example.com/v1', apiKey: 'k', model: 'gw-model' })
    expect(s.providerId).toBe('custom')
    expect(s.providers.custom.adapter).toBe('openai')
    expect(s.providers.custom.models).toEqual(['gw-model'])
    expect(s.providers.custom.defaultModel).toBe('gw-model')
  })

  it('幂等：已是新结构则原样返回', () => {
    const s = { providerId: 'openai', providers: { openai: { id: 'openai', apiKey: 'k' } } }
    expect(migrateSettings(s)).toBe(s)
    expect(migrateSettings(null)).toBe(null)
  })
})
