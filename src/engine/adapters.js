// 适配器层：屏蔽模型/音色/形象/设备供应商差异
// 模型适配器已接入本地安全代理（真实 DeepSeek API）；其余保持 Mock，接口不变
// 密钥只在服务端 .env，浏览器仅传 apiKeyRef 引用（env:变量名），永不接触明文

import { generateAvatarCandidates } from './avatarGen.js'
import { decodeAudioFile } from './audioDecode.js'
import { cloneFromAudio, extractFeatures, deriveParams } from './voiceClone.js'

// ---------- 模型适配器（真实 API，经本地代理）----------
export const modelAdapter = {
  capabilities(resource) {
    return resource.capabilities || {}
  },

  // 连通性测试：走服务端一次真实最小调用（max_tokens=16），不做假成功
  async healthCheck(resource) {
    try {
      const res = await fetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: resource.endpoint,
          modelId: resource.modelId,
          apiKeyRef: resource.apiKeyRef,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return { ok: false, message: data.error || `代理返回 ${res.status}` }
      return data
    } catch (e) {
      return { ok: false, message: '无法连接本地模型代理，请确认已执行 npm run dev（后端随前端一起启动）' }
    }
  },

  // 真实流式回复：从本地代理读取 SSE，逐块吐出 delta.content
  // 参数：resource=模型资源；messages=规范消息(含 system)；signal=可选中止信号
  async *stream(resource, messages, signal) {
    let res
    try {
      res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: resource.endpoint,
          modelId: resource.modelId,
          apiKeyRef: resource.apiKeyRef,
          params: resource.params || {},
          messages,
          stream: true,
        }),
        signal,
      })
    } catch (e) {
      if (e.name === 'AbortError') return
      throw new Error('无法连接本地模型代理，请确认 npm run dev 正在运行')
    }

    if (!res.ok || !res.body) {
      let msg = `模型服务返回 ${res.status}`
      try { msg = (await res.json()).error || msg } catch { /* 忽略解析失败 */ }
      throw new Error(msg)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try {
          const json = JSON.parse(data)
          if (json.error) throw new Error(json.error)
          if (json.content) yield json.content
        } catch (e) {
          if (e instanceof SyntaxError) continue
          throw e
        }
      }
    }
  },
}

// ---------- 音色适配器 ----------
//
// 核心原则（对应契约 B3）：克隆音色必须被「真正加载」，
// 而不是只对同一条系统语音做变调。因此 speak() 的第一步是按音色性别
// 从系统语音列表里挑一把合适的嗓子，再叠加 pitch/rate/volume 参数。

// 系统语音列表在部分浏览器是异步就绪的：
// 首次调用 speechSynthesis.getVoices() 可能返回空数组，
// 必须监听 voiceschanged 并设置超时兜底，才能稳定拿到列表。
const VOICE_LIST_TIMEOUT = 1500

// 系统语音的性别判定词表。
// 注意顺序：先判 female 再判 male —— 因为 'female' 里含 'male'、'woman' 里含 'man'。
const FEMALE_HINTS = [
  /female/i, /woman/i, /girl/i, /女/,
  /xiaoxiao/i, /xiaoyi/i, /xiaohan/i, /xiaomo/i, /xiaorui/i, /xiaoshuang/i,
  /xiaoxuan/i, /xiaoyan/i, /xiaoyou/i, /xiaozhen/i, /yunxia/i,
  /ting-?ting/i, /tingting/i, /huihui/i, /yaoyao/i, /sin-?ji/i, /mei-?jia/i,
  /hiugaai/i, /hiumaan/i, /yu-?shu/i,
  /aria/i, /jenny/i, /samantha/i, /victoria/i, /zira/i, /susan/i, /karen/i,
]
const MALE_HINTS = [
  /male/i, /\bman\b/i, /\bboy\b/i, /男/,
  /yunxi/i, /yunjian/i, /yunyang/i, /yunfeng/i, /yunhao/i, /kangkang/i,
  /david/i, /daniel/i, /mark/i, /george/i, /fred/i, /james/i, /thomas/i, /alex/i,
]

