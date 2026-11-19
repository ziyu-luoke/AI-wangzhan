// 本地语气判定：不调用额外模型，纯规则匹配，零延迟。
// 目标是把机器人回复按句子映射到 5 类表情：
//   happy / thinking / surprised / angry / idle
// 生成阶段（生命周期态）由对话页直接指定 thinking；这里只负责「回复正文」的语气。

import { splitIntoSentences } from './adapters.js'

export const MOOD_KEYS = ['happy', 'thinking', 'surprised', 'angry', 'idle']

// 缺图/未绑定形象时的内置 emoji 兜底
export const MOOD_EMOJI = {
  happy: '😄',
  thinking: '🤔',
  surprised: '😲',
  angry: '😠',
  idle: '🤖',
}

// 规则按优先级从高到低排列：愤怒 > 惊讶 > 开心 > 思考 > 待机（默认）。
// 中文标点也算语气线索；问号优先判为思考，除非有更强的情绪词。
const RULES = [
  ['angry', /(气死|生气|愤怒|发火|可恶|讨厌|烦死|太过分|荒唐|无语|怒|警告|不允许|岂有此理|!!|！！)/],
  // 注意：不把单独的「！」当惊讶——开心句也常用感叹号，会误判。只认明确的惊讶词。
  ['surprised', /(哇|居然|竟然|没想到|震惊|惊呆|天哪|哎呀|诶|咦|what| Wow | wow )/i],
  ['happy', /(哈哈|呵呵|嘻嘻|嘿嘿|开心|高兴|太好了|喜欢|谢谢|棒|可爱|笑|恭喜|不错|耶|～|~)/],
  ['thinking', /(？|\?|为什么|怎么|如何|吗|呢|吧|考虑|或许|可能|让我想|思考|如果|其实|建议|因为|所以)/],
]

/** 判定单句语气，返回 5 类之一 */
export function detectMood(text) {
  const s = String(text || '').trim()
  if (!s) return 'idle'
  for (const [mood, re] of RULES) {
    if (re.test(s)) return mood
  }
  return 'idle'
}

/**
 * 把整段回复切成句子，并为每句标注语气。
 * 与 TTS 的句子流水线复用同一个切分函数，保证「音画」按同一粒度推进。
 * @returns {Array<{sentence: string, mood: string}>}
 */
export function moodSequence(text) {
  return splitIntoSentences(text).map((sentence) => ({ sentence, mood: detectMood(sentence) }))
}

/** 取一段回复里最有代表性的语气（用于整体兜底展示） */
export function dominantMood(text) {
  const seq = moodSequence(text)
  if (!seq.length) return 'idle'
  const nonIdle = seq.filter((x) => x.mood !== 'idle')
  return (nonIdle[0] || seq[0]).mood
}
