import React, { useState, useRef, useEffect } from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'
import { useUI } from '../components/UIContext.jsx'
import { resolveActiveConfig, streamReply, consumeSafePoint, playTTS } from '../engine/chatEngine.js'
import { stripMeta } from '../engine/textClean.js'

const QUICK = ['今天天气真好呀！', '给我讲个冷笑话', '你是谁呀？', '周末去哪玩？']

export default function ChatPage() {
  useStoreState()
  const state = store.getState()
  const { toast, setMascot } = useUI()
  const session = state.sessions[0]
  const config = resolveActiveConfig()
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [botMood, setBotMood] = useState('idle')
  const msgsEndRef = useRef(null)
  const timersRef = useRef([])

  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session.context.length, streaming])

  useEffect(() => () => timersRef.current.forEach(clearTimeout), [])

  const send = async (text) => {
    const msg = (text || input).trim()
    if (!msg || busy) return
    setInput(''); setBusy(true); setStreaming('')
    setBotMood('thinking'); setMascot('thinking', '让我想想…', 0)

    store.appendMessage(session.sessionId, 'user', msg)

    // 流式生成回复（带当前生效配置标识）
    const finalText = await streamReply(msg, config, (partial) => {
      setStreaming(partial)
      setBotMood('thinking')
    })

    setStreaming('')
    store.appendMessage(session.sessionId, 'assistant', finalText)
    setBotMood('happy'); setMascot('happy', '说完啦！')
    playTTS(finalText, config)

    // === 安全点：TTS 播完的这一刻，消费配置变更 ===
    const t = setTimeout(() => {
      const switched = consumeSafePoint(session.sessionId)
      if (switched) {
        const changes = switched.switchHistory[0]?.changes?.join('，') || ''
        toast(`✅ 已在安全点切换到 v${switched.configVersion}，会话与 ${switched.context.length} 条上下文完整保留`, 'success')
        setMascot('surprised', `切换到 v${switched.configVersion} 啦！`, 3200)
        setBotMood('surprised')
      }
      setBusy(false)
    }, 500)
    timersRef.current.push(t)
  }

  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }

  const moodEmoji = {
    idle: config.avatar?.emoji || '🤖',
    thinking: config.avatar?.expressions?.thinking || '🤔',
    happy: config.avatar?.expressions?.happy || '😄',
    surprised: config.avatar?.expressions?.surprised || '😲',
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>💬 对话演示</h2>
          <p>在此验证：配置发布后下一个轮次即生效，且会话上下文、身份、话题完整保留。</p>
        </div>
        <span className="spacer" />
        {session.pendingSwitch && <span className="badge warn">⏳ 有配置待切换 · 本轮结束后生效</span>}
      </div>

      <div className="chat-sim">
        {/* 对话窗口 */}
        <div className="sim-window">
          <div className="sim-head">
            <div className="sim-avatar">{moodEmoji[botMood]}</div>
            <div>
              <div>{config.avatar?.name || '小智'}</div>
              <div className="tiny" style={{ opacity: .85, fontFamily: 'var(--font-body)' }}>
                会话 {session.sessionId} · 话题：{session.topic} · 上下文 {session.context.length} 条
              </div>
            </div>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="badge" style={{ background: '#fff' }}>v{session.configVersion}</span>
          </div>

          <div className="sim-msgs">
            {session.context.filter((m) => m.role !== 'system').map((m, i) => (
              <div className={`sim-msg ${m.role === 'user' ? 'user' : ''}`} key={i}>
                <div className="sim-face">{m.role === 'user' ? '😊' : (config.avatar?.emoji || '🤖')}</div>
                <div style={{ maxWidth: '76%' }}>
                  <div className="who">{m.role === 'user' ? '我' : config.avatar?.name || '小智'} · <span className="muted">v{m.configVersion ?? 0}</span></div>
                  <div className={`chat-bubble ${m.role === 'user' ? 'user' : 'bot'}`}>{m.role === 'assistant' ? stripMeta(m.content) : m.content}</div>
                </div>
              </div>
            ))}
            {streaming && (
              <div className="sim-msg">
                <div className="sim-face">{moodEmoji.thinking}</div>
                <div style={{ maxWidth: '76%' }}>
                  <div className="who">{config.avatar?.name || '小智'} · 正在生成</div>
                  <div className="chat-bubble bot">{stripMeta(streaming)}<span className="blink">▍</span></div>
                </div>
              </div>
            )}
            <div ref={msgsEndRef} />
          </div>

          <div className="sim-input-bar">
            <input className="input" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} placeholder="和小智说点什么…（Enter 发送）" disabled={busy} />
            <button className="btn btn-primary" onClick={() => send()} disabled={busy || !input.trim()}>{busy ? '⏳' : '➤ 发送'}</button>
          </div>
          <div className="row wrap" style={{ padding: '0 12px 12px', gap: 6 }}>
            <span className="tiny muted">快捷：</span>
            {QUICK.map((q) => <button key={q} className="tag" style={{ cursor: 'pointer' }} onClick={() => send(q)} disabled={busy}>{q}</button>)}
          </div>
        </div>

        {/* 侧栏：当前生效配置 + 上下文 + 切换记录 */}
        <div className="sim-side">
          <h4>🎯 当前生效配置 · v{config.version}</h4>
          <div className="active-stack">
            {[
              ['🧠', 'AI 模型', config.model?.name],
              ['🎨', '虚拟形象', config.avatar?.name],
              ['🎵', '语音音色', config.voice?.name],
              ['💖', 'AI 人设', config.persona?.name],
            ].map(([emoji, type, name]) => (
              <div className="active-item" key={type}>
                <span className="a-emoji">{emoji}</span>
                <div><div className="a-type">{type}</div><div className="a-name">{name || '—'}</div></div>
              </div>
            ))}
          </div>

          {/* 音色明细：展示来源标记与声学特征，便于验证克隆音色确实被加载 */}
          {config.voice && (
            <div className="voice-detail">
              <div className="vd-head">
                <b className="tiny">音色来源与特征</b>
                <span className={`tag ${config.voice.sourceType === 'clone' ? 'tag-clone' : ''}`}>
                  {config.voice.sourceType === 'clone' ? '克隆音色' : config.voice.sourceType === 'preset' ? '系统预置' : '参数调节'}
                </span>
              </div>
              <div className="tiny muted vd-line">
                音色 ID：<b>{config.voice.voiceId || '—'}</b>
              </div>
              {config.voice.features?.f0 > 0 && (
                <div className="tiny muted vd-line">
                  基频：<b>{Math.round(config.voice.features.f0)}Hz</b>
                  {config.voice.features.brightness != null && <> · 明亮度 <b>{config.voice.features.brightness.toFixed(2)}</b></>}
                </div>
              )}
              <div className="tiny muted vd-line">
                音调 <b>{(config.voice.params?.pitch ?? 1).toFixed(2)}×</b> · 语速 <b>{(config.voice.params?.speed ?? 1).toFixed(2)}×</b>
                {' · '}{config.voice.params?.gender === 'male' ? '偏男声' : config.voice.params?.gender === 'female' ? '偏女声' : '中性'}
              </div>
            </div>
          )}

          <h4>🧩 会话上下文（迁移后可追溯）</h4>
          <div className="ctx-list">
            {session.context.slice(-5).map((m, i) => (
              <div className="ctx-msg" key={i}>
                <span className="ctx-tag">{m.role === 'user' ? '👤 用户' : m.role === 'system' ? '⚙️ 系统' : '🤖 助手'}</span>
                <span className="muted"> · v{m.configVersion ?? 0}</span><br />
                {(() => { const t = m.role === 'assistant' ? stripMeta(m.content) : m.content; return t.slice(0, 46) + (t.length > 46 ? '…' : '') })()}
              </div>
            ))}
          </div>

          <h4 style={{ marginTop: 18 }}>🔄 切换记录</h4>
          {session.switchHistory.length === 0 ? (
            <p className="tiny muted">暂无切换。去发布中心发布新配置，再回来发一条消息即可观察热切换。</p>
          ) : (
            <div className="timeline">
              {session.switchHistory.map((h, i) => (
                <div className="tl-item" key={i}>
                  <div className="tl-dot"></div>
                  <div className="tl-card">
                    <b className="tiny">v{h.fromVersion} → v{h.toVersion}</b>
                    <div className="tiny muted mt">{h.changes.join('，')}</div>
                    <div className="tiny muted mt">🕐 {h.time} · 保留 {h.messageCount} 条上下文</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
