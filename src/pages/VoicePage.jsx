import React, { useState, useRef, useEffect, useMemo } from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'
import { useUI } from '../components/UIContext.jsx'
import ResourceCard from '../components/ResourceCard.jsx'
import Modal from '../components/Modal.jsx'
import { voiceAdapter, voiceSampleValidator } from '../engine/adapters.js'
import { MAX_FILE_BYTES } from '../engine/audioDecode.js'
import { deriveParams } from '../engine/voiceClone.js'

const SAMPLE_SENTENCE = '你好呀，我是小智，很高兴认识你！'

// 单文件大小上限与扩展名白名单统一由 audioDecode.js 定义，避免两处口径不一致
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|opus|webm|flac|aiff?)$/i

// gender 只是「音色方向」的粗略提示，不是身份判定
const GENDER_LABEL = { male: '偏男声', female: '偏女声', neutral: '中性' }
const SOURCE_LABEL = { clone: '克隆', preset: '预置', tune: '参数调节' }

// 样本质量阈值：与适配器 voiceSampleValidator 保持同一口径
const MIN_SAMPLE_DURATION = 2
const MAX_SILENCE_RATIO = 0.6

const emptyForm = () => ({
  name: '', source: '声音克隆', voiceId: '', sampleAudioRef: '',
  sampleRate: 24000, format: 'Opus',
  params: { pitch: 1.0, speed: 1.0, emotion: 0.6, gender: 'neutral' },
  features: null, sampleKey: '', sourceType: 'clone', gender: 'neutral',
  authorization: null, enabled: true,
})

/**
 * 样本文件的前置校验（6 类异常中的前 3 类：空文件 / 超大文件 / 非音频文件）。
 * 在解码之前先挡掉明显不合法的文件，避免把几十 MB 的非音频丢给解码器。
 */
function checkSampleFile(file) {
  if (!file) return '未选择音频文件，请先上传声音样本'
  if (file.size === 0) return '音频文件为空（0 字节），请重新选择有效的声音样本'
  if (file.size > MAX_FILE_BYTES) return '音频文件超过 20MB 上限，请压缩或截取后再上传'
  const looksAudio = /^audio\//.test(file.type || '') || AUDIO_EXT.test(file.name || '')
  if (!looksAudio) return '所选文件不是音频文件，仅支持 WAV / MP3 / M4A / OGG / WebM 等音频格式'
  return ''
}

/**
 * 解码后的样本质量校验（6 类异常中的后 2 类：时长过短 / 静音占比过高）。
 * 时长与静音占比只有在拿到真实 PCM 之后才能判断，因此这里一律用真实测量值，绝不让用户手填。
 */
function checkSampleQuality(info) {
  const problems = []
  const duration = Number(info?.duration) || 0
  if (duration < MIN_SAMPLE_DURATION) {
    problems.push(`样本时长不足：${duration.toFixed(2)}s，至少需要 ${MIN_SAMPLE_DURATION} 秒`)
  }
  const silenceRatio = Number(info?.features?.silenceRatio) || 0
  if (silenceRatio > MAX_SILENCE_RATIO) {
    problems.push(`静音占比过高：${(silenceRatio * 100).toFixed(0)}%，超过 ${MAX_SILENCE_RATIO * 100}% 上限，请录制更连续的语音`)
  }
  return problems
}

/** 把声学特征渲染成一句人话，用于卡片与详情展示 */
function featureSummary(f) {
  if (!f) return '暂无特征'
  const f0 = f.f0 > 0 ? `基频 ${Math.round(f.f0)}Hz` : '基频未检出'
  return `${f0} · 明亮度 ${(f.brightness ?? 0).toFixed(2)} · 时长 ${(f.duration ?? 0).toFixed(1)}s`
}

