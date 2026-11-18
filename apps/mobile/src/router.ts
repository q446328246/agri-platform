import { createRouter, createWebHashHistory } from 'vue-router'
import { session } from './auth'

/** hash 路由：/m/ 子路径部署刷新不依赖服务端回落 */
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/cockpit' },
    { path: '/login', component: () => import('./views/Login.vue') },
    { path: '/cockpit', component: () => import('./views/Cockpit.vue') },
    { path: '/patrol', component: () => import('./views/Patrol.vue') },
    { path: '/tasks', component: () => import('./views/Tasks.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/cockpit' }
  ]
})

router.beforeEach((to) => {
  if (!session.user && to.path !== '/login') return '/login'
  if (session.user && to.path === '/login') return '/cockpit'
  return true
})

export default router