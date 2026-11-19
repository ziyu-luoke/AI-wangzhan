import React, { useState, useRef } from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'
import { useUI } from '../components/UIContext.jsx'
import ResourceCard from '../components/ResourceCard.jsx'
import Modal from '../components/Modal.jsx'
import AvatarFace from '../components/AvatarFace.jsx'
import { avatarAdapter, delay } from '../engine/adapters.js'
import {
  EXPRESSION_KEYS, EXPRESSION_LABELS, expressionKey, normalizeExpressionImage,
  saveAvatarExpressions, loadAvatarExpressionUrls, putAvatarExpression,
  deleteAvatarExpressions, revokeExpressionUrl,
} from '../engine/avatarAssets.js'

const emptyForm = () => ({
  name: '', avatarType: '2D虚拟形象', source: '上传图集',
  emoji: '🤖',
  expressions: { happy: '😄', thinking: '🤔', surprised: '😲', angry: '😠', idle: '🤖' },
  expressionImages: {},
  generateParams: {},
  enabled: true, previewUrl: '', deviceCompat: { screen: '240x320 SPI', minFirmware: '2.0.0' },
})

// 生成流程：上传素材 → 标注表情并规范到 240x240 → 创建
const STEPS = ['上传素材', '标注表情', '创建完成']

