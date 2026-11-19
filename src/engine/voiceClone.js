// 音色克隆参数提取引擎（纯 DSP，无浏览器 API 依赖）
//
// 模块职责：
//   1. 从「已解码的单声道 PCM 采样」中客观测量一组声学特征（基频、过零率、亮度、静音比、削波率……）
//   2. 把这些特征映射成 4 个可解释的克隆参数（音高 / 语速 / 情绪 / 性别倾向）
//   3. 用特征指纹生成稳定的音色 id，使同一段素材在任何时候都得到同一份参数
//
// 能力边界（重要）：
//   - 本模块只做「测量 + 映射」，不生成音频，不做神经网络声学模型推理，不做变声算法。
//     它输出的是描述素材声音特征的参数，供上游合成/克隆服务消费。
//   - 只接受已解码的数值数据（Float32Array / number[]），不接受 File / Blob / ArrayBuffer。
//     因此绝不触碰 document / window / AudioContext / FileReader 等浏览器 API，
//     同一份代码既能在浏览器主线程跑，也能在 Node 里直接 import 做单测。
//   - 所有对外数值都经过 clamp + NaN 防护，极端输入（静音、超长 f0、零采样率）不会产出非法值。

const EPS = 1e-12

// 自相关搜索的基频范围（人声常见区间）。范围之外的自相关峰多为谐波误检或噪声。
const F0_MIN = 60
const F0_MAX = 400

// 帧参数：20ms 分析窗 / 10ms 帧移，与语音处理惯例一致。
const FRAME_MS = 20
const HOP_MS = 10

// 谱质心（brightness）归一化的上下界。
const BRIGHT_LO = 80
const BRIGHT_HI = 5000

// 削波判定阈值：浮点 PCM 上 0.99 以上基本等同于录满了。
const CLIP_THRESHOLD = 0.99

// 静音帧判定：帧 RMS 低于全片峰值峰值的 10% 视为静音。
const SILENCE_RATIO = 0.1

// 候选数量与偏移幅度的上限，避免参数被推到不合理区间。
const MAX_CANDIDATES = 8

// ---------------------------------------------------------------- 基础工具

function clamp(v, lo, hi) {
  const n = Number.isFinite(v) ? v : lo
  return n < lo ? lo : n > hi ? hi : n
}

function toFinite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback
}

/** 把任意输入规整成 Float32Array，并剔除 NaN / Infinity 采样（会污染所有统计量） */
function toSampleArray(input) {
  if (!input) return new Float32Array(0)
  let src = input
  if (ArrayBuffer.isView(src)) {
    src = new Float32Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength))
  } else if (!Array.isArray(src)) {
    return new Float32Array(0)
  }
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    out[i] = Number.isFinite(v) ? v : 0
  }
  return out
}

/** FNV-1a 32 位哈希：同样的输入永远得到同样的输出，用于生成稳定的音色指纹 */
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** 由字符串生成确定性伪随机序列（mulberry32），用来在候选之间做「可复现」的微偏移 */
function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------- 特征提取

/** 全片 RMS 与峰值；输入若超出 [-1,1] 一律收敛到 0~1 */
function computeRmsPeak(samples) {
  const n = samples.length
  if (n === 0) return { rms: 0, peak: 0 }
  let sumSq = 0
  let peak = 0
  for (let i = 0; i < n; i++) {
    const v = samples[i]
    sumSq += v * v
    const a = v < 0 ? -v : v
    if (a > peak) peak = a
  }
  return { rms: clamp(Math.sqrt(sumSq / n), 0, 1), peak: clamp(peak, 0, 1) }
}

/** 过零率：相邻采样符号发生变化的次数 / 总采样数 */
function computeZcr(samples) {
  const n = samples.length
  if (n < 2) return 0
  let changes = 0
  let prev = samples[0] >= 0
  for (let i = 1; i < n; i++) {
    const cur = samples[i] >= 0
    if (cur !== prev) changes++
    prev = cur
  }
  return clamp(changes / n, 0, 1)
}

/** 绝对值 >= 0.99 的采样占比，反映素材是否已经录爆 */
function computeClipping(samples) {
  const n = samples.length
  if (n === 0) return 0
  let clipped = 0
  for (let i = 0; i < n; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i]
    if (a >= CLIP_THRESHOLD) clipped++
  }
  return clamp(clipped / n, 0, 1)
}

