#!/usr/bin/env node
// 声音克隆功能 · 独立验证脚本（反例式 / 证伪优先）
//
// 设计原则：
//   1. 与 scripts/test-voice.mjs 完全独立，不复用其代码，只依据 docs/voice-clone-contract.md 契约。
//   2. 以「能否证伪」为目标：默认实现可能造假/写死，用反例去攻击它。
//   3. 纯 Node 环境运行，无浏览器 API、无新 npm 依赖。
//
// 运行：node scripts/verify-voice-clone.mjs    退出码 0 = 全部通过

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MODULE_PATH = path.join(ROOT, 'src', 'engine', 'voiceClone.js')

// ============================ 迷你测试框架 ============================

const groups = []
let current = null

function group(title) {
  current = { title, checks: [] }
  groups.push(current)
  return current
}

function check(desc, fn) {
  const item = { desc, ok: false, detail: '' }
  try {
    const r = fn()
    if (r === true) { item.ok = true; item.detail = '' }
    else if (r === false || r == null) { item.ok = false; item.detail = '返回 false / 空' }
    else { item.ok = true; item.detail = String(r) }
  } catch (e) {
    item.ok = false
    item.detail = `抛出异常：${e && e.message ? e.message : String(e)}`
  }
  current.checks.push(item)
  return item.ok
}

/** 异步版本的 check（fn 可为 async），需 await 使用 */
async function acheck(desc, fn) {
  const item = { desc, ok: false, detail: '' }
  try {
    const r = await fn()
    if (r === true) { item.ok = true; item.detail = '' }
    else if (r === false || r == null) { item.ok = false; item.detail = '返回 false / 空' }
    else { item.ok = true; item.detail = String(r) }
  } catch (e) {
    item.ok = false
    item.detail = `抛出异常：${e && e.message ? e.message : String(e)}`
  }
  current.checks.push(item)
  return item.ok
}

/** 断言：条件为真则返回说明文字（记为 PASS），否则抛出带证据的 Error（记为 FAIL） */
function assert(cond, okMsg, failMsg) {
  if (!cond) throw new Error(failMsg)
  return okMsg
}

function info(msg) {
  current.checks.push({ desc: '[信息]', ok: true, detail: msg, info: true })
}

// ============================ 工具函数 ============================

/** 确定性伪随机（LCG），保证信号可复现 */
function makeRng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * 合成信号。freq=基频(Hz)，harmonics=谐波层数（制造明亮度差异），noise=噪声占比
 * 边缘做淡入淡出，避免截断带来的频谱泄漏污染基频检测
 */
function makeSignal({ freq, durSec = 1.5, sampleRate = 16000, amp = 0.5, harmonics = 0, noise = 0, seed = 12345 }) {
  const n = Math.round(durSec * sampleRate)
  const out = new Float32Array(n)
  const rng = makeRng(seed)
  const fadeLen = Math.max(1, Math.floor(sampleRate * 0.02))
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let v = Math.sin(2 * Math.PI * freq * t)
    for (let k = 2; k <= harmonics; k++) v += (1 / k) * Math.sin(2 * Math.PI * freq * k * t)
    if (noise > 0) v += noise * (rng() * 2 - 1)
    const edge = Math.min(i, n - 1 - i)
    const fade = Math.min(1, edge / fadeLen)
    out[i] = v * amp * fade
  }
  return out
}

function cloneBuffer(buf) {
  return Float32Array.from(buf)
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 构造一个 decoded 对象（对齐 audioDecode.js 的返回形状） */
function makeDecoded(samples, sampleRate = 16000) {
  return {
    ok: true,
    samples,
    sampleRate,
    duration: samples.length / sampleRate,
    error: null,
  }
}

/** 手搓特征向量（用于直接攻击 deriveParams，不依赖音频实现） */
function makeFeatures(over = {}) {
  return {
    duration: 3,
    sampleRate: 16000,
    rms: 0.3,
    peak: 0.6,
    zcr: 0.1,
    f0: 180,
    brightness: 0.4,
    silenceRatio: 0.2,
    clipping: 0,
    ...over,
  }
}

// ============================ 字面量扫描 ============================

/**
 * 扫描全仓库中的固定音色字面量。
 * - 硬命中区（判 FAIL）：源代码文件 .js/.jsx/.ts/.tsx/.mjs/.cjs/.html/.json/.vue/.svelte，排除 node_modules/、dist/、.git/
 * - 软命中区（仅提示）：scripts/ 下的测试脚本（可能是反例断言）、以及非源代码文件（日志/文档等）
 * - 本脚本自身排除（它显式引用了该字面量用于扫描）
 */
function scanHardcodedVoiceLiterals() {
  const needle = ['voice_clone_', 'A'].join('') // 动态拼接，避免本脚本自身命中
  const needle2 = ['voice_clone_', 'B'].join('')
  const excludedDirs = new Set(['node_modules', 'dist', '.git', '.vite', 'coverage'])
  const SOURCE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.html', '.json', '.vue', '.svelte'])
  const excludedFiles = new Set(['verify-voice-clone.mjs'])
  const hits = []
  const softHits = []

  const walk = (dir, rel = '') => {
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (excludedDirs.has(e.name)) continue
        walk(abs, relPath)
        continue
      }
      if (!e.isFile()) continue
      if (excludedFiles.has(e.name)) continue
      const isSource = SOURCE_EXT.has(path.extname(e.name).toLowerCase())
      const isTestDir = rel.startsWith('scripts')
      let text
      try { text = fs.readFileSync(abs, 'utf8') } catch { continue }
      for (const n of [needle, needle2]) {
        if (!text.includes(n)) continue
        const lines = text.split(/\r?\n/)
        const lineNo = lines.findIndex((l) => l.includes(n)) + 1
        const rec = { file: relPath, line: lineNo, needle: n, excerpt: (lines[lineNo - 1] || '').trim().slice(0, 120) }
        if (isSource && !isTestDir) hits.push(rec)
        else softHits.push(rec)
      }
    }
  }
  walk(ROOT)
  return { hits, softHits }
}

// ============================ 主流程 ============================

async function main() {
  console.log('='.repeat(78))
  console.log('  声音克隆功能 · 独立验证脚本（反例式）')
  console.log(`  目标模块：${path.relative(ROOT, MODULE_PATH).replace(/\\/g, '/')}`)
  console.log('='.repeat(78))

  // ---------- 阶段 0：模块存在性与可导入性 ----------
  group('阶段 0 · 模块存在性与 Node 可导入性（契约 2.1 / 3 关键约束）')

  let vc = null
  if (!fs.existsSync(MODULE_PATH)) {
    check('src/engine/voiceClone.js 存在', () => assert(false, '', '文件不存在：前端工程师尚未提交实现'))
  } else {
    check('src/engine/voiceClone.js 存在', () => '文件存在')
    try {
      vc = await import(pathToFileURL(MODULE_PATH).href)
    } catch (e) {
      check('模块可在纯 Node 环境直接 import（不依赖 DOM/WebAudio）', () =>
        assert(false, '', `import 失败：${e && e.message ? e.message : e}`))
    }
  }

  if (vc) {
    check('模块可在纯 Node 环境直接 import（不依赖 DOM/WebAudio）', () => 'import 成功，模块未在顶层引用 window/document/AudioContext')
  }

  const extractFeatures = vc?.extractFeatures
  const deriveParams = vc?.deriveParams
  const hashFeatures = vc?.hashFeatures
  const cloneFromAudio = vc?.cloneFromAudio

  check('导出 extractFeatures / deriveParams / hashFeatures / cloneFromAudio', () => {
    const missing = []
    if (typeof extractFeatures !== 'function') missing.push('extractFeatures')
    if (typeof deriveParams !== 'function') missing.push('deriveParams')
    if (typeof hashFeatures !== 'function') missing.push('hashFeatures')
    if (typeof cloneFromAudio !== 'function') missing.push('cloneFromAudio')
    return assert(missing.length === 0, '四个契约导出齐全', `缺少导出：${missing.join(', ')}`)
  })

  const engineReady = ['extractFeatures', 'deriveParams', 'hashFeatures', 'cloneFromAudio']
    .every((k) => typeof vc?.[k] === 'function')

  // ---------- 阶段 1~8：引擎层行为验证（依赖模块就绪） ----------
  if (engineReady) {
    await runEngineStages({ extractFeatures, deriveParams, hashFeatures, cloneFromAudio })
    await runAttackStages({ extractFeatures, deriveParams, hashFeatures, cloneFromAudio })
  } else {
    group('阶段 1~8 · 引擎层行为验证')
    info('因 src/engine/voiceClone.js 未就绪或导出缺失，跳过引擎层行为验证（阶段 1~8、12）')
    for (let i = 1; i <= 8; i++) {
      check(`阶段 ${i} 未执行`, () => assert(false, '', '引擎模块未就绪，无法执行'))
    }
  }

  await runSourceStages()
  return finish()
}