export default function AvatarPage() {
  useStoreState()
  const state = store.getState()
  const { toast, setMascot } = useUI()
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(null)
  const [confirmDel, setConfirmDel] = useState(null)
  // 编辑态的表情图：editPreviews=当前已存图 url，editPending=待替换的新图 blob，editRemoved=待清空的图
  const [editPreviews, setEditPreviews] = useState({})
  const [editPending, setEditPending] = useState({})
  const [editRemoved, setEditRemoved] = useState([])
  const [editBusy, setEditBusy] = useState(false)
  const editFileRefs = useRef({})
  const avatars = state.resources.avatar
  const using = state.draftBinding.avatarId

  // 生成流程状态
  const [genOpen, setGenOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [assets, setAssets] = useState([])   // [{ fid, file, previewUrl, width, height, bytes, tag }]
  const [authorized, setAuthorized] = useState(true)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)

  const resetEditImages = () => { setEditPreviews({}); setEditPending({}); setEditRemoved([]); setEditBusy(false) }
  const openNew = () => { resetEditImages(); setForm(emptyForm()); setEditing('new'); setMascot('happy', '来做新形象吧！') }
  const openEdit = async (item) => {
    resetEditImages()
    setForm(JSON.parse(JSON.stringify(item))); setEditing(item.id)
    // 异步加载已存的表情图，做成可预览的 objectURL（缺图则留空，界面显示 emoji 兜底）
    try { setEditPreviews(await loadAvatarExpressionUrls(item.expressionImages || {})) }
    catch { setEditPreviews({}) }
  }
  const close = () => { setEditing(null); setForm(null); resetEditImages() }
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  // 编辑态：为某类表情挑选替换图（统一 240×240，不拉伸不裁切）
  const onEditPick = async (expr, e) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    try {
      const norm = await normalizeExpressionImage(f)
      setEditPending((p) => ({ ...p, [expr]: { blob: norm.blob, previewUrl: norm.previewUrl } }))
      setEditRemoved((prev) => prev.filter((k) => k !== expr))
      toast(`${EXPRESSION_LABELS[expr]}图片已就绪，保存后生效`, 'success')
    } catch (err) { toast(err.message, 'error') }
  }

  // 编辑态：移除某类表情图（保存后该类回退到 emoji 兜底）
  const onEditRemove = (expr) => {
    setEditPending((p) => { const n = { ...p }; delete n[expr]; return n })
    setEditRemoved((prev) => prev.includes(expr) ? prev : [...prev, expr])
  }

  const save = async () => {
    if (!form.name.trim()) { toast('请填写形象名称', 'error'); setMascot('error', '名字没填哦～'); return }
    try {
      if (editing === 'new') {
        store.createResource('avatar', form); toast(`形象「${form.name}」已创建`, 'success')
      } else {
        setEditBusy(true); setMascot('thinking', '正在保存表情图…')
        const cur = store.getResource('avatar', editing)
        const nextImages = { ...(form.expressionImages || {}) }
        // ① 替换/新增：用带版本的新 key 写入，避免旧 objectURL 缓存导致头像不刷新
        for (const expr of Object.keys(editPending)) {
          const { blob } = editPending[expr]
          const oldKey = nextImages[expr]
          const newKey = `${expressionKey(editing, expr)}-v${Date.now().toString(36)}`
          await putAvatarExpression(newKey, blob)
          if (oldKey) { revokeExpressionUrl(oldKey); await deleteAvatarExpressions({ [expr]: oldKey }) }
          nextImages[expr] = newKey
        }
        // ② 移除：清掉图片库记录与引用，对话侧自动回退 emoji
        for (const expr of editRemoved) {
          const oldKey = nextImages[expr]
          if (oldKey) { revokeExpressionUrl(oldKey); await deleteAvatarExpressions({ [expr]: oldKey }) }
          delete nextImages[expr]
        }
        store.updateResource('avatar', editing, { ...form, expressionImages: nextImages }, cur.version)
        const changed = Object.keys(editPending).length + editRemoved.length
        toast(changed ? `形象「${form.name}」已保存（更新 ${changed} 类表情图）` : `形象「${form.name}」已保存`, 'success')
      }
      setMascot('love', '形象保存好啦！')
      close()
    } catch (e) { toast(e.message, 'error'); setMascot('error', '保存失败啦…') }
    finally { setEditBusy(false) }
  }

  const doToggle = (item) => { try { store.toggleResource('avatar', item.id) } catch (e) { toast(e.message, 'error') } }
  const doDelete = (item) => setConfirmDel(item)
  const confirmDelete = () => {
    try { store.deleteResource('avatar', confirmDel.id); toast('已删除', 'success'); setConfirmDel(null) }
    catch (e) { toast(e.message, 'error') }
  }

  // ---- 图集生成流程 ----
  const openGenerate = () => {
    setGenOpen(true); setStep(0); setAssets([]); setAuthorized(true); setBusy(false)
    setMascot('thinking', '来上传 5 张表情图吧～')
  }

  const onPickFiles = async (e) => {
    const fs = Array.from(e.target.files || [])
    e.target.value = ''
    if (!fs.length) return
    const v = await avatarAdapter.validateAsset(fs)
    if (!v.ok) { toast(v.problems[0], 'error'); setMascot('error', '素材不太行…'); return }
    setBusy(true); setMascot('wink', '收到素材，正在规范尺寸…')
    const picked = []
    const problems = []
    for (const file of fs) {
      try {
        // 强制统一到 240x240：等比 contain + 透明留白，不拉伸不裁切，画面内容不损坏
        const norm = await normalizeExpressionImage(file)
        picked.push({
          fid: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          file, previewUrl: norm.previewUrl, blob: norm.blob,
          width: norm.width, height: norm.height, bytes: norm.bytes, tag: '',
        })
      } catch (err) {
        problems.push(`${file.name}：${err.message}`)
      }
    }
    setAssets((prev) => [...prev, ...picked])
    setBusy(false)
    if (problems.length) toast(problems[0], 'error')
    if (picked.length) {
      toast(`已添加 ${picked.length} 张图，统一为 240×240`, 'success')
      setMascot('cheer', '尺寸统一好啦！')
    }
  }

  const setTag = (fid, tag) => {
    setAssets((prev) => prev.map((a) => {
      if (a.fid === fid) return { ...a, tag }
      // 一类表情只保留一张：其它图若占用了同一标签，则清空
      if (tag && a.tag === tag) return { ...a, tag: '' }
      return a
    }))
  }

  const removeAsset = (fid) => setAssets((prev) => prev.filter((a) => a.fid !== fid))

  const tagged = assets.filter((a) => a.tag)
  const missing = EXPRESSION_KEYS.filter((k) => !tagged.some((a) => a.tag === k))

  const goLabel = () => {
    if (!assets.length) { toast('请先上传图片素材', 'error'); return }
    setStep(1); setMascot('thinking', '给每张图选个表情吧～')
  }

  const createAvatar = async () => {
    const name = (form?.name || '').trim()
    if (!name) { toast('请填写形象名称', 'error'); return }
    if (!tagged.length) { toast('请至少为一张图标注表情', 'error'); return }
    if (!authorized) { toast('请先确认素材授权', 'error'); return }
    setBusy(true); setMascot('cheer', '正在保存形象…')
    try {
      const id = store.uid('avatar')
      const images = {}
      for (const a of tagged) images[a.tag] = a.blob
      const refs = await saveAvatarExpressions(id, images)
      const emojiFallback = {}
      for (const k of EXPRESSION_KEYS) emojiFallback[k] = (emptyForm().expressions[k])
      const item = {
        ...emptyForm(),
        id,
        name,
        expressionImages: refs,
        expressions: emojiFallback,
        source: '上传图集',
        generateParams: { mode: 'manual-tag', size: '240x240', tagged: tagged.map((a) => a.tag) },
      }
      store.createResource('avatar', item)
      toast(`形象「${name}」已创建（${Object.keys(refs).length}/5 类表情）`, 'success')
      setMascot('love', '新形象做好啦！')
      setStep(2)
    } catch (e) {
      toast(`创建失败：${e.message}`, 'error'); setMascot('error', '创建失败啦…')
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>🎨 虚拟形象</h2>
          <p>上传一组表情图片创建形象，统一规范为 240×240；在对话演示中按语气自动切换，设备端可通过 assets.bin 烧录同一组图。</p>
        </div>
        <span className="spacer" />
        <button className="btn btn-blue" onClick={openGenerate}>🖼️ 上传表情图集新建</button>
        <button className="btn btn-primary" onClick={openNew}>➕ 手动新增</button>
      </div>

      {avatars.length === 0 ? (
        <div className="empty"><div className="empty-emoji">🎨</div><div className="empty-text">还没有形象，空空如也～</div></div>
      ) : (
        <div className="grid">
          {avatars.map((a) => (
            <ResourceCard
              key={a.id} item={a}
              avatar={<AvatarFace avatar={a} mood="idle" />}
              using={using === a.id}
              meta={[
                ['类型', a.avatarType],
                ['来源', a.source],
                ['表情图', `${Object.keys(a.expressionImages || {}).length}/5 类`],
              ]}
              tags={Object.keys(a.expressionImages || {}).length ? ['表情图集'] : [a.avatarType]}
              onEdit={() => openEdit(a)} onToggle={() => doToggle(a)} onDelete={() => doDelete(a)}
            />
          ))}
        </div>
      )}

      {/* 手动新增/编辑抽屉（保留 emoji 方式，兼容老形象） */}
      <Modal open={!!editing && !genOpen} title={editing === 'new' ? '➕ 手动新增形象' : '✏️ 编辑形象'} onClose={close}
        footer={<><button className="btn" onClick={close}>取消</button><button className="btn btn-primary" onClick={save} disabled={editBusy}>💾 {editBusy ? '保存中…' : '保存'}</button></>}>
        {form && <>
          <div className="form-section">
            <h4>📝 基础信息</h4>
            <div className="field-row">
              <div className="field"><label>形象名称 *</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如：诗歌剧" /></div>
              <div className="field"><label>形象类型</label><select className="select" value={form.avatarType} onChange={(e) => set('avatarType', e.target.value)}><option>表情包</option><option>静态头像</option><option>2D虚拟形象</option></select></div>
            </div>
            <div className="field"><label>代表 Emoji</label><input className="input" value={form.emoji} onChange={(e) => set('emoji', e.target.value)} placeholder="🤖" /></div>
          </div>
          <div className="form-section">
            <h4>😊 五类表情图（可逐张替换 / 移除）</h4>
            <p className="tiny muted">每类一张，替换时自动等比缩放到 240×240（不拉伸、不裁切）。移除后该类在对话中回退到下方 emoji 兜底。</p>
            <div className="expr-edit-list">
              {EXPRESSION_KEYS.map((k) => {
                const previewUrl = editPending[k]?.previewUrl || (!editRemoved.includes(k) ? editPreviews[k] : null)
                const hasImage = !!(editPending[k] || (!editRemoved.includes(k) && form.expressionImages?.[k]))
                return (
                  <div className="expr-edit-row" key={k}>
                    <div className="expr-edit-thumb">
                      {previewUrl ? <img src={previewUrl} alt={EXPRESSION_LABELS[k]} /> : <span>{form.expressions?.[k] || '🤖'}</span>}
                    </div>
                    <div className="expr-edit-main">
                      <div className="expr-edit-line">
                        <b>{EXPRESSION_LABELS[k]}</b>
                        <span className="tag">{hasImage ? '有图' : '缺图 → emoji'}</span>
                        {editPending[k] && <span className="tag tag-on">待保存</span>}
                        {editRemoved.includes(k) && <span className="tag">待移除</span>}
                      </div>
                      <div className="expr-edit-line">
                        <button className="btn btn-sm btn-blue" onClick={() => editFileRefs.current[k]?.click()}>🔄 替换图片</button>
                        {hasImage && <button className="btn btn-sm btn-ghost" onClick={() => onEditRemove(k)}>🗑️ 移除图片</button>}
                        <input ref={(el) => { editFileRefs.current[k] = el }} type="file" accept="image/*" hidden onChange={(e) => onEditPick(k, e)} />
                      </div>
                      <div className="expr-edit-line">
                        <label>兜底 emoji</label>
                        <input className="input" value={form.expressions?.[k] || ''} onChange={(e) => set('expressions', { ...form.expressions, [k]: e.target.value })} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>}
      </Modal>

      {/* 图集生成流程抽屉 */}
      <Modal open={genOpen} title="🖼️ 上传表情图集新建形象" onClose={() => setGenOpen(false)} width="720px"
        footer={<>
          <button className="btn" onClick={() => setGenOpen(false)}>关闭</button>
          {step === 0 && <button className="btn btn-blue" onClick={goLabel} disabled={busy || !assets.length}>下一步：标注表情 →</button>}
          {step === 1 && <><button className="btn" onClick={() => setStep(0)}>← 上一步</button><button className="btn btn-primary" onClick={createAvatar} disabled={busy}>✅ 创建形象</button></>}
        </>}>
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
            <h4>📁 上传图片素材（可多张）</h4>
            <div className="gen-drop" onClick={() => fileRef.current?.click()}>
              <div className="gd-emoji">🖼️</div>
              <div className="gd-text">点击选择图片（PNG / JPG / WebP，单张 ≤ 5MB）</div>
              <div className="gd-hint">每张会自动等比缩放到 240×240 并居中留白，不拉伸、不裁切</div>
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
            {busy && <p className="tiny muted mt">正在处理图片…</p>}
            {assets.length > 0 && (
              <div className="expr-grid mt">
                {assets.map((a) => (
                  <div className="expr-tile" key={a.fid}>
                    <img src={a.previewUrl} alt="素材" className="expr-tile-img" />
                    <div className="expr-tile-meta">{a.width}×{a.height} · {(a.bytes / 1024).toFixed(0)}KB</div>
                    <button className="btn btn-sm btn-ghost" onClick={() => removeAsset(a.fid)}>移除</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="checkbox-row">
            <input type="checkbox" id="auth-avatar-group" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
            <label htmlFor="auth-avatar-group">我确认拥有所上传素材的合法使用权，不上传未经授权的他人肖像。</label>
          </div>
        </>}

        {step === 1 && <>
          <div className="form-section">
            <h4>📝 形象名称</h4>
            <div className="field"><input className="input" value={form?.name || ''} onChange={(e) => setForm((f) => ({ ...(f || emptyForm()), name: e.target.value }))} placeholder="如：诗歌剧" /></div>
          </div>
          <div className="form-section">
            <h4>😊 为每张图标注表情（一类一张）</h4>
            <p className="tiny muted">下拉选择该图对应的表情；同一表情只会保留一张。未标注的表情在对话中用内置 emoji 顶替。</p>
            <div className="expr-tag-grid">
              {assets.map((a) => (
                <div className="expr-tag-row" key={a.fid}>
                  <img src={a.previewUrl} alt="素材" className="expr-tag-img" />
                  <select className="select" value={a.tag} onChange={(e) => setTag(a.fid, e.target.value)}>
                    <option value="">— 未标注（不采用） —</option>
                    {EXPRESSION_KEYS.map((k) => <option key={k} value={k}>{EXPRESSION_LABELS[k]}（{k}）</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="mt">
              {EXPRESSION_KEYS.map((k) => {
                const ok = tagged.some((a) => a.tag === k)
                return <span className={`tag ${ok ? 'tag-on' : ''}`} key={k} style={{ marginRight: 6 }}>{EXPRESSION_LABELS[k]}：{ok ? '✓ 有图' : '缺图→emoji'}</span>
              })}
            </div>
          </div>
        </>}

        {step === 2 && <>
          <div className="preview-panel" style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 40 }}>🎉</div>
            <p className="mt">形象已创建。请到「发布中心」手动绑定并发布，对话演示就会使用它。</p>
            <p className="tiny muted">提示：首次打开对话时图片从本地图片库加载，可能需要一瞬。</p>
          </div>
        </>}
      </Modal>

      {/* 删除确认 */}
      <Modal open={!!confirmDel} title="🗑️ 确认删除" onClose={() => setConfirmDel(null)} width="440px"
        footer={<><button className="btn" onClick={() => setConfirmDel(null)}>取消</button><button className="btn btn-danger" onClick={confirmDelete}>确认删除</button></>}>
        <p>确定删除形象「<b>{confirmDel?.name}</b>」吗？其表情图片也会一并清理。</p>
      </Modal>
    </div>
  )
}
