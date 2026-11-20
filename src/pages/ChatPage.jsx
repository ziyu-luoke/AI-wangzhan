import React, { useState, useRef, useEffect } from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'
import { useUI } from '../components/UIContext.jsx'
import { resolveActiveConfig, streamReply, consumeSafePoint, playTTS } from '../engine/chatEngine.js'
import { stopClonedSpeech } from '../engine/adapters.js'
import { stripMeta } from '../engine/textClean.js'
import AvatarFace from '../components/AvatarFace.jsx'
import { detectMood, dominantMood, MOOD_EMOJI } from '../engine/moodEngine.js'
import { identitySummary } from '../engine/personaHelper.js'

const QUICK = ['今天天气真好呀！', '给我讲个冷笑话', '你是谁呀？', '周末去哪玩？']

export default function ChatPage() {
  useStoreState()
  const state = store.getState()
  const { toast, setMascot } = useUI()
  const session = state.sessions[0]
  const config = resolveActiveConfig()
  // AI 身份名 = 当前生效虚拟形象名；无形象时才回退人设名/中性称呼，绝不写死"小智"
  const aiName = config.avatar?.name || config.persona?.name || 'AI 助手'
  const identity = identitySummary(config.avatar, config.persona)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState('')
  const [busy, setBusy] = useState(false)
  const [botMood, setBotMood] = useState('idle')
  const [activeMsgMood, setActiveMsgMood] = useState(null) // 正在朗读的那条助手消息的气质（按句变化）
  const pageRef = useRef(null)      // 对话页根节点：整页滚动目标，滚到这里可同时看到消息框与输入区
  const msgsBoxRef = useRef(null)   // 消息列表容器：只滚动它自身，避免牵动整页
  const timersRef = useRef([])

  // 消息区内部跟随最新内容（含流式输出）：只滚动内部容器，不触发整页滚动。
  // 旧实现把"消息末尾"scrollIntoView 默认 block:'start' 顶到视口顶部，
  // 导致下方输入区被挤出视野、侧栏露出（错误位置）。
  useEffect(() => {
    const box = msgsBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [session.context.length, streaming])

  // 整页滚动：仅在进入对话页（从其他界面返回）与消息数变化（发送/新对话/人设切换）时，
  // 把对话页顶部对齐到视口，确保对话框与输入区完整可见；
  // streaming 变化不触发，避免流式输出过程反复把页面拉回顶部、影响正常浏览。
  useEffect(() => {
    pageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [session.context.length])

  useEffect(() => () => {
    timersRef.current.forEach(clearTimeout)
    stopClonedSpeech()
  }, [])

  // 新对话：原地清空当前会话消息，用当前生效人设的 greeting 自动打头；不弹保存提示
  const newChat = () => {
    stopClonedSpeech()
    timersRef.current.forEach(clearTimeout)
    timersRef.current = []
    store.resetSession(session.sessionId, config.persona)
    setInput(''); setStreaming(''); setBusy(false)
    setBotMood('idle'); setActiveMsgMood(null)
    setMascot('happy', '开启新对话啦～')
    const g = String(config.persona?.greeting || '').trim()
    toast(g ? `已开启新对话，并以人设「${config.persona?.name || '默认'}」向你问好` : '已开启新对话', 'success')
  }

  const send = async (text) => {
    const msg = (text || input).trim()
    if (!msg || busy) return
    setInput(''); setBusy(true); setStreaming('')
    setBotMood('thinking'); setActiveMsgMood(null); setMascot('thinking', '让我想想…', 0)
    // 新一轮开始：打断上一轮尚未播完的克隆语音，避免两段声音叠加
    stopClonedSpeech()

    store.appendMessage(session.sessionId, 'user', msg)

    // 流式生成回复（带当前生效配置标识）
    const finalText = await streamReply(msg, config, (partial) => {
      setStreaming(partial)
      setBotMood('thinking')
    })

    setStreaming('')
    store.appendMessage(session.sessionId, 'assistant', finalText)

    // 朗读开始：顶部头像先用正文推断出的主语气，随后随每一句切换
    const startMood = dominantMood(finalText)
    setBotMood(startMood)
    setActiveMsgMood(startMood)
    setMascot(startMood, '说完啦！')

    // 朗读完成：头像与历史消息统一回落到 idle 图
    const onSpeechSentence = (sentence) => {
      const mood = detectMood(sentence) || 'idle'
      setBotMood(mood)
      setActiveMsgMood(mood)
    }
    const onSpeechDone = () => {
      setBotMood('idle')
      setActiveMsgMood(null)
    }

    // 语音播报：真克隆音色走云端合成（本人声音），本地音色用系统语音 + 派生参数
    const voiceName = config.voice?.name || '默认音色'
    let speechStarted = false
    if (!config.voice) {
      toast('未加载生效音色，请到发布中心绑定后再试', 'warn')
    } else if (config.voice.ttsMode === 'cloned' && config.voice.realVoiceId) {
      speechStarted = playTTS(finalText, config, { onSentence: onSpeechSentence, onDone: onSpeechDone })
      toast(`正在用克隆音色「${voiceName}」播放`, 'info')
    } else {
      const speaks = typeof window !== 'undefined' && 'speechSynthesis' in window
      const played = speaks ? playTTS(finalText, config, { onSentence: onSpeechSentence, onDone: onSpeechDone }) : false
      speechStarted = !!played
      if (!speaks) {
        toast('当前浏览器不支持语音合成，回复已正常显示（音色播放不可用）', 'warn')
      } else if (!played) {
        toast(`音色「${voiceName}」无正文可播报`, 'info')
      }
    }
    // 无正文可播时，直接回落 idle，避免头像卡在 thinking
    if (!speechStarted) {
      const t0 = setTimeout(onSpeechDone, 400)
      timersRef.current.push(t0)
    }

    // === 安全点：TTS 播完的这一刻，消费配置变更 ===
    const t = setTimeout(() => {
      const switched = consumeSafePoint(session.sessionId)
      if (switched) {
        const rec = switched.switchHistory[0] || {}
        const changes = (rec.changes || []).join('，')
        if (rec.personaChanged) {
          // 人设变了：store 已清空上下文并以新 greeting 开新对话，这里只做 UI 复位与提示
          setStreaming(''); setBotMood('idle'); setActiveMsgMood(null)
          toast(`✅ 已切换到 v${switched.configVersion}；人设变更，已开启新对话`, 'success')
          setMascot('surprised', '换人设啦，重新认识一下！', 3200)
        } else {
          toast(`✅ 已在安全点切换到 v${switched.configVersion}，会话与 ${switched.context.length} 条上下文完整保留`, 'success')
          setMascot('surprised', `切换到 v${switched.configVersion} 啦！`, 3200)
        }
        setBotMood('surprised')
        const tReset = setTimeout(() => setBotMood('idle'), 1400)
        timersRef.current.push(tReset)
      }
      setBusy(false)
    }, 500)
    timersRef.current.push(t)
  }

  const onKey = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }

  // 顶部头像 / 每条消息头像都走 AvatarFace：有对应表情图就显示图，否则显示内置 emoji
  const topMood = botMood
  const visible = session.context.filter((m) => m.role !== 'system')
  const lastAssistantIdx = (() => {
    for (let i = visible.length - 1; i >= 0; i--) if (visible[i].role === 'assistant') return i
    return -1
  })()

  return (
    <div ref={pageRef}>
      <div className="page-head">
        <div>
          <h2>💬 对话演示</h2>
          <p>在此验证：配置发布后下一个轮次即生效，且会话上下文、身份、话题完整保留；头像随回答语气切换，读完回落 idle。</p>
        </div>
        <span className="spacer" />
        {session.pendingSwitch && <span className="badge warn">⏳ 有配置待切换 · 本轮结束后生效</span>}
        <button className="btn btn-sm btn-blue" onClick={newChat} disabled={busy}>🆕 新对话</button>
      </div>

      <div className="chat-sim">
        {/* 对话窗口 */}
        <div className="sim-window">
          <div className="sim-head">
            <AvatarFace avatar={config.avatar} mood={topMood} className="sim-avatar" />
            <div>
              <div>{aiName}</div>
              <div className="tiny" style={{ opacity: .85, fontFamily: 'var(--font-body)' }}>
                会话 {session.sessionId} · 话题：{session.topic} · 上下文 {session.context.length} 条
              </div>
            </div>
            <span className="spacer" style={{ flex: 1 }} />
            <span className="badge" style={{ background: '#fff' }}>v{session.configVersion}</span>
          </div>

          <div className="sim-msgs" ref={msgsBoxRef}>
            {visible.map((m, i) => {
              const isAssistant = m.role === 'assistant'
              const isSpeaking = isAssistant && i === lastAssistantIdx && !!activeMsgMood
              const mood = isSpeaking ? activeMsgMood : 'idle'
              return (
                <div className={`sim-msg ${m.role === 'user' ? 'user' : ''}`} key={i}>
                  {m.role === 'user'
                    ? <div className="sim-face">😊</div>
                    : <AvatarFace avatar={config.avatar} mood={mood} className="sim-face" />}
                  <div style={{ maxWidth: '76%' }}>
                    <div className="who">{m.role === 'user' ? '我' : aiName} · <span className="muted">v{m.configVersion ?? 0}</span></div>
                    <div className={`chat-bubble ${m.role === 'user' ? 'user' : 'bot'}`}>{isAssistant ? stripMeta(m.content) : m.content}</div>
                  </div>
                </div>
              )
            })}
            {streaming && (
              <div className="sim-msg">
                <AvatarFace avatar={config.avatar} mood="thinking" className="sim-face" />
                <div style={{ maxWidth: '76%' }}>
                  <div className="who">{aiName} · 正在生成</div>
                  <div className="chat-bubble bot">{stripMeta(streaming)}<span className="blink">▍</span></div>
                </div>
              </div>
            )}
          </div>

          <div className="sim-input-bar">
            <input className="input" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} placeholder={`和${aiName}说点什么…（Enter 发送）`} disabled={busy} />
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
              ['💖', 'AI 人设', config.persona?.name || '未绑定'],
            ].map(([emoji, type, name]) => (
              <div className="active-item" key={type}>
                <span className="a-emoji">{emoji}</span>
                <div><div className="a-type">{type}</div><div className="a-name">{name || '—'}</div></div>
              </div>
            ))}
          </div>

          {/* 名字来自形象、身份来自 AI 人设：两者分离，便于验证切换即时生效且不串扰 */}
          <div className="voice-detail">
            <div className="vd-head"><b className="tiny">🪪 名字与身份</b><span className="tag tag-on">{aiName}</span></div>
            <div className="tiny muted vd-line">名字（形象名，问"你是谁"时回答）：<b>{identity.name}</b></div>
            <div className="tiny muted vd-line">身份标识（人设名，仅问"你的身份"时回答）：<b>{identity.identityName || '未设置'}</b></div>
            <div className="tiny muted vd-line">语气：<b>{identity.tags.join('、') || '默认'}</b></div>
            {identity.content && <div className="tiny muted vd-line">回复规则摘要：{String(identity.content).slice(0, 46)}{String(identity.content).length > 46 ? '…' : ''}</div>}
          </div>

          {/* 形象表情图状态：验证 5 类图是否齐全 */}
          {config.avatar && (
            <div className="voice-detail">
              <div className="vd-head"><b className="tiny">形象表情图</b><span className="tag">{Object.keys(config.avatar.expressionImages || {}).length}/5 类</span></div>
              <div className="tiny muted vd-line">缺图的表情自动用内置 emoji 顶替；朗读时按句切换，读完回落 idle。</div>
            </div>
          )}

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
                {(() => {
                  // 动态身份条目随当前生效形象变化，避免历史里残留固定"小智"
                  if (m.role === 'system' && m.dynamic) return `当前身份：${aiName}（语气：${identity.tags.join('、') || '默认'}）`
                  const t = m.role === 'assistant' ? stripMeta(m.content) : m.content
                  return t.slice(0, 46) + (t.length > 46 ? '…' : '')
                })()}
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