/** 阶段 12：team-lead 指定的 6 个重点攻击点 */
async function runAttackStages({ extractFeatures, deriveParams, hashFeatures, cloneFromAudio }) {
  group('阶段 12 · 重点攻击点（team-lead 指定的 6 个高风险点）')

  const E = { extractFeatures, deriveParams, hashFeatures, cloneFromAudio }

  // --- 攻击点 1：特征差异极大的素材，候选 voiceId 是否真的无交集 ---
  check('【攻击1】特征差异极大的素材（人声/白噪声/低频嗡鸣）候选 voiceId 无交集', () => {
    const sr = 16000
    const voiceSig = (f, dur = 2, amp = 0.5) => {
      const n = Math.round(dur * sr); const o = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const env = 0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / sr)
        let v = Math.sin((2 * Math.PI * f * i) / sr)
        for (let k = 2; k <= 5; k++) v += (1 / k) * Math.sin((2 * Math.PI * f * k * i) / sr)
        o[i] = v * amp * env
      }
      return o
    }
    const whiteSig = (dur = 2, amp = 0.5) => {
      const n = Math.round(dur * sr); const o = new Float32Array(n); const rng = makeRng(777)
      for (let i = 0; i < n; i++) o[i] = rng() * amp
      return o
    }
    const humSig = (f = 55, dur = 2, amp = 0.5) => {
      const n = Math.round(dur * sr); const o = new Float32Array(n)
      for (let i = 0; i < n; i++) o[i] = Math.sin((2 * Math.PI * f * i) / sr) * amp
      return o
    }
    const mats = [
      ['人声110Hz', voiceSig(110)], ['人声260Hz', voiceSig(260)], ['人声350Hz', voiceSig(350)],
      ['白噪声', whiteSig()], ['低频嗡鸣55Hz', humSig(55)], ['低频嗡鸣30Hz', humSig(30)],
    ]
    const seen = new Map(); const collisions = []; const rows = []
    for (const [label, sig] of mats) {
      const f = E.extractFeatures(sig, sr)
      const c = E.cloneFromAudio({ samples: sig, sampleRate: sr, duration: 2 }, { name: label, count: 3, seed: '' })
      const ids = [...new Set(c.map((x) => x.voiceId))]
      rows.push(`${label}(f0=${f.f0.toFixed(1)}Hz)`)
      for (const v of ids) {
        if (seen.has(v)) collisions.push(`${label} 与 ${seen.get(v)} 撞号 ${v}`)
        else seen.set(v, label)
      }
    }
    return assert(collisions.length === 0,
      `${mats.length} 组极端素材 → ${seen.size} 个不同 voiceId，零碰撞：${rows.join(' / ')}`,
      `发生撞号 ${collisions.length} 处：${collisions.join('；')}`)
  })

  // --- 攻击点 2：白噪声的 f0 是否误检伪峰 ---
  check('【攻击2】白噪声不被误判为稳定语音基频（zcr 应显著区别于语音）', () => {
    const sr = 16000
    const rows = []
    let suspicious = []
    for (const seed of [1, 42, 777, 12345, 99999]) {
      // 真正的白噪声必须【居中】（零均值）；若用单极 [0,1) 噪声会引入 DC 偏置，
      // zcr 会恒为 0，那是测试方法错误而非实现缺陷
      const rng = makeRng(seed)
      const n = sr * 2; const o = new Float32Array(n)
      for (let i = 0; i < n; i++) o[i] = (rng() * 2 - 1) * 0.5
      const f = E.extractFeatures(o, sr)
      const p = E.deriveParams(f)
      rows.push(`seed${seed}: f0=${f.f0.toFixed(1)}Hz zcr=${f.zcr.toFixed(3)} bright=${f.brightness.toFixed(3)} gender=${p.gender}`)
      // 判据：白噪 zcr ≈ 0.5（远高于语音 0.03~0.15），据此可与语音区分；
      // 若 zcr 偏低却仍报出稳定 f0，才说明把噪声当成了语音。
      if (f.f0 > 0 && f.zcr < 0.3) suspicious.push(`seed${seed} f0=${f.f0.toFixed(1)}Hz 但 zcr=${f.zcr.toFixed(3)} 偏低，疑似把噪声当语音`)
      if (f.zcr > 0.3 && !['male', 'female', 'neutral'].includes(p.gender)) suspicious.push(`seed${seed} gender 非法`)
    }
    return assert(suspicious.length === 0,
      `白噪未被当作语音基频（zcr≈0.5 明显区别于语音 0.03~0.15，UI 层可据此识别）：${rows.join(' | ')}`,
      `疑似伪峰误检：${suspicious.join('；')}`)
  })

  check('【攻击2b】人声基频全域扫描 60~400Hz 检出准确（逐 5Hz）', () => {
    const sr = 16000
    const bad = []
    let count = 0
    for (let f = 60; f <= 400; f += 5) {
      const n = sr * 2; const o = new Float32Array(n)
      for (let i = 0; i < n; i++) o[i] = Math.sin((2 * Math.PI * f * i) / sr) * 0.5
      const d = E.extractFeatures(o, sr)
      count++
      if (d.f0 === 0 || Math.abs(d.f0 - f) / f >= 0.15) bad.push(`${f}Hz→${d.f0.toFixed(1)}Hz`)
    }
    return assert(bad.length === 0, `60~400Hz 共 ${count} 个频点全部检出准确（误差 <15%）`,
      `${bad.length} 个频点异常：${bad.join(', ')}`
      + (bad.length === 1 && bad[0].startsWith('60Hz')
        ? '。根因：maxLag=ceil(sr/60)=267 使最低可达 f0=59.925Hz < F0_MIN=60，'
          + '该帧被范围守卫整帧丢弃 → 60Hz 恰好落在 [59.925, 60.150)Hz 死区内'
        : ''))
  })

  check('【攻击2c】低频干扰下 f0 不应被推到搜索区间另一端（不得报 400Hz 假峰）', () => {
    const sr = 16000
    const mix = (voiceF, rumbleF, rumbleAmp) => {
      const n = sr * 2; const o = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const t = i / sr
        const env = 0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t)
        let v = Math.sin(2 * Math.PI * voiceF * t)
        for (let k = 2; k <= 4; k++) v += (1 / k) * Math.sin(2 * Math.PI * voiceF * k * t)
        o[i] = (v * 0.35 + Math.sin(2 * Math.PI * rumbleF * t) * rumbleAmp) * env
      }
      return o
    }
    const rows = []
    const bad = []
    // 低频嗡鸣 50Hz（周期 320 点 > maxLag 267）会压制真实基频并诱发伪峰
    for (const ra of [0.2, 0.3, 0.4, 0.5]) {
      const f = E.extractFeatures(mix(120, 50, ra), sr)
      const p = E.deriveParams(f)
      rows.push(`嗡${ra}: f0=${f.f0.toFixed(1)}Hz pitch=${p.pitch.toFixed(2)} ${p.gender}`)
      // 契约要求：无有效峰返回 0，而不是报出区间另一端的 400Hz
      if (f.f0 >= 399) bad.push(`嗡声幅度${ra} → f0=400Hz（搜索区间上界假峰），真值 120Hz`)
    }
    return assert(bad.length === 0,
      `低频嗡鸣下 f0 未落到区间上界：${rows.join(' | ')}`,
      `检出区间另一端的假峰：${bad.join('；')}。根因：maxLag=ceil(sr/60)=267 使最低可达 f0=59.925Hz < F0_MIN=60，`
      + `范围守卫把真峰整帧丢弃，反而放行 minLag 伪峰。契约要求「无有效峰返回 0」。`)
  })

  // --- 攻击点 3：纯静音边界 ---
  check('【攻击3】纯静音（全零数组）extractFeatures + deriveParams 安全无 NaN', () => {
    const sr = 16000
    const rows = []
    for (const [label, n] of [['全零1s', sr], ['全零0.1s', Math.round(sr * 0.1)], ['全零10s', sr * 10]]) {
      const o = new Float32Array(n)
      const f = E.extractFeatures(o, sr)
      const p = E.deriveParams(f)
      const badF = Object.entries(f).filter(([, v]) => typeof v === 'number' && !Number.isFinite(v)).map(([k]) => k)
      const badP = Object.entries(p).filter(([, v]) => typeof v === 'number' && !Number.isFinite(v)).map(([k]) => k)
      const rangeOk = p.pitch >= 0.5 && p.pitch <= 2 && p.speed >= 0.5 && p.speed <= 2 && p.emotion >= 0 && p.emotion <= 1
      const ok = badF.length === 0 && badP.length === 0 && rangeOk && ['male', 'female', 'neutral'].includes(p.gender)
      rows.push(`${label}: f0=${f.f0} silence=${f.silenceRatio} → pitch=${p.pitch} speed=${p.speed} emotion=${p.emotion} gender=${p.gender}`)
      if (!ok) return assert(false, '', `${label} 异常：NaN字段=${badF.concat(badP).join(',') || '无'}，区间合法=${rangeOk}`)
    }
    return assert(true, rows.join(' | '), '')
  })

  check('【攻击3b】全静音素材 f0 必须为 0（不得误检出基频）', () => {
    const sr = 16000
    const o = new Float32Array(sr * 2)
    const f = E.extractFeatures(o, sr)
    return assert(f.f0 === 0, `全零信号 f0=${f.f0}（正确：无有效峰返回 0）`, `全零信号误检出 f0=${f.f0}`)
  })

  // --- 攻击点 4：hashFeatures 碰撞风险 ---
  check('【攻击4a】hashFeatures 对 duration/rms 的量化分辨率（仅单字段变化）', () => {
    const base = { duration: 5, sampleRate: 16000, rms: 0.3, peak: 0.6, zcr: 0.1, f0: 180, brightness: 0.4, silenceRatio: 0.2, clipping: 0 }
    const h0 = E.hashFeatures(base, 'seed')
    const durDiff = []
    for (let d = 5; d < 5.05; d += 0.001) durDiff.push(E.hashFeatures({ ...base, duration: d }, 'seed') !== h0)
    const rmsDiff = []
    for (let r = 0.3; r < 0.31; r += 0.0001) rmsDiff.push(E.hashFeatures({ ...base, rms: r }, 'seed') !== h0)
    // duration 量化到 ms → 1ms 内必同；rms 量化到 1e-4 → 首档同、其余异
    const durOk = durDiff.filter(Boolean).length >= 45
    const rmsOk = rmsDiff.filter(Boolean).length >= 95
    return assert(durOk && rmsOk,
      `duration 1ms 分辨率：50 档中 ${durDiff.filter(Boolean).length} 档与基准不同；rms 1e-4 分辨率：100 档中 ${rmsDiff.filter(Boolean).length} 档不同（量化精度内碰撞属预期设计）`,
      `量化过粗：duration 不同档=${durDiff.filter(Boolean).length}/50，rms=${rmsDiff.filter(Boolean).length}/100`)
  })

  check('【攻击4b】500 组随机差异素材的 voiceId 碰撞率为 0', () => {
    const sr = 16000
    const rng = makeRng(987654321)
    const ids = new Map()
    let collide = 0
    const N = 500
    for (let i = 0; i < N; i++) {
      const f = rng() * 400 + 50
      const dur = 1 + rng() * 20
      const amp = 0.1 + rng() * 0.8
      const n = Math.round(dur * sr); const o = new Float32Array(n)
      for (let k = 0; k < n; k++) o[k] = Math.sin((2 * Math.PI * f * k) / sr) * amp * (0.5 + 0.5 * rng())
      const v = E.cloneFromAudio({ samples: o, sampleRate: sr, duration: dur }, { name: 'x', count: 1, seed: '' })[0].voiceId
      if (ids.has(v)) collide++
      else ids.set(v, i)
    }
    return assert(collide === 0, `${N} 组随机素材 → ${ids.size} 个不同 voiceId，碰撞 0 次（碰撞率 0.00%）`,
      `发生 ${collide} 次碰撞（${ids.size}/${N} 唯一）`)
  })

  // --- 攻击点 5：count 边界 ---
  check('【攻击5】count 边界（0/1/5/9/99/-1/小数/字符串/null/缺省）安全且返回数 = 请求数', () => {
    const sr = 16000
    const n = sr * 2; const o = new Float32Array(n)
    for (let i = 0; i < n; i++) o[i] = Math.sin((2 * Math.PI * 180 * i) / sr) * 0.5
    const d = { samples: o, sampleRate: sr, duration: 2 }
    const cases = [[0, 1], [1, 1], [5, 5], [9, 8], [99, 8], [-1, 1], [1.7, 2], ['3', 3], [null, 3], [undefined, 3]]
    const rows = []; const problems = []
    for (const [c, expect] of cases) {
      try {
        const r = E.cloneFromAudio(d, { name: 'x', count: c, seed: 's' })
        if (!Array.isArray(r)) { problems.push(`count=${JSON.stringify(c)} 未返回数组`); continue }
        if (r.length !== expect) problems.push(`count=${JSON.stringify(c)} → ${r.length} 个（期望 ${expect}）`)
        const sameVoice = new Set(r.map((x) => x.voiceId)).size === 1
        if (!sameVoice) problems.push(`count=${JSON.stringify(c)} 候选 voiceId 不统一`)
        rows.push(`${JSON.stringify(c)}→${r.length}`)
      } catch (e) {
        problems.push(`count=${JSON.stringify(c)} 抛异常：${e.message}`)
      }
    }
    return assert(problems.length === 0, `count→候选数：${rows.join(', ')}（超上限钳到 8，下限钳到 1，小数取整）`,
      `问题：${problems.join(' | ')}`)
  })

  // --- 攻击点 6：非 Float32Array 输入降级 ---
  check('【攻击6a】extractFeatures 接受非 Float32Array 输入并安全降级（无 NaN、无异常）', () => {
    const sr = 16000
    const arr = Array.from({ length: sr }, (_, i) => Math.sin((2 * Math.PI * 180 * i) / sr) * 0.5)
    const cases = [
      ['普通 number[]', arr, 180], ['Float64Array', new Float64Array(arr), null],
      ['Int8Array', new Int8Array(100).fill(100), null],
      ['null', null, 0], ['undefined', undefined, 0], ['空数组 []', [], 0],
      ['对象 {}', {}, 0], ['字符串 "abc"', 'abc', 0],
    ]
    const rows = []; const problems = []
    for (const [label, inp, expectF0] of cases) {
      try {
        const f = E.extractFeatures(inp, sr)
        const bad = Object.entries(f).filter(([, v]) => typeof v === 'number' && !Number.isFinite(v)).map(([k]) => k)
        if (bad.length) { problems.push(`${label} NaN 字段：${bad.join(',')}`); continue }
        if (expectF0 !== null && expectF0 > 0) {
          const err = Math.abs(f.f0 - expectF0) / expectF0
          if (err >= 0.15) { problems.push(`${label} f0=${f.f0.toFixed(1)}Hz（期望 ≈${expectF0}）`); continue }
        }
        rows.push(`${label}→f0=${f.f0.toFixed(1)}`)
      } catch (e) {
        problems.push(`${label} 抛异常：${e.message}`)
      }
    }
    return assert(problems.length === 0, `全部安全降级：${rows.join(' | ')}`, `问题：${problems.join(' | ')}`)
  })

  check('【攻击6b】cloneFromAudio 传入非法 samples 时抛出带中文提示的错误（契约 2.5 异常要求）', () => {
    const sr = 16000
    const rows = []; const problems = []
    for (const [label, samples] of [['null', null], ['undefined', undefined], ['空数组', new Float32Array(0)]]) {
      try {
        E.cloneFromAudio({ samples, sampleRate: sr, duration: 0 }, { name: 'x', count: 2, seed: 's' })
        problems.push(`${label} 未抛异常（应给出明确错误）`)
      } catch (e) {
        const msg = String(e && e.message ? e.message : e)
        if (!/[\u4e00-\u9fa5]/.test(msg)) problems.push(`${label} 错误信息无中文：${msg}`)
        else rows.push(`${label}→「${msg}」`)
      }
    }
    return assert(problems.length === 0, rows.join(' | '), `问题：${problems.join(' | ')}`)
  })
}

