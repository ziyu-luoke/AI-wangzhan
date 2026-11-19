// 小智配置台 · 本地模型安全代理（零依赖，Node >= 18 原生 fetch）
// 职责：密钥只保存在服务端 .env / 环境变量；浏览器只拿到"引用名"和脱敏状态，永不接触明文密钥。
// 安全边界：
//   1) 前端传来的 apiKeyRef 必须是 env:VAR 形式，服务端据此从 process.env 取值，绝不接受明文密钥字段。
//   2) endpoint 做 host 白名单校验，防止把密钥转发到任意地址（SSRF）。
//   3) /api/health 只返回脱敏信息（configured + 尾4位），不回传密钥本身。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ---------- 极简 .env 加载（无第三方依赖）----------
function loadEnv(file) {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    // 环境变量优先级高于 .env（便于 CI/命令行覆盖）
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnv(path.join(ROOT, '.env'))

const PORT = Number(process.env.API_PORT || 8787)
const ALLOWED_HOSTS = (process.env.ALLOWED_API_HOSTS || 'api.deepseek.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
const DEFAULT_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
const REASONING = process.env.DEEPSEEK_REASONING || 'none' // none=关闭思考，响应更快

// ---------- 语音合成 / 音色克隆（千问AI平台 · 阿里云百炼兼容接口）----------
// 密钥复用 DASHSCOPE_API_KEY（health 探针已覆盖），网关与模型走服务端固定配置，
// 前端只传 base64 音频/文本，永不接触密钥与网关地址。
const TTS_BASE = (process.env.TTS_BASE_URL || 'https://maas.qianwenaiapi.com/api/v1').replace(/\/$/, '')
const TTS_MODEL = process.env.TTS_MODEL || 'qwen-audio-3.1-tts-plus'
const TTS_VOICE_API = `${TTS_BASE}/services/audio/tts/customization`
const TTS_SYNTH_API = `${TTS_BASE}/services/audio/tts/SpeechSynthesizer`
// 合成结果音频 URL 的下载白名单：只允许这些 OSS 域名，防止把请求引到任意地址（SSRF）
const TTS_AUDIO_HOSTS = (process.env.TTS_AUDIO_HOSTS ||
  'dashscope-result-bj.oss-cn-beijing.aliyuncs.com,dashscope-result-cn-beijing.oss-cn-beijing.aliyuncs.com,nls-cloud-cn-beijing.oss-cn-beijing.aliyuncs.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

// ---------- 工具函数 ----------
function maskKey(key) {
  if (!key) return ''
  if (key.length <= 8) return '****'
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}

// 解析前端传来的密钥引用：只接受 env:VAR 形式，从服务端环境取值
function resolveKey(apiKeyRef) {
  const ref = typeof apiKeyRef === 'string' ? apiKeyRef.trim() : ''
  if (!ref) return { key: '', error: '未配置密钥引用（apiKeyRef 为空）' }
  if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    return { key: '', error: '密钥引用格式非法：应为 env:VARIABLE_NAME，且不允许直接传明文密钥' }
  }
  const name = ref.slice(4)
  const key = process.env[name]
  if (!key || /^(sk-REPLACE_ME|your[_-]?key|changeme)$/i.test(key)) {
    return { key: '', error: `密钥变量 ${name} 尚未在服务端 .env 中配置（或仍是占位值）` }
  }
  return { key, error: '' }
}

// endpoint host 白名单，防止 SSRF 把密钥外带
function checkEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') return { ok: false, error: 'endpoint 为空' }
  let url
  try { url = new URL(endpoint) } catch { return { ok: false, error: 'endpoint 不是合法 URL' } }
  if (!/^https?:$/.test(url.protocol)) return { ok: false, error: '仅支持 http/https' }
  const host = url.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.includes(host)) {
    return { ok: false, error: `endpoint 主机 ${host} 不在白名单内（允许：${ALLOWED_HOSTS.join(', ')}）` }
  }
  return { ok: true, endpoint }
}

