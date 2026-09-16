import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    vueDevTools(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'pwa-192x192.png', 'pwa-512x512.png'],
      manifest: {
        name: 'ScoutingPro 27',
        short_name: 'ScoutingPro',
        description: 'FTC Robotics Scouting System - WebRTC Offline PWA',
        theme_color: '#0d1117',
        background_color: '#0d1117',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}']
      }
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // 将打包产物直接输出到 Java 后端的静态资源目录
    outDir: '../Backend/src/main/resources/public',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('highlight.js') || id.includes('markdown-it') || id.includes('dompurify')) {
              return 'vendor-markdown'
            }
            if (id.includes('mqtt')) {
              return 'vendor-network'
            }
            if (id.includes('vue') || id.includes('pinia')) {
              return 'vendor-vue'
            }
          }
        }
      }
    }
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
