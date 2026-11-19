import React, { createContext, useContext, useState, useCallback, useRef } from 'react'

const UIContext = createContext(null)

const EMOJI = {
  idle: '🤖', happy: '😄', thinking: '🤔', surprised: '😲', error: '😵',
  cheer: '🎉', wink: '😉', love: '🥰',
}

const IDLE = { emoji: '🤖', say: '嗨～今天想配置点什么？' }

export function UIProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const [mascot, setMascotState] = useState(IDLE)
  const timerRef = useRef(null)

  const toast = useCallback((message, level = 'info') => {
    const id = `${Date.now()}-${Math.random()}`
    setToasts((t) => [...t, { id, message, level }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600)
  }, [])

  const setMascot = useCallback((emojiOrKey, say, holdMs = 2600) => {
    const emoji = EMOJI[emojiOrKey] ? EMOJI[emojiOrKey] : emojiOrKey
    setMascotState({ emoji, say })
    if (timerRef.current) clearTimeout(timerRef.current)
    if (holdMs > 0) {
      timerRef.current = setTimeout(() => setMascotState(IDLE), holdMs)
    }
  }, [])

  return (
    <UIContext.Provider value={{ toast, setMascot, mascot }}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            <span className="t-emoji">{t.level === 'error' ? '😵' : t.level === 'warn' ? '⚠️' : t.level === 'success' ? '🎉' : '💬'}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </UIContext.Provider>
  )
}

export function useUI() {
  const ctx = useContext(UIContext)
  if (!ctx) throw new Error('useUI 必须在 UIProvider 内使用')
  return ctx
}
