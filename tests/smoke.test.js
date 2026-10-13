// 批次4 · 渲染冒烟：不依赖真实 API / 浏览器，只保证"页面能挂载、崩溃有兜底"。
// 目的：捕获未定义变量、JSX 结构错误这类只有运行时才暴露的问题（build 能过不代表能渲染）。
import { beforeAll, describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import App from '../src/App.jsx'
import ErrorBoundary from '../src/ErrorBoundary.jsx'

beforeAll(() => {
  // App 在 useState 初始化时读 localStorage（node 环境没有），给个最小 stub
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
  globalThis.__APP_VERSION__ = globalThis.__APP_VERSION__ || 'test'
})

describe('SM · 渲染冒烟', () => {
  it('App 能渲染出底部五个页签', () => {
    const html = renderToString(React.createElement(App))
    for (const t of ['对话', '状态', '世界书', '角色', '设置']) {
      expect(html).toContain(t)
    }
  })

  it('未进入故事时，对话页显示会话列表的空态而不是白屏', () => {
    const html = renderToString(React.createElement(App))
    expect(html).toContain('新故事')
  })

  // 注意：legacy renderToString **不会**走错误边界恢复（错误直接抛出），
  // 所以这里直接验证边界的两段逻辑：捕获 → state.error；以及 state.error 存在时渲染兜底界面。
  it('ErrorBoundary：捕获渲染异常并渲染兜底界面（含导出备份逃生口）', () => {
    const err = new Error('boom')
    const state = ErrorBoundary.getDerivedStateFromError(err)
    expect(state.error).toBe(err)

    const inst = new ErrorBoundary({ children: null })
    inst.state = state
    const html = renderToString(inst.render())
    expect(html).toContain('页面出错了')
    expect(html).toContain('导出备份')
    expect(html).toContain('重载页面')
  })

  it('ErrorBoundary：无错误时原样渲染子组件', () => {
    const inst = new ErrorBoundary({ children: React.createElement('div', null, 'hello') })
    expect(renderToString(inst.render())).toContain('hello')
  })
})