/**
 * 判定一条系统语音的性别倾向。
 * 先看 name 里的关键词（中文名如「晓晓 / 云希」，英文名如 Xiaoxiao / Yunxi），
 * 判不出时按 lang 归为 neutral。
 */
export function detectVoiceGender(name, lang) {
  const n = String(name || '')
  if (FEMALE_HINTS.some((re) => re.test(n))) return 'female'
  if (MALE_HINTS.some((re) => re.test(n))) return 'male'
  return 'neutral'
}

/** 把 SpeechSynthesisVoice 转成对外暴露的轻量描述 */
function toVoiceInfo(v) {
  return {
    id: v.voiceURI || v.name,
    name: v.name,
    lang: v.lang,
    gender: detectVoiceGender(v.name, v.lang),
  }
}

// 解码结果缓存：同一个 File 对象只解码一次。
// 克隆流程的「步骤0 真实解码校验」与「步骤2 生成候选」共用同一份解码数据，
// 避免对大文件重复解码（decodeAudioData 对 20MB 音频可能要数秒）。
const decodedCache = new WeakMap()

async function decodeOnce(file) {
  if (file && decodedCache.has(file)) return decodedCache.get(file)
  const decoded = await decodeAudioFile(file)
  if (file) decodedCache.set(file, decoded)
  return decoded
}

// 把用户选择的音频 File 转成 Base64 Data URI，交给本地代理上传给语音平台。
// 用 FileReader 而非 file.arrayBuffer()，兼容性更好。
function fileToDataUri(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取音频文件失败'))
    reader.readAsDataURL(file)
  })
}

// 轮询音色部署状态：创建后服务端为 DEPLOYING，需等到 OK 才能合成。
// 最多等 ~20 秒（10 次 × 2 秒），超时则抛错，由上层降级处理。
async function waitVoiceReady(voiceId, onProgress) {
  for (let i = 0; i < 10; i++) {
    await delay(2000)
    try {
      const res = await fetch('/api/tts/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId }),
      })
      const data = await res.json().catch(() => ({}))
      if (data.status === 'OK') return true
      if (data.status === 'FAILED') throw new Error('平台音色部署失败，请更换样本重试')
      try { onProgress?.(88 + i, `音色部署中…（${i + 1}/10）`) } catch { /* ignore */ }
    } catch (e) {
      // 网络抖动不立即放弃，继续轮询
      if (/部署失败/.test(e?.message || '')) throw e
    }
  }
  throw new Error('音色部署超时（20s），请稍后在音色列表中重试')
}

// 真·克隆：通过本地代理调用语音平台创建克隆音色。
// 返回带 realVoiceId 的候选；任何失败都向上抛，由 clone() 统一降级。
async function cloneViaCloud(file, name, count, genderOverride, onProgress) {
  try { onProgress?.(20, '上传样本并创建克隆音色…') } catch { /* ignore */ }
  const audio = await fileToDataUri(file)
  const res = await fetch('/api/tts/clone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio }),
  })
  let data
  try { data = await res.json() } catch { data = {} }
  if (!res.ok || !data.ok) throw new Error(data.error || `音色创建失败（${res.status}）`)
  const voiceId = data.voiceId
  try { onProgress?.(85, '等待音色就绪…') } catch { /* ignore */ }
  await waitVoiceReady(voiceId, onProgress)
  // 真实特征仍要算：候选卡片展示实测基频/明亮度，与参数面板一致
  let features = null
  let params = { pitch: 1, speed: 1, emotion: 0.6, gender: genderOverride || 'neutral' }
  try {
    const decoded = await decodeOnce(file)
    if (decoded.ok) {
      features = extractFeatures(decoded.samples, decoded.sampleRate)
      params = deriveParams(features)
      if (genderOverride && ['male', 'female', 'neutral'].includes(genderOverride)) params.gender = genderOverride
    }
  } catch { /* 特征失败不影响真克隆音色本身 */ }
  // 云克隆一次得到一个真实音色；count=3 时用同一 voiceId 生成不同语速的候选供挑选
  const list = []
  for (let i = 0; i < count; i++) {
    const speedBias = 1 + (i - (count - 1) / 2) * 0.06
    list.push({
      id: `${voiceId}::${i}`,
      voiceId: `${voiceId}::${i}`,
      realVoiceId: voiceId,
      ttsMode: 'cloned',
      name: i === 0 ? name : `${name} · 变体${i + 1}`,
      params: { ...params, speed: Math.min(2, Math.max(0.5, +(params.speed * speedBias).toFixed(3))) },
      features,
      source: 'clone',
    })
  }
  return list
}

