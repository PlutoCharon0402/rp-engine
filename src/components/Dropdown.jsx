// 应用风格的自定义下拉组件（B6）：替代原生 <select>。
// 原因：原生 select 的展开菜单由系统渲染（白底黑字、系统选中圆点），
// 与深色金色主题严重脱节（见 alpha-feedback.md B6 截图）。
// 语义与 <select> 对齐：受控组件，options=[{value,label}]，value/onChange。
import { useEffect, useRef, useState } from 'react'

export default function Dropdown({ value, onChange, options = [], placeholder = '', className = '' }) {
  const [open, setOpen] = useState(false)
  const root = useRef(null)

  // 打开时：点组件外 / 按 Escape 关闭
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (!root.current?.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const current = options.find((o) => o.value === value)

  return (
    <div className={`dropdown ${className}`} ref={root}>
      <button type="button" className="input dropdown-trigger" onClick={() => setOpen((v) => !v)}>
        <span className={`dropdown-value ${current ? '' : 'is-placeholder'}`}>
          {current ? current.label : (placeholder || '（未选择）')}
        </span>
        <span className={`dropdown-arrow ${open ? 'is-open' : ''}`} aria-hidden>▾</span>
      </button>
      {open && (
        <div className="dropdown-menu" role="listbox">
          {options.map((o) => (
            <button
              type="button" key={String(o.value)} role="option" aria-selected={o.value === value}
              className={`dropdown-item ${o.value === value ? 'is-active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false) }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
