/**
 * 动态路由（docs/multi-provider-design.md §2 Router / §6.3）：
 * 把一次请求（purpose + 用户显式选择）解析为**有序目标链**，供 client 按序尝试。
 *
 * 优先级（高 → 低）：
 *   1. 用户显式选择（会话覆盖 > 全局）——仅对 purpose === 'chat' 生效，
 *      状态提取 / 摘要不该跟着"这个故事换了模型"走，它们有自己的路由配置；
 *   2. purpose 路由配置（settings.routing[extract|summary]，空 = 跟随对话默认）；
 *   3. 对话默认（settings.providerId）；
 *   4. 故障转移链（settings.fallbackIds，按用户勾选顺序）。
 *
 * 过滤规则：未就绪（没 Key 且非本地服务）的厂商**静默跳过**；
 * 用户显式选择的厂商不就绪时不静默换（由 client 抛错引导去配置）。
 */
import { allProviders, getProvider, providerReady } from './registry'

/** 解析某个目标的实际模型：显式 > 路由配置 > 对话默认模型 > 厂商默认模型 */
function pickModel(settings, provider, purpose, override) {
  if (purpose === 'chat' && override?.model) return override.model
  const routed = settings.routing?.[purpose]
  if (routed?.model && routed.providerId === provider.id) return routed.model
  if (provider.id === settings.providerId && settings.model) return settings.model
  return provider.defaultModel || provider.models[0] || ''
}

/**
 * @returns {{ provider: object, model: string }[]} 就绪且去重的目标链（至少为空数组）
 */
export function routeChain(settings, purpose, override = {}) {
  const list = allProviders(settings)
  const chain = []
  const add = (id) => {
    const p = list.find((x) => x.id === id)
    if (p && providerReady(p) && !chain.some((t) => t.provider.id === id)) {
      const model = pickModel(settings, p, purpose, override)
      if (model) chain.push({ provider: p, model }) // 没有任何模型名可用的厂商无法请求
    }
  }

  if (purpose === 'chat') add(override.providerId)                 // 1. 用户显式选择（仅对话）
  if (purpose !== 'chat') add(settings.routing?.[purpose]?.providerId) // 2. purpose 路由
  add(settings.providerId)                                          // 3. 对话默认
  add('deepseek')                                                   //    内置兜底（常在注册表）
  for (const id of settings.fallbackIds || []) add(id)              // 4. 故障转移链
  return chain
}

/**
 * 用户显式选择的厂商是否"点名了但不可用"。
 * @returns {null | {id, displayName}} 不可用时返回厂商信息（client 据此抛 AUTH 错）
 */
export function explicitUnavailable(settings, override = {}) {
  const id = override?.providerId
  if (!id) return null
  const p = getProvider(settings, id)
  if (!p) return { id, displayName: id }
  return providerReady(p) ? null : { id: p.id, displayName: p.displayName }
}