/**
 * 从系统语音列表里挑一条最合适的嗓子。
 * 优先级：中文语音 > 性别匹配 > 任意可用语音。
 * 找不到匹配性别时降级为默认语音（仍会设置 pitch/rate/volume），不静默失败。
 */
function pickSystemVoice(rawVoices, gender) {
  if (!Array.isArray(rawVoices) || rawVoices.length === 0) return null
  // 中文优先
  let pool = rawVoices.filter((v) => /^zh/i.test(v.lang || ''))
  if (pool.length === 0) pool = rawVoices
  if (gender && gender !== 'neutral') {
    const matched = pool.filter((v) => detectVoiceGender(v.name, v.lang) === gender)
    if (matched.length > 0) pool = matched
  }
  // 本地语音优先（无需联网，延迟更低），同组内按名称排序保证结果稳定可复现
  return [...pool].sort((a, b) => {
    const la = a.localService ? 0 : 1
    const lb = b.localService ? 0 : 1
    if (la !== lb) return la - lb
    return String(a.name).localeCompare(String(b.name))
  })[0] || null
}

// ---------- 克隆音色的句子级流水线播放（P0：降低首字延迟）----------
// 背景：云端合成耗时近似线性于文本长度（实测约 0.1s/字 + 1.3s 固定开销）。
// 整段 200 字要等 ~20s 才开口。这里把回复切成句子：首句即可合成播放，
// 播放当前句的同时后台预合成下一句，从而把「首字延迟」降到首句的合成时间。
const SENTENCE_MIN = 8   // 太短的片段不单独合成（固定开销不划算），并入相邻句
const SENTENCE_MAX = 42  // 太长的句子再按逗号切，避免单句合成过久
const PREFETCH_MAX = 80  // 客户端预取表上限，防止长会话累积 blob URL

// 把纯文本切成适合逐句合成的句子数组。逐字符扫描，避免依赖 lookbehind 正则的兼容性。
export function splitIntoSentences(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return []
  const STRONG = '。！？!?；;\n'
  const WEAK = '，,、'
  const segs = []
  let cur = ''
  for (const ch of raw) {
    cur += ch
    if (STRONG.includes(ch)) { segs.push(cur); cur = '' }
  }
  if (cur.trim()) segs.push(cur)

  const out = []
  let buf = ''
  const flush = (force) => { if (buf && (force || buf.length >= SENTENCE_MIN)) { out.push(buf); buf = '' } }
  for (const seg of segs) {
    if (seg.length > SENTENCE_MAX) {
      flush(true)
      let sub = ''
      for (const ch of seg) {
        sub += ch
        if (sub.length >= SENTENCE_MIN && (WEAK.includes(ch) || sub.length >= SENTENCE_MAX)) { out.push(sub); sub = '' }
      }
      if (sub.trim()) out.push(sub)
    } else if ((buf + seg).length > SENTENCE_MAX && buf) {
      flush(true); buf = seg; flush(false)
    } else {
      buf += seg; flush(false)
    }
  }
  if (buf.trim()) {
    if (out.length && (out[out.length - 1] + buf).length <= SENTENCE_MAX) out[out.length - 1] += buf
    else out.push(buf)
  }
  return out.length ? out : [raw]
}

