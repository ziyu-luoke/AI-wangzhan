// 小智配置台 · 数据层
// 统一资源表 + 绑定策略 + 发布版本 + 会话 + 审计 + 生成任务，localStorage 持久化
// 设计目标：配置状态与会话状态分离；配置变更产生带版本号的事件，在会话安全点消费

import { stripMeta } from '../engine/textClean.js'
import { deleteAvatarExpressions } from '../engine/avatarAssets.js'

const STORAGE_KEY = 'xiaozhi-console-state-v1'

// ---------- 样本库（声音原声留存） ----------
// 为什么要单独存：克隆音色的「原声」必须留档，否则无法试听原素材、
// 也没法在替换音色时对比新旧差异。
//
// 存储策略：IndexedDB 优先（可持久化、可存二进制 Blob），
// 不可用时（隐私模式 / 老浏览器）降级为内存 Map，保证功能不中断，
// 只是刷新页面后样本会丢失。

const SAMPLE_DB_NAME = 'xiaozhi-console-samples'
const SAMPLE_DB_STORE = 'samples'

// 内存降级容器：key -> Blob
const memorySamples = new Map()

let sampleDbPromise = null

function openSampleDb() {
  if (sampleDbPromise) return sampleDbPromise
  sampleDbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    let req
    try {
      req = indexedDB.open(SAMPLE_DB_NAME, 1)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(SAMPLE_DB_STORE)) db.createObjectStore(SAMPLE_DB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return sampleDbPromise
}

async function idbPut(key, blob) {
  const db = await openSampleDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SAMPLE_DB_STORE, 'readwrite')
      tx.objectStore(SAMPLE_DB_STORE).put(blob, key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

async function idbGet(key) {
  const db = await openSampleDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SAMPLE_DB_STORE, 'readonly')
      const req = tx.objectStore(SAMPLE_DB_STORE).get(key)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbDelete(key) {
  const db = await openSampleDb()
  if (!db) return false
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(SAMPLE_DB_STORE, 'readwrite')
      tx.objectStore(SAMPLE_DB_STORE).delete(key)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
}

// ---------- 初始 Mock 数据 ----------
function seedResources() {
  return {
    model: [
      {
        id: 'model-qwen', type: 'model', name: '通义千问 Qwen-Plus',
        provider: 'Qwen', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKeyRef: 'env:DASHSCOPE_API_KEY', modelId: 'qwen-plus',
        capabilities: { context: 128000, streaming: true, tools: true, vision: true },
        params: { temperature: 0.7, maxTokens: 1024, topP: 0.8 },
        systemPromptRef: 'persona-sweet', enabled: true, priority: 1,
        version: 1, createdAt: '2026-11-01 10:00', updatedAt: '2026-11-18 09:12',
      },
      {
        id: 'model-deepseek', type: 'model', name: 'DeepSeek',
        provider: 'DeepSeek', endpoint: 'https://api.deepseek.com',
        apiKeyRef: 'env:DEEPSEEK_API_KEY', modelId: 'deepseek-flash',
        capabilities: { context: 64000, streaming: true, tools: true, vision: false },
        params: { temperature: 0.6, maxTokens: 2048, topP: 0.9 },
        systemPromptRef: 'persona-pro', enabled: true, priority: 2,
        version: 1, createdAt: '2026-11-02 14:20', updatedAt: '2026-11-15 16:40',
      },
      {
        id: 'model-local', type: 'model', name: '本地 Llama 3.2',
        provider: 'OpenAI兼容', endpoint: 'http://192.168.1.50:8000/v1',
        apiKeyRef: '', modelId: 'llama3.2:3b',
        capabilities: { context: 8000, streaming: true, tools: false, vision: false },
        params: { temperature: 0.8, maxTokens: 512, topP: 0.95 },
        systemPromptRef: '', enabled: false, priority: 3,
        version: 1, createdAt: '2026-11-05 08:30', updatedAt: '2026-11-10 11:05',
      },
    ],
    avatar: [
      {
        id: 'avatar-xiaozhi', type: 'avatar', name: '小智 · 经典款',
        avatarType: '表情包', source: '系统内置',
        previewUrl: '', emoji: '🤖',
        expressions: { happy: '😄', thinking: '🤔', surprised: '😲', error: '😵', idle: '🤖' },
        deviceCompat: { screen: '240x320 SPI', minFirmware: '2.0.0' },
        generateParams: {}, enabled: true,
        persona: {
          name: '小智 · 经典款',
          content: '你是「{avatar_name}」，一个温柔贴心、活泼可爱的 AI 语音助手。你正在和{user_name}对话，说话简洁、有温度，偶尔卖个萌。',
          toneTags: ['温柔', '活泼'],
          background: '住在小智配置台里，喜欢陪用户聊天、讲笑话、出主意。',
        },
        version: 1, createdAt: '2026-11-01 10:00', updatedAt: '2026-11-01 10:00',
      },
      {
        id: 'avatar-sakura', type: 'avatar', name: '樱花酱',
        avatarType: '2D虚拟形象', source: '上传生成',
        previewUrl: '', emoji: '🌸',
        expressions: { happy: '🌸', thinking: '💭', surprised: '😳', error: '🥺', idle: '🌷' },
        deviceCompat: { screen: '240x320 SPI', minFirmware: '2.0.0' },
        generateParams: { style: '日系赛璐璐', resolution: '512x512', background: '透明' },
        persona: {
          name: '樱花酱',
          content: '你是「{avatar_name}」，一位来自樱花国的二次元少女，元气满满、古灵精怪，说话带着软软的关西腔口癖。你正在和{user_name}聊天，总能把平凡的小事讲得热气腾腾。',
          toneTags: ['元气', '二次元', '可爱'],
          background: '喜欢看动漫、收集樱花周边，梦想是开一家自己的甜品店。',
        },
        enabled: true,
        version: 2, createdAt: '2026-11-08 15:30', updatedAt: '2026-11-12 09:20',
      },
    ],
    voice: [
      {
        id: 'voice-sweet', type: 'voice', name: '温柔小姐姐',
        source: '系统预置', voiceId: 'voice_sweet_female', sampleAudioRef: '',
        sampleRate: 24000, format: 'Opus',
        params: { speed: 1.0, pitch: 1.0, emotion: 0.6, gender: 'female' },
        features: null, sampleKey: '', sourceType: 'preset', gender: 'female',
        authorization: null, enabled: true,
        version: 1, createdAt: '2026-11-01 10:00', updatedAt: '2026-11-01 10:00',
      },
      {
        id: 'voice-boy', type: 'voice', name: '阳光少年（克隆）',
        source: '声音克隆', voiceId: 'voice_clone_boy_01', sampleAudioRef: 'audio素材/sample_boy.wav',
        sampleRate: 24000, format: 'Opus',
        params: { speed: 1.05, pitch: 1.1, emotion: 0.8, gender: 'male' },
        features: { f0: 152, brightness: 0.31, rms: 0.17, duration: 12.4, silenceRatio: 0.14 },
        sampleKey: '', sourceType: 'clone', gender: 'male',
        authorization: { owner: '测试用户', confirmedAt: '2026-11-10 14:22', scope: '仅本项目使用' },
        enabled: true,
        version: 1, createdAt: '2026-11-10 14:20', updatedAt: '2026-11-10 14:25',
      },
    ],
    persona: [
      {
        id: 'persona-sweet', type: 'persona', name: '贴心小助手',
        content: '你是{device_name}，一个温柔贴心、活泼可爱的 AI 语音助手。\n你正在和{user_name}对话，说话简洁、有温度，偶尔卖个萌。\n遇到不确定的问题，诚实说明，不要编造。',
        variables: ['{device_name}', '{user_name}'],
        toneTags: ['温柔', '活泼'],
        greeting: '嗨～我是小智，有什么可以帮你的吗？',
        fallbackReply: '呜…我这边开小差了，请再说一遍好吗？',
        enabled: true,
        version: 1, createdAt: '2026-11-01 10:00', updatedAt: '2026-11-14 10:30',
      },
      {
        id: 'persona-pro', type: 'persona', name: '专业导师',
        content: '你是一位严谨专业的科技导师，擅长用通俗语言解释复杂技术。\n回答条理清晰、有理有据，必要时举例说明。',
        variables: [],
        toneTags: ['专业', '严谨'],
        greeting: '你好，我是你的技术导师，请提出你的问题。',
        fallbackReply: '抱歉，这个问题我需要再确认一下。',
        enabled: false,
        version: 1, createdAt: '2026-11-06 09:15', updatedAt: '2026-11-06 09:15',
      },
    ],
  }
}

function seedState() {
  return {
    resources: seedResources(),
    // 当前生效绑定（草稿）与线上绑定分离
    draftBinding: {
      scope: 'global', targetIds: ['*'],
      modelId: 'model-qwen', avatarId: 'avatar-xiaozhi',
      voiceId: 'voice-sweet', personaId: 'persona-sweet',
      rolloutPercent: 100,
      fallbackIds: { model: 'model-deepseek', voice: 'voice-sweet' },
    },
    publishedBinding: null,
    currentVersion: 0,
    publishedVersions: [],
    // 会话：与配置分离，独立存活
    sessions: [{
      sessionId: 'sess-demo-001', deviceId: '72f0d5bf-f30e-4c87-95c7-d17c794a65a4',
      identity: { userName: '小主人' }, topic: '周末去哪里玩',
      configVersion: 0, status: 'active', pendingSwitch: false,
      context: [
        { role: 'system', content: '（身份由当前生效的虚拟形象动态决定）', configVersion: 0, dynamic: true },
        { role: 'user', content: '周末我们去哪里玩呀？', configVersion: 0 },
        { role: 'assistant', content: '可以去公园野餐呀，天气据说很不错呢～', configVersion: 0 },
      ],
      switchHistory: [],
      updatedAt: '2026-11-19 10:30',
    }],
    generationTasks: [],
    auditLogs: [
      { id: 'audit-init', actor: '系统', action: '初始化', target: '配置台', fromVersion: 0, toVersion: 0, timestamp: '2026-11-19 10:00', detail: '原型数据初始化完成' },
    ],
    // 实时事件流（用于演示热切换）
    events: [],
  }
}

// ---------- Store 实现 ----------
class ConsoleStore {
  constructor() {
    this.listeners = new Set()
    this.state = this.load()
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        const state = { ...seedState(), ...parsed }
        this.migrateModelRefs(state)
        this.migrateStripMeta(state)
        this.normalizeVoiceFields(state)
        this.normalizeAvatarFields(state)
        return state
      }
    } catch (e) {
      console.warn('读取本地状态失败，使用初始数据', e)
    }
    const fresh = seedState()
    this.normalizeAvatarFields(fresh)
    return fresh
  }

  // 归一化形象资源字段（向后兼容）：
  //  - expressionImages 缺图片库引用补空对象，对话侧回退 emoji
  //  - persona 为该形象专属的人设（身份/内容/语气/背景）。老形象若没有，不强行塞默认值，
  //    对话侧会回退到全局绑定的 AI 人设，避免老数据突然换性格。
  normalizeAvatarFields(state) {
    for (const a of state.resources?.avatar || []) {
      if (!a.expressionImages || typeof a.expressionImages !== 'object') a.expressionImages = {}
      const ex = a.expressions && typeof a.expressions === 'object' ? a.expressions : {}
      if (!('angry' in ex)) ex.angry = '😠'
      if (!('idle' in ex)) ex.idle = '🤖'
      a.expressions = ex
      if (a.persona && typeof a.persona === 'object') {
        const p = a.persona
        if (!Array.isArray(p.toneTags)) p.toneTags = []
        if (typeof p.content !== 'string') p.content = ''
        if (typeof p.background !== 'string') p.background = ''
      }
    }
  }

  // 归一化音色资源字段（向后兼容）：
  // 旧数据里没有 features / sampleKey / sourceType / gender，
  // 这里补上默认值，不改动任何已有业务字段与版本号。
  normalizeVoiceFields(state) {
    let changed = false
    for (const v of state.resources?.voice || []) {
      if (!('sourceType' in v)) {
        v.sourceType = v.source === '声音克隆' ? 'clone' : v.source === '系统预置' ? 'preset' : 'tune'
        changed = true
      }
      if (!('features' in v)) { v.features = null; changed = true }
      if (!('sampleKey' in v)) { v.sampleKey = ''; changed = true }
      if (!v.params || typeof v.params !== 'object') { v.params = { speed: 1, pitch: 1, emotion: 0.6 }; changed = true }
      if (!('gender' in v.params)) {
        v.params.gender = v.gender === 'male' || v.gender === 'female' ? v.gender : 'neutral'
        changed = true
      }
      const g = v.params.gender
      const norm = g === 'male' || g === 'female' ? g : 'neutral'
      if (v.gender !== norm) { v.gender = norm; changed = true }
    }
    if (changed) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* 忽略持久化失败 */ }
    }
  }

  // 迁移：把旧原型的脱敏占位密钥引用升级为 env: 引用（只改引用，不写入任何明文密钥）
  migrateModelRefs(state) {
    const legacyKeyMap = {
      'secret-ds-********81c2': 'env:DEEPSEEK_API_KEY',
      'secret-qwen-********3f9a': 'env:DASHSCOPE_API_KEY',
    }
    const legacyEndpoint = { 'https://api.deepseek.com/v1': 'https://api.deepseek.com' }
    const legacyModel = { 'deepseek-chat': 'deepseek-flash' }
    let changed = false
    for (const m of state.resources?.model || []) {
      if (legacyKeyMap[m.apiKeyRef]) { m.apiKeyRef = legacyKeyMap[m.apiKeyRef]; changed = true }
      if (m.provider === 'DeepSeek' && legacyEndpoint[m.endpoint]) { m.endpoint = legacyEndpoint[m.endpoint]; changed = true }
      if (m.provider === 'DeepSeek' && legacyModel[m.modelId]) { m.modelId = legacyModel[m.modelId]; changed = true }
    }
    if (changed) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* 忽略持久化失败 */ }
      console.info('[小智配置台] 已将旧模型密钥引用迁移为服务端环境变量引用')
    }
  }

  // 迁移：清除历史回复正文里残留的配置元信息标注（模型/音色/版本/降级标注）
  // 只改 assistant 消息正文，身份/话题/上下文条数均不变，会话状态完整保留
  migrateStripMeta(state) {
    let changed = false
    for (const sess of state.sessions || []) {
      for (const m of sess.context || []) {
        if (m.role !== 'assistant' || !m.content) continue
        const cleaned = stripMeta(m.content)
        if (cleaned !== m.content) { m.content = cleaned; changed = true }
      }
    }
    if (changed) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* 忽略持久化失败 */ }
      console.info('[小智配置台] 已清除历史回复中的配置元信息标注')
    }
  }

  persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch (e) {
      console.warn('持久化失败', e)
    }
  }

  getState = () => this.state

  subscribe = (listener) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    this.persist()
    this.listeners.forEach((l) => l())
  }

  // 浅合并更新顶层字段
  patch(partial) {
    this.state = { ...this.state, ...partial }
    this.emit()
  }

  now() {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  // ---------- 审计 ----------
  audit(action, target, fromVersion, toVersion, detail) {
    const entry = {
      id: this.uid('audit'), actor: '当前用户（所有者）', action, target,
      fromVersion, toVersion, timestamp: this.now(), detail: detail || '',
    }
    this.state.auditLogs = [entry, ...this.state.auditLogs]
    return entry
  }

  // ---------- 事件流 ----------
  pushEvent(type, message, level = 'info') {
    const evt = { id: this.uid('evt'), type, message, level, timestamp: this.now() }
    this.state.events = [evt, ...this.state.events].slice(0, 50)
    return evt
  }

  // ---------- 资源 CRUD ----------
  listResources(type) {
    return this.state.resources[type] || []
  }

  getResource(type, id) {
    return (this.state.resources[type] || []).find((r) => r.id === id)
  }

  createResource(type, data) {
    const item = {
      ...data,
      id: data.id || this.uid(type),
      type,
      enabled: data.enabled ?? false,
      version: 1,
      createdAt: this.now(),
      updatedAt: this.now(),
    }
    if (type === 'voice') this.applyVoiceDefaults(item)
    if (type === 'avatar') {
      if (!item.expressionImages || typeof item.expressionImages !== 'object') item.expressionImages = {}
      const ex = item.expressions && typeof item.expressions === 'object' ? item.expressions : {}
      if (!('angry' in ex)) ex.angry = '😠'
      if (!('idle' in ex)) ex.idle = '🤖'
      item.expressions = ex
    }
    const resources = { ...this.state.resources, [type]: [...this.state.resources[type], item] }
    this.patch({ resources })
    this.audit('新增', `${type}:${item.name}`, 0, 1, `新增${type}资源「${item.name}」`)
    this.pushEvent('resource', `新增资源「${item.name}」`)
    return item
  }

  updateResource(type, id, data, expectedVersion) {
    const list = this.state.resources[type]
    const idx = list.findIndex((r) => r.id === id)
    if (idx < 0) throw new Error('资源不存在')
    const current = list[idx]
    // 乐观锁
    if (expectedVersion != null && current.version !== expectedVersion) {
      throw new Error('配置已被他人修改，请刷新后重试')
    }
    const updated = { ...current, ...data, version: current.version + 1, updatedAt: this.now() }
    if (type === 'voice') this.applyVoiceDefaults(updated)
    const newList = [...list]
    newList[idx] = updated
    this.patch({ resources: { ...this.state.resources, [type]: newList } })
    this.audit('编辑', `${type}:${current.name}`, current.version, updated.version, `编辑「${current.name}」的配置`)
    this.pushEvent('resource', `更新资源「${updated.name}」`)
    return updated
  }

  // 音色资源的字段默认值：保证 features / sampleKey / sourceType / gender / params.gender 始终存在，
  // 旧数据（缺字段）走这里补齐，不影响已有业务字段与版本号。
  applyVoiceDefaults(item) {
    if (!('sourceType' in item)) {
      item.sourceType = item.source === '声音克隆' ? 'clone' : item.source === '系统预置' ? 'preset' : 'tune'
    }
    if (!('features' in item)) item.features = null
    if (!('sampleKey' in item)) item.sampleKey = ''
    if (!item.params || typeof item.params !== 'object') item.params = { speed: 1, pitch: 1, emotion: 0.6 }
    // params.gender 是权威值（speak() 优先读它）：旧数据没有时用顶层 gender 补齐，
    // 之后顶层 gender 始终镜像 params.gender，避免两处字段打架。
    if (!('gender' in item.params)) {
      item.params.gender = item.gender === 'male' || item.gender === 'female' ? item.gender : 'neutral'
    }
    const g = item.params.gender
    item.gender = g === 'male' || g === 'female' ? g : 'neutral'
  }

  toggleResource(type, id) {
    const list = this.state.resources[type]
    const idx = list.findIndex((r) => r.id === id)
    if (idx < 0) throw new Error('资源不存在')
    const current = list[idx]
    const updated = { ...current, enabled: !current.enabled, version: current.version + 1, updatedAt: this.now() }
    const newList = [...list]
    newList[idx] = updated
    this.patch({ resources: { ...this.state.resources, [type]: newList } })
    this.audit(updated.enabled ? '启用' : '停用', `${type}:${current.name}`, current.version, updated.version, `${updated.enabled ? '启用' : '停用'}「${current.name}」`)
    this.pushEvent('resource', `「${current.name}」已${updated.enabled ? '启用' : '停用'}`)
    return updated
  }

  deleteResource(type, id) {
    const current = this.getResource(type, id)
    if (!current) throw new Error('资源不存在')
    // 若被当前绑定引用则阻止删除
    const binding = this.state.draftBinding
    const refField = { model: 'modelId', avatar: 'avatarId', voice: 'voiceId', persona: 'personaId' }[type]
    if (binding[refField] === id) {
      throw new Error(`「${current.name}」正在使用中，请先切换后再删除`)
    }
    const list = this.state.resources[type].filter((r) => r.id !== id)
    this.patch({ resources: { ...this.state.resources, [type]: list } })
    // 音色删除后，其原声样本必须同步清理，否则样本库里会留下无主文件
    if (type === 'voice' && current.sampleKey) {
      this.deleteVoiceSample(current.sampleKey)
    }
    // 形象删除后同步清理其 5 类表情图，避免资源库残留
    if (type === 'avatar' && current.expressionImages) {
      deleteAvatarExpressions(current.expressionImages).catch(() => { /* 清理失败不影响主流程 */ })
    }
    this.audit('删除', `${type}:${current.name}`, 1, 0, `删除「${current.name}」`)
    this.pushEvent('resource', `删除资源「${current.name}」`)
  }

  // ---------- 样本库（声音原声留存） ----------
  // 优先落 IndexedDB；失败降级内存 Map，保证「替换音色 / 原声试听」始终可用。

  /**
   * 保存一份声音样本（原声）。
   * @param {string} key 样本键，通常是音色 id 或派生音色 id
   * @param {Blob|File|ArrayBuffer} file 样本数据
   * @returns {Promise<{ok: boolean, backend: 'idb'|'memory'}>}
   */
  async saveVoiceSample(key, file) {
    if (!key || !file) return { ok: false, backend: 'memory' }
    const blob = file instanceof Blob ? file : new Blob([file])
    const ok = await idbPut(key, blob)
    if (ok) return { ok: true, backend: 'idb' }
    // 降级：内存 Map
    memorySamples.set(key, blob)
    return { ok: true, backend: 'memory' }
  }

  /**
   * 取回样本（原声试听用）。
   * @returns {Promise<Blob|null>}
   */
  async loadVoiceSample(key) {
    if (!key) return null
    const fromDb = await idbGet(key)
    if (fromDb) return fromDb
    return memorySamples.get(key) || null
  }

  /**
   * 删除样本。删除音色时必须调用，避免样本库残留。
   * @returns {Promise<boolean>}
   */
  async deleteVoiceSample(key) {
    if (!key) return false
    memorySamples.delete(key)
    return await idbDelete(key)
  }

  // ---------- 绑定与发布 ----------
  updateDraftBinding(patch) {
    this.patch({ draftBinding: { ...this.state.draftBinding, ...patch } })
  }

  validateBinding(binding) {
    const problems = []
    const map = { modelId: 'model', avatarId: 'avatar', voiceId: 'voice', personaId: 'persona' }
    for (const [field, type] of Object.entries(map)) {
      const r = this.getResource(type, binding[field])
      if (!r) problems.push(`${type} 引用不存在`)
      else if (!r.enabled) problems.push(`「${r.name}」尚未启用`)
    }
    return problems
  }

  // 发布：产生新版本事件，标记受影响会话为 pending-switch
  publish() {
    const binding = this.state.draftBinding
    const problems = this.validateBinding(binding)
    if (problems.length) throw new Error(`校验未通过：${problems.join('；')}`)
    const nextVersion = this.state.currentVersion + 1
    const snapshot = JSON.parse(JSON.stringify(binding))
    const pv = {
      version: nextVersion, snapshot, publisher: '当前用户（所有者）',
      publishedAt: this.now(), rollbackTo: this.state.currentVersion || null,
    }
    const sessions = this.state.sessions.map((s) => ({
      ...s,
      pendingSwitch: true,
      targetVersion: nextVersion,
    }))
    this.patch({
      currentVersion: nextVersion,
      publishedBinding: snapshot,
      publishedVersions: [pv, ...this.state.publishedVersions],
      sessions,
    })
    this.audit('发布', `配置版本 v${nextVersion}`, this.state.currentVersion - 1, nextVersion, '发布新配置，等待会话安全点切换')
    this.pushEvent('publish', `配置 v${nextVersion} 已发布，等待会话安全点切换`, 'success')
    return pv
  }

  rollback() {
    if (this.state.currentVersion <= 0) throw new Error('没有可回滚的版本')
    const current = this.state.currentVersion
    const prev = this.state.publishedVersions.find((v) => v.version === current - 1)
    if (!prev) throw new Error('找不到上一版本快照')
    const sessions = this.state.sessions.map((s) => ({ ...s, pendingSwitch: true, targetVersion: current - 1 }))
    this.patch({
      currentVersion: current - 1,
      publishedBinding: JSON.parse(JSON.stringify(prev.snapshot)),
      draftBinding: JSON.parse(JSON.stringify(prev.snapshot)),
      sessions,
    })
    this.audit('回滚', `配置版本 v${current}→v${current - 1}`, current, current - 1, '回滚到上一版本')
    this.pushEvent('rollback', `已回滚到 v${current - 1}，等待安全点切换`, 'warn')
  }

  // ---------- 会话：安全点切换 + 上下文迁移 ----------
  // 由对话面板在"轮次结束/TTS播完"的安全点调用
  applyPendingSwitch(sessionId) {
    const s = this.state.sessions.find((x) => x.sessionId === sessionId)
    if (!s || !s.pendingSwitch) return null
    const target = s.targetVersion
    const binding = this.state.publishedBinding
    // 上下文迁移：保留会话身份/话题/历史消息，仅标记新版本，历史不重写（避免上下文污染）
    const movedContext = s.context.map((m) => ({ ...m }))
    const switchRecord = {
      fromVersion: s.configVersion, toVersion: target,
      time: this.now(),
      changes: this.describeBindingChanges(binding),
      messageCount: movedContext.length,
    }
    const updated = {
      ...s,
      configVersion: target,
      pendingSwitch: false,
      targetVersion: undefined,
      context: movedContext,
      switchHistory: [switchRecord, ...s.switchHistory],
      updatedAt: this.now(),
    }
    const sessions = this.state.sessions.map((x) => x.sessionId === sessionId ? updated : x)
    this.patch({ sessions })
    this.audit('切换', `会话 ${sessionId}`, s.configVersion, target, `安全点热切换，保留 ${movedContext.length} 条上下文`)
    this.pushEvent('switch', `会话已在安全点切换到 v${target}，上下文完整保留`, 'success')
    return updated
  }

  describeBindingChanges(binding) {
    if (!binding) return []
    const names = { modelId: '模型', avatarId: '形象', voiceId: '音色', personaId: '人设' }
    const out = []
    for (const [field, label] of Object.entries(names)) {
      const r = this.getResource(field.replace('Id', ''), binding[field])
      if (r) out.push(`${label}→${r.name}`)
    }
    return out
  }

  appendMessage(sessionId, role, content) {
    const sessions = this.state.sessions.map((s) => {
      if (s.sessionId !== sessionId) return s
      return {
        ...s,
        context: [...s.context, { role, content, configVersion: s.configVersion, time: this.now() }],
        topic: role === 'user' ? content.slice(0, 20) : s.topic,
        updatedAt: this.now(),
      }
    })
    this.patch({ sessions })
  }

  // ---------- 生成任务 ----------
  createGenerationTask(type, payload) {
    const task = {
      id: this.uid('gen'), type, ...payload,
      status: 'PENDING', progress: 0, createdAt: this.now(), result: null, error: null,
    }
    this.patch({ generationTasks: [task, ...this.state.generationTasks] })
    this.audit('生成', `${type}任务`, 0, 0, `创建${type}生成任务`)
    return task
  }

  updateGenerationTask(id, patch) {
    const tasks = this.state.generationTasks.map((t) => t.id === id ? { ...t, ...patch } : t)
    this.patch({ generationTasks: tasks })
  }

  // ---------- 重置 ----------
  resetAll() {
    this.state = seedState()
    this.emit()
  }
}

export const store = new ConsoleStore()
