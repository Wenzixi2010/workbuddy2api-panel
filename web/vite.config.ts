import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 构建产物直接落进 internal/panel/dist，由 Go 侧 go:embed 打进二进制。
//
// 关键约束：base 必须是 '/panel/'。面板挂在 /panel/ 下，若用默认 '/'，
// 产物里的资源引用会变成 /assets/xxx.js —— 请求会打到网关根路径而不是面板，
// 表现为整页白屏（而且网络面板里是一堆 404，很容易误判成构建没生成文件）。
export default defineConfig({
  base: '/panel/',
  plugins: [react()],
  build: {
    outDir: '../internal/panel/dist',
    emptyOutDir: true,
    // 产物文件名带内容 hash：配合 index.go 的内容指纹机制，跨版本 URL 必然不同，
    // 中间层缓存回放的旧资源命不中新页面（issue #33 的同类问题在 SPA 下更致命：
    // 新 HTML 配旧 chunk，React 会拿到 undefined 组件直接白屏）。
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  // 开发期：把 /panel/api 代理到本地 Go 服务，避免 CORS 与鉴权头问题。
  server: {
    port: 5173,
    proxy: {
      '/panel/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
    },
  },
})
