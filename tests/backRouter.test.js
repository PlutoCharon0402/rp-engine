// 返回键路由（alpha.12）：后进先出的弹层消费栈。
// 背景：Android 返回键曾直接退会话，导演弹层草稿被丢弃（实测「导演指令时灵时不灵」主因）。
// 注意：栈是模块级单例，测试必须自行 pop 干净，否则用例间互相污染。
import { describe, expect, it } from 'vitest'
import { pushBackHandler, consumeBack } from '../src/lib/backRouter.js'

describe('BR1 · 返回键消费栈', () => {
  it('后注册的处理器先被调用（后进先出），且消费后仍留在栈上直到反注册', () => {
    const calls = []
    const popOuter = pushBackHandler(() => { calls.push('outer'); return true })
    const popInner = pushBackHandler(() => { calls.push('inner'); return true })
    expect(consumeBack()).toBe(true)
    expect(calls).toEqual(['inner']) // 只有栈顶被调用
    popInner(); popOuter()
  })

  it('处理器返回 false → 不消费（交给默认退会话行为）', () => {
    const pop = pushBackHandler(() => false)
    expect(consumeBack()).toBe(false)
    pop()
  })

  it('反注册后不再被调用；栈空时 consumeBack 返回 false 不抛错', () => {
    let hit = false
    const pop = pushBackHandler(() => { hit = true; return true })
    pop()
    expect(consumeBack()).toBe(false)
    expect(hit).toBe(false)
  })

  it('内层关掉自己后，下一次返回键落到外层（弹层逐层关闭）', () => {
    const log = []
    const popOuter = pushBackHandler(() => { log.push('outer'); return true })
    const popInner = pushBackHandler(() => { log.push('inner'); return true })
    consumeBack() // 内层消费一次
    popInner()    // 内层关闭自己（如弹层关闭时反注册）
    consumeBack() // 落到外层
    expect(log).toEqual(['inner', 'outer'])
    popOuter()
    expect(consumeBack()).toBe(false)
  })
})
