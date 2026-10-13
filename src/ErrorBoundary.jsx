import { Component } from 'react'
import { buildDump, downloadDump, countDump } from './lib/backup'

/**
 * 顶层错误边界。
 *
 * 为什么必须有：白屏状态下用户**连"导出备份"都点不到** —— 数据没丢但取不出来，
 * 与真丢没有区别。这里的 fallback 只做三件事：说清发生了什么、把数据导出来、给条退路。
 *
 * 注意：只捕获渲染 / 生命周期异常。事件回调里的异步错误（如 importDump 失败）不会被捕获，
 * 因此各视图自己必须处理异步错误 —— 这里兜的是"代码 bug / 数据形状意外"导致的渲染崩溃。
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, dumpMsg: '' }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[rp-engine] 渲染异常：', error, info)
  }

  /** 逃生口：直接在崩溃界面导出整库，不需要回到正常 UI */
  async exportDump() {
    try {
      const dump = await buildDump()
      downloadDump(dump, `rp-engine-崩溃导出-${new Date().toISOString().slice(0, 10)}.json`)
      this.setState({ dumpMsg: `已导出 ${countDump(dump)} 条记录。若重载后仍崩溃，可清空站点数据后导入该文件。` })
    } catch (e) {
      this.setState({ dumpMsg: `导出失败：${e?.message || e}。可尝试在浏览器开发者工具里直接读取 IndexedDB（库名 rp-engine）。` })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="view">
        <div className="view-head"><h2>页面出错了</h2></div>
        <div className="banner error">
          界面渲染时发生异常。数据仍保存在本机数据库中，建议先导出备份再重载页面。
        </div>

        <div className="card">
          <div className="card-title"><b>错误信息</b></div>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>
            {String(this.state.error?.stack || this.state.error)}
          </pre>
        </div>

        <div className="row">
          <button className="btn primary" onClick={() => this.exportDump()}>导出备份</button>
          <button className="btn" onClick={() => location.reload()}>重载页面</button>
        </div>
        {this.state.dumpMsg && <div className="banner info">{this.state.dumpMsg}</div>}
      </div>
    )
  }
}