/** 20ms 帧的 RMS */
function frameRms(samples, start, len) {
  let sumSq = 0
  for (let i = start; i < start + len; i++) sumSq += samples[i] * samples[i]
  return Math.sqrt(sumSq / Math.max(1, len))
}

/**
 * 静音占比：把信号切成 20ms 帧，统计帧 RMS 低于「全片峰值 × 10%」的帧比例。
 * 峰值即最响那一下的绝对幅度，用它当基准比用均值更能反映真实的听感动态。
 */
function computeSilenceRatio(samples, sampleRate, peak) {
  const frameLen = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000))
  if (samples.length < frameLen) return 0
  const total = Math.floor(samples.length / frameLen)
  if (total <= 0) return 0
  // 整段几乎无声：所有帧都算静音
  if (peak <= EPS) return 1
  const threshold = peak * SILENCE_RATIO
  let silent = 0
  for (let f = 0; f < total; f++) {
    if (frameRms(samples, f * frameLen, frameLen) < threshold) silent++
  }
  return clamp(silent / total, 0, 1)
}

/**
 * 归一化自相关：r(lag) = Σ x[n]x[n+lag] / sqrt(Σx[n]² · Σx[n+lag]²)
 * 在 [minLag, maxLag] 区间内取最大峰，即 60~400Hz 对应的周期范围。
 */
function autocorrelation(frame, minLag, maxLag) {
  const L = frame.length
  const r = new Float64Array(maxLag + 2)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let num = 0
    let e0 = 0
    let e1 = 0
    const limit = L - lag
    for (let i = 0; i < limit; i++) {
      const a = frame[i]
      const b = frame[i + lag]
      num += a * b
      e0 += a * a
      e1 += b * b
    }
    const den = Math.sqrt(e0 * e1)
    r[lag] = den > EPS ? num / den : 0
  }
  return r
}

/** 抛物线插值细化峰位，把整数 lag 提升到亚采样精度 */
function parabolicPeak(r, lag, minLag, maxLag) {
  if (lag <= minLag || lag >= maxLag) return lag
  const y0 = r[lag - 1]
  const y1 = r[lag]
  const y2 = r[lag + 1]
  const denom = y0 - 2 * y1 + y2
  if (Math.abs(denom) < EPS) return lag
  const delta = clamp((0.5 * (y0 - y2)) / denom, -1, 1)
  return lag + delta
}

/**
 * 基频估计：逐帧自相关 + 中位数汇总。
 * 为什么取中位数而不是均值：个别帧会被清音/噪声污染，中位数对离群帧不敏感。
 */
function estimateF0(samples, sampleRate) {
  const frameLen = Math.max(4, Math.round((sampleRate * FRAME_MS) / 1000))
  const hop = Math.max(1, Math.round((sampleRate * HOP_MS) / 1000))
  const minLag = Math.max(2, Math.floor(sampleRate / F0_MAX))
  const maxLag = Math.min(Math.ceil(sampleRate / F0_MIN), frameLen - 2)
  if (samples.length < frameLen || maxLag <= minLag) return 0

  const values = []
  for (let start = 0; start + frameLen <= samples.length; start += hop) {
    // 去直流：帧内的直流分量会在低 lag 处堆出一个假峰，干扰基频判定
    let mean = 0
    for (let i = start; i < start + frameLen; i++) mean += samples[i]
    mean /= frameLen

    let energy = 0
    for (let i = start; i < start + frameLen; i++) {
      const d = samples[i] - mean
      energy += d * d
    }
    if (energy < EPS) continue // 静音帧不参与统计

    const frame = new Float32Array(frameLen)
    for (let i = 0; i < frameLen; i++) frame[i] = samples[start + i] - mean

    const r = autocorrelation(frame, minLag, maxLag)

    let globalMax = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (r[lag] > globalMax) globalMax = r[lag]
    }
    if (globalMax < 0.3) continue // 相关性太弱，判为清音/噪声帧

    // 在所有局部峰里取「最小的那个显著峰」。
    // 为什么不直接用最高峰：谐波丰富时半周期处也会出现接近的高峰（倍频误检），
    // 显著峰阈值 + 取最小 lag 可以在真实基频的整数倍关系里优先选长周期（低频）解。
    let bestLag = -1
    for (let lag = minLag; lag <= maxLag; lag++) {
      const isLocalMax =
        (lag === minLag || r[lag] >= r[lag - 1]) && (lag === maxLag || r[lag] >= r[lag + 1])
      if (!isLocalMax) continue
      if (r[lag] >= globalMax * 0.85) {
        bestLag = lag
        break
      }
    }
    if (bestLag < 0) continue

    const refined = parabolicPeak(r, bestLag, minLag, maxLag)
    const f0 = sampleRate / refined
    if (Number.isFinite(f0) && f0 >= F0_MIN && f0 <= F0_MAX) values.push(f0)
  }

  if (values.length === 0) return 0
  values.sort((a, b) => a - b)
  const mid = values.length >> 1
  const median =
    values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2
  return clamp(toFinite(median, 0), 0, F0_MAX)
}

