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
