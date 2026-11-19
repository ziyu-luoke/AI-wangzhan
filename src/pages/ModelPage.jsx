import React, { useState } from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'
import { useUI } from '../components/UIContext.jsx'
import ResourceCard from '../components/ResourceCard.jsx'
import Modal from '../components/Modal.jsx'
import { modelAdapter } from '../engine/adapters.js'

const PROVIDERS = ['OpenAI兼容', 'Qwen', 'DeepSeek', '自定义']
const emptyForm = () => ({
  name: '', provider: 'DeepSeek', endpoint: 'https://api.deepseek.com', apiKeyRef: 'env:DEEPSEEK_API_KEY', modelId: 'deepseek-flash',
  capabilities: { context: 8000, streaming: true, tools: false, vision: false },
  params: { temperature: 0.7, maxTokens: 1024, topP: 0.8 },
  systemPromptRef: '', enabled: true, priority: 1,
})

export default function ModelPage() {
  useStoreState()
  const state = store.getState()
  const { toast, setMascot } = useUI()
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [confirmDel, setConfirmDel] = useState(null)
  const models = state.resources.model
  const using = state.draftBinding.modelId

  const openNew = () => { setForm(emptyForm()); setEditing('new'); setTestResult(null); setMascot('happy', '新建模型，冲鸭！') }
  const openEdit = (item) => { setForm(JSON.parse(JSON.stringify(item))); setEditing(item.id); setTestResult(null) }
  const close = () => { setEditing(null); setForm(null); setTestResult(null) }

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const setCap = (k, v) => setForm((f) => ({ ...f, capabilities: { ...f.capabilities, [k]: v } }))
  const setParam = (k, v) => setForm((f) => ({ ...f, params: { ...f.params, [k]: v } }))

  const save = () => {
    if (!form.name.trim() || !form.modelId.trim()) { toast('请填写名称与模型 ID', 'error'); setMascot('error', '名称或 ID 没填哦～'); return }
    if (testResult && !testResult.ok) { toast('连通性测试未通过，请先修复后再保存', 'error'); return }
    try {
      if (editing === 'new') {
        store.createResource('model', form)
        toast(`模型「${form.name}」已创建`, 'success')
      } else {
        const cur = store.getResource('model', editing)
        store.updateResource('model', editing, form, cur.version)
        toast(`模型「${form.name}」已保存`, 'success')
      }
      setMascot('love', '搞定啦，好开心！')
      close()
    } catch (e) { toast(e.message, 'error'); setMascot('error', '哎呀，保存失败了…') }
  }

  const doTest = async () => {
    setTesting(true); setTestResult(null); setMascot('thinking', '让我连一下试试…', 0)
    const res = await modelAdapter.healthCheck(form)
    setTestResult(res); setTesting(false)
    if (res.ok) { toast(`连接正常 · 延迟 ${res.latency}ms`, 'success'); setMascot('happy', '连上啦！') }
    else { toast(res.message, 'error'); setMascot('error', '连不上呀…') }
  }

  const doToggle = (item) => { try { store.toggleResource('model', item.id) } catch (e) { toast(e.message, 'error') } }
  const doDelete = (item) => { setConfirmDel(item) }
  const confirmDelete = () => {
    try { store.deleteResource('model', confirmDel.id); toast('已删除', 'success'); setConfirmDel(null) }
    catch (e) { toast(e.message, 'error') }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>🧠 AI 模型</h2>
          <p>管理可接入的大模型，支持连通性测试、能力声明与失败自动降级。</p>
        </div>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={openNew}>➕ 新增模型</button>
      </div>

      {models.length === 0 ? (
        <div className="empty"><div className="empty-emoji">🧠</div><div className="empty-text">还没有模型，空空如也～</div></div>
      ) : (
        <div className="grid">
          {models.map((m) => (
            <ResourceCard
              key={m.id} item={m}
              avatar="🧠" avatarBg="linear-gradient(135deg,#c9b6e4,#e8deFA)"
              using={using === m.id}
              meta={[
                ['供应商', m.provider],
                ['模型 ID', m.modelId || '—'],
                ['上下文', `${(m.capabilities.context / 1000).toFixed(0)}K`],
                ['优先级', `P${m.priority}`],
              ]}
              tags={[
                m.capabilities.streaming && '流式', m.capabilities.tools && '工具调用',
                m.capabilities.vision && '视觉', m.systemPromptRef && '绑定人设',
              ].filter(Boolean)}
              onEdit={() => openEdit(m)}
              onToggle={() => doToggle(m)}
              onDelete={() => doDelete(m)}
              onExtra={() => openEdit(m)}
              extraLabel="测试"
            />
          ))}
        </div>
      )}

      {/* 编辑抽屉 */}
      <Modal open={!!editing} title={editing === 'new' ? '➕ 新增 AI 模型' : '✏️ 编辑 AI 模型'} onClose={close}
        footer={<>
          <button className="btn" onClick={close}>取消</button>
          <button className="btn btn-blue" onClick={doTest} disabled={testing}>{testing ? '⏳ 真实调用中…' : '🔌 真实调用测试'}</button>
          <button className="btn btn-primary" onClick={save}>💾 保存</button>
        </>}>
        {form && <>
          <div className="form-section">
            <h4>📝 基础信息</h4>
            <div className="field-row">
              <div className="field"><label>显示名称 *</label><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="如：通义千问 Qwen-Plus" /></div>
              <div className="field"><label>供应商类型</label><select className="select" value={form.provider} onChange={(e) => set('provider', e.target.value)}>{PROVIDERS.map((p) => <option key={p}>{p}</option>)}</select></div>
            </div>
            <div className="field"><label>API 地址 (endpoint)</label><input className="input" value={form.endpoint} onChange={(e) => set('endpoint', e.target.value)} placeholder="https://.../v1" /></div>
            <div className="field-row">
              <div className="field"><label>模型 ID *</label><input className="input" value={form.modelId} onChange={(e) => set('modelId', e.target.value)} placeholder="如：deepseek-flash" /></div>
              <div className="field"><label>密钥引用（服务端环境变量）</label><input className="input" value={form.apiKeyRef} onChange={(e) => set('apiKeyRef', e.target.value)} placeholder="env:DEEPSEEK_API_KEY" /><div className="field-hint">🔒 只填 env:变量名，真实密钥写在服务端 .env；浏览器不接触明文。DeepSeek 默认 env:DEEPSEEK_API_KEY</div></div>
            </div>
          </div>

          <div className="form-section">
            <h4>⚡ 能力声明</h4>
            <div className="field"><label>上下文长度：{(form.capabilities.context / 1000).toFixed(0)}K</label><input type="range" min="4000" max="200000" step="1000" value={form.capabilities.context} onChange={(e) => setCap('context', +e.target.value)} style={{ width: '100%' }} /></div>
            <div className="row wrap">
              {[['streaming', '支持流式'], ['tools', '工具调用'], ['vision', '视觉输入']].map(([k, label]) => (
                <label className="checkbox-row" key={k}><input type="checkbox" checked={form.capabilities[k]} onChange={(e) => setCap(k, e.target.checked)} /> {label}</label>
              ))}
            </div>
          </div>

          <div className="form-section">
            <h4>🎛️ 生成参数</h4>
            <div className="field-row">
              <div className="field"><label>temperature：{form.params.temperature}</label><input type="range" min="0" max="2" step="0.1" value={form.params.temperature} onChange={(e) => setParam('temperature', +e.target.value)} style={{ width: '100%' }} /></div>
              <div className="field"><label>maxTokens：{form.params.maxTokens}</label><input type="range" min="128" max="8192" step="128" value={form.params.maxTokens} onChange={(e) => setParam('maxTokens', +e.target.value)} style={{ width: '100%' }} /></div>
            </div>
            <div className="field"><label>关联人设（可选）</label>
              <select className="select" value={form.systemPromptRef} onChange={(e) => set('systemPromptRef', e.target.value)}>
                <option value="">— 不关联 —</option>
                {state.resources.persona.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>

          {testResult && (
            <div className={`preview-panel ${testResult.ok ? '' : ''}`} style={{ borderColor: testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
              <b>{testResult.ok ? '✅ 连通性测试通过' : '❌ 连通性测试失败'}</b>
              <p className="tiny mt">{testResult.message}{testResult.ok ? ` · 延迟 ${testResult.latency}ms` : ''}</p>
              {!testResult.ok && <p className="tiny muted mt">提示：测试失败的资源将保留为草稿，不允许启用与发布。</p>}
            </div>
          )}
        </>}
      </Modal>

      {/* 删除确认 */}
      <Modal open={!!confirmDel} title="🗑️ 确认删除" onClose={() => setConfirmDel(null)} width="440px"
        footer={<><button className="btn" onClick={() => setConfirmDel(null)}>取消</button><button className="btn btn-danger" onClick={confirmDelete}>确认删除</button></>}>
        <p>确定删除模型「<b>{confirmDel?.name}</b>」吗？此操作不可撤销。</p>
        <p className="tiny muted mt">若该模型正被使用或被其它资源引用，删除会被阻止。</p>
      </Modal>
    </div>
  )
}
