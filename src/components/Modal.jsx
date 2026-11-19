import React from 'react'

export default function Modal({ open, title, onClose, children, footer, width }) {
  if (!open) return null
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div
        className="drawer"
        style={width ? { width } : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="btn btn-icon btn-ghost" onClick={onClose} title="关闭">✕</button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </div>
    </div>
  )
}
