// 浏览器侧音频解码（WebAudio）
//
// 模块职责：
//   把用户选择的音频文件（File/Blob）解码成「单声道 Float32Array + 采样率」，
//   交给 voiceClone.js 做特征提取。真实时长与真实采样率一律取自解码结果，
//   绝不依赖用户手填。
//
// 为什么单独拆一个模块：
//   voiceClone.js 必须能在 Node 里裸跑（契约第 3 节硬约束），因此它不能碰
//   任何浏览器 API；而解码强依赖 AudioContext，只能待在浏览器侧。两者以
//   「decoded = { samples, sampleRate }」这一最小结构解耦。
//
// 能力边界：这里只做「解码 + 取真实时长/采样率 + 单声道混合」，
// 不做任何降噪、重采样、变声处理。

// 单文件上限：超过 20MB 的音频在浏览器里解码容易卡死主线程，直接拒绝。
export const MAX_FILE_BYTES = 20 * 1024 * 1024

// 支持的容器/编码扩展名。浏览器 decodeAudioData 实际能解的格式比这多，
// 这里只是先做一道快速拦截，避免把明显不是音频的文件丢给解码器。
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac|aiff?|mp4)$/i

const AUDIO_MIME = /^(audio\/|video\/(mp4|webm|ogg))/i

/**
 * 判断文件是否「看起来是音频」。
 * 优先看 MIME（浏览器对音频文件基本都会给出 audio/*），
 * MIME 缺失时退回到扩展名判断。
 */
export function looksLikeAudio(file) {
  if (!file) return false
  const type = (file.type || '').toLowerCase()
  if (type) {
    if (AUDIO_MIME.test(type)) return true
    // 有些系统会把 wav 标成 application/octet-stream，此时不直接否定，
    // 交给扩展名再判一次。
    if (type === 'application/octet-stream') return AUDIO_EXT.test(file.name || '')
    return false
  }
  return AUDIO_EXT.test(file.name || '')
}

/**
 * decodeAudioData 会「消费」传入的 ArrayBuffer（解码后该 buffer 被 detach），
 * 因此必须先 slice 一份副本，否则调用方手里的 buffer 会失效。
 * 同时兼容老版 Safari 只认回调签名的情况。
 */
function decodeAudioData(ctx, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false
    const onOk = (buf) => { if (!settled) { settled = true; resolve(buf) } }
    const onErr = (err) => { if (!settled) { settled = true; reject(err) } }
    try {
      const ret = ctx.decodeAudioData(arrayBuffer.slice(0), onOk, onErr)
      if (ret && typeof ret.then === 'function') ret.then(onOk, onErr)
    } catch (e) {
      onErr(e)
    }
  })
}

/**
 * 把解码后的 AudioBuffer 混合成单声道 Float32Array。
 * 多声道取算术平均：人声素材以单/双声道为主，平均能保留音色且不引入相位问题。
 */
function toMono(audioBuffer) {
  const channels = audioBuffer.numberOfChannels
  const length = audioBuffer.length
  if (channels === 1) {
    // 复制一份，避免持有 AudioBuffer 内部引用导致其无法释放
    return new Float32Array(audioBuffer.getChannelData(0))
  }
  const out = new Float32Array(length)
  for (let c = 0; c < channels; c++) {
    const data = audioBuffer.getChannelData(c)
    for (let i = 0; i < length; i++) out[i] += data[i]
  }
  const inv = 1 / channels
  for (let i = 0; i < length; i++) out[i] *= inv
  return out
}

/**
 * 读取文件为 ArrayBuffer。
 * 优先用 file.arrayBuffer()（现代浏览器），不可用时退回 FileReader。
 */
function readArrayBuffer(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('音频文件读取失败，请重新选择文件'))
    reader.readAsArrayBuffer(file)
  })
}

/**
 * 解码音频文件。
 *
 * @param {File|Blob} file 用户选择的音频文件
 * @returns {Promise<{ok: boolean, samples: Float32Array|null, sampleRate: number, duration: number, error: string|null}>}
 *   ok=true 时 samples 为单声道 [-1,1] 采样，duration 为真实时长（秒），
 *   sampleRate 为真实采样率（Hz）；ok=false 时 error 为可直接展示的中文提示。
 */
export async function decodeAudioFile(file) {
  const fail = (error) => ({ ok: false, samples: null, sampleRate: 0, duration: 0, error })

  if (!file) return fail('未选择音频文件，请先上传声音样本')
  if (typeof file.size === 'number' && file.size === 0) {
    return fail('音频文件为空（0 字节），请重新选择有效的声音样本')
  }
  if (typeof file.size === 'number' && file.size > MAX_FILE_BYTES) {
    return fail('音频文件超过 20MB，请压缩或截取后再上传')
  }
  if (!looksLikeAudio(file)) {
    return fail('所选文件不是音频文件，仅支持 WAV / MP3 / M4A / OGG / WebM 等音频格式')
  }

  const Ctor = typeof window !== 'undefined'
    ? (window.AudioContext || window.webkitAudioContext)
    : null
  if (!Ctor) {
    return fail('当前浏览器不支持 WebAudio 解码，无法读取音频，请更换浏览器后重试')
  }

  let ctx = null
  try {
    const buffer = await readArrayBuffer(file)
    ctx = new Ctor()
    const audioBuffer = await decodeAudioData(ctx, buffer)
    if (!audioBuffer || audioBuffer.length === 0) {
      return fail('音频解码失败：文件可能已损坏或格式不受支持')
    }
    // 真实时长与真实采样率一律取自解码结果，不允许用户手填
    const duration = audioBuffer.duration
    const sampleRate = audioBuffer.sampleRate
    const samples = toMono(audioBuffer)
    if (!samples || samples.length === 0) {
      return fail('音频解码失败：文件可能已损坏或格式不受支持')
    }
    return { ok: true, samples, sampleRate, duration, error: null }
  } catch (e) {
    // decodeAudioData 对损坏/不支持的编码会抛错，统一转成可读的中文提示
    return fail('音频解码失败：文件可能已损坏或格式不受支持')
  } finally {
    // 释放 AudioContext，避免长时间占用音频硬件
    if (ctx && typeof ctx.close === 'function') {
      try { ctx.close() } catch { /* 忽略关闭异常 */ }
    }
  }
}