// 播放运行时：seq 用于打断旧队列；urls 统一回收；prefetch 做客户端去重（同轮内）
const speechRuntime = {
  seq: 0,
  audio: null,
  urls: new Set(),
  prefetch: new Map(),
}

function cleanupSpeechUrls() {
  for (const u of speechRuntime.urls) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } }
  speechRuntime.urls.clear()
  speechRuntime.prefetch.clear()
}

// 合成单句 → blob URL；同轮内相同句子复用，避免重复请求
function synthOne(text, voiceId) {
  const key = `${voiceId}|${text}`
  if (speechRuntime.prefetch.has(key)) return speechRuntime.prefetch.get(key)
  const p = (async () => {
    try {
      const res = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceId }),
      })
      if (!res.ok) return null
      const blob = await res.blob()
      if (blob.size < 32) return null
      const url = URL.createObjectURL(blob)
      speechRuntime.urls.add(url)
      return url
    } catch { return null }
  })()
  speechRuntime.prefetch.set(key, p)
  if (speechRuntime.prefetch.size > PREFETCH_MAX) {
    const oldest = speechRuntime.prefetch.keys().next().value
    speechRuntime.prefetch.delete(oldest)
  }
  return p
}

function playAudioUrl(url) {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined') return resolve(false)
    const a = new Audio(url)
    speechRuntime.audio = a
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      if (speechRuntime.audio === a) speechRuntime.audio = null
      resolve(v)
    }
    a.onended = () => done(true)
    a.onerror = () => done(false)
    try { const pr = a.play(); if (pr && typeof pr.catch === 'function') pr.catch(() => done(false)) }
    catch { done(false) }
  })
}

// 停止当前克隆播报（新一轮消息/切换音色时调用）。递增 seq 让旧队列在下一次检查时退出。
export function stopClonedSpeech() {
  speechRuntime.seq += 1
  const a = speechRuntime.audio
  if (a) { try { a.pause() } catch { /* ignore */ } speechRuntime.audio = null }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel() } catch { /* ignore */ }
  }
  cleanupSpeechUrls()
}

// 句子级流水线播报：首句先合成即播，播放中预取下一句；返回是否至少成功起播一句。
async function playClonedSequence(text, resource, callbacks = {}) {
  const mySeq = ++speechRuntime.seq
  cleanupSpeechUrls() // 清掉上一轮遗留的 URL（seq 已递增，不会被旧队列复用）
  const voiceId = resource?.realVoiceId || resource?.voiceId
  if (!voiceId) { callbacks.onError?.('音色缺少 voiceId'); return false }
  const sentences = splitIntoSentences(text)
  if (!sentences.length) return false

  let next = synthOne(sentences[0], voiceId) // 首句立即开始合成
  let started = false
  for (let i = 0; i < sentences.length; i++) {
    if (mySeq !== speechRuntime.seq) return started // 被新一轮打断
    const url = await next
    if (mySeq !== speechRuntime.seq) return started
    // 播放当前句的同时，后台预合成下一句（并行 = 流水线）
    next = i + 1 < sentences.length ? synthOne(sentences[i + 1], voiceId) : Promise.resolve(null)
    if (!url) { continue } // 某句合成失败则跳过，不中断整轮
    // 头像随句子切换：在真正开始播放这一句时通知上层（顺序与 sentences 一致）
    try { callbacks.onSentence?.(sentences[i], i, sentences.length) } catch { /* 回调异常不影响播放 */ }
    const played = await playAudioUrl(url)
    if (mySeq !== speechRuntime.seq) return started
    if (played) started = true
  }
  cleanupSpeechUrls()
  callbacks.onDone?.()
  return started
}

