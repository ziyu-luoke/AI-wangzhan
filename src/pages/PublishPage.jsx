import React, { useState } from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'
import { useUI } from '../components/UIContext.jsx'
import { deviceAdapter, delay } from '../engine/adapters.js'

export default function PublishPage() {
  useStoreState()
  const state = store.getState()
  const { toast, setMascot } = useUI()
  const [publishing, setPublishing] = useState(false)
  const [scope, setScope] = useState(state.draftBinding.scope)

  const b = state.draftBinding
  const problems = store.validateBinding(b)
  const hasChanges = JSON.stringify(state.draftBinding) !== JSON.stringify(state.publishedBinding)

  const pick = (field, value) => {
    store.updateDraftBinding({ [field]: value })
    setMascot('wink', '换好啦，记得发布哦～')
  }

  const doPublish = async () => {
    setMascot('thinking', '正在校验并发布…', 0)
    try {
      store.publish() // 产生版本事件，会话标记 pending-switch
    } catch (e) { toast(e.message, 'error'); setMascot('error', '校验没过…'); return }
    setPublishing(true)
    // 模拟设备推送 + ACK
    const binding = store.getState().publishedBinding
    const version = store.getState().currentVersion
    setMascot('cheer', '推送到设备中…', 0)
    const ack = await deviceAdapter.pushConfig(version, binding)
    setPublishing(false)
    toast(`v${version} 已发布并推送 · ${ack.note}`, 'success')
    setMascot('love', '发布成功！去对话演示看看～', 3600)
  }

  const doRollback = () => {
    try {
      store.rollback()
      toast('已回滚到上一版本，等待会话安全点切换', 'warn')
      setMascot('surprised', '回滚好啦～')
    } catch (e) { toast(e.message, 'error') }
  }

  const optionsFor = (type) => state.resources[type].filter((r) => r.enabled)
  // 发布中心展示全部资源，停用的也可见（标注并可一键启用），避免"选不了也不知道为什么"
  const allOf = (type) => state.resources[type] || []

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>🚀 发布中心</h2>
          <p>配置草稿经校验→发布→推送设备；变更产生版本事件，在会话安全点即时生效且保留会话。</p>
        </div>
        <span className="spacer" />
        <button className="btn" onClick={doRollback} disabled={state.currentVersion <= 0}>↩️ 回滚上一版</button>
        <button className="btn btn-primary" onClick={doPublish} disabled={publishing || problems.length > 0}>
          {publishing ? '⏳ 推送中…' : '🚀 发布新配置'}
        </button>
      </div>

      {/* 校验提示 */}
      {problems.length > 0 && (
        <div className="preview-panel mb" style={{ borderColor: 'var(--danger)' }}>
          <b>❌ 发布前校验未通过</b>
          <p className="tiny mt">{problems.join('；')}。请先在资源管理中启用或修正对应资源。</p>
        </div>
      )}
      {problems.length === 0 && (
        <div className="preview-panel mb" style={{ borderColor: 'var(--success)' }}>
          <b>✅ 校验通过</b>
          <p className="tiny mt">四类资源均已启用。发布后当前会话将在下一个安全点（回复播完）切换到新配置，上下文完整保留。</p>
        </div>
      )}

      {/* 生效范围 */}
      <div className="setting-block">
        <h4>🎯 生效范围</h4>
        <p>原型演示全局生效；生产环境可扩展为分组 / 单设备灰度放量。</p>
        <div className="row wrap">
          <select className="select" style={{ maxWidth: 200 }} value={scope} onChange={(e) => { setScope(e.target.value); store.updateDraftBinding({ scope: e.target.value }) }}>
            <option value="global">全局（所有设备）</option>
            <option value="group">分组</option>
            <option value="device">单设备</option>
          </select>
          <div className="field" style={{ flex: 1, minWidth: 160, margin: 0 }}>
            <label>灰度比例：{b.rolloutPercent}%</label>
            <input type="range" min="1" max="100" value={b.rolloutPercent} onChange={(e) => store.updateDraftBinding({ rolloutPercent: +e.target.value })} style={{ width: '100%' }} />
          </div>
        </div>
      </div>

      {/* 四类绑定选择 */}
      <div className="setting-block">
        <h4>🧩 当前配置绑定（草稿 v{state.currentVersion + 1}）</h4>
        <p>选择本次要生效的模型 / 形象 / 音色 / 人设。停用的资源标注「已停用」，选中后可一键启用。</p>
        {[
          ['modelId', 'model', '🧠', 'AI 模型'],
          ['avatarId', 'avatar', '🎨', '虚拟形象'],
          ['voiceId', 'voice', '🎵', '语音音色'],
          ['personaId', 'persona', '💖', 'AI 人设'],
        ].map(([field, type, emoji, label]) => {
          const chosen = state.resources[type].find((r) => r.id === b[field])
          const chosenDisabled = chosen && !chosen.enabled
          return (
            <div className="binding-row" key={field}>
              <div className="b-icon">{emoji}</div>
              <div><div className="b-label">{label}</div><div className="b-name">{chosen?.name || '未选择'}{chosenDisabled ? <span className="badge warn" style={{ marginLeft: 6 }}>已停用</span> : null}</div></div>
              <select className="select" value={b[field]} onChange={(e) => pick(field, e.target.value)}>
                {allOf(type).map((r) => <option key={r.id} value={r.id}>{r.name}{r.enabled ? '' : '（已停用）'}</option>)}
              </select>
              {chosenDisabled && (
                <button className="btn btn-sm btn-blue" onClick={() => {
                  try { store.toggleResource(type, chosen.id); toast(`「${chosen.name}」已启用，可继续发布`, 'success'); setMascot('love', '启用好啦～') }
                  catch (e) { toast(e.message, 'error') }
                }}>启用</button>
              )}
            </div>
          )
        })}
      </div>

      {/* 降级备选 */}
      <div className="setting-block">
        <h4>🛟 降级备选</h4>
        <p>主资源异常时自动切换，不中断对话。通用原则：失败时保持上一个可用状态。</p>
        <div className="row wrap">
          <div className="field" style={{ minWidth: 200, margin: 0 }}>
            <label>备用模型</label>
            <select className="select" value={b.fallbackIds?.model || ''} onChange={(e) => store.updateDraftBinding({ fallbackIds: { ...b.fallbackIds, model: e.target.value } })}>
              <option value="">— 无 —</option>
              {optionsFor('model').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ minWidth: 200, margin: 0 }}>
            <label>备用音色</label>
            <select className="select" value={b.fallbackIds?.voice || ''} onChange={(e) => store.updateDraftBinding({ fallbackIds: { ...b.fallbackIds, voice: e.target.value } })}>
              <option value="">— 无 —</option>
              {optionsFor('voice').map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* 发布历史 */}
      <div className="setting-block">
        <h4>📜 发布历史（可回滚）</h4>
        {state.publishedVersions.length === 0 ? (
          <p className="tiny muted">暂无发布记录。当前生效版本 v{state.currentVersion}。</p>
        ) : (
          <table className="table">
            <thead><tr><th>版本</th><th>发布时间</th><th>发布人</th><th>回滚至</th><th>状态</th></tr></thead>
            <tbody>
              {state.publishedVersions.map((v) => (
                <tr key={v.version}>
                  <td><b>v{v.version}</b></td>
                  <td>{v.publishedAt}</td>
                  <td>{v.publisher}</td>
                  <td>{v.rollbackTo ? `v${v.rollbackTo}` : '—'}</td>
                  <td>{v.version === state.currentVersion ? <span className="badge on">当前生效</span> : <span className="badge">历史</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 最近事件流 */}
      <div className="setting-block">
        <h4>📢 最近事件</h4>
        {state.events.slice(0, 6).map((e) => (
          <div key={e.id} className="tiny" style={{ padding: '5px 0', borderBottom: '1px dashed #eee' }}>
            <span className={`badge ${e.level === 'success' ? 'on' : e.level === 'warn' ? 'warn' : ''}`}>{e.type}</span>
            <span style={{ marginLeft: 8 }}>{e.message}</span>
            <span className="muted" style={{ float: 'right' }}>{e.timestamp}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
