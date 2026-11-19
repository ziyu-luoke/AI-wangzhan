# 小智 · 可视化配置台（本地原型）

按《小智AI机器人-可视化配置台实现方案》实现的本地可运行原型。**吉卜力 / 宫崎骏风格**（自然暖色、水彩纸感、手绘云朵与远山草地，全部原创 SVG/CSS，无电影版权素材）。四类资源配置 + 素材/声音生成 + 热切换演示，配置数据存浏览器 localStorage。已适配桌面与移动端。

**模型对话已接入真实 DeepSeek API**（经本地安全代理，密钥只存服务端 `.env`，浏览器不接触明文）。其余生成/设备推送仍为 Mock。

## 一、启动

```bash
cd xiaozhi-console
npm install       # 首次运行
npm run dev       # 一键启动：后端安全代理(8787) + 前端(5173)
```

打开 http://127.0.0.1:5173/ 。`Ctrl+C` 会同时关闭前后端。

生产构建：`npm run build`（产物在 `dist/`）；`npm run preview` 预览构建产物。

## 二、配置真实 DeepSeek API（关键）

> ⚠️ 纯前端无法安全持有密钥——放在浏览器代码或 localStorage 里等于公开。因此本项目加了**本地后端代理**：密钥只写在服务端的 `.env`，前端只传 `env:变量名` 这样的引用。

1. 复制模板：在本目录执行 `cp .env.example .env`（Windows 可手动复制改名）。
2. 编辑 `.env`，把 `DEEPSEEK_API_KEY` 换成你在 [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) 申请的真实密钥：
   ```env
   DEEPSEEK_API_KEY=sk-你的真实密钥
   ```
3. 重启 `npm run dev`（后端启动时读取 `.env`）。

`.env` 已被 `.gitignore` 忽略，**不会被提交、也不会下发到浏览器**。后端日志和接口只显示脱敏值（如 `sk-****81c2`）。

如需接入其它供应商（Qwen/OpenAI 兼容），在 `.env` 配对应变量，并把其域名加入 `ALLOWED_API_HOSTS` 白名单。

## 三、让对话真正用上 DeepSeek

模型列表里的 Qwen、DeepSeek 都是可配置项。当前**默认生效的是 Qwen**（为了保留"Qwen→DeepSeek 热切换"的演示路径）。要让对话走 DeepSeek：

- 方式 A（推荐）：进入「发布中心」→ 生效模型选 DeepSeek → 发布新配置 → 去「对话演示」发消息。
- 方式 B：直接在「系统设置」把配置重置后，在模型页调整绑定（按页面提示操作）。

模型页的「真实调用测试」按钮会对当前模型发起一次真实最小调用（约 16 token），不通过会明确报错且不允许发布。

## 四、验证调用是否成功

```bash
npm run check:deepseek
```

脚本依次验证：① 代理与密钥配置状态（脱敏显示）；② 发起一次真实最小调用，打印延迟、模型名与回复片段。退出码 `0`=成功，`1`=密钥未配置/调用失败，`2`=代理未启动。

> ✅ **实测记录（2026-11-19）**：填入真实 Key 后验证通过——`/api/test` 连续 3 次成功（延迟 122~265ms，模型 `deepseek-flash`，返回 `Pong!`）；浏览器端到端确认对话拿到真实模型回复、安全点热切换 `pending→切换记录+1`、上下文完整保留、运行时 0 错误。期间曾出现一次瞬时 402，重试即恢复，属 DeepSeek 侧偶发状态，代理已正确映射为友好提示。

也可在网页「AI 模型」页打开 DeepSeek 卡片 →「真实调用测试」，看到"✅ 真实调用成功"即通。

常见失败提示对应：
- `API Key 无效或已过期` → 检查 `.env` 密钥是否正确、是否有多余空格
- `账户余额不足` → 到 DeepSeek 平台充值
- `请求过于频繁` → 稍后重试
- `endpoint 主机 xxx 不在白名单内` → 把该域名加入 `.env` 的 `ALLOWED_API_HOSTS`
- `密钥引用格式非法` → 密钥引用必须填 `env:变量名`，不能填明文

## 五、页面导览

| 页面 | 作用 |
|---|---|
| AI 模型 / 虚拟形象 / 语音音色 / AI 人设 | 四类资源的增删改、启停、编辑 |
| 虚拟形象页「上传素材生成」 | 上传图片 → 选风格 → **素材驱动生成**（提取主色调 + Q 版风格化，候选来自素材本身）→ 预览采纳 |

> 形象生成说明：候选由 `src/engine/avatarGen.js` 用 canvas 读取上传素材生成——按所选风格提取素材主色调、做 Q 版滤镜/裁切/描边，不同素材得到不同且外观相似的候选；不再返回固定 emoji。空素材、非图片、损坏文件均有明确报错，生成任务会标记 FAILED。这是本地原型的风格化处理，**不是 AI 语义重绘**；接入真实图生图服务时只需替换 `avatarAdapter.generate()` 内部实现（输入输出契约不变）。
| 语音音色页「上传声音克隆」 | 上传样本 → 强制授权 → Mock 克隆 → 试听采纳 |
| 对话演示 | 走真实模型；验证"下一轮生效 + 上下文保留"的热切换 |
| 发布中心 | 绑定四类资源、校验、发布、灰度、回滚、事件流 |
| 系统设置 | 审计日志、权限说明、真机适配器参数、导出/重置 |

## 六、安全与实现说明

- 密钥链路：前端资源只存 `apiKeyRef = env:DEEPSEEK_API_KEY`；代理从 `process.env` 取真实值；明文密钥不经过浏览器、不写 localStorage、不进日志。
- SSRF 防护：代理校验 endpoint 主机必须在 `ALLOWED_API_HOSTS` 白名单内。
- 拒绝明文：任何直接传明文密钥的请求都会被代理拒绝。
- 本地访问限制：代理只接受来自 `127.0.0.1` 的请求。
- 错误处理：401/402/403/404/422/429/5xx 均映射为友好中文提示；主模型失败会真实调用备用模型，主备都失败才显示错误，绝不伪造回复。
- 真机参数（api.tenclass.net / hello v3 / MCP 2024-11-05）见方案附录 A，已在「系统设置」列出。

## 七、改动文件速查（本次接入真实 API）

| 文件 | 改动 |
|---|---|
| `server/index.mjs`（新增） | 安全代理：读 `.env`、SSE 流式转发、错误映射、SSRF 防护 |
| `server/check.mjs`（新增） | 真实调用验证脚本 |
| `scripts/dev.mjs`（新增） | 一键启动前后端 |
| `.env.example` / `.gitignore`（新增） | 密钥模板与忽略规则 |
| `src/engine/adapters.js` | 模型适配器改为真实 HTTP 流式调用 |
| `src/engine/chatEngine.js` | 人设注入 system prompt、真实降级与错误提示 |
| `src/engine/personaHelper.js` | 新增 `buildSystemPrompt` 变量插值 |
| `src/store/store.js` | 密钥引用改为 `env:` 并加旧数据迁移 |
| `src/pages/ModelPage.jsx` | 密钥字段提示改为环境变量引用 |
| `vite.config.js` / `package.json` | `/api` 代理与启动/验证脚本 |

## 技术栈

React 18 + Vite 5（前端）+ Node 原生 HTTP（安全代理，零依赖）。配置数据 `src/store/`，引擎 `src/engine/`，页面 `src/pages/`，代理 `server/`。