/** 阶段 1~8：引擎层行为验证 */
async function runEngineStages({ extractFeatures, deriveParams, hashFeatures, cloneFromAudio }) {
  // ---------- 阶段 1：特征提取正确性 ----------
  group('阶段 1 · extractFeatures 特征提取正确性（契约 2.1 / 验收 5）')

  const SINES = [
    { freq: 100, expect: 100 },
    { freq: 220, expect: 220 },
    { freq: 330, expect: 330 },
  ]
  const detected = []
  for (const s of SINES) {
    const sig = makeSignal({ freq: s.freq, durSec: 1.5, sampleRate: 16000, amp: 0.6 })
    const f = extractFeatures(sig, 16000)
    detected.push({ ...s, f0: f?.f0, err: f?.f0 ? Math.abs(f.f0 - s.expect) / s.expect : 1 })
    check(`合成正弦波 ${s.freq}Hz → 检出 f0 误差 < 15%`, () => {
      const got = f?.f0
      if (!isFiniteNumber(got) || got <= 0) return assert(false, '', `未检出有效 f0（得到 ${JSON.stringify(got)}）`)
      const err = Math.abs(got - s.expect) / s.expect
      return assert(err < 0.15, `真值 ${s.freq}Hz → 检出 ${got.toFixed(2)}Hz（误差 ${(err * 100).toFixed(2)}%）`,
        `真值 ${s.freq}Hz → 检出 ${got.toFixed(2)}Hz，误差 ${(err * 100).toFixed(2)}% ≥ 15%`)
    })
  }
  info(`f0 检出汇总：${detected.map((d) => `${d.expect}Hz→${isFiniteNumber(d.f0) ? d.f0.toFixed(1) : 'NaN'}Hz`).join(' | ')}`)

  check('谐波丰富时 f0 不发生倍频/半频误检（真值 120Hz，0~8 层谐波）', () => {
    const rows = []
    const bad = []
    for (const h of [0, 1, 2, 3, 5, 8]) {
      const sig = makeSignal({ freq: 120, durSec: 1.5, sampleRate: 16000, amp: 0.5, harmonics: h })
      const f = extractFeatures(sig, 16000)
      const err = f.f0 ? Math.abs(f.f0 - 120) / 120 : 1
      rows.push(`${h}层:${f.f0?.toFixed(1)}Hz(${(err * 100).toFixed(1)}%)`)
      if (err >= 0.15) bad.push(`${h} 层谐波→${f.f0?.toFixed(1)}Hz`)
    }
    return assert(bad.length === 0, rows.join(' | '), `发生八度误检：${bad.join(', ')}`)
  })

  check('噪声干扰下 f0 仍准确（真值 200Hz，噪声 0~0.4）', () => {
    const rows = []
    const bad = []
    for (const nz of [0, 0.05, 0.1, 0.2, 0.4]) {
      const sig = makeSignal({ freq: 200, durSec: 1.5, sampleRate: 16000, amp: 0.5, harmonics: 2, noise: nz, seed: 42 })
      const f = extractFeatures(sig, 16000)
      const err = f.f0 ? Math.abs(f.f0 - 200) / 200 : 1
      rows.push(`噪${nz}:${f.f0?.toFixed(1)}Hz`)
      if (err >= 0.15) bad.push(`噪声${nz}→${f.f0?.toFixed(1)}Hz`)
    }
    return assert(bad.length === 0, rows.join(' | '), `噪声下 f0 失准：${bad.join(', ')}`)
  })

  check('f0 检测在多种采样率下准确（8k/16k/22.05k/24k/44.1k/48k，真值 200Hz）', () => {
    const rows = []
    const bad = []
    for (const sr of [8000, 16000, 22050, 24000, 44100, 48000]) {
      const sig = makeSignal({ freq: 200, durSec: 1.5, sampleRate: sr, amp: 0.5 })
      const f = extractFeatures(sig, sr)
      const err = f.f0 ? Math.abs(f.f0 - 200) / 200 : 1
      rows.push(`${sr}:${f.f0?.toFixed(1)}Hz`)
      if (err >= 0.15) bad.push(`${sr}→${f.f0?.toFixed(1)}Hz`)
    }
    return assert(bad.length === 0, rows.join(' | '), `跨采样率失准：${bad.join(', ')}`)
  })

  check('extractFeatures 返回契约要求的 9 个特征字段', () => {
    const f = extractFeatures(makeSignal({ freq: 200 }), 16000)
    const need = ['duration', 'sampleRate', 'rms', 'peak', 'zcr', 'f0', 'brightness', 'silenceRatio', 'clipping']
    const missing = need.filter((k) => !(k in (f || {})))
    return assert(missing.length === 0, '字段齐全：' + need.join('/'),
      `缺少字段：${missing.join(', ')}；实际返回 ${JSON.stringify(Object.keys(f || {}))}`)
  })

  check('extractFeatures 全部特征为有限数（无 NaN / undefined）', () => {
    const f = extractFeatures(makeSignal({ freq: 200 }), 16000)
    const bad = Object.entries(f || {}).filter(([, v]) => !isFiniteNumber(v)).map(([k]) => k)
    return assert(bad.length === 0, '全部为有限数', `非有限数字字段：${bad.join(', ')}`)
  })

  check('extractFeatures 对极端输入不抛异常且不产生 NaN', () => {
    const cases = [
      ['空数组', new Float32Array(0)],
      ['全零（静音）', new Float32Array(16000)],
      ['单样本', new Float32Array([0.5])],
      ['含 NaN 的信号', (() => { const a = makeSignal({ freq: 200 }); a[100] = NaN; return a })()],
      ['含 Infinity 的信号', (() => { const a = makeSignal({ freq: 200 }); a[200] = Infinity; return a })()],
      ['满幅直流', (() => { const a = new Float32Array(16000); a.fill(1); return a })()],
    ]
    const problems = []
    for (const [label, buf] of cases) {
      try {
        const f = extractFeatures(buf, 16000)
        for (const [k, v] of Object.entries(f || {})) {
          if (!isFiniteNumber(v)) problems.push(`${label}.${k}=${v}`)
        }
      } catch (e) {
        problems.push(`${label} 抛异常：${e.message}`)
      }
    }
    return assert(problems.length === 0, `${cases.length} 种极端输入均安全`,
      `存在问题：${problems.join(' | ')}`)
  })

  check('extractFeatures 不修改入参（纯净性）', () => {
    const buf = makeSignal({ freq: 200 })
    const copy = cloneBuffer(buf)
    extractFeatures(buf, 16000)
    let diff = 0
    for (let i = 0; i < buf.length; i++) if (!Object.is(buf[i], copy[i])) diff++
    return assert(diff === 0, '入参数组未被修改', `入参被修改了 ${diff} 个样本`)
  })

  check('duration / sampleRate 来自真实信号（不写死）', () => {
    const a = extractFeatures(makeSignal({ freq: 200, durSec: 1.0, sampleRate: 16000 }), 16000)
    const b = extractFeatures(makeSignal({ freq: 200, durSec: 2.5, sampleRate: 16000 }), 16000)
    const dOk = Math.abs(a.duration - 1.0) < 0.05 && Math.abs(b.duration - 2.5) < 0.05
    return assert(dOk, `duration 随信号长度变化：1.0s→${a.duration?.toFixed(3)}s，2.5s→${b.duration?.toFixed(3)}s`,
      `duration 与真实长度不符：${a.duration} / ${b.duration}`)
  })

  // ---------- 阶段 2：同素材稳定性 ----------
  group('阶段 2 · 同素材稳定性（契约 3.1 / 验收 A2）')

  const F_A = makeFeatures({ f0: 120, brightness: 0.25, rms: 0.22, zcr: 0.08, duration: 5 })
  const F_B = makeFeatures({ f0: 240, brightness: 0.72, rms: 0.55, zcr: 0.31, duration: 12 })

  check('hashFeatures(同特征) 两次调用结果相同', () => {
    const h1 = hashFeatures(F_A, 'seed-1')
    const h2 = hashFeatures(F_A, 'seed-1')
    return assert(h1 === h2 && typeof h1 === 'string', `稳定：${h1}`, `不稳定：${h1} vs ${h2}`)
  })

  check('hashFeatures 返回 8 位小写十六进制', () => {
    const h = hashFeatures(F_A, 'seed-1')
    return assert(/^[0-9a-f]{8}$/.test(h), `格式合法：${h}`, `格式非法：${JSON.stringify(h)}`)
  })

  check('hashFeatures 对 seed 敏感（seed 被真实混入）', () => {
    const h1 = hashFeatures(F_A, 'seed-1')
    const h2 = hashFeatures(F_A, 'seed-2')
    return assert(h1 !== h2, `seed 生效：${h1} vs ${h2}`, `seed 未混入哈希：${h1} === ${h2}`)
  })

  check('同一素材两次 cloneFromAudio → voiceId 完全相同', () => {
    const buf1 = makeSignal({ freq: 180, durSec: 1.2, sampleRate: 16000, amp: 0.4 })
    const buf2 = makeSignal({ freq: 180, durSec: 1.2, sampleRate: 16000, amp: 0.4 })
    const c1 = cloneFromAudio(makeDecoded(buf1), { name: '素材1', count: 3, seed: 's1' })
    const c2 = cloneFromAudio(makeDecoded(buf2), { name: '素材1', count: 3, seed: 's1' })
    const v1 = new Set(c1.map((c) => c.voiceId))
    const v2 = new Set(c2.map((c) => c.voiceId))
    const same = v1.size === v2.size && [...v1].every((v) => v2.has(v))
    return assert(same, `voiceId 稳定：${[...v1].join(',')}`,
      `同素材 voiceId 不一致：${[...v1].join(',')} vs ${[...v2].join(',')}`)
  })

  check('同一素材、不传 seed（默认参数）两次调用 → voiceId 相同（验收 A2 核心）', () => {
    const d = makeDecoded(makeSignal({ freq: 180, durSec: 1.2, sampleRate: 16000, amp: 0.4 }))
    const c1 = cloneFromAudio(d, { name: '素材', count: 2 })
    const c2 = cloneFromAudio(d, { name: '素材', count: 2 })
    const v1 = c1.map((c) => c.voiceId).join(',')
    const v2 = c2.map((c) => c.voiceId).join(',')
    return assert(v1 === v2, `默认 seed 下 voiceId 一致：${v1}`,
      `默认 seed 下 voiceId 不一致（可能使用了随机 seed，违反验收 A2「同一音频 → voiceId 相同」）：${v1} vs ${v2}`)
  })

  check('同一素材、显式相同 seed 两次调用 → voiceId 相同', () => {
    const d = makeDecoded(makeSignal({ freq: 205, durSec: 1.0, sampleRate: 16000, amp: 0.45 }))
    const c1 = cloneFromAudio(d, { name: '素材', count: 2, seed: 'fixed-seed' })
    const c2 = cloneFromAudio(d, { name: '素材', count: 2, seed: 'fixed-seed' })
    const v1 = c1.map((c) => c.voiceId).join(',')
    const v2 = c2.map((c) => c.voiceId).join(',')
    return assert(v1 === v2, `voiceId 一致：${v1}`, `voiceId 不一致：${v1} vs ${v2}`)
  })

  // ---------- 阶段 3：异素材差异性 ----------
  group('阶段 3 · 异素材差异性（契约 3.2 / 验收 A2、A3）')

  check('低基频 vs 高基频 → pitch 必须不同', () => {
    const lo = deriveParams(makeFeatures({ f0: 100 }))
    const hi = deriveParams(makeFeatures({ f0: 250 }))
    return assert(lo.pitch !== hi.pitch, `f0=100→pitch ${lo.pitch}，f0=250→pitch ${hi.pitch}`,
      `pitch 未随基频变化：${lo.pitch} vs ${hi.pitch}`)
  })

  check('低基频 vs 高基频 → hash 必须不同', () => {
    const h1 = hashFeatures(makeFeatures({ f0: 100 }), 's')
    const h2 = hashFeatures(makeFeatures({ f0: 250 }), 's')
    return assert(h1 !== h2, `hash 不同：${h1} vs ${h2}`, `hash 相同：${h1}`)
  })

  check('低基频 vs 高基频 → voiceId 必须不同', () => {
    const a = cloneFromAudio(makeDecoded(makeSignal({ freq: 100, durSec: 1.2 })), { name: '低', count: 2, seed: 's' })
    const b = cloneFromAudio(makeDecoded(makeSignal({ freq: 250, durSec: 1.2 })), { name: '高', count: 2, seed: 's' })
    const v1 = a.map((c) => c.voiceId).join(',')
    const v2 = b.map((c) => c.voiceId).join(',')
    return assert(v1 !== v2, `voiceId 不同：${v1} vs ${v2}`, `voiceId 相同：${v1}`)
  })

  check('亮度差异大的特征 → gender 或 params 必须不同', () => {
    const dark = deriveParams(makeFeatures({ f0: 200, brightness: 0.05, zcr: 0.02 }))
    const bright = deriveParams(makeFeatures({ f0: 200, brightness: 0.95, zcr: 0.42 }))
    const genderDiff = dark.gender !== bright.gender
    const paramsDiff = JSON.stringify(dark) !== JSON.stringify(bright)
    return assert(genderDiff || paramsDiff,
      `gender: ${dark.gender} vs ${bright.gender}；params: ${JSON.stringify(dark)} vs ${JSON.stringify(bright)}`,
      `亮度差异未反映到 gender/params：${JSON.stringify(dark)} vs ${JSON.stringify(bright)}`)
  })

  check('真实音频：纯音 vs 含谐波信号 → brightness 显著不同', () => {
    const pure = extractFeatures(makeSignal({ freq: 200, durSec: 1.2, amp: 0.5, harmonics: 0 }), 16000)
    const rich = extractFeatures(makeSignal({ freq: 200, durSec: 1.2, amp: 0.5, harmonics: 6 }), 16000)
    const delta = Math.abs(pure.brightness - rich.brightness)
    return assert(delta > 0.01, `纯音 brightness=${pure.brightness?.toFixed(4)}，含谐波 brightness=${rich.brightness?.toFixed(4)}，差 ${delta.toFixed(4)}`,
      `brightness 几乎无差异（差 ${delta.toFixed(6)}）：${pure.brightness} vs ${rich.brightness}，疑似写死`)
  })

  check('真实音频：纯音 vs 含谐波 → 派生 gender 或 params 不同', () => {
    const pure = extractFeatures(makeSignal({ freq: 200, durSec: 1.2, amp: 0.5, harmonics: 0 }), 16000)
    const rich = extractFeatures(makeSignal({ freq: 200, durSec: 1.2, amp: 0.5, harmonics: 6 }), 16000)
    const p1 = deriveParams(pure)
    const p2 = deriveParams(rich)
    const diff = p1.gender !== p2.gender || JSON.stringify(p1) !== JSON.stringify(p2)
    return assert(diff, `${JSON.stringify(p1)} vs ${JSON.stringify(p2)}`,
      `派生参数完全相同：${JSON.stringify(p1)}`)
  })

  check('真实音频：低基频 vs 高基频 → 检出 f0 不同且派生 pitch 不同', () => {
    const lo = extractFeatures(makeSignal({ freq: 100, durSec: 1.5, amp: 0.5 }), 16000)
    const hi = extractFeatures(makeSignal({ freq: 250, durSec: 1.5, amp: 0.5 }), 16000)
    const p1 = deriveParams(lo)
    const p2 = deriveParams(hi)
    return assert(Math.abs(lo.f0 - hi.f0) > 10 && p1.pitch !== p2.pitch,
      `f0 ${lo.f0?.toFixed(1)}Hz(pitch ${p1.pitch}) vs ${hi.f0?.toFixed(1)}Hz(pitch ${p2.pitch})`,
      `f0 区分度不足或 pitch 未变：f0 ${lo.f0} / ${hi.f0}，pitch ${p1.pitch} / ${p2.pitch}`)
  })

  check('不同特征向量 → 参数不相同的比例足够高（反例抽样 240 组）', () => {
    const rng = makeRng(987654321)
    const seen = new Map()
    let collision = 0
    let total = 240
    for (let i = 0; i < total; i++) {
      const f = makeFeatures({
        f0: 60 + Math.floor(rng() * 340),
        brightness: Math.round(rng() * 100) / 100,
        rms: Math.round(rng() * 100) / 100,
        zcr: Math.round(rng() * 100) / 100,
        duration: 1 + Math.round(rng() * 20),
        silenceRatio: Math.round(rng() * 100) / 100,
      })
      const key = JSON.stringify(deriveParams(f))
      if (seen.has(key)) collision++
      else seen.set(key, f)
    }
    const uniqueRatio = seen.size / total
    // 不要求 100%（量化必然碰撞），但要求绝大多数不同特征得到不同参数
    return assert(uniqueRatio >= 0.9,
      `${total} 组随机特征 → ${seen.size} 组不同参数（唯一率 ${(uniqueRatio * 100).toFixed(1)}%）`,
      `参数唯一率过低（${(uniqueRatio * 100).toFixed(1)}%）：${total} 组特征只得到 ${seen.size} 组参数，疑似写死/量化过粗`)
  })

  check('低基频素材与高基频素材的 gender 判定不同（验收 A3）', () => {
    const lo = deriveParams(makeFeatures({ f0: 110, brightness: 0.3, zcr: 0.05 }))
    const hi = deriveParams(makeFeatures({ f0: 260, brightness: 0.6, zcr: 0.12 }))
    return assert(lo.gender !== hi.gender,
      `f0=110 → gender=${lo.gender}；f0=260 → gender=${hi.gender}`,
      `低/高基频素材 gender 判定相同（${lo.gender}），无法据此选择系统语音（验收 A3）`)
  })

  check('pitch 随 f0 连续变化（非二值写死映射）', () => {
    const seq = []
    for (let f0 = 80; f0 <= 400; f0 += 40) {
      seq.push(deriveParams(makeFeatures({ f0 })).pitch)
    }
    const uniq = new Set(seq.map((p) => p.toFixed(4))).size
    return assert(uniq >= Math.ceil(seq.length * 0.7),
      `f0 80→400 的 pitch 序列：${seq.map((p) => p.toFixed(2)).join(', ')}（${uniq}/${seq.length} 个不同取值）`,
      `pitch 取值过于离散（${uniq}/${seq.length}），疑似写死映射：${seq.join(', ')}`)
  })

  // ---------- 阶段 4：候选数量与唯一性 ----------
  group('阶段 4 · 候选数量与唯一性（契约 3.3 / 验收 A2）')

  const matA = makeSignal({ freq: 110, durSec: 1.2, sampleRate: 16000, amp: 0.4 })
  const matB = makeSignal({ freq: 260, durSec: 1.2, sampleRate: 16000, amp: 0.65 })

  check('cloneFromAudio 的 count 边界被安全钳制（0/负数/超上限不产生异常）', () => {
    const d = makeDecoded(matA)
    const rows = []
    const problems = []
    for (const c of [0, -1, 1, 3, 8, 12]) {
      try {
        const r = cloneFromAudio(d, { name: 'x', count: c, seed: 's' })
        if (!Array.isArray(r)) problems.push(`count=${c} 未返回数组`)
        else {
          rows.push(`${c}→${r.length}`)
          if (r.length < 1) problems.push(`count=${c} 返回 ${r.length} 个候选（应至少 1 个）`)
        }
      } catch (e) {
        problems.push(`count=${c} 抛异常：${e.message}`)
      }
    }
    return assert(problems.length === 0, `count→实际候选数：${rows.join(', ')}`,
      `问题：${problems.join(' | ')}`)
  })

  check('同一素材不同 count → voiceId 保持一致（voiceId 派生自素材而非候选序号）', () => {
    const d = makeDecoded(matA)
    const v1 = cloneFromAudio(d, { name: 'x', count: 1, seed: 's' })[0].voiceId
    const v5 = cloneFromAudio(d, { name: 'x', count: 5, seed: 's' })[0].voiceId
    return assert(v1 === v5, `count=1 与 count=5 同为 ${v1}`, `voiceId 随 count 变化：${v1} vs ${v5}`)
  })

  check('seed 各种类型（string/number/null/undefined）均被安全处理', () => {
    const d = makeDecoded(matA)
    const rows = []
    const problems = []
    for (const sd of ['s', 123, 0, '', null, undefined]) {
      try {
        const r = cloneFromAudio(d, { name: 'x', count: 1, seed: sd })
        const v = r[0]?.voiceId
        if (!/^voice_clone_[0-9a-f]{8}$/.test(String(v))) problems.push(`seed=${JSON.stringify(sd)} → voiceId=${v}`)
        else rows.push(`${JSON.stringify(sd)}→${v}`)
      } catch (e) {
        problems.push(`seed=${JSON.stringify(sd)} 抛异常：${e.message}`)
      }
    }
    return assert(problems.length === 0, rows.join(' | '), `问题：${problems.join(' | ')}`)
  })

  for (const count of [1, 2, 3, 5]) {
    check(`cloneFromAudio(count=${count}) 返回候选数 = ${count}`, () => {
      const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count, seed: 's' })
      return assert(Array.isArray(c) && c.length === count, `实际返回 ${c?.length} 个`,
        `期望 ${count} 个，实际 ${c?.length} 个（${JSON.stringify(c?.map((x) => x.id))}）`)
    })
  }

  check('同一批次内候选 id 互不重复', () => {
    const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count: 5, seed: 's' })
    const ids = c.map((x) => x.id)
    return assert(new Set(ids).size === ids.length, `id 唯一：${ids.join(', ')}`, `id 重复：${ids.join(', ')}`)
  })

  check('两组不同素材的候选 voiceId 集合无交集', () => {
    const a = cloneFromAudio(makeDecoded(matA), { name: 'A', count: 4, seed: 's' })
    const b = cloneFromAudio(makeDecoded(matB), { name: 'B', count: 4, seed: 's' })
    const sa = new Set(a.map((c) => c.voiceId))
    const sb = new Set(b.map((c) => c.voiceId))
    const inter = [...sa].filter((v) => sb.has(v))
    return assert(inter.length === 0, `A={${[...sa].join(',')}} 与 B={${[...sb].join(',')}} 无交集`,
      `存在交集：${inter.join(', ')}（A={${[...sa].join(',')}}，B={${[...sb].join(',')}}）`)
  })

  check('两组不同素材的候选 id 集合无交集', () => {
    const a = cloneFromAudio(makeDecoded(matA), { name: 'A', count: 4, seed: 's' })
    const b = cloneFromAudio(makeDecoded(matB), { name: 'B', count: 4, seed: 's' })
    const ia = new Set(a.map((c) => c.id))
    const ib = new Set(b.map((c) => c.id))
    const inter = [...ia].filter((v) => ib.has(v))
    return assert(inter.length === 0, '候选 id 无交集', `候选 id 存在交集：${inter.join(', ')}`)
  })

  check('候选对象字段齐全（id/name/voiceId/params/features/previewNote）', () => {
    const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count: 2, seed: 's' })
    const need = ['id', 'name', 'voiceId', 'params', 'features', 'previewNote']
    const missing = []
    for (const cand of c) {
      for (const k of need) if (!(k in (cand || {}))) missing.push(`${cand?.id}.${k}`)
    }
    return assert(missing.length === 0, '字段齐全', `缺少字段：${missing.join(', ')}`)
  })

  check('候选 voiceId 形如 voice_clone_<hash> 且含真实哈希', () => {
    const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count: 1, seed: 's' })
    const v = c[0]?.voiceId
    const ok = typeof v === 'string' && /^voice_clone_[0-9a-f]{6,}$/.test(v)
    return assert(ok, `voiceId=${v}`, `voiceId 不符合契约格式 voice_clone_<hash>：${JSON.stringify(v)}`)
  })

  check('候选 params 落在合法区间且含 pitch/speed/emotion', () => {
    const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count: 3, seed: 's' })
    const bad = []
    for (const cand of c) {
      const p = cand.params || {}
      for (const k of ['pitch', 'speed']) {
        if (!isFiniteNumber(p[k]) || p[k] < 0.5 || p[k] > 2.0) bad.push(`${cand.id}.params.${k}=${p[k]}`)
      }
      if (!isFiniteNumber(p.emotion) || p.emotion < 0 || p.emotion > 1) bad.push(`${cand.id}.params.emotion=${p.emotion}`)
    }
    return assert(bad.length === 0, `params 合法：${JSON.stringify(c.map((x) => x.params))}`, `越界：${bad.join(', ')}`)
  })

  check('候选 features 为真实特征摘要（与真实提取值一致，f0 允许音高偏移量）', () => {
    const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count: 1, seed: 's' })
    const fe = c[0]?.features || {}
    const truth = extractFeatures(matA, 16000)
    const hasF0 = 'f0' in fe && isFiniteNumber(fe.f0)
    // 契约要点：features 必须是「测出来的真实特征」，不能是写死值。
    // brightness / rms / duration / silenceRatio 必须与 extractFeatures 完全一致；
    // f0 允许因候选自身的音高偏移而微调（实现约定 effF0 = 180 × pitch），故设相对容差。
    const exactFields = ['brightness', 'rms', 'duration', 'silenceRatio']
    const mismatched = exactFields.filter((k) => !(k in fe) || Math.abs((fe[k] ?? NaN) - (truth[k] ?? NaN)) > 1e-6)
    const f0Tol = Math.max(20, truth.f0 * 0.15)
    const f0Ok = hasF0 && Math.abs(fe.f0 - truth.f0) <= f0Tol
    const ok = mismatched.length === 0 && f0Ok
    return assert(ok,
      `真实特征一致（brightness=${fe.brightness?.toFixed(4)} rms=${fe.rms?.toFixed(4)} duration=${fe.duration?.toFixed(3)}s silenceRatio=${fe.silenceRatio}）；f0=${fe.f0?.toFixed(2)}Hz vs 实测 ${truth.f0?.toFixed(2)}Hz（差 ${Math.abs((fe.f0 ?? 0) - truth.f0).toFixed(2)}Hz，在音高偏移容差 ${f0Tol.toFixed(1)}Hz 内）`,
      `候选 features 偏离真实测量：不一致字段=${mismatched.join(', ') || '无'}；f0=${fe.f0} vs 实测 ${truth.f0}（容差 ${f0Tol.toFixed(1)}）`)
  })

  check('两组不同素材的候选 features 摘要互不相同（证明来自素材而非写死）', () => {
    const a = cloneFromAudio(makeDecoded(matA), { name: 'A', count: 1, seed: 's' })[0]
    const b = cloneFromAudio(makeDecoded(matB), { name: 'B', count: 1, seed: 's' })[0]
    const diffs = ['f0', 'brightness', 'rms', 'duration'].filter((k) =>
      JSON.stringify(a.features?.[k]) !== JSON.stringify(b.features?.[k]))
    return assert(diffs.length >= 2,
      `差异字段：${diffs.join(', ')}（A.f0=${a.features?.f0?.toFixed(1)} B.f0=${b.features?.f0?.toFixed(1)}；A.brightness=${a.features?.brightness?.toFixed(4)} B.brightness=${b.features?.brightness?.toFixed(4)}）`,
      `两组素材的 features 仅在 ${diffs.length} 个字段上不同（${diffs.join(', ') || '无'}），疑似写死`)
  })

  check('候选 name / previewNote 含真实特征描述（非固定文案）', () => {
    const a = cloneFromAudio(makeDecoded(matA), { name: 'A', count: 1, seed: 's' })
    const b = cloneFromAudio(makeDecoded(matB), { name: 'B', count: 1, seed: 's' })
    const differs = a[0].name !== b[0].name || a[0].previewNote !== b[0].previewNote
    const mentionsF0 = /f0|基频|Hz|hz/i.test(`${a[0].name} ${a[0].previewNote}`)
    return assert(differs && mentionsF0,
      `A="${a[0].name}" / "${a[0].previewNote}"；B="${b[0].name}"`,
      `文案未体现真实特征或完全固定：A="${a[0].name}" B="${b[0].name}"`)
  })

  // ---------- 阶段 5：参数钳制边界 ----------
  group('阶段 5 · 参数钳制边界（契约 3.4 / 验收 A3）')

  const EXTREME = [
    ['f0=0', makeFeatures({ f0: 0 })],
    ['f0=5000（超出检测上限）', makeFeatures({ f0: 5000 })],
    ['f0=60（检测下限）', makeFeatures({ f0: 60 })],
    ['f0=400（检测上限）', makeFeatures({ f0: 400 })],
    ['rms=0', makeFeatures({ rms: 0 })],
    ['rms=1', makeFeatures({ rms: 1 })],
    ['rms=1.8（越界）', makeFeatures({ rms: 1.8 })],
    ['brightness=0', makeFeatures({ brightness: 0 })],
    ['brightness=1', makeFeatures({ brightness: 1 })],
    ['brightness=-0.5（越界）', makeFeatures({ brightness: -0.5 })],
    ['zcr=0', makeFeatures({ zcr: 0 })],
    ['zcr=1', makeFeatures({ zcr: 1 })],
    ['silenceRatio=1', makeFeatures({ silenceRatio: 1 })],
    ['clipping=1', makeFeatures({ clipping: 1 })],
    ['duration=0', makeFeatures({ duration: 0 })],
  ]

  for (const [label, f] of EXTREME) {
    check(`deriveParams(${label}) → 全部参数合法且无 NaN/undefined`, () => {
      let p
      try { p = deriveParams(f) } catch (e) { return assert(false, '', `抛异常：${e.message}`) }
      const bad = []
      if (!isFiniteNumber(p.pitch) || p.pitch < 0.5 || p.pitch > 2.0) bad.push(`pitch=${p.pitch}`)
      if (!isFiniteNumber(p.speed) || p.speed < 0.5 || p.speed > 2.0) bad.push(`speed=${p.speed}`)
      if (!isFiniteNumber(p.emotion) || p.emotion < 0 || p.emotion > 1) bad.push(`emotion=${p.emotion}`)
      if (!['male', 'female', 'neutral'].includes(p.gender)) bad.push(`gender=${p.gender}`)
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined || v === null) bad.push(`${k}=${v}`)
      }
      return assert(bad.length === 0, `pitch=${p.pitch} speed=${p.speed} emotion=${p.emotion} gender=${p.gender}`,
        `非法参数：${bad.join(', ')}`)
    })
  }

  check('deriveParams 对非法数值输入（NaN / undefined / null）不产出 NaN 参数', () => {
    const cases = [
      ['f0=NaN', makeFeatures({ f0: NaN })],
      ['rms=NaN', makeFeatures({ rms: NaN })],
      ['brightness=undefined', makeFeatures({ brightness: undefined })],
      ['zcr=null', makeFeatures({ zcr: null })],
      ['duration=NaN', makeFeatures({ duration: NaN })],
    ]
    const problems = []
    for (const [label, f] of cases) {
      try {
        const p = deriveParams(f)
        for (const [k, v] of Object.entries(p)) {
          if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`${label}.${k}=${v}`)
          if (v === undefined) problems.push(`${label}.${k}=undefined`)
        }
        if (!isFiniteNumber(p.pitch) || p.pitch < 0.5 || p.pitch > 2.0) problems.push(`${label}.pitch 越界=${p.pitch}`)
        if (!isFiniteNumber(p.speed) || p.speed < 0.5 || p.speed > 2.0) problems.push(`${label}.speed 越界=${p.speed}`)
      } catch (e) {
        problems.push(`${label} 抛异常：${e.message}`)
      }
    }
    return assert(problems.length === 0, '非法输入均被安全处理', `问题：${problems.join(' | ')}`)
  })

  check('deriveParams 对空对象不抛异常', () => {
    try {
      const p = deriveParams({})
      const ok = isFiniteNumber(p.pitch) && p.pitch >= 0.5 && p.pitch <= 2 &&
        isFiniteNumber(p.speed) && p.speed >= 0.5 && p.speed <= 2
      return assert(ok, `空特征 → pitch=${p.pitch} speed=${p.speed} gender=${p.gender}`, `空特征产出非法参数：${JSON.stringify(p)}`)
    } catch (e) {
      return assert(false, '', `抛异常：${e.message}`)
    }
  })

  check('f0=0（未检出）时 pitch 有合理兜底且不同于 f0=100', () => {
    const p0 = deriveParams(makeFeatures({ f0: 0 }))
    const p1 = deriveParams(makeFeatures({ f0: 100 }))
    return assert(p0.pitch !== p1.pitch, `f0=0→pitch ${p0.pitch}，f0=100→pitch ${p1.pitch}`,
      `f0=0 与 f0=100 得到相同 pitch：${p0.pitch}`)
  })

  // ---------- 阶段 6：确定性与纯净性 ----------
  group('阶段 6 · 确定性与纯净性')

  await acheck('模块重复 import（不同 cache-bust query）结果一致', async () => {
    const buf = makeSignal({ freq: 175, durSec: 1.1, sampleRate: 16000, amp: 0.45 })
    const hashes = []
    for (let i = 0; i < 3; i++) {
      const mod = await import(`${pathToFileURL(MODULE_PATH).href}?probe=${i}-${Date.now()}`)
      const f = mod.extractFeatures(buf, 16000)
      hashes.push(`${mod.hashFeatures(f, 'seed')}|${mod.deriveParams(f).pitch}|${f.f0.toFixed(4)}`)
    }
    const same = hashes.every((h) => h === hashes[0])
    return assert(same, `3 次独立加载结果一致：${hashes[0]}`, `结果不一致：${hashes.join(' / ')}`)
  })

  check('extractFeatures 不因调用顺序改变结果', () => {
    const a = makeSignal({ freq: 130, durSec: 1.0, sampleRate: 16000, amp: 0.4 })
    const b = makeSignal({ freq: 290, durSec: 1.0, sampleRate: 16000, amp: 0.7 })
    const fa1 = extractFeatures(a, 16000)
    const fb = extractFeatures(b, 16000)
    const fa2 = extractFeatures(a, 16000)
    const j1 = JSON.stringify(fa1)
    const j2 = JSON.stringify(fa2)
    return assert(j1 === j2, 'A→B→A 顺序下 A 的结果一致',
      `结果被调用顺序污染：\n  A1=${j1}\n  A2=${j2}\n  B =${JSON.stringify(fb)}`)
  })

  check('同一段音频反复提取结果一致（无内部随机性）', () => {
    const buf = makeSignal({ freq: 210, durSec: 1.0, sampleRate: 16000, amp: 0.5 })
    const rs = []
    for (let i = 0; i < 5; i++) rs.push(JSON.stringify(extractFeatures(buf, 16000)))
    return assert(rs.every((r) => r === rs[0]), '5 次结果一致', '结果不稳定：' + rs.join(' / '))
  })

  check('cloneFromAudio 无内部随机性（同输入同输出）', () => {
    const d = makeDecoded(makeSignal({ freq: 165, durSec: 1.0, sampleRate: 16000, amp: 0.5 }))
    const r1 = cloneFromAudio(d, { name: 'x', count: 3, seed: 'fixed' })
    const r2 = cloneFromAudio(d, { name: 'x', count: 3, seed: 'fixed' })
    const k = (arr) => arr.map((c) => `${c.voiceId}|${JSON.stringify(c.params)}`).join(';')
    return assert(k(r1) === k(r2), '两次调用完全一致', `输出不稳定：${k(r1)} vs ${k(r2)}`)
  })

  check('hashFeatures 不受 features 中的无关字段影响（只取关键特征）', () => {
    const f1 = makeFeatures({ f0: 200 })
    const f2 = { ...makeFeatures({ f0: 200 }), someExtraField: 'ignored' }
    const h1 = hashFeatures(f1, 's')
    const h2 = hashFeatures(f2, 's')
    return assert(h1 === h2, `无关字段不影响哈希：${h1}`, `无关字段改变了哈希：${h1} vs ${h2}`)
  })

  check('cloneFromAudio 对非法输入不产生未捕获崩溃（返回空数组或抛出明确中文错误）', () => {
    const problems = []
    const cases = [
      ['空数组', makeDecoded(new Float32Array(0))],
      ['null samples', { samples: null, sampleRate: 16000, duration: 0 }],
      ['缺 samples 字段', { sampleRate: 16000, duration: 0 }],
    ]
    const notes = []
    for (const [label, arg] of cases) {
      try {
        const c = cloneFromAudio(arg, { name: 'x', count: 2, seed: 's' })
        if (!Array.isArray(c)) problems.push(`${label} 未返回数组`)
        else notes.push(`${label}→返回 ${c.length} 项`)
      } catch (e) {
        // 抛出带明确中文提示的错误是契约允许的行为（上层需捕获并提示用户）
        const msg = String(e && e.message ? e.message : e)
        const hasChinese = /[\u4e00-\u9fa5]/.test(msg)
        if (!hasChinese) problems.push(`${label} 抛出的错误无中文提示：${msg}`)
        else notes.push(`${label}→抛出中文错误「${msg}」`)
      }
    }
    return assert(problems.length === 0, notes.join('；'), `问题：${problems.join(' | ')}`)
  })

  // ---------- 阶段 8：契约 2.1 输出结构 ----------
  group('阶段 8 · cloneFromAudio 输出结构（契约 2.1）')

  check('候选 id 形如 cand_<hash>_<i>', () => {
    const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count: 3, seed: 's' })
    const bad = c.map((x) => x.id).filter((id) => !/^cand_[0-9a-zA-Z]+_\d+$/.test(String(id)))
    return assert(bad.length === 0, `id 格式合法：${c.map((x) => x.id).join(', ')}`,
      `id 格式不符：${bad.join(', ')}`)
  })

  check('候选 params 含 pitch/speed/emotion（契约 2.1）', () => {
    const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count: 1, seed: 's' })
    const p = c[0]?.params || {}
    const miss = ['pitch', 'speed', 'emotion'].filter((k) => !(k in p))
    return assert(miss.length === 0, `params=${JSON.stringify(p)}`, `缺少字段：${miss.join(', ')}`)
  })

  check('deriveParams 返回 pitch/speed/emotion/gender 四字段', () => {
    const p = deriveParams(makeFeatures())
    const miss = ['pitch', 'speed', 'emotion', 'gender'].filter((k) => !(k in p))
    return assert(miss.length === 0, `返回 ${JSON.stringify(p)}`, `缺少字段：${miss.join(', ')}`)
  })

  check('同一素材不同 seed → 候选 voiceId 可区分（seed 生效）', () => {
    const d = makeDecoded(matA)
    const a = cloneFromAudio(d, { name: 'x', count: 1, seed: 'seedA' })
    const b = cloneFromAudio(d, { name: 'x', count: 1, seed: 'seedB' })
    return assert(a[0].voiceId !== b[0].voiceId, `${a[0].voiceId} vs ${b[0].voiceId}`,
      `seed 未影响 voiceId：${a[0].voiceId}`)
  })
}