/** Hann 窗，抑制帧边界带来的频谱泄漏 */
function hannWindow(n) {
  const w = new Float64Array(n)
  if (n <= 1) {
    w[0] = 1
    return w
  }
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
  return w
}

/**
 * 谱质心：先用稀疏的对数间隔频点做直接 DFT（Goertzel 式的单频累加），
 * 再用幅值加权求重心。相比完整 FFT 频谱，稀疏频点已经足够反映「亮/暗」，
 * 且计算量可控（32 个频点 × 1024 采样）。
 */
function spectralCentroid(frame, sampleRate, binFreqs, win) {
  const N = frame.length
  if (N < 8) return 0
  let num = 0
  let den = 0
  for (let k = 0; k < binFreqs.length; k++) {
    const f = binFreqs[k]
    const w = (2 * Math.PI * f) / sampleRate
    let re = 0
    let im = 0
    for (let i = 0; i < N; i++) {
      const x = frame[i] * win[i]
      re += x * Math.cos(w * i)
      im -= x * Math.sin(w * i)
    }
    const mag = Math.sqrt(re * re + im * im) / N
    num += f * mag
    den += mag
  }
  if (den <= EPS) return 0
  return num / den
}

/**
 * 亮度：对若干帧求谱质心后按能量加权平均，再归一化到 0~1。
 * 用对数刻度（80Hz→0，5000Hz→1）是因为人耳对音高的感知接近对数，
 * 线性刻度会让绝大多数真实语音挤在 0.1 附近，无法区分。
 */
function computeBrightness(samples, sampleRate) {
  const N = Math.min(1024, samples.length)
  if (N < 128) return 0
  const frameCount = Math.max(1, Math.floor(samples.length / N))
  const binCount = 32
  const topFreq = Math.min(sampleRate * 0.45, 8000)
  const binFreqs = []
  for (let k = 0; k < binCount; k++) {
    const t = k / (binCount - 1)
    binFreqs.push(BRIGHT_LO * Math.pow(topFreq / BRIGHT_LO, t))
  }
  const win = hannWindow(N)

  let weighted = 0
  let weightSum = 0
  const picks = Math.min(8, frameCount)
  for (let s = 0; s < picks; s++) {
    // 均匀抽帧覆盖整段素材，避免只测到开头
    const idx = picks === 1 ? 0 : Math.floor((s * (frameCount - 1)) / (picks - 1))
    const start = Math.min(idx * N, Math.max(0, samples.length - N))
    let mean = 0
    for (let i = 0; i < N; i++) mean += samples[start + i]
    mean /= N
    const frame = new Float32Array(N)
    let energy = 0
    for (let i = 0; i < N; i++) {
      frame[i] = samples[start + i] - mean
      energy += frame[i] * frame[i]
    }
    if (energy < EPS) continue
    const centroid = spectralCentroid(frame, sampleRate, binFreqs, win)
    if (!Number.isFinite(centroid) || centroid <= 0) continue
    weighted += centroid * energy
    weightSum += energy
  }
  if (weightSum <= EPS) return 0
  const centroid = weighted / weightSum
  const ratio = Math.log(Math.max(centroid, BRIGHT_LO) / BRIGHT_LO) / Math.log(BRIGHT_HI / BRIGHT_LO)
  return clamp(ratio, 0, 1)
}

/**
 * 提取一组声学特征。
 * @param {Float32Array|number[]} samples 单声道采样，[-1,1] 区间
 * @param {number} sampleRate 采样率（Hz）
 */
export function extractFeatures(samples, sampleRate) {
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 16000
  const data = toSampleArray(samples)
  const { rms, peak } = computeRmsPeak(data)
  const duration = data.length / sr
  return {
    duration: clamp(toFinite(duration, 0), 0, Number.MAX_SAFE_INTEGER),
    sampleRate: sr,
    rms,
    peak,
    zcr: computeZcr(data),
    f0: estimateF0(data, sr),
    brightness: computeBrightness(data, sr),
    silenceRatio: computeSilenceRatio(data, sr, peak),
    clipping: computeClipping(data),
  }
}

