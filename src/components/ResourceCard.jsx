import React from 'react'
import { useUI } from './UIContext.jsx'

// 通用资源卡片。meta 为卡片主体展示的键值对数组，tags 为标签数组
export default function ResourceCard({ item, meta = [], tags = [], avatar, avatarBg, avatarImage, using, onEdit, onToggle, onDelete, onExtra, extraLabel }) {
  const { setMascot } = useUI()
  return (
    <div className="rcard">
      {using && <div className="using-ribbon">使用中</div>}
      <div className="rcard-head">
        <div className="rcard-avatar" style={avatarBg ? { background: avatarBg } : {}}>
          {avatarImage
            ? <img src={avatarImage} alt={item.name} className="rcard-avatar-img" />
            : (avatar || '📦')}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="rcard-title" title={item.name}>{item.name}</div>
          <div className="rcard-sub">v{item.version} · {item.updatedAt}</div>
        </div>
      </div>
      <div className="rcard-body">
        {meta.map(([k, v]) => (
          <div className="kv" key={k}><span>{k}</span><b title={String(v)}>{v}</b></div>
        ))}
        {tags.length > 0 && <div style={{ marginTop: 8 }}>{tags.map((t, i) => <span className="tag" key={i}>{t}</span>)}</div>}
      </div>
      <div className="rcard-foot">
        <button
          className={`switch ${item.enabled ? 'on' : ''}`}
          title={item.enabled ? '点击停用' : '点击启用'}
          onClick={() => { setMascot('wink', item.enabled ? '好，先停用这个～' : '收到，启用啦！'); onToggle?.() }}
        ></button>
        <span className={`badge ${item.enabled ? 'on' : 'off'}`}>{item.enabled ? '已启用' : '已停用'}</span>
        <span className="rcard-actions">
          {onExtra && <button className="btn btn-sm btn-blue" onClick={onExtra}>{extraLabel || '测试'}</button>}
          <button className="btn btn-sm" onClick={() => { setMascot('thinking', '来，我们一起改～'); onEdit?.() }}>✏️ 编辑</button>
          <button className="btn btn-sm btn-icon btn-ghost" title="删除" onClick={onDelete}>🗑️</button>
        </span>
      </div>
    </div>
  )
}