export default function VoicePage() {
  useStoreState()
  const state = store.getState()
  const { toast, setMascot } = useUI()
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(null)
  const [confirmDel, setConfirmDel] = useState(null)
  const voices = state.resources.voice
  const using = state.draftBinding.voiceId

  // ---- 克隆流程状态 ----
  const [genOpen, setGenOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [file, setFile] = useState(null)
  const [material, setMaterial] = useState(null)   // 素材真实解码结果
  const [sampleError, setSampleError] = useState('')
  const [authorized, setAuthorized] = useState(false)
  const [candidates, setCandidates] = useState([])
  const [selected, setSelected] = useState(null)
  const [progress, setProgress] = useState(0)
  const [progressLabel, setProgressLabel] = useState('')
  const [replaceId, setReplaceId] = useState('')   // 非空表示「替换已有音色」
  const fileRef = useRef(null)
  const audioRef = useRef(null)
  const sampleUrlRef = useRef('')

  const openNew = () => { setForm(emptyForm()); setEditing('new'); setMascot('happy', '来做新音色吧！') }
  const openEdit = (item) => { setForm(JSON.parse(JSON.stringify(item))); setEditing(item.id) }
  const close = () => { setEditing(null); setForm(null) }
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const setParam = (k, v) => setForm((f) => ({ ...f, params: { ...f.params, [k]: v } }))

  // 编辑抽屉里的「素材派生参数」（只读）：由 features 重新推导，
  // 用来对照当前生效参数是否已被手动微调过
  const derived = useMemo(() => {
    if (!form?.features) return null
    try { return deriveParams(form.features) } catch { return null }
  }, [form])

  const save = () => {
    if (!form.name.trim()) { toast('请填写音色名称', 'error'); return }
    if (form.source === '声音克隆' && !form.authorization) { toast('声音克隆需要授权确认', 'error'); return }
    try {
      if (editing === 'new') { store.createResource('voice', form); toast(`音色「${form.name}」已创建`, 'success') }
      else { const cur = store.getResource('voice', editing); store.updateResource('voice', editing, form, cur.version); toast(`音色「${form.name}」已保存，需重新发布后生效`, 'success') }
      setMascot('love', '音色保存好啦！')
      close()
    } catch (e) { toast(e.message, 'error') }
  }

  const doToggle = (item) => { try { store.toggleResource('voice', item.id) } catch (e) { toast(e.message, 'error') } }
  const doDelete = (item) => setConfirmDel(item)
  const confirmDelete = () => {
    try { store.deleteResource('voice', confirmDel.id); toast('已删除', 'success'); setConfirmDel(null) }
    catch (e) { toast(e.message, 'error') }
  }

  // 试听已有音色：用该资源自己的派生参数驱动系统语音
  const audition = async (item) => {
    setMascot('thinking', '来听一句～', 0)
    const p = await voiceAdapter.preview(item)
    const spoken = voiceAdapter.speak(p.sampleText, item)
    toast(spoken ? `试听：${SAMPLE_SENTENCE}` : `音色 ${item.voiceId}（当前浏览器不支持语音合成）`, 'info')
    setMascot('happy', '听出来了吗？')
  }

  // 原声试听：读取样本库里留存的原始音频
  const auditionOriginal = async (item) => {
    if (!item.sampleKey) { toast('该音色没有留存原声样本', 'info'); return }
    const blob = await store.loadVoiceSample(item.sampleKey)
    if (!blob) { toast('原声样本已丢失（可能浏览器未持久化存储）', 'info'); return }
    if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current)
    sampleUrlRef.current = URL.createObjectURL(blob)
    if (audioRef.current) { audioRef.current.src = sampleUrlRef.current; audioRef.current.play().catch(() => {}) }
    toast('正在播放原声样本', 'info')
  }

  useEffect(() => () => { if (sampleUrlRef.current) URL.revokeObjectURL(sampleUrlRef.current) }, [])

  // ---- 克隆流程 ----
  const openClone = () => {
    setGenOpen(true); setStep(0); setFile(null); setMaterial(null)
    setSampleError(''); setAuthorized(false); setCandidates([]); setSelected(null)
    setProgress(0); setProgressLabel(''); setReplaceId('')
    setForm(emptyForm()); setMascot('thinking', '上传一段声音样本吧～')
  }

  // 步骤0：选文件 → 真实解码 → 展示真实时长/采样率/特征
  const onPickFiles = async (e) => {
    const fs = Array.from(e.target.files || [])
    if (!fs.length) return
    const f = fs[0]
    const fileErr = checkSampleFile(f)
    if (fileErr) { setSampleError(fileErr); setFile(null); setMaterial(null); toast(fileErr, 'error'); return }
    setSampleError(''); setFile(f); setMaterial(null); setCandidates([]); setSelected(null)
    setMascot('thinking', '正在解码音频…', 0)
    // 真实解码：拿真实时长与真实采样率，绝不让用户手填
    let info
    try {
      info = await voiceAdapter.inspect(f)
    } catch (err) {
      const msg = '音频解码失败：文件可能已损坏或格式不受支持'
      setSampleError(msg); toast(msg, 'error'); return
    }
    if (!info.ok) {
      const msg = info.error || '音频解码失败：文件可能已损坏或格式不受支持'
      setSampleError(msg); toast(msg, 'error'); setMascot('error', '这段音频读不出来…'); return
    }
    setMaterial(info)
    // 质量校验全部基于真实解码结果：时长不足 / 静音占比过高只有拿到真实 PCM 才能判断
    const problems = checkSampleQuality(info)
    // 适配器侧独立复核（双保险，两处结论一致才算通过）
    const v = voiceSampleValidator.validate(info)
    for (const p of v.problems) if (!problems.includes(p)) problems.push(p)
    if (problems.length > 0) {
      setSampleError(problems.join('；'))
      toast(problems[0], 'error')
      setMascot('error', '样本质量不够哦～')
      return
    }
    toast('样本校验通过', 'success'); setMascot('wink', '样本不错哦！')
  }

  // 步骤2：真实执行特征提取与候选生成（进度对应真实阶段，不是假进度）
  const startClone = async () => {
    if (!file) { toast('请先上传合格样本', 'error'); return }
    if (sampleError) { toast(sampleError, 'error'); return }
    if (!authorized) { toast('请先确认声音授权', 'error'); setMascot('error', '要先确认授权哦'); return }
    setStep(2); setMascot('cheer', '正在提取声纹特征…加油！', 0)
    setProgress(8); setProgressLabel('准备中…')
    const task = store.createGenerationTask('voice', {
      name: form.name || '克隆音色',
      files: file ? [file.name] : [],
      duration: material?.duration ?? 0,
      sampleRate: material?.sampleRate ?? 0,
    })
    store.updateGenerationTask(task.id, { status: 'PROCESSING' })
    try {
      const result = await voiceAdapter.clone(file, {
        name: form.name || '克隆音色',
        count: 3,
        // seed 固定 → 同一素材每次得到同一 voiceId，不同素材必然不同
        onProgress: (pct, label) => { setProgress(pct); setProgressLabel(label) },
      })
      setCandidates(result); setSelected(result[0] || null)
      setProgress(100); setProgressLabel('候选生成完成')
      store.updateGenerationTask(task.id, { status: 'SUCCEEDED', progress: 100, result })
      setStep(3); setMascot('surprised', '克隆好啦，听听看！')
    } catch (err) {
      const msg = err?.message || '音频解码失败：文件可能已损坏或格式不受支持'
      store.updateGenerationTask(task.id, { status: 'FAILED', error: msg })
      setStep(0); setSampleError(msg); toast(msg, 'error'); setMascot('error', '克隆失败了…')
    }
  }

  // 步骤3：试听候选 —— 必须用该候选自己的 params
  const previewCandidate = (c) => {
    setSelected(c)
    const spoken = voiceAdapter.speak(SAMPLE_SENTENCE, { ...c, params: c.params })
    toast(spoken ? `试听候选：${c.name}` : '当前浏览器不支持语音合成', 'info')
  }

  // 步骤3：采纳（新建 或 替换已有音色）
  const adopt = async () => {
    if (!selected) { toast('请先选择并试听一个候选音色', 'error'); return }
    const name = (form.name || '').trim() || selected.name
    // 替换时保持原资源 id 不变 → 已有绑定与版本关系不失效
    const resourceId = replaceId || store.uid('voice')
    const sampleKey = `voice-sample-${resourceId}`
    const base = {
      ...emptyForm(),
      name,
      source: '声音克隆',
      sourceType: 'clone',
      voiceId: selected.voiceId,
      params: { ...selected.params },
      features: selected.features,
      gender: selected.params.gender || 'neutral',
      sampleKey,
      sampleAudioRef: `audio素材/${file?.name || 'sample.wav'}`,
      sampleRate: material?.sampleRate || 24000,
      authorization: {
        owner: '当前用户（所有者）',
        confirmedAt: store.now?.() || new Date().toLocaleString(),
        scope: '仅本项目使用',
      },
      enabled: true,
    }
    try {
      if (replaceId) {
        const cur = store.getResource('voice', replaceId)
        if (!cur) { toast('待替换的音色已不存在，请重新选择', 'error'); return }
        // 替换只更新音色内容（voiceId/params/features/sampleKey 等），
        // 资源 id 保持不变 → 已有绑定与版本关系不失效；启用状态沿用原值，不擅自改变。
        store.updateResource('voice', replaceId, { ...base, enabled: cur.enabled }, cur.version)
        // 旧样本键不同则清理，避免样本库残留
        if (cur.sampleKey && cur.sampleKey !== sampleKey) await store.deleteVoiceSample(cur.sampleKey)
        toast(`音色「${name}」已替换，资源 ID 保持不变，需重新发布后生效`, 'success')
      } else {
        store.createResource('voice', { ...base, id: resourceId })
        toast(`音色「${name}」已采纳并创建`, 'success')
      }
      // 样本落盘：原声留存，支持后续原声试听与替换
      const saved = await store.saveVoiceSample(sampleKey, file)
      setMascot('love', '采用啦！')
      const latest = store.getState().generationTasks[0]
      if (latest) store.updateGenerationTask(latest.id, { status: 'ADOPTED' })
      setGenOpen(false)
      if (!saved.ok) toast('原声样本保存失败，刷新后原声试听将不可用', 'warn')
    } catch (e) { toast(e.message, 'error') }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>🎵 语音音色</h2>
          <p>上传声音样本后，系统会真实提取基频、明亮度、时长等声学特征，并用这些特征驱动音色选型与参数合成——不同素材会得到可区分且可复现的音色。</p>
        </div>
        <span className="spacer" />
        <button className="btn btn-blue" onClick={openClone}>🎤 上传声音克隆</button>
        <button className="btn btn-primary" onClick={openNew}>➕ 新增音色</button>
      </div>

      {voices.length === 0 ? (
        <div className="empty"><div className="empty-emoji">🎵</div><div className="empty-text">还没有音色，空空如也～</div></div>
      ) : (
        <div className="grid">
          {voices.map((v) => (
            <ResourceCard
              key={v.id} item={v}
              avatar="🎵" avatarBg="linear-gradient(135deg,#ffe0a3,#fff0cc)"
              using={using === v.id}
              meta={[
                ['来源', `${SOURCE_LABEL[v.sourceType] || '预置'}（${v.source}）`],
                ['音色 ID', v.voiceId || '—'],
                ['基频', v.features?.f0 > 0 ? `${Math.round(v.features.f0)}Hz` : '—'],
                ['采样率', `${((v.sampleRate || 0) / 1000).toFixed(0)}kHz`],
              ]}
              tags={[
                v.source === '声音克隆' ? '🔒 已授权' : v.source,
                `语速 ${v.params.speed}`,
                `音调 ${v.params.pitch}`,
                GENDER_LABEL[v.gender || v.params.gender] || '中性',
              ]}
              onEdit={() => openEdit(v)} onToggle={() => doToggle(v)} onDelete={() => doDelete(v)}
              onExtra={() => audition(v)} extraLabel="▶ 试听"
            />
          ))}
        </div>
      )}

      {/* 编辑抽屉 */}
      <Modal open={!!editing && !genOpen} title={editing === 'new' ? '➕ 新增音色' : '✏️ 编辑音色'} onClose={close}
        footer={<><button className="btn" onClick={close}>取消</button><button className="btn btn-primary" onClick={save}>💾 保存</button></>}>
        {form && <>
          <div className="form-section">
            <h4>📝 基础信息</h4>
            <div className="field-row">
              <div className="field"><label>音色名称 *</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如：温柔小姐姐" /></div>
              <div className="field"><label>来源</label><select className="select" value={form.source} onChange={(e) => set('source', e.target.value)}><option>声音克隆</option><option>系统预置</option><option>参数调节</option></select></div>
            </div>
            <div className="field-row">
              <div className="field"><label>音色 ID</label><input className="input" value={form.voiceId} onChange={(e) => set('voiceId', e.target.value)} placeholder="voice_xxx" /></div>
              <div className="field"><label>采样率</label><select className="select" value={form.sampleRate} onChange={(e) => set('sampleRate', +e.target.value)}><option value={16000}>16000 Hz</option><option value={24000}>24000 Hz</option><option value={44100}>44100 Hz</option></select></div>
            </div>
          </div>

          {form.sourceType === 'clone' && form.features && (
            <div className="form-section">
              <h4>🔬 克隆音色特征（由样本真实测得）</h4>
              <div className="feat-grid">
                <div className="feat-cell"><span>基频</span><b>{form.features.f0 > 0 ? `${Math.round(form.features.f0)}Hz` : '未检出'}</b></div>
                <div className="feat-cell"><span>明亮度</span><b>{(form.features.brightness ?? 0).toFixed(2)}</b></div>
                <div className="feat-cell"><span>时长</span><b>{(form.features.duration ?? 0).toFixed(1)}s</b></div>
                <div className="feat-cell"><span>静音占比</span><b>{((form.features.silenceRatio ?? 0) * 100).toFixed(0)}%</b></div>
                <div className="feat-cell"><span>能量</span><b>{(form.features.rms ?? 0).toFixed(3)}</b></div>
                <div className="feat-cell"><span>过零率</span><b>{(form.features.zcr ?? 0).toFixed(3)}</b></div>
              </div>
              <p className="tiny muted mt">下面这些参数由上述特征推导，可手动微调；保存后需重新发布才会对线上生效。</p>
              {derived && (
                <div className="feat-grid mt">
                  <div className="feat-cell"><span>派生音调</span><b>{derived.pitch.toFixed(2)}×</b></div>
                  <div className="feat-cell"><span>派生语速</span><b>{derived.speed.toFixed(2)}×</b></div>
                  <div className="feat-cell"><span>派生情感</span><b>{derived.emotion.toFixed(2)}</b></div>
                  <div className="feat-cell"><span>派生音色方向</span><b>{GENDER_LABEL[derived.gender] || '中性'}</b></div>
                </div>
              )}
              <p className="tiny muted mt">以上为素材自动派生的基准值（只读）；下方滑块是最终生效参数，可在基准值上手动微调。</p>
            </div>
          )}

          <div className="form-section">
            <h4>🎛️ 语音参数</h4>
            <div className="field"><label>语速：{form.params.speed}</label><input type="range" min="0.5" max="2" step="0.05" value={form.params.speed} onChange={(e) => setParam('speed', +e.target.value)} style={{ width: '100%' }} /></div>
            <div className="field"><label>音调：{form.params.pitch}</label><input type="range" min="0.5" max="2" step="0.05" value={form.params.pitch} onChange={(e) => setParam('pitch', +e.target.value)} style={{ width: '100%' }} /></div>
            <div className="field"><label>情感强度：{form.params.emotion}</label><input type="range" min="0" max="1" step="0.1" value={form.params.emotion} onChange={(e) => setParam('emotion', +e.target.value)} style={{ width: '100%' }} /></div>
            <div className="field"><label>音色方向：{GENDER_LABEL[form.params.gender] || '中性'}</label>
              <select className="select" value={form.params.gender || 'neutral'} onChange={(e) => setParam('gender', e.target.value)}>
                <option value="neutral">中性</option><option value="female">偏女声</option><option value="male">偏男声</option>
              </select>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-sm btn-mint" onClick={() => audition(form)}>▶ 试听示例句</button>
              {form.sampleKey && <button className="btn btn-sm" onClick={() => auditionOriginal(form)}>🎧 原声试听</button>}
            </div>
          </div>
          {form.source === '声音克隆' && !form.authorization && (
            <div className="preview-panel" style={{ borderColor: 'var(--warn)' }}>
              <b>⚠️ 声音授权确认</b>
              <p className="tiny mt">克隆音色需确认声纹权属，未确认将无法保存与发布。</p>
            </div>
          )}
        </>}
      </Modal>

      {/* 克隆流程抽屉 */}
      <Modal open={genOpen} title="🎤 上传声音样本克隆音色" onClose={() => setGenOpen(false)} width="720px"
        footer={<>
          <button className="btn" onClick={() => setGenOpen(false)}>关闭</button>
          {step === 1 && <button className="btn btn-blue" onClick={startClone}>🚀 开始克隆</button>}
          {step === 3 && <button className="btn btn-primary" onClick={adopt}>✅ {replaceId ? '采纳并替换' : '采纳并创建'}</button>}
        </>}>
        <div className="row" style={{ marginBottom: 18 }}>
          {['上传样本', '授权确认', '克隆中', '试听采纳'].map((s, i) => (
            <React.Fragment key={s}>
              <div className={`badge ${i === step ? 'active' : i < step ? 'on' : 'off'}`}>{i < step ? '✓' : i + 1}. {s}</div>
              {i < 3 && <span className="muted">—</span>}
            </React.Fragment>
          ))}
        </div>

        {step === 0 && <>
          <div className="form-section">
            <h4>📁 上传声音样本</h4>
            <div className="gen-drop" onClick={() => fileRef.current?.click()}>
              <div className="gd-emoji">🎤</div>
              <div className="gd-text">点击选择音频文件</div>
              <div className="gd-hint">支持 WAV / MP3 / M4A / OGG / WebM，时长需 ≥{voiceSampleValidator.MIN_DURATION}s、安静环境</div>
            </div>
            <input ref={fileRef} type="file" accept="audio/*" hidden onChange={onPickFiles} />
            {file && <div className="mt"><span className="tag">🎵 {file.name}（{(file.size / 1024).toFixed(0)} KB）</span></div>}
            {sampleError && (
              <div className="preview-panel mt" style={{ borderColor: 'var(--danger)' }}>
                <b>❌ 样本不可用</b><p className="tiny mt">{sampleError}</p>
              </div>
            )}
            {material && !sampleError && (
              <div className="feat-grid mt">
                <div className="feat-cell"><span>真实时长</span><b>{material.duration.toFixed(2)}s</b></div>
                <div className="feat-cell"><span>真实采样率</span><b>{material.sampleRate}Hz</b></div>
                <div className="feat-cell"><span>基频</span><b>{material.features.f0 > 0 ? `${Math.round(material.features.f0)}Hz` : '未检出'}</b></div>
                <div className="feat-cell"><span>明亮度</span><b>{material.features.brightness.toFixed(2)}</b></div>
                <div className="feat-cell"><span>能量</span><b>{material.features.rms.toFixed(3)}</b></div>
                <div className="feat-cell"><span>静音占比</span><b>{(material.features.silenceRatio * 100).toFixed(0)}%</b></div>
              </div>
            )}
            {material && !sampleError && <p className="tiny mt" style={{ color: 'var(--success)' }}>✅ 样本真实解码通过，时长与采样率均取自音频本身</p>}
          </div>
          <div className="row mt"><button className="btn btn-mint" disabled={!material || !!sampleError} onClick={() => setStep(1)}>下一步：授权确认 →</button></div>
        </>}

        {step === 1 && <>
          <div className="preview-panel" style={{ borderColor: 'var(--warn)' }}>
            <b>🔒 声音权属授权（强制）</b>
            <p className="tiny mt">克隆音色涉及声纹权属。请确认你拥有该声音的使用授权，不克隆他人声音用于冒充或欺诈。</p>
            <div className="checkbox-row mt">
              <input type="checkbox" id="auth-voice" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
              <label htmlFor="auth-voice">我确认拥有该声音样本的合法使用授权，并同意遵守音色合规要求。</label>
            </div>
          </div>
          <div className="form-section mt">
            <h4>🎛️ 克隆参数</h4>
            <div className="field"><label>音色名称</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如：阳光少年" /></div>
            <div className="field">
              <label>替换已有音色（可选）</label>
              <select className="select" value={replaceId} onChange={(e) => setReplaceId(e.target.value)}>
                <option value="">不替换，克隆为新音色</option>
                {voices.map((v) => <option key={v.id} value={v.id}>替换「{v.name}」（资源 ID 保持不变）</option>)}
              </select>
              <p className="tiny muted mt">替换会保留原资源 ID，已有绑定与版本关系不失效；替换后需重新发布才会对线上生效。</p>
            </div>
            {material && (
              <p className="tiny muted">素材实测：{featureSummary(material.features)}</p>
            )}
          </div>
        </>}

        {step === 2 && <>
          <div className="preview-panel" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 52 }} className="spin">🎤</div>
            <p className="mt" style={{ fontFamily: 'var(--font-round)' }}>{progressLabel || '正在提取声纹特征…'}</p>
            <div className="progress-track mt"><div className="progress-fill" style={{ width: `${progress}%` }}>{progress}%</div></div>
          </div>
        </>}

        {step === 3 && <>
          <p className="tiny muted mb">点击候选试听（使用该候选自身的音高/语速/情感参数），选择最满意的一个采纳。试听句：<b>{SAMPLE_SENTENCE}</b></p>
          {material && <p className="tiny muted mb">素材实测：{featureSummary(material.features)}</p>}
          <div className="cand-list">
            {candidates.map((c) => (
              <div key={c.id} className={`cand-row ${selected?.id === c.id ? 'selected' : ''}`} onClick={() => previewCandidate(c)}>
                <div className="cand-title">
                  <b>{c.name}</b>
                  <span className="tag">{GENDER_LABEL[c.params.gender] || '中性'}</span>
                </div>
                <div className="cand-desc tiny muted">{c.previewNote}</div>
                <div className="cand-kv">
                  <span>素材基频 {material?.features?.f0 > 0 ? `${Math.round(material.features.f0)}Hz` : '未检出'}</span>
                  <span>本候选等效基频 {c.features.f0 > 0 ? `${Math.round(c.features.f0)}Hz` : '—'}</span>
                  <span>音调 {c.params.pitch.toFixed(2)}×</span>
                  <span>语速 {c.params.speed.toFixed(2)}×</span>
                  <span>情感 {c.params.emotion.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </>}
      </Modal>

      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* 删除确认 */}
      <Modal open={!!confirmDel} title="🗑️ 确认删除" onClose={() => setConfirmDel(null)} width="440px"
        footer={<><button className="btn" onClick={() => setConfirmDel(null)}>取消</button><button className="btn btn-danger" onClick={confirmDelete}>确认删除</button></>}>
        <p>确定删除音色「<b>{confirmDel?.name}</b>」吗？其原声样本也会一并清理。</p>
      </Modal>
    </div>
  )
}