// 上游错误 → 友好中文提示
function friendlyError(status, raw) {
  let detail = ''
  try { detail = JSON.parse(raw)?.error?.message || raw } catch { detail = raw }
  const map = {
    401: 'API Key 无效或已过期，请检查服务端 .env 中的密钥',
    402: '账户余额不足，请到平台充值后重试',
    403: '无权限访问该模型',
    404: '模型名称或接口路径不存在，请检查 modelId',
    422: '请求参数不被接受：' + detail,
    429: '请求过于频繁（限流），请稍后再试',
    500: '模型服务内部错误：' + detail,
    503: '模型服务暂时不可用：' + detail,
  }
  return map[status] || `模型服务返回 ${status}：${detail}`.slice(0, 300)
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function buildUpstreamBody(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  const body = {
    model: payload.modelId || DEFAULT_MODEL,
    messages,
    stream: !!payload.stream,
    temperature: payload.params?.temperature ?? 0.7,
    max_tokens: payload.params?.maxTokens ?? 1024,
    thinking: { type: REASONING === 'none' ? 'disabled' : 'enabled' },
  }
  if (!body.stream && payload.params?.topP) body.top_p = payload.params.topP
  return body
}

// ---------- 路由 ----------
async function handleHealth(req, res) {
  const probe = ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY']
    .map((name) => ({ name, configured: !!process.env[name] && !/^sk-REPLACE_ME$/i.test(process.env[name]) }))
  sendJSON(res, 200, {
    ok: true,
    service: 'xiaozhi-model-proxy',
    defaultModel: DEFAULT_MODEL,
    allowedHosts: ALLOWED_HOSTS,
    tts: { configured: !!ttsKey(), model: TTS_MODEL, masked: ttsKey() ? maskKey(ttsKey()) : '' },
    keys: probe.map((k) => ({ env: k.name, configured: k.configured, masked: k.configured ? maskKey(process.env[k.name]) : '' })),
  })
}

async function handleTest(req, res) {
  const p = await readBody(req)
  const { key, error: keyErr } = resolveKey(p.apiKeyRef)
  if (!key) return sendJSON(res, 200, { ok: false, message: keyErr })
  const ep = checkEndpoint(p.endpoint)
  if (!ep.ok) return sendJSON(res, 200, { ok: false, message: ep.error })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  const started = Date.now()
  try {
    const r = await fetch(ep.endpoint.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: p.modelId || DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false,
        max_tokens: 16,
        thinking: { type: 'disabled' },
      }),
      signal: controller.signal,
    })
    const latency = Date.now() - started
    const text = await r.text()
    if (!r.ok) return sendJSON(res, 200, { ok: false, message: friendlyError(r.status, text), latency })
    let reply = ''
    try { reply = JSON.parse(text)?.choices?.[0]?.message?.content || '' } catch { /* ignore */ }
    return sendJSON(res, 200, { ok: true, latency, message: '真实调用成功', model: p.modelId || DEFAULT_MODEL, reply: reply.slice(0, 80) })
  } catch (e) {
    const msg = e.name === 'AbortError' ? '调用超时（20s）' : '网络错误：' + e.message
    return sendJSON(res, 200, { ok: false, message: msg, latency: Date.now() - started })
  } finally {
    clearTimeout(timer)
  }
}

