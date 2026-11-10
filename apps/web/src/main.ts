import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import 'leaflet/dist/leaflet.css'
import App from './App.vue'
import router from './router'
import './assets/styles/main.scss'

const app = createApp(App)

// 重建前端镜像后带哈希的懒加载 chunk 全部改名，改版前打开的页签点进未预载的路由
// 会因 404 停在白屏（地块详情页正是这么打不开的）。整页重载一次拿到新的 index.html，
// 10 秒内不重复重载，避免资源真缺失时陷入刷新循环。
const CHUNK_RELOAD_KEY = 'agri-chunk-reload-at'
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0)
  if (Date.now() - last < 10_000) return
  sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
  window.location.reload()
})

// 注册所有Element Plus图标
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn as any })

app.mount('#app')