export const voiceAdapter = {
  /**
   * 读取系统可用语音列表（中文优先）。
   * 兼容异步加载：getVoices() 首次可能返回空数组，
   * 此时监听 voiceschanged 并用超时兜底，确保最终拿到列表。
   */
  async listVoices() {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return []
    const synth = window.speechSynthesis
    const read = () => (synth.getVoices() || []).map(toVoiceInfo)
    const immediate = read()
    if (immediate.length > 0) return immediate
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (typeof synth.removeEventListener === 'function') synth.removeEventListener('voiceschanged', onChanged)
        resolve(read())
      }
      const onChanged = () => {
        if ((synth.getVoices() || []).length > 0) finish()
      }
      const timer = setTimeout(finish, VOICE_LIST_TIMEOUT)
      if (typeof synth.addEventListener === 'function') synth.addEventListener('voiceschanged', onChanged)
      // 注册监听前可能已经就绪，再查一次
      if ((synth.getVoices() || []).length > 0) finish()
    })
  },

  /**
   * 按音色特征挑选系统语音并合成。
   * 这是「克隆音色真正被加载」的关键步骤：
   *   1. 按 resource.params.gender / resource.gender 从系统语音里选一把嗓子
   *   2. 用 pitch / rate / volume 叠加该音色的真实派生参数
   * 找不到匹配性别的语音时降级为默认语音，参数照常生效。
   * @returns {boolean} 是否成功发起发声
   */
  /**
   * 用真实克隆音色播报：走本地代理合成音频，再用 <audio> 播放素材本人的声音。
   * 返回 Promise<boolean>：true=已开始播放，false=合成/播放失败（调用方可降级或提示）。
   */
  async speakCloned(text, resource) {
    const realVoiceId = resource?.realVoiceId || resource?.voiceId
    if (!realVoiceId) return false
    try {
      const res = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceId: realVoiceId }),
      })
      if (!res.ok) {
        let msg = `合成失败（${res.status}）`
        try { msg = (await res.json()).error || msg } catch { /* ignore */ }
        throw new Error(msg)
      }
      const blob = await res.blob()
      if (blob.size < 32) throw new Error('合成音频为空')
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.onended = () => { try { URL.revokeObjectURL(url) } catch { /* ignore */ } }
      audio.onerror = () => { try { URL.revokeObjectURL(url) } catch { /* ignore */ } }
      await audio.play()
      return true
    } catch (e) {
      console.warn('[voiceAdapter] 云端音色播放失败：', e?.message || e)
      return false
    }
  },

  speak(text, resource, callbacks = {}) {
    // 真克隆音色：走句子级流水线（首句即播 + 预取下一句），显著降低首字延迟。
    // 这是对整段 speakCloned 的替代；试听单句仍直接用 speakCloned。
    if (resource && resource.ttsMode === 'cloned' && resource.realVoiceId) {
      playClonedSequence(text, resource, callbacks)
      return true
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
    const synth = window.speechSynthesis
    const params = (resource && resource.params) || {}
    const gender = params.gender || (resource && resource.gender) || 'neutral'

    // 真正的发声动作。把嗓音选择放到拿到列表之后执行——speechSynthesis.getVoices()
    // 首次调用常返回空数组（列表异步就绪），若此时直接 synthesize 会退化成系统默认嗓音，
    // 用户会误以为「克隆音色没生效」。这里用 gotVoices 回调在列表就绪后再合成。
    const synthesize = (rawVoices) => {
      const picked = pickSystemVoice(rawVoices, gender)
      const buildUtterance = (sentence) => {
        const u = new SpeechSynthesisUtterance(String(sentence ?? ''))
        u.rate = Math.min(2, Math.max(0.5, Number(params.speed) || 1))
        u.pitch = Math.min(2, Math.max(0.5, Number(params.pitch) || 1))
        u.volume = Math.min(1, Math.max(0, Number(params.volume ?? 1)))
        if (picked) {
          u.voice = picked
          u.lang = picked.lang || 'zh-CN'
        } else {
          u.lang = 'zh-CN'
        }
        return u
      }
      synth.cancel()
      // 系统语音也按句子推进：上一句 onend 后才排队下一句，头像切换才与朗读节奏一致。
      const sentences = splitIntoSentences(text)
      if (!sentences.length) { try { callbacks.onDone?.() } catch { /* ignore */ }; return }
      const mySeq = ++speechRuntime.seq // 与克隆语音共用打断计数，新一轮会中止旧的逐句队列
      let settled = false
      const speakAt = (i) => {
        if (mySeq !== speechRuntime.seq) return // 被新一轮打断
        if (i >= sentences.length) {
          if (!settled) { settled = true; try { callbacks.onDone?.() } catch { /* ignore */ } }
          return
        }
        const u = buildUtterance(sentences[i])
        let started = false
        const fireStart = () => {
          if (started) return
          started = true
          try { callbacks.onSentence?.(sentences[i], i, sentences.length) } catch { /* ignore */ }
        }
        u.onstart = fireStart
        u.onend = () => { fireStart(); speakAt(i + 1) }
        u.onerror = () => { fireStart(); speakAt(i + 1) }
        synth.speak(u)
        // 部分浏览器不触发 onstart，用下一帧兜底，避免头像不切换
        setTimeout(fireStart, 120)
      }
      speakAt(0)
    }

    const immediate = synth.getVoices() || []
    if (immediate.length > 0) {
      synthesize(immediate)
    } else {
      // 列表尚未就绪：监听 voiceschanged，就绪后用【原始】SpeechSynthesisVoice 列表
      // 选嗓（pickSystemVoice 依赖 name/lang/localService，不能用转换后的轻量对象）。
      // 1.5s 超时兜底，超时仍以空列表降级发声，绝不静默失败。
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (typeof synth.removeEventListener === 'function') {
          synth.removeEventListener('voiceschanged', onChanged)
        }
        synthesize(synth.getVoices() || [])
      }
      const onChanged = () => { if ((synth.getVoices() || []).length > 0) finish() }
      const timer = setTimeout(finish, VOICE_LIST_TIMEOUT)
      if (typeof synth.addEventListener === 'function') {
        synth.addEventListener('voiceschanged', onChanged)
      }
      if ((synth.getVoices() || []).length > 0) finish()
    }
    return true
  },

  /**
   * 克隆入口：解码 → 特征提取 → 候选生成（真实链路，无任何写死候选）。
   * @param {File|Blob} file 用户选择的音频文件
   * @param {{name?: string, count?: number, seed?: string|number, onProgress?: Function}} options
   * @returns {Promise<Array>} 候选音色列表
   */
  async clone(file, options = {}) {
    const { name = '克隆音色', count = 3, seed, genderOverride, onProgress } = options || {}
    const report = (pct, label) => { try { onProgress?.(pct, label) } catch { /* 进度回调异常不影响主流程 */ } }

    // 优先走云端真音色克隆：上传到语音平台创建真实克隆音色，拿到 voice_id。
    // 这条路才能得到「像素材本人」的声音；失败时降级到本地 DSP 参数化模拟，保证功能可用。
    try {
      const cloud = await cloneViaCloud(file, name, count, genderOverride, report)
      report(100, '克隆音色生成完成（真实声纹）')
      return cloud
    } catch (e) {
      // 云端不可用（未配密钥 / 网络 / 平台拒绝）→ 降级到本地 DSP，并在候选上标注原因
      const degradeMsg = (e?.message || '云端克隆不可用').slice(0, 120)
      report(15, '云端不可用，改用本地模式…')
      const decoded = await decodeOnce(file)
      if (!decoded.ok) throw new Error(decoded.error || '音频解码失败：文件可能已损坏或格式不受支持')
      report(45, '提取声纹特征中…')
      await new Promise((r) => setTimeout(r, 0))
      report(70, '派生候选音色中…')
      const candidates = cloneFromAudio(decoded, { name, count, seed, genderOverride })
        .map((c) => ({ ...c, ttsMode: 'local', degradeReason: degradeMsg }))
      report(100, '候选生成完成（本地参数化模拟）')
      return candidates
    }
  },

  /**
   * 步骤0 用：真实解码并给出素材概览（真实时长 / 采样率 / 声学特征）。
   * 供 UI 展示与异常判断，绝不让用户手填时长。
   */
  async inspect(file) {
    const decoded = await decodeOnce(file)
    if (!decoded.ok) {
      return { ok: false, error: decoded.error, duration: 0, sampleRate: 0, features: null }
    }
    const features = extractFeatures(decoded.samples, decoded.sampleRate)
    return {
      ok: true,
      error: null,
      duration: decoded.duration,
      sampleRate: decoded.sampleRate,
      features,
    }
  },

  // 试听：返回一句固定示例句 + 该音色的真实参数，页面用 voiceAdapter.speak 朗读
  async preview(resource, sampleText = '你好呀，我是小智，很高兴认识你！') {
    await delay(200)
    return {
      sampleText,
      voiceId: resource?.voiceId,
      params: { ...(resource?.params || {}) },
      features: resource?.features || null,
    }
  },
}

