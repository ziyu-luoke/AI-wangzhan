import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// /api 转发到本地安全代理（密钥只在代理服务端），dev 与 preview 均生效
const proxy = {
  '/api': {
    target: 'http://127.0.0.1:8787',
    changeOrigin: true,
  },
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy,
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    proxy,
  },
})
