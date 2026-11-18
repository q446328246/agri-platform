import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// 移动端 H5（A17）：独立工程不混入 apps/web 桌面布局；
// 生产挂在边缘 /m/ 路径下（nginx alias），故 base 固定 /m/；路由用 hash 模式，刷新不依赖服务端回落
export default defineConfig({
  base: '/m/',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 3001,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
})