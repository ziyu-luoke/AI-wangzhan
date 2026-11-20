// 人设工具
// - buildSystemPrompt：把「AI 人设」拼成真正发给大模型的 system prompt（真实链路）
// - personaReply：仅用于人设编辑页的"效果预览"（Mock，不参与真实对话）
//
// 概念边界（依需求重新厘清）：
//   · 形象名（avatar.name）= AI 的"名字"。用户问"你是谁/你叫什么"时回答它。
//   · AI 人设名（persona.name）= 身份标识，不含名字。只有明确问"你的身份"时才回答它。
//   · 回复内容以人设 content 为最高依据；身份字段仅作说明，不强制写进日常回复。
//   · 虚拟形象自带的 persona 不再参与 system prompt；内容、语气、兜底一律取全局 AI 人设。

// 变量插值：只替换已知变量，未知/中文占位符（如历史脏数据 {辉哥}）原样保留，避免污染人设
function interpolate(content, vars) {
  return String(content || '').replace(/\{(\w+)\}/g, (match, key) => {
    const v = vars[key]
    return v === undefined || v === '' ? match : String(v)
  })
}

/**
 * 构建真正发给大模型的 system prompt。
 * @param {object} persona 全局绑定的 AI 人设资源（回复内容/语气/身份标识的唯一权威）
 * @param {object} identity 会话身份 { userName }
 * @param {object} avatar  当前生效的虚拟形象资源（只提供"名字"）
 */
export function buildSystemPrompt(persona, identity = {}, avatar = null) {
  // ① 名字：只取形象名（AI 的名字），绝不写死；无形象时用中性名。身份标识不冒充名字。
  const avatarName = String(avatar?.name || '').trim()
  const aiName = avatarName || String(identity.deviceName || '').trim() || 'AI 助手'
  // ② 身份标识：复用现有人设名称，仅作说明、不含名字
  const identityName = String(persona?.name || '').trim()

  const vars = {
    device_name: aiName,
    avatar_name: aiName,
    user_name: identity.userName || '小主人',
    ...(persona?.variableValues || {}),
  }

  const parts = []

  // ③ 身份说明区：区分"名字"与"身份"两类提问，明确"仅作说明、不强制进日常回复"
  const idLines = []
  idLines.push(`你的名字是「${aiName}」。`)
  idLines.push(`当用户问"你是谁 / 你叫什么 / 你的名字是什么"时，回答你的名字「${aiName}」。`)
  if (identityName) {
    idLines.push(`你的身份是「${identityName}」（这是一个身份标识，不是名字）。`)
    idLines.push(`只有当用户明确问"你的身份是什么 / 你是什么身份"时，才回答身份「${identityName}」。`)
  }
  idLines.push('除上述身份类提问外，不要在日常回复中主动提及名字或身份。')
  parts.push(`【身份说明 · 仅用于回答身份类提问，不影响日常回复内容】\n${idLines.join('\n')}`)

  // ④ 回复规则：人设 content 是唯一最高依据（形象自带 persona 已彻底退出）
  const globalContent = String(persona?.content || '').trim()
  const rules = globalContent
    ? interpolate(globalContent, vars)
    : `你是「${aiName}」，一个温和的 AI 助手。回答简洁、得体。`
  parts.push(`【回复规则 · 最高依据，必须严格遵守，覆盖历史对话风格与下述语气】\n${rules}`)

  // ⑤ 语气：只取全局人设
  const toneTags = Array.isArray(persona?.toneTags) ? persona.toneTags : []
  if (toneTags.length) parts.push(`语气参考：${toneTags.join('、')}（不得违反上面的回复规则）`)

  // ⑥ 异常兜底回复：只取全局人设
  const fallbackReply = String(persona?.fallbackReply || '').trim()
  if (fallbackReply) parts.push(`不确定或出错时可说："${fallbackReply}"`)

  // ⑦ 历史风格隔离：让模型忽略旧消息说话方式，只以当前回复规则为准
  parts.push('注意：忽略历史消息中的说话风格，你当前的回复以【回复规则】为准。')

  return parts.join('\n\n')
}

/** 供对话页展示：名字（形象名）、身份标识（人设名）、语气（人设）摘要 */
export function identitySummary(avatar, persona) {
  const name = String(avatar?.name || '').trim() || 'AI 助手'
  const identityName = String(persona?.name || '').trim()
  const tags = Array.isArray(persona?.toneTags) ? persona.toneTags : []
  return { name, identityName, tags, content: String(persona?.content || '') }
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
