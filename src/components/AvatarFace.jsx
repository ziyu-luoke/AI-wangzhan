import React, { useEffect, useState } from 'react'
import { loadAvatarExpressionUrl } from '../engine/avatarAssets.js'
import { MOOD_EMOJI } from '../engine/moodEngine.js'

/**
 * 虚拟形象头像：按 mood 显示表情图，缺图或未绑定时回退内置 emoji。
 * imageKey 来自 avatar.expressionImages[mood]（IndexedDB 引用），
 * 资源本身只存 key，不把图片二进制塞进配置。
 */
export default function AvatarFace({ avatar, mood = 'idle', className = '', style }) {
  const [url, setUrl] = useState(null)
  const key = avatar?.expressionImages?.[mood]

  useEffect(() => {
    let alive = true
    setUrl(null)
    if (key) {
      loadAvatarExpressionUrl(key)
        .then((u) => { if (alive) setUrl(u) })
        .catch(() => { if (alive) setUrl(null) })
    }
    return () => { alive = false }
  }, [key])

  const fallback = avatar?.expressions?.[mood] || MOOD_EMOJI[mood] || '🤖'

  if (url) {
    return <img src={url} alt={fallback} className={className} style={style} />
  }
  return <span className={className} style={style}>{fallback}</span>
}
