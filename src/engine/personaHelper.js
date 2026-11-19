// 人设工具
// - buildSystemPrompt：把「当前生效虚拟形象的人设」+ 全局人设兜底 + 变量插值成真正发给大模型的 system prompt（真实链路）
// - personaReply：仅用于人设编辑页的"效果预览"（Mock，不参与真实对话）
//
// 身份规则（修复"无论选哪个形象都自称小智"）：
//   1. AI 的名字 = 当前生效虚拟形象的 name，绝不写死；没有形象时才用全局人设/identity。
//   2. 每个形象自带 persona（内容/语气/背景），优先于全局 AI 人设，保证形象之间人设不串扰。
//   3. 形象没有专属人设时，回退到全局绑定的 persona（兼容老数据）。

// 变量插值：把 content 中的 {device_name}/{avatar_name}/{user_name} 等替换为实际值
function interpolate(content, vars) {
  return String(content || '').replace(/\{(\w+)\}/g, (match, key) => {
    const v = vars[key]
    return v === undefined || v === '' ? match : String(v)
  })
}

/**
 * 构建真正发给大模型的 system prompt。
 * @param {object} persona 全局绑定的 AI 人设资源（兜底用）
 * @param {object} identity 会话身份 { userName }
 * @param {object} avatar  当前生效的虚拟形象资源（身份与人设的主来源）
 */
export function buildSystemPrompt(persona, identity = {}, avatar = null) {
  // ① 身份名称：形象名优先，绝不固定为「小智」
  const avatarName = String(avatar?.name || '').trim()
  const identityName = avatarName || String(identity.deviceName || '').trim() || String(persona?.deviceName || '').trim() || 'AI 助手'

  const vars = {
    device_name: identityName,
    avatar_name: identityName,
    user_name: identity.userName || '小主人',
    ...(persona?.variableValues || {}),
  }

  // ② 人设来源：形象自带 persona 优先；否则回退全局 persona；都没有才用中性兜底
  const ap = avatar?.persona
  const useAvatarPersona = !!ap && String(ap.content || '').trim()
  let prompt
  let toneTags

  if (useAvatarPersona) {
    prompt = interpolate(ap.content, vars)
    toneTags = Array.isArray(ap.toneTags) ? ap.toneTags : []
  } else if (persona) {
    prompt = interpolate(persona.content, vars)
    toneTags = Array.isArray(persona.toneTags) ? persona.toneTags : []
  } else {
    prompt = `你是「${identityName}」，一个温柔贴心的 AI 语音助手。回答简洁、有温度。`
    toneTags = []
  }

  // ③ 背景设定（仅形象自带）：让不同形象有各自的经历与世界观
  if (useAvatarPersona && String(ap.background || '').trim()) {
    prompt += `\n你的背景设定：${interpolate(ap.background, vars)}`
  }

  // ④ 语气
  if (toneTags.length) prompt += `\n请以${toneTags.join('、')}的语气说话。`

  // ⑤ 异常兜底回复
  const fallbackReply = (useAvatarPersona && ap.fallbackReply) || persona?.fallbackReply
  if (fallbackReply) prompt += `\n当不确定或出错时，可以说："${fallbackReply}"`

  // ⑥ 身份锚定：显式声明"你就是 X"，并要求以此自称，防止模型沿用默认人设或把别的形象名带进来。
  //    放在最前面，权重最高；明确禁止提及"小智""助手"等默认称呼（除非当前形象本身就叫这个）。
  const defaultNames = ['小智', 'AI 助手', 'AI助手']
    .filter((n) => n !== identityName)
    .map((n) => `「${n}」`)
    .join('、')
  const forbid = defaultNames ? `不要自称${defaultNames}等默认名称；` : ''
  prompt = `你是「${identityName}」，你的名字就是「${identityName}」。用户问到"你是谁/叫什么"时，必须明确回答你是「${identityName}」，${forbid}始终严格遵循上述人设、语气与背景设定，不要混入其他形象的设定。\n\n${prompt}`

  return prompt
}

/** 供上下文列表展示：当前身份的一句话摘要（不含完整人设，短小） */
export function identitySummary(avatar, persona) {
  const name = String(avatar?.name || '').trim() || 'AI 助手'
  const tags = avatar?.persona?.toneTags || persona?.toneTags || []
  return { name, tags: Array.isArray(tags) ? tags : [] }
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
