// 虚拟形象 · 表情图集存储
// 设计要点：
//   1) 5 类表情各一张图：happy / thinking / surprised / angry / idle
//   2) 上传图统一到 240x240：等比 contain + 居中留白（透明），不拉伸、不裁切，画面内容不损坏
//   3) 图片二进制存 IndexedDB；形象资源里只保存引用 key，不把 dataURL 塞进配置库
//   4) 隐私模式/无 IndexedDB 时降级内存 Map，保证本次会话可用

export const EXPRESSION_KEYS = ['happy', 'thinking', 'surprised', 'angry', 'idle']
export const EXPRESSION_LABELS = {
  happy: '开心', thinking: '思考', surprised: '惊讶', angry: '生气', idle: '待机',
}

const TARGET_SIZE = 240
const DB_NAME = 'xiaozhi-console-avatar-assets'
const STORE_NAME = 'images'

const memoryBlobs = new Map()
const memoryUrls = new Map()
let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return }
    let req
    try { req = indexedDB.open(DB_NAME, 1) } catch { resolve(null); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

async function idbPut(key, value) {
  const db = await openDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(value, key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch { resolve(false) }
  })
}

async function idbGet(key) {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

async function idbDelete(keys) {
  const db = await openDb()
  if (!db || !keys.length) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      keys.forEach((k) => store.delete(k))
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch { resolve(false) }
  })
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(blob)
  })
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('图片解析失败，可能文件已损坏'))
    img.src = src
  })
}

function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(',')
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png'
  const bin = atob(body || '')
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * 把一张上传图规范成 240x240 的透明 PNG。
 * 采用等比 contain + 居中留白：不拉伸、不裁切，原始画面比例和内容都保留。
 * @returns {Promise<{blob: Blob, previewUrl: string, width: number, height: number, bytes: number}>}
 */
export async function normalizeExpressionImage(file) {
  if (!file || (!file.type?.startsWith('image/') && !/\.(png|jpe?g|webp|gif)$/i.test(file.name || ''))) {
    throw new Error('仅支持 PNG / JPG / WebP / GIF 图片')
  }
  const dataUrl = await readAsDataUrl(file)
  const img = await loadImage(dataUrl)
  const iw = img.naturalWidth || img.width
  const ih = img.naturalHeight || img.height
  if (!iw || !ih) throw new Error('图片尺寸无效')

  const canvas = document.createElement('canvas')
  canvas.width = TARGET_SIZE
  canvas.height = TARGET_SIZE
  const ctx = canvas.getContext('2d')
  // 透明背景留白，绝不拉伸变形
  ctx.clearRect(0, 0, TARGET_SIZE, TARGET_SIZE)
  const scale = Math.min(TARGET_SIZE / iw, TARGET_SIZE / ih)
  const dw = Math.max(1, Math.round(iw * scale))
  const dh = Math.max(1, Math.round(ih * scale))
  const dx = Math.round((TARGET_SIZE - dw) / 2)
  const dy = Math.round((TARGET_SIZE - dh) / 2)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, dx, dy, dw, dh)

  const outUrl = canvas.toDataURL('image/png')
  return {
    blob: dataUrlToBlob(outUrl),
    previewUrl: outUrl,
    width: iw,
    height: ih,
    bytes: Math.round(outUrl.length * 0.75),
  }
}

export function expressionKey(avatarId, expression) {
  return `avatar:${avatarId}:${expression}`
}

/**
 * 批量写入 5 类表情图。images: { happy: Blob, ... }
 * 返回写入后的引用映射 { happy: key, ... }，供形象资源保存。
 */
export async function saveAvatarExpressions(avatarId, images) {
  const refs = {}
  for (const expr of EXPRESSION_KEYS) {
    const blob = images?.[expr]
    if (!blob) continue
    const key = expressionKey(avatarId, expr)
    const ok = await idbPut(key, blob)
    if (ok) memoryBlobs.delete(key)
    else memoryBlobs.set(key, blob) // 降级：本次会话仍可用
    refs[expr] = key
  }
  return refs
}

/**
 * 把单张表情图写入指定 key（编辑替换时用带版本的新 key，确保引用变化触发头像组件刷新）。
 * 成功写库后清掉内存兜底；写库失败则退化到内存 Map，保证本次会话可用。
 */
export async function putAvatarExpression(key, blob) {
  if (!key || !blob) return false
  const ok = await idbPut(key, blob)
  if (ok) memoryBlobs.delete(key)
  else memoryBlobs.set(key, blob)
  return ok
}

/** 读取图片 Blob（IndexedDB 优先，内存兜底） */
export async function loadAvatarExpressionBlob(key) {
  if (!key) return null
  const fromDb = await idbGet(key)
  if (fromDb) return fromDb
  return memoryBlobs.get(key) || null
}

/** 读取可直接放进 <img src> 的 URL；内部缓存，避免重复创建 objectURL */
export async function loadAvatarExpressionUrl(key) {
  if (!key) return null
  if (memoryUrls.has(key)) return memoryUrls.get(key)
  const blob = await loadAvatarExpressionBlob(key)
  if (!blob) return null
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null
  const url = URL.createObjectURL(blob)
  memoryUrls.set(key, url)
  return url
}

/** 批量读取，返回 { happy: url, ... } */
export async function loadAvatarExpressionUrls(refs = {}) {
  const entries = await Promise.all(
    EXPRESSION_KEYS.map(async (expr) => [expr, await loadAvatarExpressionUrl(refs[expr])])
  )
  return Object.fromEntries(entries.filter(([, url]) => !!url))
}

/** 删除形象时同步清理其 5 张图 */
export async function deleteAvatarExpressions(refs = {}) {
  const keys = EXPRESSION_KEYS.map((e) => refs[e]).filter(Boolean)
  keys.forEach((k) => { memoryBlobs.delete(k); const u = memoryUrls.get(k); if (u) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } memoryUrls.delete(k) } })
  if (keys.length) await idbDelete(keys)
}

/** 释放某张图的 objectURL（形象被替换时） */
export function revokeExpressionUrl(key) {
  const url = memoryUrls.get(key)
  if (url) { try { URL.revokeObjectURL(url) } catch { /* ignore */ } memoryUrls.delete(key) }
}
