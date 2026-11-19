import React, { useState } from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'
import { useUI } from '../components/UIContext.jsx'
import ResourceCard from '../components/ResourceCard.jsx'
import Modal from '../components/Modal.jsx'
import { personaReply } from '../engine/personaHelper.js'

const TONES = ['温柔', '活泼', '专业', '严谨', '幽默', '治愈', '元气', '二次元']
const emptyForm = () => ({
  name: '', content: '', variables: [], toneTags: [],
  greeting: '', fallbackReply: '', enabled: true,
})

export default function PersonaPage() {
  useStoreState()
  const state = store.getState()
  const { toast, setMascot } = useUI()
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(null)
  const [preview, setPreview] = useState(null)
  const [confirmDel, setConfirmDel] = useState(null)
  const personas = state.resources.persona
  const using = state.draftBinding.personaId

  const openNew = () => { setForm(emptyForm()); setEditing('new'); setPreview(null); setMascot('happy', '来创作新人设吧～') }
  const openEdit = (item) => { setForm(JSON.parse(JSON.stringify(item))); setEditing(item.id); setPreview(null) }
  const close = () => { setEditing(null); setForm(null); setPreview(null) }
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

  const toggleTone = (t) => setForm((f) => ({ ...f, toneTags: f.toneTags.includes(t) ? f.toneTags.filter((x) => x !== t) : [...f.toneTags, t] }))

  const detectVars = () => {
    const found = [...new Set((form.content.match(/\{[a-zA-Z_]+\}/g) || []))]
    set('variables', found)
    toast(found.length ? `识别到 ${found.length} 个变量` : '未发现变量', found.length ? 'success' : 'info')
  }

  const renderPreview = () => {
    const sample = { content: '今天天气真好呀！' }
    const reply = personaReply(form, [{ role: 'user', content: sample.content }])
    setPreview(reply)
    setMascot('thinking', '嗯，让我按这个人设说一句…')
  }

  const save = () => {
    if (!form.name.trim() || !form.content.trim()) { toast('请填写人设名称与内容', 'error'); setMascot('error', '内容还没写呢～'); return }
    try {
      if (editing === 'new') { store.createResource('persona', form); toast(`人设「${form.name}」已创建`, 'success') }
      else { const cur = store.getResource('persona', editing); store.updateResource('persona', editing, form, cur.version); toast(`人设「${form.name}」已保存`, 'success') }
      setMascot('love', '人设完成，好有感觉！')
      close()
    } catch (e) { toast(e.message, 'error'); setMascot('error', '保存失败…') }
  }

  const doToggle = (item) => { try { store.toggleResource('persona', item.id) } catch (e) { toast(e.message, 'error') } }
  const doDelete = (item) => setConfirmDel(item)
  const confirmDelete = () => {
    try { store.deleteResource('persona', confirmDel.id); toast('已删除', 'success'); setConfirmDel(null) }
    catch (e) { toast(e.message, 'error') }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>💖 AI 人设</h2>
          <p>自定义人设内容、变量插值与语气风格，让机器人拥有独特性格。</p>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={openNew}>➕ 新增人设</button>
      </div>

      {personas.length === 0 ? (
        <div className="empty"><div className="empty-emoji">💖</div><div className="empty-text">还没有人设，空空如也～</div></div>
      ) : (
        <div className="grid">
          {personas.map((p) => (
            <ResourceCard
              key={p.id} item={p}
              avatar="💖" avatarBg="linear-gradient(135deg,#ffb7c5,#ffd9e8)"
              using={using === p.id}
              meta={[
                ['语气', p.toneTags.join('、') || '—'],
                ['变量', `${p.variables.length} 个`],
                ['问候语', p.greeting || '—'],
              ]}
              tags={p.variables.slice(0, 4)}
              onEdit={() => openEdit(p)} onToggle={() => doToggle(p)} onDelete={() => doDelete(p)}
            />
          ))}
        </div>
      )}

      <Modal open={!!editing} title={editing === 'new' ? '➕ 新增 AI 人设' : '✏️ 编辑 AI 人设'} onClose={close}
        footer={<>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-purple" onClick={renderPreview}>👀 预览对话</button>
          <button className="btn btn-primary" onClick={save}>💾 保存</button>
        </>}>
        {form && <>
          <div className="form-section">
            <h4>📝 基础信息</h4>
            <div className="field"><label>人设名称 *</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如：贴心小助手" /></div>
            <div className="field">
              <label>语气标签</label>
              <div className="row wrap">{TONES.map((t) => <button key={t} className={`tag ${form.toneTags.includes(t) ? '' : ''}`} style={{ cursor: 'pointer', background: form.toneTags.includes(t) ? 'var(--pink)' : '#f0eafa', borderWidth: '2px' }} onClick={() => toggleTone(t)}>{form.toneTags.includes(t) ? '✓ ' : ''}{t}</button>)}</div>
            </div>
          </div>

          <div className="form-section">
            <h4>📜 人设内容</h4>
            <div className="field">
              <textarea className="textarea" value={form.content} onChange={(e) => set('content', e.target.value)} placeholder={'描述机器人的性格、身份、说话风格…\n支持变量，如 {user_name}、{device_name}'} style={{ minHeight: 140 }} />
              <div className="row mt">
                <button className="btn btn-sm btn-mint" onClick={detectVars}>🔍 识别变量</button>
                <span className="tiny muted">支持 &#123;变量名&#125; 插值，运行时自动替换</span>
              </div>
            </div>
            {form.variables.length > 0 && <div className="field"><label>识别到的变量</label><div>{form.variables.map((v) => <span className="tag" key={v}>{v}</span>)}</div></div>}
          </div>

          <div className="form-section">
            <h4>💬 对话文案</h4>
            <div className="field"><label>首次唤醒问候语</label><input className="input" value={form.greeting} onChange={(e) => set('greeting', e.target.value)} placeholder="嗨～我是小智！" /></div>
            <div className="field"><label>异常兜底回复</label><input className="input" value={form.fallbackReply} onChange={(e) => set('fallbackReply', e.target.value)} placeholder="呜…再说一遍好吗？" /></div>
          </div>

          {preview && (
            <div className="preview-panel">
              <b className="tiny">👀 对话预览（示例输入："今天天气真好呀！"）</b>
              <div className="chat-bubble user">今天天气真好呀！</div>
              <div className="chat-bubble bot">{preview}</div>
              <p className="tiny muted mt">人设变更将在下一轮次与模型同步生效，历史消息保留但不重写。</p>
            </div>
          )}
        </>}
      </Modal>

      <Modal open={!!confirmDel} title="🗑️ 确认删除" onClose={() => setConfirmDel(null)} width="440px"
        footer={<><button className="btn" onClick={() => setConfirmDel(null)}>取消</button><button className="btn btn-danger" onClick={confirmDelete}>确认删除</button></>}>
        <p>确定删除人设「<b>{confirmDel?.name}</b>」吗？</p>
      </Modal>
    </div>
  )
}
