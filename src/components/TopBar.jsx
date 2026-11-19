import React from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'

export function TopBar({ page, onPublish, onGotoPublish }) {
  useStoreState()
  const state = store.getState()
  const session = state.sessions[0]
  const hasDraftChanges = JSON.stringify(state.draftBinding) !== JSON.stringify(state.publishedBinding)
  const pending = session?.pendingSwitch

  const titles = {
    model: 'AI 模型管理', avatar: '虚拟形象管理', voice: '语音音色管理',
    persona: 'AI 人设管理', chat: '对话演示', publish: '发布中心', settings: '系统设置',
  }

  return (
    <header className="topbar">
      <h1>{titles[page] || '小智配置台'}</h1>
      <span className="spacer" />
      <span className="version-chip">🏷️ 生效版本 v{state.currentVersion}</span>
      <span className="session-chip" title={pending ? '配置已发布，等待会话安全点切换' : '会话上下文存活中'}>
        <span className={`dot ${pending ? 'pending' : ''}`}></span>
        {pending ? '切换待生效' : '会话在线 · 上下文保留'}
      </span>
      {hasDraftChanges && <span className="badge warn">● 有未发布改动</span>}
      {page !== 'publish' && (
        <button className="btn btn-primary btn-sm" onClick={() => { onGotoPublish?.(); }}>
          🚀 去发布
        </button>
      )}
    </header>
  )
}

export function StatusBar() {
  useStoreState()
  const state = store.getState()
  const latestEvent = state.events[0]
  return (
    <footer className="statusbar">
      <span className="sb-item">📡 设备连接 <strong>模拟设备 · 在线</strong></span>
      <span className="sb-item">🖥️ 在线设备 <strong>1 台</strong></span>
      <span className="sb-item">🧩 协议 <strong>MQTT+UDP · hello v3</strong></span>
      <span className="sb-item">💾 存储 <strong>localStorage</strong></span>
      <span className="spacer" style={{ flex: 1 }} />
      <span className="sb-item">
        {latestEvent ? `📢 ${latestEvent.message}` : '📢 就绪'}
      </span>
    </footer>
  )
}