// ---------------------------------------------------------------- 参数映射

/**
 * 把声学特征映射为克隆参数。
 * 所有分支都做 clamp + NaN 防护：静音、极端 f0、空特征都不会产出非法值。
 */
export function deriveParams(features) {
  const f = features || {}
  const f0 = clamp(toFinite(f.f0, 0), 0, F0_MAX)
  const rms = clamp(toFinite(f.rms, 0), 0, 1)
  const zcr = clamp(toFinite(f.zcr, 0), 0, 1)
  const brightness = clamp(toFinite(f.brightness, 0), 0, 1)
  const silenceRatio = clamp(toFinite(f.silenceRatio, 0), 0, 1)

  // 音高：以 180Hz 为中性基准，80~360Hz 覆盖绝大多数人声。
  // f0 = 100 → 0.56，f0 = 260 → 1.44，两者差异明显。
  const pitch = f0 > 0 ? clamp(f0 / 180, 0.5, 2) : 1

  // 语速：过零率（波形变化快慢）与亮度（高频能量占比）共同决定。
  // 参考值：安静语音 zcr ≈ 0.03~0.08，高频摩擦音可到 0.15 以上。
  const zcrScore = clamp(zcr / 0.15, 0, 1)
  const brightScore = clamp(brightness, 0, 1)
  const speed = clamp(0.5 + 1.5 * (0.5 * zcrScore + 0.5 * brightScore), 0.5, 2)

  // 情绪：用能量、活跃度（1 - 静音占比）、清晰度三项加权。
  // 静音占比在这里扮演「内部起伏」的代理——停顿与动态越明显，情绪表达越强。
  const energy = clamp(rms * 3, 0, 1)
  const activity = clamp(1 - silenceRatio, 0, 1)
  const clarity = clamp(zcr / 0.12, 0, 1)
  const emotion = clamp(0.45 * energy + 0.35 * activity + 0.2 * clarity, 0, 1)

  // 性别倾向：只作为「音色方向」的粗略提示，不是身份判定
  const gender = f0 <= 0 ? 'neutral' : f0 < 150 ? 'male' : f0 > 205 ? 'female' : 'neutral'

  return {
    pitch: toFinite(pitch, 1),
    speed: toFinite(speed, 1),
    emotion: toFinite(emotion, 0),
    gender,
  }
}

// ---------------------------------------------------------------- 指纹

/**
 * 特征指纹：把量化后的特征与 seed 一起哈希，输出 8 位小写十六进制。
 * 量化到固定精度，保证「同特征同 seed → 同 id」「特征不同 → id 不同」。
 */
