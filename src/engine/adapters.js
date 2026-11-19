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

  speak(text, resource) {
    // 真克隆音色：异步走云端合成播放。调用方若需要知道结果，可改用 speakAsync()。
    if (resource && resource.ttsMode === 'cloned' && resource.realVoiceId) {
      this.speakCloned(text, resource)
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
      const u = new SpeechSynthesisUtterance(String(text ?? ''))
      u.rate = Math.min(2, Math.max(0.5, Number(params.speed) || 1))
      u.pitch = Math.min(2, Math.max(0.5, Number(params.pitch) || 1))
      u.volume = Math.min(1, Math.max(0, Number(params.volume ?? 1)))
      const picked = pickSystemVoice(rawVoices, gender)
      if (picked) {
        u.voice = picked
        u.lang = picked.lang || 'zh-CN'
      } else {
        u.lang = 'zh-CN'
      }
      synth.cancel()
      synth.speak(u)
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