async function handleChat(req, res) {
  const p = await readBody(req)
  const { key, error: keyErr } = resolveKey(p.apiKeyRef)
  if (!key) return sendJSON(res, 503, { error: keyErr })
  const ep = checkEndpoint(p.endpoint)
  if (!ep.ok) return sendJSON(res, 400, { error: ep.error })

  const upstreamBody = buildUpstreamBody(p)
  const controller = new AbortController()
  // 客户端断开 → 中止上游，避免浪费 token
  res.on('close', () => { if (!res.writableEnded) controller.abort() })
  const timer = setTimeout(() => controller.abort(), 120000)

  let upstream
  try {
    upstream = await fetch(ep.endpoint.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    const msg = e.name === 'AbortError' ? '调用超时' : '网络错误：' + e.message
    return sendJSON(res, 502, { error: msg })
  }

  if (!upstream.ok) {
    clearTimeout(timer)
    const text = await upstream.text()
    return sendJSON(res, upstream.status === 401 ? 401 : 502, { error: friendlyError(upstream.status, text) })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })

  try {
    const reader = upstream.body.getReader()
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
        if (data === '[DONE]') { res.write('data: [DONE]\n\n'); continue }
        try {
          const json = JSON.parse(data)
          const delta = json?.choices?.[0]?.delta?.content
          if (delta) res.write(`data: ${JSON.stringify({ content: delta })}\n\n`)
          const usage = json?.usage
          if (usage) res.write(`data: ${JSON.stringify({ usage })}\n\n`)
        } catch { /* 忽略无法解析的帧 */ }
      }
    }
    if (buffer.trim()) {
      const data = buffer.replace(/^data:\s*/, '').trim()
      if (data && data !== '[DONE]') {
        try {
          const json = JSON.parse(data)
          if (json?.choices?.[0]?.delta?.content) {
            res.write(`data: ${JSON.stringify({ content: json.choices[0].delta.content })}\n\n`)
          }
        } catch { /* ignore */ }
      }
    }
  } catch (e) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: '流式传输中断：' + e.message })}\n\n`)
    }
  } finally {
    clearTimeout(timer)
    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
  }
}

// ---------- 语音合成 / 音色克隆 路由 ----------

// 从服务端环境取语音密钥：只认 env 里的 DASHSCOPE_API_KEY，绝不接收前端明文
function ttsKey() {
  const key = (process.env.DASHSCOPE_API_KEY || '').trim()
  if (!key || /^(sk-REPLACE_ME|your[_-]?key|changeme)$/i.test(key)) return ''
  return key
}

// 校验 Base64 Data URI 音频，返回可透传给上游的 data URI
function normalizeAudioDataUri(audio) {
  if (typeof audio !== 'string') return { ok: false, error: '缺少音频数据（audio）' }
  const m = /^data:(audio\/(?:mpeg|mp3|wav|mp4|x-wav|ogg|webm));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(audio.trim())
  if (!m) return { ok: false, error: '音频格式不支持：仅接受 data:audio/<type>;base64,... 格式' }
  const bytes = Buffer.from(m[2].replace(/\s/g, ''), 'base64')
  if (bytes.length < 8 * 1024) return { ok: false, error: '音频数据过小（<8KB），请上传有效的声音样本' }
  if (bytes.length > 12 * 1024 * 1024) return { ok: false, error: '音频数据超过 12MB，请压缩后重试' }
  return { ok: true, uri: `data:${m[1].toLowerCase()};base64,${m[2].replace(/\s/g, '')}` }
}

// POST /api/tts/clone —— 上传参考音频，创建克隆音色（创建免费）
// 请求：{ audio: data:audio/...;base64,..., name?: string }
// 响应：{ ok:true, voiceId, status, message }；异步部署时 status=DEPLOYING，前端轮询 /api/tts/status
async function handleTtsClone(req, res) {
  const key = ttsKey()
  if (!key) return sendJSON(res, 503, { ok: false, error: '服务端尚未配置 DASHSCOPE_API_KEY（语音密钥），请在 .env 中配置' })
  let p
  try { p = await readBody(req, 14 * 1024 * 1024) } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }) }
  const aud = normalizeAudioDataUri(p.audio)
  if (!aud.ok) return sendJSON(res, 400, { ok: false, error: aud.error })
  // prefix 仅允许字母数字且 ≤10 字符（平台约束），用时间戳保证唯一、避免与已有音色冲突
  const prefix = 'vc' + String(Date.now()).slice(-6)
  const body = {
    model: 'voice-enrollment',
    input: {
      action: 'create_voice',
      target_model: TTS_MODEL,
      prefix,
      audio: aud.uri,
      language_hints: ['zh'],
      enable_volume_normalization: 'false',
    },
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)
  try {
    const r = await fetch(TTS_VOICE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await r.text()
    if (!r.ok) {
      let detail = text
      try { detail = JSON.parse(text)?.message || text } catch { /* ignore */ }
      return sendJSON(res, r.status === 401 ? 401 : 502, { ok: false, error: `音色创建失败：${detail}`.slice(0, 300) })
    }
    let json
    try { json = JSON.parse(text) } catch { return sendJSON(res, 502, { ok: false, error: '音色创建响应解析失败' }) }
    const voiceId = json?.output?.voice_id
    if (!voiceId) return sendJSON(res, 502, { ok: false, error: '音色创建未返回 voice_id' })
    return sendJSON(res, 200, { ok: true, voiceId, model: TTS_MODEL, status: 'DEPLOYING', message: '音色创建成功，正在部署，请稍候' })
  } catch (e) {
    const msg = e.name === 'AbortError' ? '音色创建超时（120s）' : '网络错误：' + e.message
    return sendJSON(res, 502, { ok: false, error: msg })
  } finally {
    clearTimeout(timer)
  }
}

// POST /api/tts/status —— 查询音色部署状态
// 请求：{ voiceId }  响应：{ ok:true, status:'OK'|'DEPLOYING'|'FAILED' }
async function handleTtsStatus(req, res) {
  const key = ttsKey()
  if (!key) return sendJSON(res, 503, { ok: false, error: '服务端尚未配置语音密钥' })
  let p
  try { p = await readBody(req) } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }) }
  if (!/^[A-Za-z0-9._-]+$/.test(String(p.voiceId || ''))) {
    return sendJSON(res, 400, { ok: false, error: 'voiceId 格式非法' })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const r = await fetch(TTS_VOICE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'voice-enrollment', input: { action: 'query_voice', voice_id: p.voiceId } }),
      signal: controller.signal,
    })
    const text = await r.text()
    if (!r.ok) return sendJSON(res, 502, { ok: false, error: `查询音色状态失败：${text.slice(0, 200)}` })
    let json
    try { json = JSON.parse(text) } catch { return sendJSON(res, 502, { ok: false, error: '状态响应解析失败' }) }
    const status = String(json?.output?.status || '').toUpperCase()
    return sendJSON(res, 200, { ok: true, status, voiceId: p.voiceId })
  } catch (e) {
    const msg = e.name === 'AbortError' ? '查询超时' : '网络错误：' + e.message
    return sendJSON(res, 502, { ok: false, error: msg })
  } finally {
    clearTimeout(timer)
  }
}

// POST /api/tts/synthesize —— 用（克隆）音色合成语音，服务端代理下载音频以二进制返回
// 请求：{ text, voiceId, model? }  响应：audio/mpeg 二进制；失败为 JSON
async function handleTtsSynthesize(req, res) {
  const key = ttsKey()
  if (!key) return sendJSON(res, 503, { ok: false, error: '服务端尚未配置语音密钥' })
  let p
  try { p = await readBody(req) } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }) }
  const text = String(p.text || '').trim()
  if (!text) return sendJSON(res, 400, { ok: false, error: '待合成文本为空' })
  if (text.length > 2000) return sendJSON(res, 400, { ok: false, error: '单次合成文本过长（>2000 字）' })
  const voice = String(p.voiceId || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(voice)) return sendJSON(res, 400, { ok: false, error: 'voiceId 非法：请先克隆音色或选择系统音色' })
  const model = typeof p.model === 'string' && /^[a-z0-9.-]+$/i.test(p.model) ? p.model : TTS_MODEL

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120000)
  let stage = 'synth-request'
  try {
    const r = await fetch(TTS_SYNTH_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        input: { text, voice, format: 'mp3', sample_rate: 24000 },
      }),
      signal: controller.signal,
    })
    stage = 'audio-download'
    const textResp = await r.text()
    if (!r.ok) {
      let detail = textResp
      try { detail = JSON.parse(textResp)?.message || textResp } catch { /* ignore */ }
      return sendJSON(res, r.status === 401 ? 401 : 502, { ok: false, error: `语音合成失败：${detail}`.slice(0, 300) })
    }
    let json
    try { json = JSON.parse(textResp) } catch { return sendJSON(res, 502, { ok: false, error: '合成响应解析失败' }) }
    const audioUrl = json?.output?.audio?.url
    if (!audioUrl) return sendJSON(res, 502, { ok: false, error: '合成响应未包含音频地址' })
    // SSRF 防护：音频下载域名必须在白名单内。
    // 注意：平台返回的 OSS 结果域名是 http://（内网回源域名），这是正常现象，
    // 因此这里只校验 host 白名单，不强制 https —— 域名白名单已足以防 SSRF。
    let host
    try {
      const u = new URL(audioUrl)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('协议非法')
      host = u.hostname.toLowerCase()
      if (!TTS_AUDIO_HOSTS.includes(host)) throw new Error(host)
    } catch {
      return sendJSON(res, 502, { ok: false, error: '音频下载地址不在安全白名单内，已拦截' })
    }
    stage = 'audio-fetch'
    const ar = await fetch(audioUrl, { signal: controller.signal })
    if (!ar.ok) return sendJSON(res, 502, { ok: false, error: `音频下载失败（${ar.status}）` })
    stage = 'audio-read'
    const abuf = Buffer.from(await ar.arrayBuffer())
    if (abuf.length < 32) return sendJSON(res, 502, { ok: false, error: '下载到的音频为空' })
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': abuf.length,
      'Cache-Control': 'no-store',
      'X-TTS-Voice': voice,
    })
    res.end(abuf)
  } catch (e) {
    const msg = e.name === 'AbortError' ? `合成超时(${stage})` : `网络错误(${stage})：${e.message}`
    if (!res.headersSent) sendJSON(res, 502, { ok: false, error: msg })
    else if (!res.writableEnded) res.end()
  } finally {
    clearTimeout(timer)
  }
}

// ---------- 服务 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  // 仅允许本机访问，避免把代理暴露到局域网
  const addr = req.socket.remoteAddress || ''
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(addr)) {
    return sendJSON(res, 403, { error: '仅允许本机访问' })
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return await handleHealth(req, res)
    if (req.method === 'POST' && url.pathname === '/api/test') return await handleTest(req, res)
    if (req.method === 'POST' && url.pathname === '/api/chat') return await handleChat(req, res)
    if (req.method === 'POST' && url.pathname === '/api/tts/clone') return await handleTtsClone(req, res)
    if (req.method === 'POST' && url.pathname === '/api/tts/status') return await handleTtsStatus(req, res)
    if (req.method === 'POST' && url.pathname === '/api/tts/synthesize') return await handleTtsSynthesize(req, res)
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    return sendJSON(res, 404, { error: 'Not Found' })
  } catch (e) {
    if (!res.headersSent) sendJSON(res, 400, { error: e.message || '请求处理失败' })
    else if (!res.writableEnded) res.end()
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const anyKey = ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'OPENAI_API_KEY']
    .some((n) => process.env[n] && !/^sk-REPLACE_ME$/i.test(process.env[n]))
  console.log(`[xiaozhi-proxy] 已启动 http://127.0.0.1:${PORT}`)
  console.log(`[xiaozhi-proxy] 服务端密钥状态：${anyKey ? '已配置' : '未配置（请编辑 .env）'}`)
  console.log(`[xiaozhi-proxy] 白名单 host：${ALLOWED_HOSTS.join(', ')} · 默认模型：${DEFAULT_MODEL}`)
})