export function hashFeatures(features, seed) {
  const f = features || {}
  const parts = [
    Math.round(clamp(toFinite(f.duration, 0), 0, 1e9) * 1000),
    Math.round(clamp(toFinite(f.rms, 0), 0, 1) * 10000),
    Math.round(clamp(toFinite(f.peak, 0), 0, 1) * 10000),
    Math.round(clamp(toFinite(f.zcr, 0), 0, 1) * 10000),
    Math.round(clamp(toFinite(f.f0, 0), 0, F0_MAX) * 100),
    Math.round(clamp(toFinite(f.brightness, 0), 0, 1) * 10000),
    Math.round(clamp(toFinite(f.silenceRatio, 0), 0, 1) * 10000),
  ]
  const seedText = seed === undefined || seed === null ? '' : String(seed)
  return fnv1a(`${seedText}|${parts.join(',')}`).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------- 候选生成

/**
 * 由参数与真实特征生成一句人话说明。
 * 说明里必须同时出现「素材原始基频」和「本次候选做了什么偏移」，
 * 让用户能看出候选来自素材、而不是凭空生成的一组随机参数。
 */
function describeCandidate(params, effF0, baseF0, baseSpeed) {
  const traits = []
  if (params.pitch >= 1.15) traits.push('音高偏高')
  else if (params.pitch <= 0.85) traits.push('音高偏低')
  else traits.push('音高接近原素材')
  if (params.speed >= 1.2) traits.push('语速偏快')
  else if (params.speed <= 0.85) traits.push('语速偏慢')
  else traits.push('语速接近原素材')
  if (params.emotion >= 0.6) traits.push('情绪饱满')
  else if (params.emotion <= 0.35) traits.push('情绪沉稳')
  else traits.push('情绪自然')

  const base = baseF0 > 0 ? `素材基频 ${Math.round(baseF0)}Hz` : '素材未检出稳定基频'
  const delta = effF0 > 0 && baseF0 > 0 ? `，本次候选 ${Math.round(effF0)}Hz` : ''
  const spd = baseSpeed > 0 ? `，语速 ${params.speed.toFixed(2)}×` : ''
  const emo = `，情绪强度 ${params.emotion.toFixed(2)}`
  return `${base}${delta}${spd}${emo}；${traits.join('、')}。`
}

/**
 * 从解码后的音频生成克隆候选。
 * @param {{samples: Float32Array|number[], sampleRate: number}} decoded 已解码的单声道音频
 * @param {{name?: string, count?: number, seed?: string|number}} options
 * @returns {Array<{id,name,voiceId,params,features,previewNote}>}
 */
export function cloneFromAudio(decoded, options = {}) {
  if (!decoded || !decoded.samples || decoded.samples.length === 0) {
    throw new Error('缺少可用的音频采样，无法提取音色特征')
  }
  const opts = options || {}
  const sampleRate = Number.isFinite(decoded.sampleRate) && decoded.sampleRate > 0
    ? decoded.sampleRate
    : 16000

  const features = extractFeatures(decoded.samples, sampleRate)
  const base = deriveParams(features)
  const seed = opts.seed === undefined || opts.seed === null ? 'voice-clone' : opts.seed
  const hash = hashFeatures(features, seed)
  const voiceId = `voice_clone_${hash}`
  const displayName = opts.name ? String(opts.name) : '克隆音色'
  const count = clamp(Math.round(toFinite(opts.count, 3)), 1, MAX_CANDIDATES)

  // 偏移幅度由特征本身算出：
  // 越亮、波形越碎的素材，其可调空间越大（合成时更不容易糊）；
  // 越安静平稳的素材可用空间越小，避免把参数推离原素材太远。
  const pitchSpread = clamp(0.03 + 0.05 * brightnessOf(features), 0.02, 0.09)
  const speedSpread = clamp(0.02 + 0.06 * clamp(toFinite(features.zcr, 0) / 0.12, 0, 1), 0.02, 0.09)
  const emotionSpread = clamp(0.02 + 0.06 * clamp(toFinite(features.silenceRatio, 0), 0, 1), 0.02, 0.09)

  const candidates = []
  for (let i = 0; i < count; i++) {
    // 伪随机源由「特征指纹 + 候选序号」决定：同素材每次生成结果一致，
    // 换素材（指纹变化）则整套候选分布都变。
    const rand = mulberry32(fnv1a(`${hash}#${i}`))
    const pitch = clamp(base.pitch + (rand() * 2 - 1) * pitchSpread, 0.5, 2)
    const speed = clamp(base.speed + (rand() * 2 - 1) * speedSpread, 0.5, 2)
    const emotion = clamp(base.emotion + (rand() * 2 - 1) * emotionSpread, 0, 1)

    // 基频随音高偏移同步缩放，保证「参数」与「特征」描述一致
    const effF0 = base.pitch > 0 ? clamp(features.f0 * (pitch / base.pitch), 0, F0_MAX) : 0
    const gender = effF0 <= 0 ? 'neutral' : effF0 < 150 ? 'male' : effF0 > 205 ? 'female' : 'neutral'

    const params = {
      pitch: toFinite(pitch, 1),
      speed: toFinite(speed, 1),
      emotion: toFinite(emotion, 0),
      gender,
    }
    const candFeatures = { ...features, f0: effF0 }
    const brightness = clamp(toFinite(features.brightness, 0), 0, 1)

    candidates.push({
      id: `cand_${hash}_${i}`,
      // 显示名里的基频必须是「素材实测基频」（真实特征），
      // 不能用按候选音高缩放后的等效基频——那会让用户误以为是素材本身的音高。
      // 等效基频仍保留在 previewNote 与 params 里，供合成与对照使用。
      name: `${displayName} · 候选${i + 1} · 素材基频${features.f0 > 0 ? `${Math.round(features.f0)}Hz` : '未检出'} · 明亮${brightness.toFixed(2)}`,
      voiceId,
      params,
      features: candFeatures,
      previewNote: describeCandidate(params, effF0, features.f0, base.speed),
    })
  }
  return candidates
}

/** 亮度的小工具封装，保持上方偏移幅度计算的表达清晰 */
function brightnessOf(features) {
  return clamp(toFinite(features?.brightness, 0), 0, 1)
}