// ---------- 形象适配器 ----------
export const avatarAdapter = {
  async validateAsset(files) {
    await delay(200)
    const problems = []
    if (!Array.isArray(files) || files.length === 0) {
      problems.push('请先上传至少一张图片素材')
      return { ok: false, problems }
    }
    for (const f of files) {
      if (f.size === 0) { problems.push(`${f.name}：文件为空`); continue }
      if (!f.type?.startsWith('image/') && !/\.(png|jpe?g|webp)$/i.test(f.name)) {
        problems.push(`${f.name}：仅支持 PNG/JPG/WebP 图片`)
        continue
      }
      if (f.size > 5 * 1024 * 1024) problems.push(`${f.name}：单文件不能超过 5MB`)
    }
    return { ok: problems.length === 0, problems }
  },
  // 素材驱动生成：候选来自上传素材本身（主色调 + 风格化处理），不再返回固定 emoji
  // 真实接入图生图服务时只需替换本方法内部实现，输入输出契约不变
  async generate(params, files) {
    await delay(900)
    return generateAvatarCandidates(files, params)
  },
}

// ---------- 设备适配器（预留真机，当前模拟） ----------
// 真机参数见方案附录 A：MQTT 控制面 + UDP 音频面，hello version=3，MCP 2024-11-05
export const deviceAdapter = {
  mode: 'mock',
  connected: true,
  async pushConfig(version, binding) {
    await delay(500)
    return { ok: true, ackedDevices: 1, version, note: '模拟设备已 ACK（真机模式待接入 api.tenclass.net）' }
  },
}

