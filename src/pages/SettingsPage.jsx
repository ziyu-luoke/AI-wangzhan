import React, { useState } from 'react'
import { store } from '../store/store.js'
import { useStoreState } from '../store/useStore.js'
import { useUI } from '../components/UIContext.jsx'
import Modal from '../components/Modal.jsx'

const ROLES = [
  ['所有者', '全部权限，含密钥管理与回滚', '✓'],
  ['管理员', '配置编辑与发布，不可管理密钥', '✓'],
  ['操作员', '编辑草稿、预览试听，不可发布', '✓'],
  ['只读', '查看配置与状态', '✓'],
]

export default function SettingsPage() {
  useStoreState()
  const state = store.getState()
  const { toast, setMascot } = useUI()
  const [confirmReset, setConfirmReset] = useState(false)

  const doReset = () => {
    store.resetAll()
    setConfirmReset(false)
    toast('已恢复初始演示数据', 'success')
    setMascot('surprised', '一切重新开始啦！')
  }

  const exportConfig = () => {
    const data = JSON.stringify({
      currentVersion: state.currentVersion,
      publishedBinding: state.publishedBinding,
      resources: state.resources,
      exportedAt: new Date().toISOString(),
    }, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'xiaozhi-config-export.json'; a.click()
    URL.revokeObjectURL(url)
    toast('配置已导出（密钥引用不含明文）', 'success')
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>⚙️ 系统设置</h2>
          <p>审计日志、权限说明、设备适配器参数与数据管理。</p>
        </div>
      </div>

      {/* 设备适配器（真机参数） */}
      <div className="setting-block">
        <h4>📡 设备适配器（当前：模拟设备）</h4>
        <p>原型使用模拟设备演示配置推送与 ACK。真机联调时替换适配器实现即可，参数来自真机实测（见方案附录 A）。</p>
        <table className="table">
          <tbody>
            <tr><td>设备板型</td><td><b>bread-compact-wifi-lcd</b>（面包板 WiFi+LCD）</td></tr>
            <tr><td>固件版本</td><td>2.0.2（ESP-IDF v5.4.2）</td></tr>
            <tr><td>MQTT 服务端</td><td>api.tenclass.net:8883（TLS）</td></tr>
            <tr><td>OTA 接口</td><td>https://api.tenclass.net/xiaozhi/ota/</td></tr>
            <tr><td>传输模式</td><td>MQTT 控制面 + UDP 音频面（hello v3，AES-CTR）</td></tr>
            <tr><td>MCP 版本</td><td>2024-11-05（旧版）</td></tr>
            <tr><td>适配器模式</td><td><span className="badge on">mock</span> 待接入真机</td></tr>
          </tbody>
        </table>
      </div>

      {/* 权限 */}
      <div className="setting-block">
        <h4>🔐 角色权限（原型默认四角色）</h4>
        <p>配置发布需管理员以上；密钥只写不回显；所有操作写审计日志。</p>
        <table className="table">
          <thead><tr><th>角色</th><th>权限</th><th>当前</th></tr></thead>
          <tbody>{ROLES.map(([r, d, c]) => <tr key={r}><td><b>{r}</b></td><td>{d}</td><td>{c === '✓' ? <span className="badge on">当前会话</span> : '—'}</td></tr>)}</tbody>
        </table>
      </div>

      {/* 审计日志 */}
      <div className="setting-block">
        <h4>📜 审计日志（只追加）</h4>
        <p>记录谁在何时改了哪个字段、从哪个版本到哪个版本，可追溯与回滚。</p>
        <div style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="table">
            <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>版本</th><th>详情</th></tr></thead>
            <tbody>
              {state.auditLogs.map((a) => (
                <tr key={a.id}>
                  <td className="tiny">{a.timestamp}</td>
                  <td className="tiny">{a.actor}</td>
                  <td><span className="badge">{a.action}</span></td>
                  <td className="tiny">{a.target}</td>
                  <td className="tiny">{a.fromVersion}→{a.toVersion}</td>
                  <td className="tiny muted">{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 数据管理 */}
      <div className="setting-block">
        <h4>💾 数据管理</h4>
        <p>原型数据保存在浏览器 localStorage。导出不包含密钥明文，仅含引用。</p>
        <div className="row wrap">
          <button className="btn btn-blue" onClick={exportConfig}>📤 导出配置</button>
          <button className="btn btn-danger" onClick={() => setConfirmReset(true)}>♻️ 恢复初始数据</button>
        </div>
      </div>

      <Modal open={confirmReset} title="♻️ 恢复初始数据" onClose={() => setConfirmReset(false)} width="440px"
        footer={<><button className="btn" onClick={() => setConfirmReset(false)}>取消</button><button className="btn btn-danger" onClick={doReset}>确认恢复</button></>}>
        <p>确定清空当前所有配置与会话，恢复到初始演示数据吗？此操作不可撤销。</p>
      </Modal>
    </div>
  )
}
