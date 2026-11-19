// 素材驱动的形象生成引擎（本地原型）
// 核心原则：候选必须来自上传素材本身，而不是固定 emoji/固定渐变
// 原型阶段用 canvas 对素材做 Q 版风格化处理（主色调提取 + 裁切 + 滤镜 + 圆角），
// 让不同素材生成不同且外观相似的候选。真实接入时把 renderCandidate 换成图生图 API 即可，
// 输入输出契约保持不变（generate(files, params) -> Candidate[]）。

const DEFAULT_SIZE = 512

// 风格 -> 画布滤镜与背景处理参数
const STYLE_RECIPES = {
  '日系赛璐璐': { filter: 'saturate(1.25) contrast(1.08)', bgMix: 0.32, border: '#5a4a3a' },
  'Q版可爱': { filter: 'saturate(1.35) brightness(1.06)', bgMix: 0.42, border: '#c98aa0' },
  '国风仙侠': { filter: 'sepia(0.28) saturate(1.15)', bgMix: 0.28, border: '#8a6d3b' },
  '像素风': { filter: 'saturate(1.1) contrast(1.2)', bgMix: 0.2, border: '#5b6b52', pixel: true },
  '治愈水彩': { filter: 'saturate(0.92) brightness(1.08) blur(0.6px)', bgMix: 0.5, border: '#7a9a86' },
}

// 把文件读成 HTMLImageElement（含 dataURL，便于后续绘制与导出）
function readImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      return reject(new Error('素材不是有效的图片文件'))
    }
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('素材读取失败，请重新选择文件'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('素材图片解析失败，可能文件已损坏'))
      img.onload = () => resolve({ img, dataUrl: reader.result })
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

// img -> RGB，取图片中心区域像素均值，跳过透明与极端黑白（多为背景）
function extractDominantColor(img) {
  try {
    const c = document.createElement('canvas')
    const S = 48
    c.width = S; c.height = S
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, S, S)
    const { data } = ctx.getImageData(0, 0, S, S)
    let r = 0, g = 0, b = 0, n = 0
    for (let i = 0; i < data.length; i += 4) {
      const [R, G, B, A] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
      if (A < 128) continue
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B)
      if (mx > 246 && mn > 246) continue // 近白背景
      if (mx < 18) continue              // 近黑
      r += R; g += G; b += B; n++
    }
    if (!n) return { r: 168, g: 216, b: 234, hex: '#a8d8ea' }
    r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n)
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
    return { r, g, b, hex }
  } catch {
    return { r: 168, g: 216, b: 234, hex: '#a8d8ea' }
  }
}

function lighten({ r, g, b }, t) {
  const mix = (v) => Math.round(v + (255 - v) * t)
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`
}

// 按风格把素材渲染成一张 Q 版风格化候选图，返回 dataURL
function renderCandidate({ img, dataUrl }, style, params) {
  const recipe = STYLE_RECIPES[style] || STYLE_RECIPES['Q版可爱']
  const size = DEFAULT_SIZE
  const canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')
  const dom = extractDominantColor(img)

  // 背景：素材主色调提亮的柔和渐变（不同素材主色不同 → 背景不同）
  const grad = ctx.createLinearGradient(0, 0, size, size)
  grad.addColorStop(0, lighten(dom, 1 - recipe.bgMix))
  grad.addColorStop(1, lighten(dom, 0.55 - recipe.bgMix / 2))
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, size, size)

  // 主体：等比 contain 绘制素材本身（保留外观特征），套用风格滤镜
  const pad = 34
  const iw = img.naturalWidth || img.width || size
  const ih = img.naturalHeight || img.height || size
  const scale = Math.min((size - pad * 2) / iw, (size - pad * 2) / ih)
  const dw = iw * scale, dh = ih * scale
  const dx = (size - dw) / 2, dy = (size - dh) / 2

  ctx.save()
  if (recipe.pixel) {
    // 像素风：降采样再放大，制造颗粒感
    const small = document.createElement('canvas')
    const sw = Math.max(24, Math.round(dw / 8)), sh = Math.max(24, Math.round(dh / 8))
    small.width = sw; small.height = sh
    const sctx = small.getContext('2d')
    sctx.filter = recipe.filter
    sctx.drawImage(img, dx, dy, dw, dh, 0, 0, sw, sh)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(small, 0, 0, sw, sh, dx, dy, dw, dh)
  } else {
    ctx.filter = recipe.filter
    ctx.drawImage(img, dx, dy, dw, dh)
  }
  ctx.restore()

  // Q 版描边：柔和圆角边框
  ctx.strokeStyle = recipe.border
  ctx.lineWidth = 6
  ctx.beginPath()
  const rr = 28
  ctx.moveTo(rr, 3); ctx.arcTo(size - 3, 3, size - 3, size - 3, rr)
  ctx.arcTo(size - 3, size - 3, 3, size - 3, rr)
  ctx.arcTo(3, size - 3, 3, 3, rr); ctx.arcTo(3, 3, size - 3, 3, rr)
  ctx.closePath(); ctx.stroke()

  return {
    canvasDataUrl: canvas.toDataURL('image/png'),
    sourceDataUrl: dataUrl,
    dominant: dom.hex,
  }
}

// 生成入口：files=上传的素材数组，params={name, styles[], resolution, background}
// 返回 Candidate[]：{ id, name, style, imageUrl, gradient, emoji, dominant, fromSource }
export async function generateAvatarCandidates(files, params = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可用素材：请先上传至少一张图片')
  }
  // 只取第一张作为主素材（多素材时以第一张为准，符合原型预期）
  const loaded = await readImage(files[0])
  const styles = Array.isArray(params.styles) && params.styles.length
    ? params.styles.slice(0, 3)
    : ['Q版可爱']
  const name = params.name || '新形象'

  const candidates = styles.map((style, i) => {
    const rendered = renderCandidate(loaded, style, params)
    return {
      id: `cand-${Date.now()}-${i}`,
      name: `${name} · 候选 ${i + 1}`,
      style,
      imageUrl: rendered.canvasDataUrl,
      gradient: `linear-gradient(135deg, ${rendered.dominant}, ${lighten(hexToRgb(rendered.dominant), 0.55)})`,
      emoji: '', // 不再使用固定 emoji；有真实素材时展示素材生成图
      dominant: rendered.dominant,
      fromSource: files[0].name,
      sourceDataUrl: rendered.sourceDataUrl,
    }
  })
  return candidates
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '')
  return {
    r: parseInt(h.slice(0, 2), 16) || 0,
    g: parseInt(h.slice(2, 4), 16) || 0,
    b: parseInt(h.slice(4, 6), 16) || 0,
  }
}