// ---------- 声音样本校验 ----------
// 校验全部基于「真实解码结果」，不再让用户手填时长：
// 时长不足/静音过高这类问题只有拿到真实 PCM 才能判断。
export const voiceSampleValidator = {
  // 最低时长（秒）。太短的样本采到的基频/频谱特征不稳定，克隆出来的音色会飘。
  MIN_DURATION: 2,
  // 静音占比上限。超过说明素材里大部分是空白，特征提取没有意义。
  MAX_SILENCE_RATIO: 0.6,

  /**
   * 校验已解码的样本。
   * @param {{ok: boolean, error: string|null, duration: number, features: object|null}} decoded
   */
  validate(decoded) {
    const problems = []
    if (!decoded) return { ok: false, problems: ['请先上传声音样本'] }
    if (!decoded.ok) {
      problems.push(decoded.error || '音频解码失败：文件可能已损坏或格式不受支持')
      return { ok: false, problems }
    }
    const duration = Number(decoded.duration) || 0
    if (duration < this.MIN_DURATION) {
      problems.push(`样本时长不足：${duration.toFixed(1)}s，至少需要 ${this.MIN_DURATION} 秒`)
    }
    const silenceRatio = Number(decoded.features?.silenceRatio) || 0
    if (silenceRatio > this.MAX_SILENCE_RATIO) {
      problems.push(`静音占比过高：${(silenceRatio * 100).toFixed(0)}%（上限 ${this.MAX_SILENCE_RATIO * 100}%），请录制更连续的语音`)
    }
    return { ok: problems.length === 0, problems }
  },
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms))
