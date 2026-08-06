import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // 将打包产物直接输出到 Java 后端的静态资源目录
    outDir: '../backend/src/main/resources/public',
    emptyOutDir: true
  },
  server: {
    proxy: {
      // 将所有 /api 开头的请求代理到你的 Javalin 服务器
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
})
