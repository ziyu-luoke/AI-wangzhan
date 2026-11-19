import React, { useState, useRef } from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'
import { useUI } from '../components/UIContext.jsx'
import ResourceCard from '../components/ResourceCard.jsx'
import Modal from '../components/Modal.jsx'
import { avatarAdapter, delay } from '../engine/adapters.js'

const STYLES = ['日系赛璐璐', 'Q版可爱', '国风仙侠', '像素风', '治愈水彩']
const emptyForm = () => ({
  name: '', avatarType: '2D虚拟形象', source: '上传生成',
  emoji: '🌸', expressions: { happy: '😄', thinking: '🤔', surprised: '😲', error: '😵', idle: '🤖' },
  generateParams: { style: '日系赛璐璐', resolution: '512x512', background: '透明' },
  enabled: true, previewUrl: '', deviceCompat: { screen: '240x320 SPI', minFirmware: '2.0.0' },
})

const STEPS = ['上传素材', '生成参数', '生成中', '选择采纳']

export default function AvatarPage() {
  useStoreState()
  const state = store.getState()
  const { toast, setMascot } = useUI()
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(null)
  const [confirmDel, setConfirmDel] = useState(null)
  const avatars = state.resources.avatar
  const using = state.draftBinding.avatarId

  // 生成流程状态
  const [genOpen, setGenOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [files, setFiles] = useState([])
  const [validation, setValidation] = useState(null)
  const [candidates, setCandidates] = useState([])
  const [selected, setSelected] = useState(null)
  const [progress, setProgress] = useState(0)
  const fileRef = useRef(null)

  const openNew = () => { setForm(emptyForm()); setEditing('new'); setMascot('happy', '来做新形象吧！') }
  const openEdit = (item) => { setForm(JSON.parse(JSON.stringify(item))); setEditing(item.id) }
  const close = () => { setEditing(null); setForm(null) }
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const setGP = (k, v) => setForm((f) => ({ ...f, generateParams: { ...f.generateParams, [k]: v } }))

  const save = () => {
    if (!form.name.trim()) { toast('请填写形象名称', 'error'); setMascot('error', '名字没填哦～'); return }
    try {
      if (editing === 'new') { store.createResource('avatar', form); toast(`形象「${form.name}」已创建`, 'success') }
      else { const cur = store.getResource('avatar', editing); store.updateResource('avatar', editing, form, cur.version); toast(`形象「${form.name}」已保存`, 'success') }
      setMascot('love', '形象保存好啦！')
      close()
    } catch (e) { toast(e.message, 'error') }
  }

  const doToggle = (item) => { try { store.toggleResource('avatar', item.id) } catch (e) { toast(e.message, 'error') } }
  const doDelete = (item) => setConfirmDel(item)
  const confirmDelete = () => {
    try { store.deleteResource('avatar', confirmDel.id); toast('已删除', 'success'); setConfirmDel(null) }
    catch (e) { toast(e.message, 'error') }
  }

  // ---- 生成流程 ----
  const openGenerate = () => {
    setGenOpen(true); setStep(0); setFiles([]); setValidation(null)
    setCandidates([]); setSelected(null); setProgress(0)
    setForm(emptyForm()); setMascot('thinking', '来上传素材吧～')
  }
  const onPickFiles = async (e) => {
    const fs = Array.from(e.target.files || [])
    if (!fs.length) return
    setFiles(fs)
    setMascot('wink', '收到素材啦！')
    const v = await avatarAdapter.validateAsset(fs)
    setValidation(v)
    if (!v.ok) { toast(v.problems[0], 'error'); setMascot('error', '素材不太行…') }
    else toast(`已上传 ${fs.length} 个素材，校验通过`, 'success')
  }
  const startGenerate = async () => {
    if (!files.length) { toast('请先上传素材', 'error'); setMascot('error', '还没传素材呢…'); return }
    if (!validation?.ok) { toast(validation?.problems?.[0] || '素材校验未通过', 'error'); setMascot('error', '素材不太行…'); return }
    setStep(2); setMascot('cheer', '加油！正在生成…', 0)
    const task = store.createGenerationTask('avatar', { name: form.name, styles: [form.generateParams.style], files: files.map((f) => f.name) })
    store.updateGenerationTask(task.id, { status: 'PROCESSING' })
    try {
      // 进度展示（生成真正在 browser canvas 中完成，进度为视觉反馈）
      for (let p = 10; p <= 90; p += 20) { await delay(180); setProgress(p) }
      const result = await avatarAdapter.generate(
        { ...form.generateParams, name: form.name || '新形象', styles: [...new Set([form.generateParams.style, STYLES[(STYLES.indexOf(form.generateParams.style) + 1) % STYLES.length]])] },
        files
      )
      if (!result?.length) throw new Error('生成服务未返回任何候选形象')
      setCandidates(result); setProgress(100)
      store.updateGenerationTask(task.id, { status: 'SUCCEEDED', progress: 100, result })
      setStep(3); setMascot('surprised', '生成好啦，挑一个吧！')
    } catch (e) {
      store.updateGenerationTask(task.id, { status: 'FAILED', error: e.message })
      setCandidates([]); setProgress(0); setStep(1)
      toast(`生成失败：${e.message}`, 'error'); setMascot('error', '生成失败啦…')
    }
  }
  const adopt = () => {
    if (!selected) { toast('请先选择一个候选形象', 'error'); return }
    const newItem = {
      ...emptyForm(),
      name: form.name || selected.name,
      emoji: selected.emoji || '🖼️',
      source: '上传生成',
      // 保存素材驱动的生成图（dataURL）；列表卡片据此显示真实形象
      previewUrl: selected.imageUrl || selected.gradient,
      generateParams: { ...form.generateParams, style: selected.style, candidates: resultIds(), fromSource: selected.fromSource || '', dominant: selected.dominant || '' },
      expressions: { happy: selected.emoji || '😊', thinking: '🤔', surprised: '😲', error: '😵', idle: selected.emoji || '🖼️' },
      enabled: true,
    }
    store.createResource('avatar', newItem)
    toast(`形象「${newItem.name}」已采纳并创建`, 'success')
    setMascot('love', '采用啦，真好看！')
    const task = state.generationTasks[0]
    if (task) store.updateGenerationTask(task.id, { status: 'ADOPTED' })
    setGenOpen(false)
  }
  const resultIds = () => candidates.map((c) => c.id)

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>🎨 虚拟形象</h2>
          <p>管理机器人形象，支持网页上传素材并实时生成形象；设备端以表情包适配 SPI 屏。</p>
        </div>
        <span className="spacer" />
        <button className="btn btn-blue" onClick={openGenerate}>✨ 上传素材生成</button>
        <button className="btn btn-primary" onClick={openNew}>➕ 新增形象</button>
      </div>

      {avatars.length === 0 ? (
        <div className="empty"><div className="empty-emoji">🎨</div><div className="empty-text">还没有形象，空空如也～</div></div>
      ) : (
        <div className="grid">
          {avatars.map((a) => (
            <ResourceCard
              key={a.id} item={a}
              avatar={a.emoji || '🌸'}
              avatarBg={a.previewUrl && a.previewUrl.startsWith('linear') ? a.previewUrl : 'linear-gradient(135deg,#a8d8ea,#d6f0fa)'}
              avatarImage={a.previewUrl && a.previewUrl.startsWith('data:image') ? a.previewUrl : null}
              using={using === a.id}
              meta={[
                ['类型', a.avatarType],
                ['来源', a.source],
                ['屏幕', a.deviceCompat?.screen || '—'],
              ]}
              tags={a.source === '上传生成' ? ['AI 生成'] : [a.avatarType]}
              onEdit={() => openEdit(a)} onToggle={() => doToggle(a)} onDelete={() => doDelete(a)}
            />
          ))}
        </div>
      )}

      {/* 编辑抽屉 */}
      <Modal open={!!editing && !genOpen} title={editing === 'new' ? '➕ 新增形象' : '✏️ 编辑形象'} onClose={close}
        footer={<><button className="btn" onClick={close}>取消</button><button className="btn btn-primary" onClick={save}>💾 保存</button></>}>
        {form && <>
          <div className="form-section">
            <h4>📝 基础信息</h4>
            <div className="field-row">
              <div className="field"><label>形象名称 *</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如：樱花酱" /></div>
              <div className="field"><label>形象类型</label><select className="select" value={form.avatarType} onChange={(e) => set('avatarType', e.target.value)}><option>表情包</option><option>静态头像</option><option>2D虚拟形象</option></select></div>
            </div>
            <div className="field"><label>代表 Emoji</label><input className="input" value={form.emoji} onChange={(e) => set('emoji', e.target.value)} placeholder="🌸" /></div>
          </div>
          <div className="form-section">
            <h4>😊 表情映射</h4>
            <div className="field-row">
              {Object.entries(form.expressions || {}).map(([k, v]) => (
                <div className="field" key={k}><label>{({ happy: '开心', thinking: '思考', surprised: '惊讶', error: '报错', idle: '待机' })[k] || k}</label><input className="input" value={v} onChange={(e) => set('expressions', { ...form.expressions, [k]: e.target.value })} /></div>
              ))}
            </div>
            <p className="tiny muted">设备端 SPI 屏通过 MCP 工具（self.screen.set_theme 等）切换主题与表情。</p>
          </div>
        </>}
      </Modal>

      {/* 生成流程抽屉 */}
      <Modal open={genOpen} title="✨ 上传素材生成形象" onClose={() => setGenOpen(false)} width="680px"
        footer={<>
          <button className="btn" onClick={() => setGenOpen(false)}>关闭</button>
          {step === 1 && <button className="btn btn-blue" onClick={startGenerate}>🚀 开始生成</button>}
          {step === 3 && <button className="btn btn-primary" onClick={adopt}>✅ 采纳并创建</button>}
        </>}>
        {/* 步骤条 */}
        <div className="row" style={{ marginBottom: 18 }}>
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              <div className={`badge ${i === step ? 'active' : i < step ? 'on' : 'off'}`}>{i < step ? '✓' : i + 1}. {s}</div>
              {i < STEPS.length - 1 && <span className="muted">—</span>}
            </React.Fragment>
          ))}
        </div>

        {step === 0 && <>
          <div className="form-section">
            <h4>📁 上传图片素材</h4>
            <div className="gen-drop" onClick={() => fileRef.current?.click()}>
              <div className="gd-emoji">🖼️</div>
              <div className="gd-text">点击选择图片（可多张）</div>
              <div className="gd-hint">支持 PNG / JPG / WebP，单张 ≤ 5MB</div>
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
            {files.length > 0 && <div className="mt">{files.map((f, i) => <span className="tag" key={i}>🖼️ {f.name}</span>)}</div>}
            {validation && validation.ok && <p className="tiny mt" style={{ color: 'var(--success)' }}>✅ 素材校验通过</p>}
          </div>
          <div className="checkbox-row">
            <input type="checkbox" id="auth-avatar" defaultChecked />
            <label htmlFor="auth-avatar">我确认拥有所上传素材的合法使用权，不上传未经授权的他人肖像。</label>
          </div>
          <div className="row mt"><button className="btn btn-mint" onClick={() => { if (!files.length) { toast('请先上传素材', 'error'); return } setStep(1) }}>下一步：设置参数 →</button></div>
        </>}

        {step === 1 && <>
          <div className="form-section">
            <h4>🎛️ 生成参数</h4>
            <div className="field"><label>形象名称</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如：樱花酱" /></div>
            <div className="field"><label>生成风格</label><select className="select" value={form.generateParams.style} onChange={(e) => setGP('style', e.target.value)}>{STYLES.map((s) => <option key={s}>{s}</option>)}</select></div>
            <div className="field-row">
              <div className="field"><label>分辨率</label><select className="select" value={form.generateParams.resolution} onChange={(e) => setGP('resolution', e.target.value)}><option>256x256</option><option>512x512</option><option>1024x1024</option></select></div>
              <div className="field"><label>背景</label><select className="select" value={form.generateParams.background} onChange={(e) => setGP('background', e.target.value)}><option>透明</option><option>纯色</option><option>渐变</option></select></div>
            </div>
          </div>
          <p className="tiny muted">生成会读取你上传的素材：提取主色调并做 Q 版风格化处理，不同素材得到不同候选。真实图生图服务接入后接口不变。</p>
        </>}

        {step === 2 && <>
          <div className="preview-panel" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 52 }} className="spin">🎨</div>
            <p className="mt" style={{ fontFamily: 'var(--font-round)' }}>小智正在努力生成中… 加油！</p>
            <div className="progress-track mt"><div className="progress-fill" style={{ width: `${progress}%` }}>{progress}%</div></div>
          </div>
        </>}

        {step === 3 && <>
          <p className="tiny muted mb">以下候选由你上传的「{candidates[0]?.fromSource || '素材'}」生成，保留素材外观特征，选择一张采纳。</p>
          <div className="candidates">
            {candidates.map((c) => (
              <div key={c.id} className={`candidate ${selected?.id === c.id ? 'selected' : ''}`} onClick={() => { setSelected(c); setMascot('wink', '眼光不错嘛～') }}>
                <div className="candidate-art" style={{ background: c.gradient }}>
                  {c.imageUrl
                    ? <img src={c.imageUrl} alt={c.style} className="candidate-img" />
                    : <span>{c.emoji || '🖼️'}</span>}
                </div>
                <div className="candidate-name">{c.style}</div>
              </div>
            ))}
          </div>
          <p className="tiny muted mt">采纳后写入形象资源，可在列表中启用并发布。原型阶段为素材风格化处理（提取主色调 + Q 版化滤镜），接入图生图服务后可升级为 AI 重绘。</p>
        </>}
      </Modal>

      {/* 删除确认 */}
      <Modal open={!!confirmDel} title="🗑️ 确认删除" onClose={() => setConfirmDel(null)} width="440px"
        footer={<><button className="btn" onClick={() => setConfirmDel(null)}>取消</button><button className="btn btn-danger" onClick={confirmDelete}>确认删除</button></>}>
        <p>确定删除形象「<b>{confirmDel?.name}</b>」吗？</p>
      </Modal>
    </div>
  )
}
