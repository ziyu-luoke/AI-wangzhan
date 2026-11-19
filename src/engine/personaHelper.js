// 人设工具
// - buildSystemPrompt：把人设内容 + 变量插值成真正发给大模型的 system prompt（真实链路）
// - personaReply：仅用于人设编辑页的"效果预览"（Mock，不参与真实对话）

// 变量插值：把 content 中的 {device_name}/{user_name} 等替换为实际值
function interpolate(content, vars) {
  return String(content || '').replace(/\{(\w+)\}/g, (match, key) => {
    const v = vars[key]
    return v === undefined || v === '' ? match : String(v)
  })
}

export function buildSystemPrompt(persona, identity = {}) {
  if (!persona) return '你是小智，一个温柔贴心的 AI 语音助手。回答简洁、有温度。'
  const vars = {
    device_name: persona.deviceName || '小智',
    user_name: identity.userName || '小主人',
    ...(persona.variableValues || {}),
  }
  let prompt = interpolate(persona.content, vars)
  const toneTags = persona.toneTags || []
  if (toneTags.length) prompt += `\n请以${toneTags.join('、')}的语气说话。`
  if (persona.fallbackReply) prompt += `\n当不确定或出错时，可以说："${persona.fallbackReply}"`
  return prompt
}

// 仅用于人设编辑页的语气效果预览（Mock）
export function personaReply(persona, messages) {
  if (!persona) return '收到啦～（当前未关联人设，使用默认回复）'
  const last = [...messages].reverse().find((m) => m.role === 'user')
  const text = last?.content || ''
  const greeting = persona.greeting || '你好呀～'
  const tags = (persona.toneTags || []).join('、')
  return `${greeting}刚才我们聊到「${text.slice(0, 12)}${text.length > 12 ? '…' : ''}」，我会用${tags || '亲切'}的语气接着说哦～`
}
