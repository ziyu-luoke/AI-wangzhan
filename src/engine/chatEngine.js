// 对话编排器：管理 conversation 状态机，在安全点消费配置变更事件
// 这是"即时生效 + 会话不丢"的核心执行逻辑

import { store } from '../store/store.js'
import { modelAdapter, voiceAdapter } from './adapters.js'
import { buildSystemPrompt } from './personaHelper.js'
import { stripMeta, stripForSpeech } from './textClean.js'

// 归一化音色资源：保证 params / features / gender 三个字段始终存在且自洽。
// 克隆音色来自 voiceClone.deriveParams（pitch/speed/emotion/gender）与 extractFeatures（基频等）；
// 预置音色没有实测特征，features 为 null —— 二者都必须能被 speak() 正常消费，
// 否则旧数据（缺字段）会让对话侧的音色退化成「一把嗓子空转调」。
function normalizeVoice(voice) {
  if (!voice) return null
  const p = voice.params || {}
  const gender = p.gender || voice.gender || 'neutral'
  return {
    ...voice,
    gender,
    features: voice.features || null,
    params: {
      pitch: Number.isFinite(+p.pitch) ? +p.pitch : 1,
      speed: Number.isFinite(+p.speed) ? +p.speed : 1,
      emotion: Number.isFinite(+p.emotion) ? +p.emotion : 0.5,
      gender,
    },
  }
}

// 根据当前生效绑定解析出四类资源
// 生效绑定优先取已发布版本（publishedBinding），未发布时回落到草稿绑定。
// voice 必须是「当前生效绑定指向的音色资源」本身——它携带克隆音色派生的
// params（pitch/speed/emotion/gender）与 features（基频等），
// speak() 会据此挑选系统语音并设置参数，从而真正加载克隆音色。
export function resolveActiveConfig() {
  const s = store.getState()
  const b = s.publishedBinding || s.draftBinding
  const voice = s.resources.voice.find(r => r.id === b.voiceId)
  return {
    model: s.resources.model.find(r => r.id === b.modelId),
    avatar: s.resources.avatar.find(r => r.id === b.avatarId),
    voice: normalizeVoice(voice),
    persona: s.resources.persona.find(r => r.id === b.personaId),
    version: s.currentVersion,
    sessionId: s.sessions[0]?.sessionId,
  }
}

// 生成机器人回复（真实模型流式调用，经本地安全代理）
export async function streamReply(userText, config, onChunk) {
  const s = store.getState()
  const session = s.sessions.find((x) => x.sessionId === config.sessionId) || s.sessions[0]
  // 构造规范消息：以「当前生效虚拟形象」的身份+人设插值成 system
  // （形象名 = AI 自称；形象专属人设优先，全局人设兜底），+ 最近 6 条上下文 + 当前输入。
  // 历史消息里 role=system 的旧条目一律剔除，彻底避免旧的固定身份被带入造成串扰。
  const systemPrompt = buildSystemPrompt(config.persona, session.identity || {}, config.avatar)
  const canonical = [
    { role: 'system', content: systemPrompt },
    ...session.context.filter((m) => m.role !== 'system').slice(-6).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ]
  let body = ''
  let lastError = null

  // 主模型
  try {
    for await (const chunk of modelAdapter.stream(config.model, canonical)) {
      body += chunk
      onChunk?.(body)
    }
  } catch (e) {
    lastError = e
  }

  // 主模型失败 → 真实调用备用模型（不再用模板造假）
  if (lastError) {
    const fallbackId = s.publishedBinding?.fallbackIds?.model
    const fallback = s.resources.model.find((r) => r.id === fallbackId && r.id !== config.model?.id)
    if (fallback) {
      try {
        body = ''
        for await (const chunk of modelAdapter.stream(fallback, canonical)) {
          body += chunk
          onChunk?.(body)
        }
        store.pushEvent('fallback', `主模型不可用（${lastError.message.slice(0, 40)}），已降级到备用模型「${fallback.name}」`, 'warn')
        lastError = null
      } catch (e2) {
        lastError = e2
      }
    }
  }

  // 主备都失败 → 明确报错，绝不伪造模型回复
  // 错误信息只写入事件流，不拼进回复正文（对话区只显示模型真实正文）
  if (lastError) {
    store.pushEvent('error', `模型调用失败：${lastError.message}`, 'error')
    body = ''
  }

  // 保险起见再清洗一次：去除模型中可能自行输出的元信息标注
  // 对话区、上下文、播报统一只使用这份纯正文，确保不重复、不混入配置标注
  const clean = stripMeta(body)
  onChunk?.(clean)
  return clean
}

// 安全点：当前轮次结束（TTS 播完）后，消费 pendingSwitch
export function consumeSafePoint(sessionId) {
  const s = store.getState()
  const session = s.sessions.find((x) => x.sessionId === sessionId)
  if (!session?.pendingSwitch) return null
  return store.applyPendingSwitch(sessionId)
}

// 播放 TTS（音色适配器），返回是否发声
// 只朗读正文：剥离配置元信息标注，且不朗读、不解释表情包（emoji 直接去掉，不转成文字）
// 传入的 config.voice 就是当前生效绑定指向的音色资源，
// 其中携带克隆音色派生的 pitch/speed/emotion/gender，
// speak() 会按 gender 挑选系统语音 —— 这就是「克隆音色真正被加载」的落点。
export function playTTS(text, config, callbacks = {}) {
  if (!config.voice) return false
  const spoken = stripForSpeech(text)
  if (!spoken.trim()) return false
  return voiceAdapter.speak(spoken, config.voice, callbacks)
}
