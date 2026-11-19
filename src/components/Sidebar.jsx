import React from 'react'
import { useUI } from './UIContext.jsx'

const NAV = [
  { key: 'model', label: 'AI 模型', icon: '🧠' },
  { key: 'avatar', label: '虚拟形象', icon: '🎨' },
  { key: 'voice', label: '语音音色', icon: '🎵' },
  { key: 'persona', label: 'AI 人设', icon: '💖' },
]

const NAV2 = [
  { key: 'chat', label: '对话演示', icon: '💬' },
  { key: 'publish', label: '发布中心', icon: '🚀' },
  { key: 'settings', label: '系统设置', icon: '⚙️' },
]

export default function Sidebar({ page, setPage }) {
  const { mascot } = useUI()
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">🤖</div>
        <div>
          <div className="brand-title">小智配置台</div>
          <div className="brand-sub">XIAOZHI CONSOLE</div>
        </div>
      </div>

      <nav className="nav">
        <div className="tiny muted" style={{ padding: '4px 13px 8px', fontFamily: 'var(--font-round)' }}>资源管理</div>
        {NAV.map((n) => (
          <button
            key={n.key}
            className={`nav-item ${page === n.key ? 'active' : ''}`}
            onClick={() => setPage(n.key)}
          >
            <span className="nav-icon">{n.icon}</span>
            {n.label}
          </button>
        ))}
        <div className="nav-sep" />
        <div className="tiny muted" style={{ padding: '4px 13px 8px', fontFamily: 'var(--font-round)' }}>运行与发布</div>
        {NAV2.map((n) => (
          <button
            key={n.key}
            className={`nav-item ${page === n.key ? 'active' : ''}`}
            onClick={() => setPage(n.key)}
          >
            <span className="nav-icon">{n.icon}</span>
            {n.label}
          </button>
        ))}
      </nav>

      <div className="mascot-box">
        <div className="mascot-face">{mascot.emoji}</div>
        <div className="mascot-say">{mascot.say}</div>
      </div>
    </aside>
  )
}
