// Android 返回键路由（alpha.12）：返回键应先关弹层/保存草稿，再退会话/退出应用。
//
// 背景实测 bug：导演指令弹层只在点「关闭/遮罩」时写库，而 App.jsx 的 backButton
// 直接 selectSession(null) —— 用户按返回键关闭弹层时草稿被整包丢弃，指令从未
// 落库，表现为「导演指令时灵时不灵」。
//
// 用法：弹层打开时 pushBackHandler(() => { 关闭并保存; return true })，
//       未打开时返回 false（不消费，由下一层/默认行为处理）。

const stack = []

/** 注册一个返回键处理器（后进先出）。返回反注册函数。 */
export function pushBackHandler(fn) {
  stack.push(fn)
  return () => {
    const i = stack.lastIndexOf(fn)
    if (i >= 0) stack.splice(i, 1)
  }
}

/**
 * 让栈顶处理器消费返回键。
 * @returns {boolean} true = 已消费（弹层已关），调用方不要再做默认行为
 */
export function consumeBack() {
  const fn = stack[stack.length - 1]
  return fn ? !!fn() : false
}
