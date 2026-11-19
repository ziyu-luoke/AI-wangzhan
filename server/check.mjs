// 验证 DeepSeek 真实调用是否成功
// 用法：先 npm run dev，再另开终端执行 npm run check:deepseek
// 说明：本脚本只读取服务端 .env 的引用状态并发起一次真实最小调用，不打印明文密钥。
const BASE = process.env.API_BASE || 'http://127.0.0.1:8787'

async function main() {
  console.log('=== 1) 检查代理与密钥配置状态 ===')
  let health
  try {
    const r = await fetch(`${BASE}/api/health`)
    health = await r.json()
  } catch (e) {
    console.error(`❌ 无法连接本地代理 ${BASE}：${e.message}`)
    console.error('   请先在一个终端执行 npm run dev')
    process.exit(2)
  }
  console.log(`   代理：${health.service} · 默认模型：${health.defaultModel} · 白名单：${health.allowedHosts.join(',')}`)
  for (const k of health.keys) {
    console.log(`   ${k.env}: ${k.configured ? `已配置 (${k.masked})` : '未配置'}`)
  }

  const ds = health.keys.find((k) => k.env === 'DEEPSEEK_API_KEY')
  if (!ds?.configured) {
    console.error('\n❌ DEEPSEEK_API_KEY 未配置。请复制 .env.example 为 .env，填入真实密钥后重启 npm run dev。')
    process.exit(1)
  }

  console.log('\n=== 2) 发起一次真实最小调用（max_tokens=16，stream=false）===')
  const r = await fetch(`${BASE}/api/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: 'https://api.deepseek.com',
      modelId: health.defaultModel,
      apiKeyRef: 'env:DEEPSEEK_API_KEY',
    }),
  })
  const res = await r.json()
  if (res.ok) {
    console.log(`   ✅ 调用成功 · 延迟 ${res.latency}ms · 模型 ${res.model}`)
    console.log(`   模型回复：${res.reply || '(空)'}`)
    console.log('\n🎉 DeepSeek API 已真实接入成功。')
    process.exit(0)
  } else {
    console.error(`   ❌ 调用失败：${res.message}${res.latency != null ? ` · 延迟 ${res.latency}ms` : ''}`)
    process.exit(1)
  }
}

main().catch((e) => { console.error('验证脚本异常：', e); process.exit(2) })
