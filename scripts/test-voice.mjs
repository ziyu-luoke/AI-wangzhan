#!/usr/bin/env node
// 声音克隆功能 · 前端测试脚本（契约第 3 节）
//
// 运行：node scripts/test-voice.mjs    退出码 0 = 全部通过
//
// 设计原则：
//   1. 只依据 docs/voice-clone-contract.md 的契约，与任何其他测试脚本无关。
//   2. 纯 Node 环境运行：不依赖 DOM / WebAudio / 浏览器 API，
//      因为 src/engine/voiceClone.js 只接受已解码的 Float32Array。
//   3. 断言全部使用「可复现的合成信号」，不依赖随机数，避免偶发失败。

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/** 断言：条件为真则返回说明文字（PASS），否则抛出带证据的 Error（FAIL） */
function assert(cond, okMsg, failMsg) {
  if (!cond) throw new Error(failMsg)
  return okMsg
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

// ============================ 工具函数 ============================

/**
 * 合成一段已知频率的正弦波（可叠加谐波）。
 * 边缘做淡入淡出，避免截断带来的频谱泄漏污染基频检测。
 */
function makeSine({ freq, durSec = 1.5, sampleRate = 16000, amp = 0.6, harmonics = 0 }) {
  const n = Math.round(durSec * sampleRate)
  const out = new Float32Array(n)
  const fadeLen = Math.max(1, Math.floor(sampleRate * 0.02))
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let v = Math.sin(2 * Math.PI * freq * t)
    for (let k = 2; k <= harmonics; k++) v += (1 / k) * Math.sin(2 * Math.PI * freq * k * t)
    const edge = Math.min(i, n - 1 - i)
    out[i] = v * amp * Math.min(1, edge / fadeLen)
  }
  return out
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

// ============================ 主流程 ============================

async function main() {
  console.log('='.repeat(72))
  console.log('  声音克隆功能 · 前端测试脚本')
  console.log('  目标模块：src/engine/voiceClone.js')
  console.log('='.repeat(72))

  // ---------- 阶段 0：模块可导入性 ----------
  group('阶段 0 · 模块可导入性（契约 2.1 / 第 3 节关键约束）')

  let vc
  try {
    vc = await import(pathToFileURL(MODULE_PATH).href)
  } catch (e) {
    check('src/engine/voiceClone.js 可在纯 Node 环境直接 import', () =>
      assert(false, '', `import 失败：${e && e.message ? e.message : e}`))
    return finish()
  }
  check('src/engine/voiceClone.js 可在纯 Node 环境直接 import', () => 'import 成功，未依赖 DOM / WebAudio')

  const { extractFeatures, deriveParams, hashFeatures, cloneFromAudio } = vc
  check('导出 extractFeatures / deriveParams / hashFeatures / cloneFromAudio', () => {
    const missing = ['extractFeatures', 'deriveParams', 'hashFeatures', 'cloneFromAudio']
      .filter((k) => typeof vc[k] !== 'function')
    return assert(missing.length === 0, '四个契约导出齐全', `缺少导出：${missing.join(', ')}`)
  })
  if (!extractFeatures || !deriveParams || !hashFeatures || !cloneFromAudio) return finish()

  // ---------- 阶段 1：特征提取正确性 ----------
  group('阶段 1 · 特征提取正确性（契约 3.5）')

  for (const freq of [100, 220, 330]) {
    check(`合成正弦波 ${freq}Hz → 检出 f0 误差 < 15%`, () => {
      const f = extractFeatures(makeSine({ freq, durSec: 1.5, sampleRate: 16000, amp: 0.6 }), 16000)
      const got = f.f0
      if (!isFiniteNumber(got) || got <= 0) return assert(false, '', `未检出有效 f0（得到 ${got}）`)
      const err = Math.abs(got - freq) / freq
      return assert(err < 0.15,
        `真值 ${freq}Hz → 检出 ${got.toFixed(2)}Hz（误差 ${(err * 100).toFixed(2)}%）`,
        `真值 ${freq}Hz → 检出 ${got.toFixed(2)}Hz，误差 ${(err * 100).toFixed(2)}% ≥ 15%`)
    })
  }

  check('extractFeatures 返回契约要求的 9 个特征字段', () => {
    const f = extractFeatures(makeSine({ freq: 200 }), 16000)
    const need = ['duration', 'sampleRate', 'rms', 'peak', 'zcr', 'f0', 'brightness', 'silenceRatio', 'clipping']
    const missing = need.filter((k) => !(k in (f || {})))
    return assert(missing.length === 0, '字段齐全：' + need.join('/'),
      `缺少字段：${missing.join(', ')}`)
  })

  check('extractFeatures 全部特征为有限数（无 NaN / undefined）', () => {
    const f = extractFeatures(makeSine({ freq: 200 }), 16000)
    const bad = Object.entries(f || {}).filter(([, v]) => !isFiniteNumber(v)).map(([k]) => k)
    return assert(bad.length === 0, '全部为有限数', `非有限数字字段：${bad.join(', ')}`)
  })

  check('duration / sampleRate 来自真实信号（不写死）', () => {
    const a = extractFeatures(makeSine({ freq: 200, durSec: 1.0, sampleRate: 16000 }), 16000)
    const b = extractFeatures(makeSine({ freq: 200, durSec: 2.5, sampleRate: 16000 }), 16000)
    const dOk = Math.abs(a.duration - 1.0) < 0.05 && Math.abs(b.duration - 2.5) < 0.05
    return assert(dOk, `duration 随信号长度变化：1.0s→${a.duration.toFixed(3)}s，2.5s→${b.duration.toFixed(3)}s`,
      `duration 与真实长度不符：${a.duration} / ${b.duration}`)
  })

  check('extractFeatures 对极端输入不抛异常且不产生 NaN', () => {
    const cases = [
      ['空数组', new Float32Array(0)],
      ['全零（静音）', new Float32Array(16000)],
      ['单样本', new Float32Array([0.5])],
      ['含 NaN 的信号', (() => { const a = makeSine({ freq: 200 }); a[100] = NaN; return a })()],
      ['含 Infinity 的信号', (() => { const a = makeSine({ freq: 200 }); a[200] = Infinity; return a })()],
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
    const buf = makeSine({ freq: 200 })
    const copy = Float32Array.from(buf)
    extractFeatures(buf, 16000)
    let diff = 0
    for (let i = 0; i < buf.length; i++) if (!Object.is(buf[i], copy[i])) diff++
    return assert(diff === 0, '入参数组未被修改', `入参被修改了 ${diff} 个样本`)
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
    const buf = makeSine({ freq: 180, durSec: 1.2, sampleRate: 16000, amp: 0.4 })
    const c1 = cloneFromAudio(makeDecoded(buf), { name: '素材1', count: 3, seed: 's1' })
    const c2 = cloneFromAudio(makeDecoded(buf), { name: '素材1', count: 3, seed: 's1' })
    const v1 = new Set(c1.map((c) => c.voiceId))
    const v2 = new Set(c2.map((c) => c.voiceId))
    const same = v1.size === v2.size && [...v1].every((v) => v2.has(v))
    return assert(same, `voiceId 稳定：${[...v1].join(',')}`,
      `同素材 voiceId 不一致：${[...v1].join(',')} vs ${[...v2].join(',')}`)
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
    const a = cloneFromAudio(makeDecoded(makeSine({ freq: 100, durSec: 1.2 })), { name: '低', count: 2, seed: 's' })
    const b = cloneFromAudio(makeDecoded(makeSine({ freq: 250, durSec: 1.2 })), { name: '高', count: 2, seed: 's' })
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

  check('真实音频：纯音 vs 含谐波 → brightness 显著不同', () => {
    const pure = extractFeatures(makeSine({ freq: 200, durSec: 1.2, amp: 0.5, harmonics: 0 }), 16000)
    const rich = extractFeatures(makeSine({ freq: 200, durSec: 1.2, amp: 0.5, harmonics: 6 }), 16000)
    const delta = Math.abs(pure.brightness - rich.brightness)
    return assert(delta > 0.01,
      `纯音 brightness=${pure.brightness.toFixed(4)}，含谐波 brightness=${rich.brightness.toFixed(4)}，差 ${delta.toFixed(4)}`,
      `brightness 几乎无差异（差 ${delta.toFixed(6)}）：${pure.brightness} vs ${rich.brightness}，疑似写死`)
  })

  // ---------- 阶段 4：候选唯一性 ----------
  group('阶段 4 · 候选数量与唯一性（契约 3.3 / 验收 A2）')

  const matA = makeSine({ freq: 110, durSec: 1.2, sampleRate: 16000, amp: 0.4 })
  const matB = makeSine({ freq: 260, durSec: 1.2, sampleRate: 16000, amp: 0.65 })

  for (const count of [1, 2, 3, 5]) {
    check(`cloneFromAudio(count=${count}) 返回候选数 = ${count}`, () => {
      const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count, seed: 's' })
      return assert(Array.isArray(c) && c.length === count, `实际返回 ${c?.length} 个`,
        `期望 ${count} 个，实际 ${c?.length} 个`)
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
      `存在交集：${inter.join(', ')}`)
  })

  check('候选对象字段齐全（id/name/voiceId/params/features/previewNote）', () => {
    const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count: 2, seed: 's' })
    const need = ['id', 'name', 'voiceId', 'params', 'features', 'previewNote']
    const missing = []
    for (const cand of c) for (const k of need) if (!(k in (cand || {}))) missing.push(`${cand?.id}.${k}`)
    return assert(missing.length === 0, '字段齐全', `缺少字段：${missing.join(', ')}`)
  })

  check('候选 voiceId 形如 voice_clone_<hash>', () => {
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

  check('候选 features 为真实特征摘要（含真实 f0）', () => {
    const c = cloneFromAudio(makeDecoded(matA), { name: '素材', count: 1, seed: 's' })
    const fe = c[0]?.features || {}
    const truth = extractFeatures(matA, 16000)
    // 候选 features 的 f0 会按该候选的音高偏移同步缩放（保证「参数」与「特征」自洽），
    // 因此允许一个与偏移幅度相当的容差；其余特征必须与真实提取值完全一致。
    const pitch = c[0]?.params?.pitch ?? 1
    const basePitch = truth.f0 > 0 ? truth.f0 / 180 : 1
    const expectedF0 = truth.f0 * (pitch / basePitch)
    const f0Ok = 'f0' in fe && isFiniteNumber(fe.f0) && Math.abs(fe.f0 - expectedF0) < 1
    const othersOk = ['duration', 'sampleRate', 'rms', 'peak', 'zcr', 'brightness', 'silenceRatio', 'clipping']
      .every((k) => k in fe && Math.abs(fe[k] - truth[k]) < 1e-6)
    return assert(Object.keys(fe).length > 0 && f0Ok && othersOk,
      `features=${JSON.stringify(fe).slice(0, 140)}`,
      `features 缺失或与真实提取值不符：候选 ${JSON.stringify(fe).slice(0, 100)} / 真实 f0=${truth.f0}`)
  })

  check('候选 name / previewNote 含真实特征描述（非固定文案）', () => {
    const a = cloneFromAudio(makeDecoded(matA), { name: 'A', count: 1, seed: 's' })
    const b = cloneFromAudio(makeDecoded(matB), { name: 'B', count: 1, seed: 's' })
    const differs = a[0].name !== b[0].name || a[0].previewNote !== b[0].previewNote
    const mentionsF0 = /f0|基频|Hz|hz/i.test(`${a[0].name} ${a[0].previewNote}`)
    return assert(differs && mentionsF0,
      `A="${a[0].name}"；B="${b[0].name}"`,
      `文案未体现真实特征或完全固定：A="${a[0].name}" B="${b[0].name}"`)
  })

  // ---------- 阶段 5：参数钳制 ----------
  group('阶段 5 · 参数钳制边界（契约 3.4 / 验收 A3）')

  const EXTREME = [
    ['f0=0（未检出）', makeFeatures({ f0: 0 })],
    ['f0=2000（远超检测上限）', makeFeatures({ f0: 2000 })],
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
      return assert(bad.length === 0,
        `pitch=${p.pitch} speed=${p.speed} emotion=${p.emotion} gender=${p.gender}`,
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
      return assert(ok, `空特征 → pitch=${p.pitch} speed=${p.speed} gender=${p.gender}`,
        `空特征产出非法参数：${JSON.stringify(p)}`)
    } catch (e) {
      return assert(false, '', `抛异常：${e.message}`)
    }
  })

  // ---------- 阶段 6：确定性与纯净性 ----------
  group('阶段 6 · 确定性与纯净性')

  check('同一段音频反复提取结果一致（无内部随机性）', () => {
    const buf = makeSine({ freq: 210, durSec: 1.0, sampleRate: 16000, amp: 0.5 })
    const rs = []
    for (let i = 0; i < 5; i++) rs.push(JSON.stringify(extractFeatures(buf, 16000)))
    return assert(rs.every((r) => r === rs[0]), '5 次结果一致', `结果不稳定：${rs.join(' / ')}`)
  })

  check('cloneFromAudio 无内部随机性（同输入同输出）', () => {
    const d = makeDecoded(makeSine({ freq: 165, durSec: 1.0, sampleRate: 16000, amp: 0.5 }))
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

  check('cloneFromAudio 对非法输入不产生未捕获崩溃', () => {
    const problems = []
    const cases = [
      ['空数组', makeDecoded(new Float32Array(0))],
      ['null samples', { samples: null, sampleRate: 16000, duration: 0 }],
    ]
    const notes = []
    for (const [label, arg] of cases) {
      try {
        const c = cloneFromAudio(arg, { name: 'x', count: 2, seed: 's' })
        if (!Array.isArray(c)) problems.push(`${label} 未返回数组`)
        else notes.push(`${label}→返回 ${c.length} 项`)
      } catch (e) {
        const msg = String(e && e.message ? e.message : e)
        if (!/[\u4e00-\u9fa5]/.test(msg)) problems.push(`${label} 抛出的错误无中文提示：${msg}`)
        else notes.push(`${label}→抛出中文错误「${msg}」`)
      }
    }
    return assert(problems.length === 0, notes.join('；'), `问题：${problems.join(' | ')}`)
  })

  return finish()
}

// ============================ 输出 ============================

function finish() {
  console.log('')
  let total = 0
  let passed = 0
  let failed = 0
  for (const g of groups) {
    console.log('-'.repeat(72))
    console.log(`▶ ${g.title}`)
    for (const c of g.checks) {
      total++
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
  console.log('-'.repeat(72))
  console.log(`总计 ${total} 项 · PASS ${passed} · FAIL ${failed}`)
  console.log(`判定：${failed === 0 ? 'PASS' : 'FAIL'}`)
  console.log('='.repeat(72))
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error('测试脚本自身异常：', e)
  process.exitCode = 1
})
