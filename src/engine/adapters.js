// 适配器层：屏蔽模型/音色/形象/设备供应商差异
// 模型适配器已接入本地安全代理（真实 DeepSeek API）；其余保持 Mock，接口不变
// 密钥只在服务端 .env，浏览器仅传 apiKeyRef 引用（env:变量名），永不接触明文

import { generateAvatarCandidates } from './avatarGen.js'
import { decodeAudioFile } from './audioDecode.js'
import { cloneFromAudio, extractFeatures } from './voiceClone.js'

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
  speak(text, resource) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
    const synth = window.speechSynthesis
    const params = (resource && resource.params) || {}
    const gender = params.gender || (resource && resource.gender) || 'neutral'
    const u = new SpeechSynthesisUtterance(String(text ?? ''))
    u.rate = Math.min(2, Math.max(0.5, Number(params.speed) || 1))
    u.pitch = Math.min(2, Math.max(0.5, Number(params.pitch) || 1))
    u.volume = Math.min(1, Math.max(0, Number(params.volume ?? 1)))
    const picked = pickSystemVoice(synth.getVoices(), gender)
    if (picked) {
      u.voice = picked
      u.lang = picked.lang || 'zh-CN'
    } else {
      u.lang = 'zh-CN'
    }
    synth.cancel()
    synth.speak(u)
    return true
  },

  /**
   * 克隆入口：解码 → 特征提取 → 候选生成（真实链路，无任何写死候选）。
   * @param {File|Blob} file 用户选择的音频文件
   * @param {{name?: string, count?: number, seed?: string|number, onProgress?: Function}} options
   * @returns {Promise<Array>} 候选音色列表
   */
  async clone(file, options = {}) {
    const { name = '克隆音色', count = 3, seed, onProgress } = options || {}
    const report = (pct, label) => { try { onProgress?.(pct, label) } catch { /* 进度回调异常不影响主流程 */ } }
    report(15, '解码音频中…')
    const decoded = await decodeOnce(file)
    if (!decoded.ok) throw new Error(decoded.error || '音频解码失败：文件可能已损坏或格式不受支持')
    report(45, '提取声纹特征中…')
    // 特征提取是纯计算，可能耗时较久；让出一次事件循环，保证进度条能刷新
    await new Promise((r) => setTimeout(r, 0))
    report(70, '派生候选音色中…')
    const candidates = cloneFromAudio(decoded, { name, count, seed })
    report(100, '候选生成完成')
    return candidates
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
