// 文本清洗工具：把"配置元信息标注"与"表情符号"从回复正文中剥离
// 设计原则：只清理成对括号里含明确元信息关键词的片段，不碰正文里的普通括号内容

// 元信息标注特征：本轮由 X 生成 / 配置 vN / 调用失败 / 已降级
// 覆盖全角〔〕、方括号[]、圆括号（）() 等常见写法，且不吃掉跨行正文
const META_RE = /[ \t]*[〔\[（(][^〔\]（）()\n]{0,200}?(?:本轮由|配置\s*v\d|调用失败|已降级|生成\s*·)[^〔\]（）()\n]{0,200}?[〕\]）)]/gi

// 移除回复正文中的元信息标注（模型名、音色、配置版本、降级/失败标注等）
export function stripMeta(text) {
  if (text == null) return ''
  return String(text)
    .replace(META_RE, '')
    .replace(/\s+$/, '')
}

// 播报用文本：在 stripMeta 基础上再去掉 emoji 表情（不朗读、不解释表情包）
// 仅移除符号本身，不把表情转成文字描述
export function stripForSpeech(text) {
  return stripMeta(text)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
