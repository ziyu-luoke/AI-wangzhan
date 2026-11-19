// 一键启动：同时拉起后端安全代理与 Vite 前端（跨平台，无额外依赖）
// Ctrl+C 时统一关闭两个子进程，避免端口残留
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')

const children = []
let shuttingDown = false

function run(label, args) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  })
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) {
      console.error(`[${label}] 进程退出（code=${code}），正在关闭其它进程…`)
      shutdown(code || 1)
    }
  })
  child.on('error', (err) => console.error(`[${label}] 启动失败：`, err.message))
  children.push(child)
  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) { try { c.kill() } catch { /* ignore */ } }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('[小智配置台] 启动后端安全代理 + 前端…')
run('proxy', [path.join(ROOT, 'server', 'index.mjs')])
run('vite', [viteBin, '--host', '127.0.0.1', '--port', '5173'])