/** 阶段 7、9、10、11：源码/仓库级静态审查（不依赖引擎模块） */
async function runSourceStages() {
  // ---------- 阶段 7：全仓库字面量扫描 ----------
  group('阶段 7 · 全仓库固定音色字面量扫描（验收 A1）')

  const scan = scanHardcodedVoiceLiterals()

  check('src/ 等业务代码中不存在 voice_clone_A / voice_clone_B', () => {
    const list = scan.hits.map((h) => `${h.file}:${h.line} → ${h.excerpt}`).join('\n     ')
    return assert(scan.hits.length === 0, '业务代码中零匹配',
      `发现 ${scan.hits.length} 处硬编码：\n     ${list}`)
  })

  if (scan.softHits.length) {
    info(`非业务代码（scripts/ 测试脚本或日志文档）中出现 ${scan.softHits.length} 处（可能为反例断言）：` +
      scan.softHits.map((h) => `${h.file}:${h.line}`).join(', '))
  } else {
    info('scripts/ 测试脚本中亦无匹配')
  }

  check('dist/ 构建产物是否仍含旧字面量（需重新 build 才会清除）', () => {
    const distDir = path.join(ROOT, 'dist')
    if (!fs.existsSync(distDir)) return 'dist/ 不存在（未构建）'
    const found = []
    const walk = (dir) => {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) { walk(abs); continue }
        if (!e.isFile()) continue
        try {
          const t = fs.readFileSync(abs, 'utf8')
          for (const n of [['voice_clone_', 'A'].join(''), ['voice_clone_', 'B'].join('')]) {
            if (t.includes(n)) found.push(path.relative(ROOT, abs).replace(/\\/g, '/'))
          }
        } catch { /* ignore */ }
      }
    }
    walk(distDir)
    if (found.length) {
      return assert(false, '', `dist/ 仍是旧构建产物，含 ${found.length} 个命中文件（${found.join(', ')}）；需 npm run build 重新生成`)
    }
    return 'dist/ 已无匹配'
  })

  // ---------- 阶段 9：源码静态审查（适配器 / 页面 / store 层，验收 A4~A7） ----------
  group('阶段 9 · 源码静态审查（适配器/页面/store 层，验收 A4~A7）')

  const readSrc = (rel) => {
    const p = path.join(ROOT, rel)
    if (!fs.existsSync(p)) return null
    return fs.readFileSync(p, 'utf8')
  }

  const adaptersSrc = readSrc(path.join('src', 'engine', 'adapters.js'))
  const voicePageSrc = readSrc(path.join('src', 'pages', 'VoicePage.jsx'))
  const storeSrc = readSrc(path.join('src', 'store', 'store.js'))
  const chatEngineSrc = readSrc(path.join('src', 'engine', 'chatEngine.js'))
  const audioDecodeSrc = readSrc(path.join('src', 'engine', 'audioDecode.js'))

  check('src/engine/audioDecode.js 存在且导出 decodeAudioFile（契约 2.2）', () => {
    if (audioDecodeSrc == null) return assert(false, '', '文件不存在')
    return assert(/export\s+(async\s+)?function\s+decodeAudioFile/.test(audioDecodeSrc),
      '已导出 decodeAudioFile', '未找到 decodeAudioFile 导出')
  })

  check('voiceAdapter.speak() 按 gender 选择系统语音并设置 pitch/rate/volume（验收 A4）', () => {
    if (adaptersSrc == null) return assert(false, '', 'adapters.js 不存在')
    // 定位 voiceAdapter 对象块，再在其中定位 speak 方法，避免误匹配到 preview/clone 等
    const adapterIdx = adaptersSrc.indexOf('voiceAdapter')
    const scope = adapterIdx >= 0 ? adaptersSrc.slice(adapterIdx) : adaptersSrc
    const speakIdx = scope.search(/\bspeak\s*\(/)
    if (speakIdx < 0) return assert(false, '', 'voiceAdapter 中未找到 speak 方法')
    const body = scope.slice(speakIdx, speakIdx + 4000)
    const setsVoice = /\.\s*voice\s*=/.test(body)
    const setsPitch = /\.\s*pitch\s*=/.test(body)
    const setsRate = /\.\s*rate\s*=/.test(body)
    const setsVolume = /\.\s*volume\s*=/.test(body)
    const usesGender = /gender/i.test(body)
    const usesVoiceList = /getVoices|listVoices|voiceList|sysVoices|systemVoices|availableVoices/i.test(body)
    const ok = setsVoice && setsPitch && setsRate && setsVolume && usesGender && usesVoiceList
    return assert(ok,
      `voice=${setsVoice} pitch=${setsPitch} rate=${setsRate} volume=${setsVolume} gender=${usesGender} 语音列表=${usesVoiceList}`,
      `speak() 要素缺失：设置voice=${setsVoice}、pitch=${setsPitch}、rate=${setsRate}、volume=${setsVolume}、用到gender=${usesGender}、用到系统语音列表=${usesVoiceList}`)
  })

  check('voiceAdapter 暴露 listVoices 且兼容 voiceschanged 异步加载（契约 2.3）', () => {
    if (adaptersSrc == null) return assert(false, '', 'adapters.js 不存在')
    const hasList = /listVoices\s*[:(]/.test(adaptersSrc)
    const hasChanged = /voiceschanged/.test(adaptersSrc)
    const hasTimeout = /setTimeout/.test(adaptersSrc)
    return assert(hasList && hasChanged && hasTimeout,
      `listVoices=${hasList} voiceschanged=${hasChanged} 超时兜底=${hasTimeout}`,
      `语音列表加载不完整：listVoices=${hasList}、voiceschanged=${hasChanged}、setTimeout 兜底=${hasTimeout}`)
  })

  check('voiceAdapter.clone() 走「解码 → 特征提取 → 候选」真实链路（契约 2.3）', () => {
    if (adaptersSrc == null) return assert(false, '', 'adapters.js 不存在')
    const callsDecode = /decodeAudioFile/.test(adaptersSrc)
    const callsClone = /cloneFromAudio/.test(adaptersSrc)
    return assert(callsDecode && callsClone,
      `已接入 decodeAudioFile=${callsDecode} / cloneFromAudio=${callsClone}`,
      `clone 链路未接通：decodeAudioFile=${callsDecode}、cloneFromAudio=${callsClone}`)
  })

  check('VoicePage 采纳时使用候选自身 voiceId / params / features（验收 A3）', () => {
    if (voicePageSrc == null) return assert(false, '', 'VoicePage.jsx 不存在')
    const usesVoiceId = /voiceId\s*:\s*(selected|cand|c)\b/.test(voicePageSrc)
    const usesParams = /params\s*:\s*(selected|cand|c)\.params|params\s*:\s*\{\s*\.\.\./.test(voicePageSrc)
    const usesFeatures = /features\s*:\s*(selected|cand|c)\.features/.test(voicePageSrc)
    const noFixedDefaults = !/params\s*:\s*\{\s*speed\s*:\s*1\.0\s*,\s*pitch\s*:\s*1\.0/.test(voicePageSrc)
    const ok = usesVoiceId && usesParams && usesFeatures && noFixedDefaults
    return assert(ok,
      `voiceId 来自候选=${usesVoiceId}、params 来自候选=${usesParams}、features 来自候选=${usesFeatures}、无写死默认=${noFixedDefaults}`,
      `采纳逻辑未使用候选真实数据：voiceId=${usesVoiceId}、params=${usesParams}、features=${usesFeatures}、无写死默认=${noFixedDefaults}`)
  })

  check('VoicePage 试听候选使用该候选自身 params（契约 2.5）', () => {
    if (voicePageSrc == null) return assert(false, '', 'VoicePage.jsx 不存在')
    const usesAdapterSpeak = /voiceAdapter\.speak\s*\(/.test(voicePageSrc)
    const passesParams = /speak\s*\([^)]*,\s*\{[^)]*params/.test(voicePageSrc) || /params\s*:\s*c\.params/.test(voicePageSrc)
    const noHardcodedPitch = !/u\.pitch\s*=\s*c\.id\.endsWith/.test(voicePageSrc)
    const ok = usesAdapterSpeak && passesParams && noHardcodedPitch
    return assert(ok,
      `走 voiceAdapter.speak=${usesAdapterSpeak}、传入候选params=${passesParams}、无按id硬编码pitch=${noHardcodedPitch}`,
      `试听未使用候选 params：voiceAdapter.speak=${usesAdapterSpeak}、传params=${passesParams}、无硬编码pitch=${noHardcodedPitch}`)
  })

  check('VoicePage 不再手填时长（使用真实解码时长）（契约 2.5 / B4）', () => {
    if (voicePageSrc == null) return assert(false, '', 'VoicePage.jsx 不存在')
    const hasDurationSlider = /type="range"[^>]*min=\{?3"?[^}]*max=\{?60"?/.test(voicePageSrc) ||
      /样本时长（秒）/.test(voicePageSrc)
    const readsRealDuration = /decodeAudioFile|\.duration\b/.test(voicePageSrc)
    return assert(!hasDurationSlider || readsRealDuration,
      '时长来自真实解码',
      `仍存在手填时长滑块且未见真实解码时长：滑块=${hasDurationSlider}、真实时长=${readsRealDuration}`)
  })

  check('VoicePage 提供「替换已有音色」且保持原资源 id 不变（验收 A5）', () => {
    if (voicePageSrc == null) return assert(false, '', 'VoicePage.jsx 不存在')
    const hasReplace = /替换/.test(voicePageSrc)
    const keepsId = /updateResource\s*\(\s*['"]voice['"]\s*,/.test(voicePageSrc)
    const ok = hasReplace && keepsId
    return assert(ok, `存在替换入口=${hasReplace}、走 updateResource 保持原 id=${keepsId}`,
      `缺少替换能力：替换入口=${hasReplace}、走 updateResource=${keepsId}`)
  })

  check('store 提供 saveVoiceSample / loadVoiceSample / deleteVoiceSample（契约 2.4）', () => {
    if (storeSrc == null) return assert(false, '', 'store.js 不存在')
    const save = /saveVoiceSample/.test(storeSrc)
    const load = /loadVoiceSample/.test(storeSrc)
    const del = /deleteVoiceSample/.test(storeSrc)
    return assert(save && load && del, `save=${save} load=${load} delete=${del}`,
      `样本库能力缺失：saveVoiceSample=${save}、loadVoiceSample=${load}、deleteVoiceSample=${del}`)
  })

  check('删除音色时同步清理样本文件（契约 2.4）', () => {
    if (storeSrc == null) return assert(false, '', 'store.js 不存在')
    const delIdx = storeSrc.indexOf('deleteResource(')
    const body = delIdx >= 0 ? storeSrc.slice(delIdx, delIdx + 2500) : ''
    const cleans = /deleteVoiceSample|removeSample|deleteSample/.test(body)
    return assert(cleans, 'deleteResource 内含样本清理', 'deleteResource 未见样本清理调用')
  })

  check('chatEngine.playTTS 仍以 config.voice 调用 voiceAdapter.speak（契约 2.6 / 验收 A7）', () => {
    if (chatEngineSrc == null) return assert(false, '', 'chatEngine.js 不存在')
    const ok = /voiceAdapter\.speak\s*\(\s*spoken\s*,\s*config\.voice\s*\)/.test(chatEngineSrc) ||
      /voiceAdapter\.speak\s*\(/.test(chatEngineSrc) && /config\.voice/.test(chatEngineSrc)
    return assert(ok, 'playTTS → voiceAdapter.speak(spoken, config.voice)', 'playTTS 调用链不匹配')
  })

  check('resolveActiveConfig 返回的 voice 为当前生效绑定指向的资源（验收 A7）', () => {
    if (chatEngineSrc == null) return assert(false, '', 'chatEngine.js 不存在')
    const ok = /resources\.voice\.find\s*\(\s*r\s*=>\s*r\.id\s*===\s*b\.voiceId\s*\)/.test(chatEngineSrc)
    return assert(ok, '按 publishedBinding/draftBinding.voiceId 解析', '未按生效绑定解析 voice 资源')
  })

  check('VoicePage 覆盖 6 类异常的中文提示（验收 A6）', () => {
    if (voicePageSrc == null) return assert(false, '', 'VoicePage.jsx 不存在')
    const need = [
      ['非音频文件', /仅支持|非音频|音频文件|格式/],
      ['解码失败', /解码失败|无法解码|已损坏/],
      ['时长过短', /时长不足|过短|至少\s*2\s*秒|≥\s*2s/],
      ['静音占比过高', /静音/],
      ['空文件', /为空|空文件|大小为\s*0|0\s*字节/],
      ['超大文件', /超过|过大|20\s*MB|20MB/],
    ]
    const miss = need.filter(([, re]) => !re.test(voicePageSrc)).map(([n]) => n)
    return assert(miss.length === 0, `6 类异常提示齐全：${need.map(([n]) => n).join('、')}`,
      `缺少异常提示：${miss.join('、')}`)
  })

  const chatPageSrc = readSrc(path.join('src', 'pages', 'ChatPage.jsx'))

  check('ChatPage 侧栏「当前生效配置」展示音色来源与特征（验收 A7）', () => {
    if (chatPageSrc == null) return assert(false, '', 'ChatPage.jsx 不存在')
    const showsSource = /克隆|预置|sourceType/.test(chatPageSrc)
    const showsFeature = /f0|基频/.test(chatPageSrc)
    return assert(showsSource && showsFeature,
      `侧栏已展示来源标记=${showsSource}、基频等特征=${showsFeature}`,
      `侧栏未展示音色来源/特征：来源=${showsSource}、基频=${showsFeature}（需展示克隆/预置标记与基频，便于验证克隆音色确实被加载）`)
  })

  // ---------- 阶段 10：回归保护（验收 A10） ----------
  group('阶段 10 · 现有功能回归保护（验收 A10）')

  check('store 四类资源 CRUD 方法齐备', () => {
    if (storeSrc == null) return assert(false, '', 'store.js 不存在')
    const need = ['createResource', 'updateResource', 'toggleResource', 'deleteResource', 'getResource', 'listResources']
    const miss = need.filter((m) => !new RegExp(`${m}\\s*\\(`).test(storeSrc))
    return assert(miss.length === 0, `CRUD 齐全：${need.join('/')}`, `缺失：${miss.join(', ')}`)
  })

  check('store 乐观锁未被破坏（expectedVersion 校验仍在）', () => {
    if (storeSrc == null) return assert(false, '', 'store.js 不存在')
    const ok = /expectedVersion/.test(storeSrc) && /配置已被他人修改/.test(storeSrc)
    return assert(ok, '乐观锁校验保留', '乐观锁校验疑似被移除')
  })

  check('store 审计日志未被破坏（audit 调用仍在）', () => {
    if (storeSrc == null) return assert(false, '', 'store.js 不存在')
    const calls = (storeSrc.match(/this\.audit\(/g) || []).length
    return assert(calls >= 5, `audit 调用 ${calls} 处`, `audit 调用仅 ${calls} 处，疑似被破坏`)
  })

  check('store 发布/回滚/安全点切换链路未被破坏', () => {
    if (storeSrc == null) return assert(false, '', 'store.js 不存在')
    const need = ['publish()', 'rollback()', 'applyPendingSwitch(']
    const miss = need.filter((m) => !new RegExp(m.replace(/[()]/g, '\\$&')).test(storeSrc))
    const cfgVer = /configVersion/.test(storeSrc)
    return assert(miss.length === 0 && cfgVer, '发布/回滚/applyPendingSwitch/configVersion 均在',
      `链路缺失：${miss.join(', ')}，configVersion=${cfgVer}`)
  })

  check('store 仍保留 localStorage 持久化', () => {
    if (storeSrc == null) return assert(false, '', 'store.js 不存在')
    const ok = /localStorage\.setItem/.test(storeSrc) && /localStorage\.getItem/.test(storeSrc)
    return assert(ok, '持久化读写均在', '持久化代码疑似被移除')
  })

  check('模型适配器仍走真实代理（未退化为模板伪造）（验收 A10）', () => {
    if (adaptersSrc == null) return assert(false, '', 'adapters.js 不存在')
    const ok = /\/api\/chat/.test(adaptersSrc) && /\/api\/test/.test(adaptersSrc) &&
      /text\/event-stream|stream\s*:\s*true/.test(adaptersSrc)
    return assert(ok, '真实流式代理调用保留', '模型适配器疑似被改动/退化')
  })

  check('server/index.mjs 未被改动（契约第 5 节禁止项）', () => {
    const p = path.join(ROOT, 'server', 'index.mjs')
    if (!fs.existsSync(p)) return 'server/index.mjs 不存在（跳过）'
    const t = fs.readFileSync(p, 'utf8')
    const ok = !/voice_clone|voiceClone|extractFeatures/.test(t)
    return assert(ok, '后端未涉及声音克隆链路', 'server/index.mjs 出现了声音克隆相关内容，违反契约第 5 节')
  })

  check('package.json 未引入新 npm 依赖（契约第 5 节禁止项）', () => {
    const p = path.join(ROOT, 'package.json')
    if (!fs.existsSync(p)) return assert(false, '', 'package.json 不存在')
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
    const allowed = new Set(['react', 'react-dom', '@vitejs/plugin-react', 'vite'])
    const deps = Object.keys(pkg.dependencies || {})
    const dev = Object.keys(pkg.devDependencies || {})
    const extra = [...deps, ...dev].filter((d) => !allowed.has(d))
    return assert(extra.length === 0, `依赖未变：${[...deps, ...dev].join(', ')}`,
      `出现新依赖：${extra.join(', ')}`)
  })

  // ---------- 阶段 11：前端测试脚本与构建（验收 A8、A9） ----------
  group('阶段 11 · 前端测试脚本与生产构建（验收 A8、A9）')

  check('scripts/test-voice.mjs 存在（验收 A8）', () => {
    const p = path.join(ROOT, 'scripts', 'test-voice.mjs')
    return assert(fs.existsSync(p), '文件存在', '文件不存在：前端工程师尚未提交测试脚本')
  })

  check('node scripts/test-voice.mjs 退出码为 0（验收 A8）', () => {
    const p = path.join(ROOT, 'scripts', 'test-voice.mjs')
    if (!fs.existsSync(p)) return assert(false, '', '文件不存在，跳过')
    let r
    try {
      r = spawnSync(process.execPath, [p], { cwd: ROOT, encoding: 'utf8', timeout: 120000 })
    } catch (e) {
      return assert(false, '', `执行异常：${e.message}`)
    }
    const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-4).join(' / ')
    return assert(r.status === 0, `退出码 ${r.status}；末行输出：${tail}`,
      `退出码 ${r.status}；末行输出：${tail}`)
  })

  check('npm run build 成功且产物无旧字面量（验收 A9 + A1）', () => {
    let r
    try {
      r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: true })
    } catch (e) {
      return assert(false, '', `构建异常：${e.message}`)
    }
    if (r.status !== 0) {
      const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-6).join(' / ')
      return assert(false, '', `构建失败（退出码 ${r.status}）：${tail}`)
    }
    const distDir = path.join(ROOT, 'dist')
    const bad = []
    const walk = (dir) => {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        if (e.isDirectory()) { walk(abs); continue }
        if (!e.isFile()) continue
        try {
          const t = fs.readFileSync(abs, 'utf8')
          for (const n of [['voice_clone_', 'A'].join(''), ['voice_clone_', 'B'].join('')]) {
            if (t.includes(n)) bad.push(path.relative(ROOT, abs).replace(/\\/g, '/'))
          }
        } catch { /* ignore */ }
      }
    }
    walk(distDir)
    return assert(bad.length === 0, '构建成功，产物中无旧字面量',
      `构建成功但产物仍含 ${bad.length} 个命中文件：${bad.join(', ')}`)
  })
}

// ============================ 输出 ============================

function finish() {
  console.log('')
  let total = 0
  let passed = 0
  let failed = 0
  for (const g of groups) {
    console.log('-'.repeat(78))
    console.log(`▶ ${g.title}`)
    for (const c of g.checks) {
      total++
      if (c.info) {
        console.log(`   ℹ️  ${c.desc} ${c.detail}`)
        continue
      }
      if (c.ok) {
        passed++
        console.log(`   ✅ PASS  ${c.desc}`)
        if (c.detail) console.log(`           ${c.detail}`)
      } else {
        failed++
        console.log(`   ❌ FAIL  ${c.desc}`)
        if (c.detail) console.log(`           ${c.detail}`)
      }
    }
  }
  console.log('-'.repeat(78))
  console.log(`总计 ${total} 项 · PASS ${passed} · FAIL ${failed}`)
  const verdict = failed === 0 ? 'PASS' : 'FAIL'
  console.log(`判定：${verdict}`)
  console.log('='.repeat(78))
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('验证脚本自身异常：', e)
  process.exitCode = 1
})
